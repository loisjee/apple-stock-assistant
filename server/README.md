# 附近自提库存监控 · 服务器版

把「门店库存」独立为 Node.js + Playwright 服务，不依赖浏览器扩展。服务器运行自己的 Chromium，复用插件的官网页面按钮、地区选择与门店识别逻辑。关闭本机浏览器或管理网页后，服务器继续检查。

此服务只监控官网自提库存；代码不执行购物袋、游客结账、订单提交或付款流程，不直接调用库存接口。

## Docker 部署

需要一台能访问苹果中国官网的 Linux 服务器，以及 Docker Engine / Compose。部署前先确认该服务器能正常打开官网商品页；服务器出口也可能遇到限流或验证码。

在服务器执行：

```sh
git clone https://github.com/loisjee/apple-stock-assistant.git
cd apple-stock-assistant
cp .env.example .env
chmod 600 .env
openssl rand -hex 24
```

把最后生成的随机值填入 `.env` 的 `MONITOR_PASSWORD`，保存好供管理页登录。首次部署时创建 `.env`；升级时保留已有 `.env` 和数据卷。

```sh
docker compose up -d --build
docker compose logs --tail=50
```

默认端口只绑定服务器的 `127.0.0.1:8787`。在自己的电脑执行端口转发，然后访问 `http://127.0.0.1:8787`：

```sh
ssh -N -L 8787:127.0.0.1:8787 你的用户名@服务器地址
```

登录后点击「配置」，填写完整商品名称、SKU、具体商品链接和所在省市区，再开始监控。**第一次需要在网页配置并开始；仅启动容器不会自动查询默认商品。** 不需要填写 Apple 账号、游客邮箱、收货人、手机号或门牌号。

默认每 60 秒检查一次，可配置 30–3600 秒。列表只展示官网返回的附近门店顺序、距离和取货文案。未知状态不会判为有货，查询失败会保留并标记上次结果过期。

## 常驻和状态保存

- 管理网页只是控制界面，关闭网页不停止监控。
- 容器使用 `restart: unless-stopped`，并将配置、上次结果和提醒去重记录保存在 `pickup-data` 数据卷中。
- 服务重启后，原先正在运行的监控会恢复；已手动暂停的任务继续暂停。
- 点击「暂停」会取消正在进行的页面检查，迟到结果不会触发提醒。
- 目前每个服务实例监控一个目标配置；切换配置会暂停，重新开始后使用新配置。
- `docker compose down` 保留数据卷；`docker compose down -v` 会删除配置和监控记录。

## 通知

未设置 `MONITOR_WEBHOOK_URL` 时，管理页显示「未配置推送」，库存结果仍会正常更新。管理页本身不发送手机或系统通知。

可在 `.env` 配置一个接收通用 JSON 的 HTTPS Webhook，然后执行 `docker compose up -d`。此地址及其中的密钥只在服务器环境中使用，不通过管理页返回，也不要提交到 GitHub。

```json
{
  "event": "pickup.available",
  "productName": "目标商品完整规格",
  "partNumber": "目标 SKU",
  "stores": [{"id": "门店编号", "name": "Apple 示例门店", "distanceText": "2.3 km", "availability": "available", "availabilityText": "今天可取货", "pickupText": "官网取货文案"}],
  "checkedAt": 1790000000000
}
```

此格式不是企业微信、钉钉或邮件的原生协议；如需这些渠道，需要增加对应适配或使用你自己的转发服务。服务器尚未配置通知地址时不会向任何渠道发消息。

首次确认某家门店可自提，或明确无货后恢复有货时提醒；持续有货不重复发送，失败或未知结果不重置去重记录。关闭通知期间不会消耗提醒记录，重新开启后可能提醒一次当前可自提的门店。Webhook 非成功状态、跳转或超时会记录通用错误，下次确认有货时重试。通知不发送查询地区或收货资料。已发送的提醒无法因随后暂停而撤回。

## HTTPS 访问

如需通过域名访问，在已有 HTTPS 反向代理后使用本服务，并设置：

```dotenv
MONITOR_PUBLIC_ORIGIN=https://stock.example.com
```

代理将请求转发到 `http://127.0.0.1:8787`，保留原始 `Host`（例如 Nginx 的 `proxy_set_header Host $http_host;`），且域名使用独立的根路径。管理密码至少 20 字符；会话 Cookie 使用 HttpOnly、SameSite=Strict，配置 HTTPS 源时启用 Secure。登录失败有次数限制，服务重启后需重新登录管理页。无需开放 Chromium 调试端口。

## 不用 Docker

使用 Node.js 22 或更新版本，在项目根目录执行：

```sh
npm ci
npx playwright install --with-deps chromium
node --env-file=.env server/index.mjs
```

默认监听本机 `127.0.0.1:8787`，数据写入 `data/state.json`。生产运行可交给系统的进程管理器；需要长期保存数据目录。

| 环境变量 | 默认 / 作用 |
| --- | --- |
| `MONITOR_PASSWORD` | 必填，20–512 字符的管理密码 |
| `MONITOR_DATA_DIR` | `data`，监控状态目录 |
| `MONITOR_WEBHOOK_URL` | 空，仅在管理页显示库存 |
| `MONITOR_PUBLIC_ORIGIN` | 空，通过本机或 SSH 转发访问 |
| `HOST` / `PORT` | `127.0.0.1` / `8787`；Docker 内部固定为 `0.0.0.0:8787` |
| `MONITOR_PORT` | Compose 发布到服务器本机的端口，默认 `8787` |
| `MONITOR_BROWSER_CHANNEL` | 默认 `chromium`（新无界面模式）；本机测试可设为 `chrome` 使用已安装 Chrome |
| `MONITOR_BROWSER_EXECUTABLE` | 可选，指定 Chromium 可执行文件 |
| `MONITOR_HEADLESS` | 默认无界面；`false` 仅供已有图形桌面与显示环境的主机排查 |

## 验证范围与限制

服务器版测试使用本地构造页面，覆盖 Chromium 适配、取消与恢复、调度、持久化、通知去重、管理页、认证及请求来源校验。插件 v0.4 的原页面逻辑已在真实官网连续两轮查询通过；服务器出口上的真实官网访问需要部署后另行验证。当前开发机器没有 Docker，Docker 构建与容器运行尚未实测。 本次在本机独立 Chrome 会话中访问官网时，页面自身的供货请求返回 HTTP 541，未能取得真实库存；服务将明确显示 HTTP 错误，不把失败判断为无货。普通 Chrome 会话可以查看该商品附近门店，因此具体部署环境仍需实测。

官网页面结构变化、浏览器崩溃、出口限流或验证码会影响查询。遇到登录、隐私确认、人机验证或无法识别的位置控件时暂停，不自动解决验证。默认容器不包含远程桌面或浏览器接管页面，不能在本机官网登录后自动把登录状态同步给服务器。正常公开库存查询不复用购买账号。

Playwright 的浏览器版本与依赖需要匹配；本镜像从项目锁定依赖安装相应 Chromium。[官方 Docker 说明](https://playwright.dev/docs/docker) · [官方浏览器安装说明](https://playwright.dev/docs/browsers)
