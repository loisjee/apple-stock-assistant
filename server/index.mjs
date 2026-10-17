import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createMonitorServer,validatePublicOrigin} from './http.mjs';
import {createPickupBrowser} from './browser.mjs';
import {PickupMonitor} from './monitor.mjs';
import {createWebhookNotifier} from './notifier.mjs';

export async function main(env=process.env){
  const password=env.MONITOR_PASSWORD||'';
  if(password.length<20||password.length>512)throw new Error('请先设置至少 20 个字符的 MONITOR_PASSWORD；可参考 server/README.md。');
  const port=Number(env.PORT||8787);if(!Number.isInteger(port)||port<1||port>65535)throw new Error('PORT 须为 1 至 65535 的整数。');
  const publicOrigin=validatePublicOrigin(env.MONITOR_PUBLIC_ORIGIN||'');
  const host=env.HOST||'127.0.0.1';
  const notify=createWebhookNotifier({url:env.MONITOR_WEBHOOK_URL||''});
  const browser=await createPickupBrowser({headless:env.MONITOR_HEADLESS!=='false',channel:env.MONITOR_BROWSER_CHANNEL||'chromium',...(env.MONITOR_BROWSER_EXECUTABLE?{executablePath:env.MONITOR_BROWSER_EXECUTABLE}:{})});
  const monitor=new PickupMonitor({browser,storePath:resolve(env.MONITOR_DATA_DIR||'data','state.json'),notify});
  await monitor.init();
  const server=createMonitorServer({monitor,password,publicOrigin,cookieSecure:env.MONITOR_COOKIE_SECURE==='true'});
  try{await new Promise((done,reject)=>{server.once('error',reject);server.listen(port,host,done);});}
  catch(error){await monitor.close();throw new Error(error.code==='EADDRINUSE'?'管理端口已被占用，请更换 PORT。':'无法监听管理端口，请检查 HOST 和 PORT 设置。');}
  console.log(`门店库存服务已启动，端口 ${port}。推送${notify?'已配置':'未配置，仅在管理页显示结果'}。`);
  let closing=false;
  const close=async()=>{if(closing)return;closing=true;const stopped=new Promise(done=>server.close(done));server.closeIdleConnections();await monitor.close();await stopped;};
  for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>{void close().then(()=>process.exit(0),()=>process.exit(1));});
  return {server,monitor,close};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){main().catch(error=>{console.error(error.message||'库存服务启动失败。');process.exitCode=1;});}
