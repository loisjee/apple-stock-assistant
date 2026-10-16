import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

let chromium;
try { ({ chromium } = await import('playwright')); }
catch {
  /* The dependency-free core tests can run without a browser installation. */
}
const panelUrl = new URL('../panel.html', import.meta.url).href;
const screenshotUrl = new URL('../test-artifacts/panel-preview.png', import.meta.url);
const duoUrl = 'https://www.apple.com.cn/shop/product/MK2T4CH/A';
const testUrl = 'https://www.apple.com.cn/shop/buy-iphone/iphone-18-pro/mjyj4ch/a';
const dummyShipping = {
  lastName: '测试', firstName: '用户', province: '测试省', city: '测试市', district: '测试区',
  detailAddress: '本地测试地址，不用于真实订单', recipientPhone: '13800000000',
  contactPhone: '13900000000', email: 'dummy@example.invalid',
};
const shippingIds = { lastName: 'last-name', firstName: 'first-name', province: 'province', city: 'city',
  district: 'district', detailAddress: 'detail-address', recipientPhone: 'recipient-phone', contactPhone: 'contact-phone', email: 'email' };

test('page-only panel preview and mocked extension controls in isolated local Chromium', { skip: !chromium }, async t => {
  let browser;
  try { browser = await chromium.launch({ channel: 'chrome', headless: true }); }
  catch { browser = await chromium.launch({ headless: true }); }
  t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 1100, height: 1000 }, deviceScaleFactor: 2 });
  const blockedRequests = [];
  // Local files only: even a regression cannot access an account or website.
  await context.route(/^https?:\/\//, route => { blockedRequests.push(route.request().url()); return route.abort(); });
  const errors = [];
  context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
  const page = await context.newPage();
  await page.goto(panelUrl);
  await page.locator('#status-tag').filter({ hasText: '演示模式' }).waitFor();

  await t.test('demo is explicit, compact, and has no actual operations', async () => {
    assert.match(await page.locator('#notice').innerText(), /界面预览.*未连接官网.*不会刷新.*下单/);
    assert.match(await page.locator('#fineprint').innerText(), /界面预览.*未连接官网.*不会刷新或下单/);
    assert.equal(await page.locator('#collapse').isVisible(), false);
    assert.equal((await page.locator('body').boundingBox()).width, 310);
    assert.equal(await page.locator('#workflow-list li').count(), 7);
    assert.match(await page.locator('#product-name').innerText(), /iPhone Duo 1TB 星光白色/);
    await mkdir(fileURLToPath(new URL('../test-artifacts/', import.meta.url)), { recursive: true });
    await page.locator('body').screenshot({ path: fileURLToPath(screenshotUrl) });
    await page.locator('#check-now').click();
    assert.equal(await page.locator('#scans').innerText(), '1');
    await page.locator('#toggle').click();
    assert.equal(await page.locator('#toggle').innerText(), '暂停');
    assert.match(await page.locator('#status-description').innerText(), /预览.*不会打开或操作真实网站/);
    assert.equal(await page.locator('.step.current').innerText(), '1\n商品规格页\n当前步骤');
    await page.locator('#toggle').click();
    assert.equal(await page.locator('#toggle').innerText(), '开始抢购');
    assert.equal(context.pages().length, 1);
  });

  await t.test('presets, native retry bounds, and unlimited refresh setting', async () => {
    await page.locator('#configure').click();
    assert.equal(await page.locator('#preset').inputValue(), 'duo');
    assert.equal(await page.locator('#product-url').inputValue(), duoUrl);
    await page.locator('#preset').selectOption('test');
    assert.equal(await page.locator('#part-number').inputValue(), 'MJYJ4CH/A');
    assert.equal(await page.locator('#product-url').inputValue(), testUrl);
    await page.locator('#preset').selectOption('duo');
    assert.equal(await page.locator('#part-number').inputValue(), 'MK2T4CH/A');
    assert.equal(await page.locator('#retry-seconds').getAttribute('min'), '3');
    assert.equal(await page.locator('#retry-seconds').getAttribute('max'), '30');
    assert.equal(await page.locator('#max-refreshes').getAttribute('min'), '0');
    assert.equal(await page.locator('#max-refreshes').getAttribute('max'), '300');
    for (const value of ['2', '31', '3.5']) {
      await page.locator('#retry-seconds').fill(value);
      assert.equal(await page.locator('#retry-seconds').evaluate(input => input.checkValidity()), false);
      await page.locator('#save-settings').click();
      assert.equal(await page.locator('#settings').evaluate(dialog => dialog.open), true);
    }
    await page.locator('#retry-seconds').fill('3');
    await page.locator('#max-refreshes').fill('0');
    assert.match(await page.locator('#settings').innerText(), /刷新次数 0 表示持续等待/);
    assert.match(await page.locator('#settings').innerText(), /插件不直接请求库存或下单接口/);
  });

  await t.test('final submit requires a positive maximum, guest data remains optional', async () => {
    for (const id of Object.values(shippingIds)) assert.equal(await page.locator(`#${id}`).inputValue(), '');
    await page.locator('#allow-submit').check();
    await page.locator('#max-total').fill('0');
    await page.locator('#save-settings').click();
    assert.equal(await page.locator('#settings').evaluate(dialog => dialog.open), true);
    assert.match(await page.locator('#settings-error').innerText(), /大于 0 的总额上限/);
    await page.locator('#allow-submit').uncheck();
    await page.locator('#save-settings').click();
    assert.equal(await page.locator('#settings').evaluate(dialog => dialog.open), false);
    await page.locator('#configure').click();
    assert.equal(await page.locator('#max-refreshes').inputValue(), '0');
    assert.equal(await page.locator('#retry-seconds').inputValue(), '3');
    assert.equal(await page.locator('#allow-submit').isChecked(), false);
    const dimensions = await page.locator('#settings').evaluate(dialog => ({ width: dialog.clientWidth, scrollWidth: dialog.scrollWidth }));
    assert.ok(dimensions.scrollWidth <= dimensions.width, 'settings must not overflow horizontally');
    await page.locator('#preset').selectOption('test');
    await page.locator('#fulfillment').selectOption('pickup');
    await page.locator('#payment-method').selectOption('wechat');
    await page.locator('#max-total').fill('16500');
    await page.locator('#allow-submit').check();
    await page.locator('#shipping-details summary').click();
    for (const [key, id] of Object.entries(shippingIds)) await page.locator(`#${id}`).fill(dummyShipping[key]);
    await page.locator('#save-settings').click();
    assert.equal(await page.locator('#settings').evaluate(dialog => dialog.open), false);
    assert.match(await page.locator('#product-name').innerText(), /iPhone 18 Pro Max 1TB 冰川蓝色/);
    assert.equal(await page.locator('#fulfillment-label').innerText(), '门店自提');
    assert.equal(await page.locator('#payment-label').innerText(), '微信支付');
    assert.match(await page.locator('#submit-label').innerText(), /16500/);
    await page.locator('#configure').click();
    assert.equal(await page.locator('#preset').inputValue(), 'test');
    for (const [key, id] of Object.entries(shippingIds)) assert.equal(await page.locator(`#${id}`).inputValue(), dummyShipping[key]);
    await page.locator('#close-settings').click();
    assert.equal(context.pages().length, 1);
  });

  const extensionPage = await context.newPage();
  await extensionPage.setViewportSize({ width: 310, height: 650 });
  await extensionPage.addInitScript(() => {
    window.rpcMessages = [];
    window.failNext = '';
    window.fixtureState = {
      config: { partNumber: 'MK2T4CH/A', productUrl: 'https://www.apple.com.cn/shop/product/MK2T4CH/A',
        fulfillment: 'delivery', paymentMethod: 'alipay', retrySeconds: 3, maxRefreshes: 0,
        maxTotal: 0, quantity: 1, submitEnabled: false, shipping: {} },
      running: false, scans: 12, clicks: 4, refreshes: 3, stage: 'product', error: '', notice: '',
      nextRetryAt: 0, lastScanAt: 0, tabId: 42, order: { status: 'idle', message: '本地模拟扩展状态', stage: 'product' },
    };
    window.chrome = {
      runtime: { id: 'local-panel-fixture', sendMessage: async message => {
        window.rpcMessages.push(message);
        if (window.failNext === message.type) { window.failNext = ''; return { ok: false, error: '本地测试：页面操作失败，请检查后继续。' }; }
        const s = window.fixtureState;
        switch (message.type) {
          case 'GET_STATE': break;
          case 'SAVE_CONFIG': s.config = structuredClone(message.config); break;
          case 'START': case 'RESUME': s.running = true; s.stage = 'product'; s.order = { status: 'waiting', message: '本地模拟：等待按钮', stage: 'product' }; break;
          case 'STOP': s.running = false; s.order.status = 'paused'; s.order.message = '本地模拟已暂停'; break;
          case 'CHECK_NOW': s.scans++; break;
          case 'TEST_NOTIFICATION': s.notice = '本地模拟：提醒已测试'; break;
          case 'OPEN_PRODUCT': case 'OPEN_BAG': break;
          case 'RESET':
            s.running = false; s.stage = 'idle'; s.tabId = null; s.nextRetryAt = 0;
            s.scans = 0; s.clicks = 0; s.refreshes = 0; s.error = ''; s.notice = '本地模拟：新任务已准备';
            s.order = { status: 'idle', stage: 'idle', message: '仅重置本机状态，尚未开始。' }; break;
          default: return { ok: false, error: `未预期的 RPC：${message.type}` };
        }
        return { ok: true, state: structuredClone(s) };
      } },
      storage: { onChanged: { addListener: listener => { window.fixtureStorageListener = listener; } } },
    };
  });
  await extensionPage.goto(panelUrl);
  await extensionPage.locator('#status-tag').filter({ hasText: '页面点击模式' }).waitFor();

  await t.test('extension view uses compact layout and the exact saved config RPC schema', async () => {
    assert.equal(await extensionPage.locator('html').evaluate(element => element.classList.contains('preview-mode')), false);
    assert.equal((await extensionPage.locator('.panel').boundingBox()).width, 310);
    assert.equal(await extensionPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.equal(await extensionPage.locator('#scans').innerText(), '12');
    assert.equal(await extensionPage.locator('#clicks').innerText(), '4');
    assert.equal(await extensionPage.locator('#refreshes').innerText(), '3');
    assert.equal(await extensionPage.locator('#new-run').isVisible(), false);
    await extensionPage.locator('#configure').click();
    await extensionPage.locator('#preset').selectOption('test');
    await extensionPage.locator('#max-total').fill('16500');
    await extensionPage.locator('#allow-submit').check();
    await extensionPage.locator('#save-settings').click();
    await extensionPage.waitForFunction(() => window.rpcMessages.at(-1)?.type === 'SAVE_CONFIG');
    const saved = await extensionPage.evaluate(() => window.rpcMessages.at(-1));
    assert.deepEqual(Object.keys(saved).sort(), ['type', 'config'].sort());
    assert.deepEqual(Object.keys(saved.config).sort(), ['partNumber', 'productUrl', 'fulfillment', 'paymentMethod', 'retrySeconds', 'maxRefreshes', 'maxTotal', 'quantity', 'submitEnabled', 'shipping'].sort());
    assert.equal(saved.config.partNumber, 'MJYJ4CH/A');
    assert.equal(saved.config.productUrl, testUrl);
    assert.equal(saved.config.quantity, 1);
    assert.equal(saved.config.submitEnabled, true);
    assert.deepEqual(saved.config.shipping, Object.fromEntries(Object.keys(shippingIds).map(key => [key, ''])));
    await extensionPage.locator('#configure').click();
    assert.equal(await extensionPage.locator('#max-total').inputValue(), '16500');
    await extensionPage.locator('#close-settings').click();
  });

  await t.test('all page controls dispatch the agreed RPC types', async () => {
    for (const [id, type] of [['toggle', 'START'], ['toggle', 'STOP'], ['resume', 'RESUME'], ['toggle', 'STOP'],
      ['check-now', 'CHECK_NOW'], ['test-notification', 'TEST_NOTIFICATION'], ['open-product', 'OPEN_PRODUCT'], ['open-bag', 'OPEN_BAG']]) {
      await extensionPage.locator(`#${id}`).click();
      await extensionPage.waitForFunction(type => window.rpcMessages.at(-1)?.type === type, type);
    }
    assert.equal(context.pages().length, 2, 'mocked controls must not open a real page');
  });

  await t.test('operation error stays visible after the button is reenabled', async () => {
    await extensionPage.evaluate(() => { window.failNext = 'CHECK_NOW'; });
    await extensionPage.locator('#check-now').click();
    await extensionPage.waitForFunction(() => !document.getElementById('check-now').disabled);
    assert.equal(await extensionPage.locator('#notice').isVisible(), true);
    assert.match(await extensionPage.locator('#notice').innerText(), /本地测试：页面操作失败/);
    await extensionPage.evaluate(() => { window.failNext = 'SAVE_CONFIG'; });
    await extensionPage.locator('#configure').click();
    await extensionPage.locator('#save-settings').click();
    assert.equal(await extensionPage.locator('#settings').evaluate(dialog => dialog.open), true);
    assert.match(await extensionPage.locator('#settings-error').innerText(), /本地测试：页面操作失败/);
    await extensionPage.locator('#close-settings').click();
  });

  await t.test('storage phase updates mark completed rows and disable restart at payment', async () => {
    await extensionPage.evaluate(() => {
      const next = structuredClone(window.fixtureState);
      next.running = true; next.stage = 'billing'; next.order = { status: 'waiting', message: '选择付款渠道', stage: 'billing' };
      window.fixtureStorageListener({ app: { newValue: next } }, 'local');
    });
    assert.equal(await extensionPage.locator('#stage-label').innerText(), '5 / 7');
    assert.equal(await extensionPage.locator('.step.done').count(), 4);
    assert.match(await extensionPage.locator('.step.current').innerText(), /选择支付渠道.*当前步骤/s);
    await extensionPage.evaluate(() => {
      const next = structuredClone(window.fixtureState);
      next.running = false; next.stage = 'shipping'; next.order = { status: 'human', message: '请手动完成验证', stage: 'shipping' };
      window.fixtureStorageListener({ app: { newValue: next } }, 'local');
    });
    assert.match(await extensionPage.locator('#status-title').innerText(), /已暂停/);
    assert.match(await extensionPage.locator('.step.current').innerText(), /配送信息与验证.*待处理/s);
    await extensionPage.evaluate(() => {
      const next = structuredClone(window.fixtureState);
      next.running = true; next.stage = 'processing'; next.order = { status: 'waiting', message: '等待提交结果', stage: 'processing' };
      window.fixtureStorageListener({ app: { newValue: next } }, 'local');
    });
    assert.equal(await extensionPage.locator('#stage-label').innerText(), '6 / 7');
    assert.match(await extensionPage.locator('.step.current').innerText(), /核对并提交订单/);
    await extensionPage.evaluate(() => {
      const next = structuredClone(window.fixtureState);
      next.running = false; next.stage = 'awaitingPayment'; next.order = { status: 'awaitingPayment', message: '待付款，请自行完成付款。', stage: 'awaitingPayment' };
      window.fixtureState = next;
      window.fixtureStorageListener({ app: { newValue: next } }, 'local');
    });
    assert.equal(await extensionPage.locator('#status-title').innerText(), '订单等待付款');
    assert.equal(await extensionPage.locator('#stage-label').innerText(), '7 / 7');
    assert.equal(await extensionPage.locator('.step.done').count(), 6);
    assert.match(await extensionPage.locator('.step.current').innerText(), /等待你付款.*已停止/s);
    assert.equal(await extensionPage.locator('#toggle').isDisabled(), true);
    assert.equal(await extensionPage.locator('#resume').isDisabled(), true);
    assert.equal(await extensionPage.locator('#new-run').isVisible(), true);
    const count = await extensionPage.evaluate(() => window.rpcMessages.length);
    await extensionPage.locator('#toggle').evaluate(button => button.click());
    await extensionPage.locator('#resume').evaluate(button => button.click());
    assert.equal(await extensionPage.evaluate(() => window.rpcMessages.length), count);
    await extensionPage.locator('#new-run').click();
    await extensionPage.waitForFunction(() => window.rpcMessages.at(-1)?.type === 'RESET');
    assert.equal(await extensionPage.evaluate(() => window.rpcMessages.length), count + 1);
    assert.equal(await extensionPage.evaluate(() => window.fixtureState.running), false);
    assert.equal(await extensionPage.evaluate(() => window.fixtureState.tabId), null);
    assert.equal(await extensionPage.locator('#toggle').isDisabled(), false);
    assert.equal(await extensionPage.locator('#toggle').innerText(), '开始抢购');
    assert.equal(await extensionPage.locator('#resume').isDisabled(), true);
    assert.equal(await extensionPage.locator('#new-run').isVisible(), false);
    assert.equal(await extensionPage.locator('#stage-label').innerText(), '等待开始');
  });

  await t.test('embedded mode exposes a collapse control without opening a site', async () => {
    const embedded = await context.newPage();
    await embedded.setViewportSize({ width: 310, height: 650 });
    await embedded.goto(`${panelUrl}?embedded=1&parent=${encodeURIComponent('https://secure6.www.apple.com.cn')}`);
    await embedded.locator('#status-tag').filter({ hasText: '演示模式' }).waitFor();
    assert.equal(await embedded.locator('body').evaluate(body => body.classList.contains('embedded')), true);
    assert.equal(await embedded.locator('#collapse').isVisible(), true);
    await embedded.evaluate(() => { window.collapseMessages = []; window.postMessage = (message, origin) => window.collapseMessages.push({ message, origin }); });
    await embedded.locator('#collapse').click();
    assert.deepEqual(await embedded.evaluate(() => window.collapseMessages), [{ message: { type: 'SHIKE_COLLAPSE' }, origin: 'https://secure6.www.apple.com.cn' }]);
    await embedded.close();
  });

  assert.deepEqual(errors, []);
  assert.deepEqual(blockedRequests, [], 'panel must never attempt HTTP requests during local tests');
});
