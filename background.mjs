import {DEFAULT_CONFIG, normalizeConfig, isAppleShopUrl, isSafeEntryUrl} from './core.mjs';

// Page controls only: no request endpoints, cookie access, or payment actions.
const ALARM='shike-page-recovery';
const STAGES=new Set(['idle','product','attach','bag','signIn','fulfillment','shipping','billing','review','processing','awaitingPayment','blocked','unknown']);
const ACTIONS=new Set(['addBag','viewBag','checkout','guest','delivery','pickup','fillShipping','selectProvince','selectCity','selectDistrict','chooseProvince','chooseCity','chooseDistrict','shippingContinue','selectPayment','billingContinue','submitOrder']);
const FORM_ACTIONS=new Set(['fillShipping','selectProvince','selectCity','selectDistrict','chooseProvince','chooseCity','chooseDistrict','selectPayment']);
const CART_ACTIONS=new Set(['addBag','submitOrder']);
const initial=()=>({schemaVersion:2,config:normalizeConfig(DEFAULT_CONFIG),configRevision:0,generation:0,running:false,
  scans:0,clicks:0,refreshes:0,errors:0,stage:'idle',error:'',notice:'',lastScanAt:0,nextRetryAt:0,tabId:null,
  order:{status:'idle',stage:'idle',message:'尚未执行',token:'',entryUrl:'',awaitedStage:null,lastAction:null,cartMutated:false,uncertain:false}});
let mutation=Promise.resolve(),tickPromise=null,startPromise=null,alarmMutation=Promise.resolve();
let queuedTick=false,fallbackTimer=null;
function restore(stored){const value=initial();return stored?.schemaVersion===2?{...value,...stored,config:normalizeConfig({...DEFAULT_CONFIG,...stored.config}),order:{...value.order,...stored.order}}:value;}
function update(fn){const job=mutation.then(async()=>{const {app:stored}=await chrome.storage.local.get('app');const app=restore(stored);await fn(app);await chrome.storage.local.set({app});return app;});mutation=job.catch(()=>{});return job;}
async function read(){await mutation;const {app}=await chrome.storage.local.get('app');return restore(app);}
const current=(app,token)=>app.running&&app.order.token===token;
const brief=value=>String(value||'').slice(0,500);
function isPanel(sender){if(sender.id!==chrome.runtime.id)return false;try{const expected=new URL(chrome.runtime.getURL('panel.html')),actual=new URL(sender.url);return actual.protocol===expected.protocol&&actual.hostname===expected.hostname&&actual.pathname===expected.pathname;}catch{return false;}}
function isContent(sender){return sender.id===chrome.runtime.id&&Number.isInteger(sender.tab?.id)&&(sender.frameId===undefined||sender.frameId===0)&&isAppleShopUrl(sender.url);}
function clearTimer(){if(fallbackTimer!==null){clearTimeout(fallbackTimer);fallbackTimer=null;}}
function reconcileAlarm(){const job=alarmMutation.then(async()=>{const app=await read();if(!app.running)return chrome.alarms.clear(ALARM);if(!await chrome.alarms.get(ALARM))await chrome.alarms.create(ALARM,{periodInMinutes:0.5});});alarmMutation=job.catch(()=>{});return job;}
async function notify(id,title,message){try{await chrome.notifications.create(id,{type:'basic',iconUrl:chrome.runtime.getURL('icons/icon128.png'),title,message:brief(message)});}catch{}}
async function cancelContent(tabId){if(Number.isInteger(tabId))try{await chrome.tabs.sendMessage(tabId,{type:'CANCEL_EXECUTION'});}catch{}}
async function stop(reason='已暂停。处理官网提示后可继续当前流程。'){
  clearTimer();const app=await update(a=>{const completed=a.order.status==='awaitingPayment'&&a.order.stage==='awaitingPayment'&&!a.order.uncertain;a.running=false;a.generation++;a.nextRetryAt=0;if(!completed){a.order.status='paused';a.order.message=reason;}});
  await cancelContent(app.tabId);await reconcileAlarm();return app;
}
async function pauseRun(token,message,{uncertain=false,error=true}={}){
  let changed=false;const app=await update(a=>{if(!current(a,token))return;changed=true;a.running=false;a.nextRetryAt=0;a.order.status='paused';a.order.message=brief(message);a.order.uncertain=a.order.uncertain||uncertain;if(error){a.errors++;a.error=brief(message);}else{a.error='';a.notice=brief(message);}});
  if(changed){clearTimer();await cancelContent(app.tabId);await reconcileAlarm();await notify('shike-paused','流程已暂停',message);}return app;
}
async function pageMessage(id,message){if(!Number.isInteger(id))throw new Error('没有执行标签页。');const tab=await chrome.tabs.get(id);if(!isAppleShopUrl(tab.url))throw new Error('执行页尚未进入受支持的官网购物页面。');return chrome.tabs.sendMessage(id,message);}
async function scheduleNext(token,delayMs){
  clearTimer();const app=await update(a=>{if(current(a,token)){a.nextRetryAt=Date.now()+delayMs;a.order.status='waiting';}});if(!current(app,token))return;
  try{const result=await pageMessage(app.tabId,{type:'PAGE_SCHEDULE',runToken:token,delayMs});if(result?.ok===true)return;}catch{}
  // Error pages have no content timer; the recovery alarm also restores this expendable timer.
  if(!current(await read(),token))return;
  fallbackTimer=setTimeout(()=>{fallbackTimer=null;void tick('fallback',token);},delayMs);
}
function expectedStages(probe){
  const supplied=(Array.isArray(probe.expectedNext)?probe.expectedNext:[probe.expectedNext]).filter(stage=>STAGES.has(stage));
  if(supplied.length)return [...new Set(supplied)];
  return ({addBag:['attach','bag'],viewBag:['bag'],checkout:['signIn','fulfillment','shipping'],guest:['fulfillment','shipping'],delivery:['fulfillment','shipping'],pickup:['fulfillment','shipping'],fillShipping:['shipping'],selectProvince:['shipping'],selectCity:['shipping'],selectDistrict:['shipping'],chooseProvince:['shipping'],chooseCity:['shipping'],chooseDistrict:['shipping'],shippingContinue:['billing'],selectPayment:['billing'],billingContinue:['review'],submitOrder:['awaitingPayment']})[probe.action]||[];
}
function hasProgress(app,probe){
  const last=app.order.lastAction;if(!last||!['dispatching','confirmed','uncertain'].includes(last.status))return true;
  if(last.action==='submitOrder')return probe.stage==='awaitingPayment';
  if(!app.order.awaitedStage?.includes(probe.stage))return false;
  if(probe.stage!==last.stage)return true;
  if(probe.action&&probe.action!==last.action)return true;
  if(probe.documentId!==last.documentId&&!CART_ACTIONS.has(last.action))return true;
  return last.status==='confirmed'&&FORM_ACTIONS.has(last.action)&&app.configRevision!==last.configRevision;
}
async function refreshEntry(app,probe=null){
  const token=app.order.token,last=app.order.lastAction;
  if(app.order.cartMutated||app.order.uncertain||(last&&['dispatching','confirmed','uncertain'].includes(last.status)))return false;
  const tab=await chrome.tabs.get(app.tabId),errorPage=typeof tab.url==='string'&&/^chrome-error:\/\//.test(tab.url);
  if(!isSafeEntryUrl(tab.url)&&!(errorPage&&isSafeEntryUrl(app.order.entryUrl)))return false;
  if(probe&&(probe.stage!=='product'||probe.safeToReload!==true||!probe.documentId||(last?.documentId===probe.documentId&&last?.clicked)))return false;
  if(app.nextRetryAt>Date.now()){await scheduleNext(token,app.nextRetryAt-Date.now());return true;}
  if(app.config.maxRefreshes>0&&app.refreshes>=app.config.maxRefreshes){await pauseRun(token,'已达到入口刷新上限。请检查官网后继续。',{error:false});return true;}
  let permitted=false;await update(a=>{if(!current(a,token)||a.order.cartMutated||a.order.uncertain)return;permitted=true;a.refreshes++;a.stage='product';a.order.stage='product';a.order.message='入口尚不可继续，正在通过页面刷新等待。';});
  if(!permitted||!current(await read(),token))return true;
  await chrome.tabs.reload(app.tabId);await scheduleNext(token,app.config.retrySeconds*1000);return true;
}
async function missingPage(app){
  if(!current(await read(),app.order.token))return;
  if(app.order.lastAction?.status==='dispatching'||app.order.uncertain){await pauseRun(app.order.token,'上次按钮结果尚未确认。请检查购物袋或订单，禁止自动重试。',{uncertain:true});return;}
  if(await refreshEntry(app))return;
  if(app.order.awaitedStage?.length&&Date.now()-(app.order.lastAction?.at||0)<60000){await scheduleNext(app.order.token,app.config.retrySeconds*1000);return;}
  await pauseRun(app.order.token,'执行页面尚不可读取。请处理登录、验证或页面错误，再继续当前流程。',{error:false});
}
async function complete(token){
  let changed=false;const app=await update(a=>{if(current(a,token)){changed=true;a.running=false;a.nextRetryAt=0;a.stage='awaitingPayment';a.order.stage='awaitingPayment';a.order.status='awaitingPayment';a.order.message='已识别订单已提交页面。自动操作停止，请核对订单并自行付款。';a.order.uncertain=false;a.order.awaitedStage=null;a.error='';}});
  if(changed){clearTimer();await cancelContent(app.tabId);await reconcileAlarm();await notify('shike-order','订单流程已停止','已识别订单已提交页面，请自行核对与付款。');}
}
async function dispatch(app,probe){
  const token=app.order.token;
  if(!ACTIONS.has(probe.action)){await pauseRun(token,'页面提出了不支持的动作，已停止。');return;}
  if(probe.action==='submitOrder'&&(!app.config.submitEnabled||app.config.maxTotal<=0||app.config.quantity!==1)){await pauseRun(token,'提交订单需要明确启用允许提交，并设置有效金额上限与数量 1。',{error:false});return;}
  const actionId=crypto.randomUUID(),previousMutation=app.order.cartMutated;let allowed=false;
  await update(a=>{if(!current(a,token))return;allowed=true;a.order.status='running';a.order.message=`正在执行页面动作：${probe.action}`;a.order.awaitedStage=expectedStages(probe);
    a.order.lastAction={id:actionId,action:probe.action,stage:probe.stage,documentId:probe.documentId,configRevision:a.configRevision,status:'dispatching',at:Date.now(),clicked:false,changed:false};
    a.order.uncertain=true;if(CART_ACTIONS.has(probe.action)||probe.mutatesCart===true)a.order.cartMutated=true;});
  if(!allowed)return;
  let result;
  try{const tab=await chrome.tabs.get(app.tabId),live=await read();if(!current(live,token)){await update(a=>{if(a.order.lastAction?.id===actionId){a.order.lastAction.status='notClicked';a.order.uncertain=false;a.order.cartMutated=previousMutation;a.order.awaitedStage=null;}});return;}if(!isAppleShopUrl(tab.url))throw new Error('离开购物页面');
    result=await chrome.tabs.sendMessage(app.tabId,{type:'PAGE_ACTION',runToken:token,actionId,documentId:probe.documentId,action:probe.action,config:app.config});
  }catch{await update(a=>{if(current(a,token)&&a.order.lastAction?.id===actionId)a.order.lastAction.status='uncertain';});await pauseRun(token,'按钮可能已经执行，但结果未收到。已停止且不会重复点击，请核对购物袋或订单。',{uncertain:true});return;}
  const latest=await read();
  if(!current(latest,token)&&latest.order.lastAction?.id!==actionId)return;
  if(!result||result.uncertain===true||typeof result.clicked!=='boolean'){await update(a=>{if(current(a,token)&&a.order.lastAction?.id===actionId)a.order.lastAction.status='uncertain';});await pauseRun(token,'页面动作结果不确定，已停止且不会重复点击。请先在官网核对。',{uncertain:true});return;}
  const mutated=result.clicked||result.changed===true;
  await update(a=>{if(a.order.lastAction?.id!==actionId)return;a.order.lastAction={...a.order.lastAction,status:mutated?'confirmed':'notClicked',clicked:result.clicked,changed:result.changed===true};a.order.uncertain=false;if(result.clicked)a.clicks++;if(!mutated){a.order.cartMutated=previousMutation;a.order.awaitedStage=null;}if(current(a,token))a.order.message=brief(result.reason)||'已执行，等待下一页面或阶段。';});
  if(!current(await read(),token))return;
  if(result.phase==='awaitingPayment'){await complete(token);return;}
  if(result.ok!==true||result.requiresHuman){await pauseRun(token,result.reason||'此步骤需要你在官网处理后继续。',{error:false});return;}
  if(probe.action==='submitOrder'&&!mutated){await pauseRun(token,result.reason||'未提交订单，请在官网核对。',{error:false});return;}
  await scheduleNext(token,mutated?350:app.config.retrySeconds*1000);
}
async function doTick(reason,requestedToken){
  const app=await read();if(!app.running||(requestedToken&&app.order.token!==requestedToken))return app;
  const token=app.order.token;
  if(app.nextRetryAt>Date.now()&&!['start','resume','manual'].includes(reason)){await scheduleNext(token,app.nextRetryAt-Date.now());return read();}
  clearTimer();
  let probe;try{probe=await pageMessage(app.tabId,{type:'PAGE_PROBE',config:app.config,runToken:token});}catch{await missingPage(app);return read();}
  let live=await read();if(!current(live,token))return live;
  if(!probe||!STAGES.has(probe.stage)||typeof probe.documentId!=='string'||!probe.documentId){await pauseRun(token,'无法识别官网页面状态，请确认页面后继续。');return read();}
  live=await update(a=>{if(current(a,token)){a.scans++;a.lastScanAt=Date.now();a.stage=probe.stage;a.order.stage=probe.stage;a.error='';a.nextRetryAt=0;}});if(!current(live,token))return live;
  if(probe.stage==='awaitingPayment'){await complete(token);return read();}
  if(probe.requiresHuman||['blocked','unknown'].includes(probe.stage)){await pauseRun(token,probe.reason||'请在官网处理登录、验证码、短信验证或条款确认，再继续。',{error:false});return read();}
  if(probe.stage==='processing'){await update(a=>{if(current(a,token))a.order.message='官网正在处理订单结果，仅等待确认，不会再次提交。';});await scheduleNext(token,app.config.retrySeconds*1000);return read();}
  if(!hasProgress(live,probe)){
    if(live.order.uncertain||Date.now()-(live.order.lastAction?.at||0)>=60000)await pauseRun(token,'上次按钮尚未确认进入下一阶段。请核对官网后继续，不会自动再次点击。',{uncertain:live.order.uncertain,error:false});
    else await scheduleNext(token,500);return read();
  }
  if(live.order.lastAction&&['dispatching','confirmed','uncertain'].includes(live.order.lastAction.status))live=await update(a=>{if(current(a,token)){a.order.awaitedStage=null;a.order.uncertain=false;a.order.lastAction.status='advanced';}});
  if(!probe.ready||!probe.action){if(probe.safeToReload===true&&await refreshEntry(live,probe))return read();await update(a=>{if(current(a,token))a.order.message=brief(probe.reason)||'等待当前页面出现可用的继续按钮。';});await scheduleNext(token,app.config.retrySeconds*1000);return read();}
  await dispatch(live,probe);return read();
}
function tick(reason='timer',token){
  if(tickPromise){queuedTick=true;return tickPromise;}
  let failedToken=null;
  tickPromise=read().then(app=>{failedToken=token||app.order.token;return doTick(reason,failedToken);}).catch(async()=>{if(failedToken)await pauseRun(failedToken,'页面自动流程遇到错误，已暂停。请检查官网后继续。');return read();}).finally(()=>{tickPromise=null;if(queuedTick){queuedTick=false;void tick('queued');}});return tickPromise;
}
async function dedicatedTab(app){if(Number.isInteger(app.tabId)){try{const tab=await chrome.tabs.get(app.tabId);await chrome.tabs.update(tab.id,{active:true});return tab;}catch{if(app.order.cartMutated||app.order.uncertain)throw new Error('原执行标签已关闭。请先核对购物袋和订单，不能自动重开流程。');}}return chrome.tabs.create({url:app.config.productUrl,active:true});}
function start(){
  if(startPromise)return startPromise;
  startPromise=(async()=>{const before=await read();if(before.running)return before;if(before.order.status==='awaitingPayment')throw new Error('订单流程已结束，请自行核对和付款。');
    const tab=await dedicatedTab(before),token=crypto.randomUUID();let enabled=false;
    const app=await update(a=>{a.tabId=tab.id;if(a.generation!==before.generation)return;enabled=true;a.running=true;a.generation++;a.error='';a.notice='';a.nextRetryAt=0;
      a.order={...a.order,status:'waiting',token,entryUrl:a.order.entryUrl||a.config.productUrl,message:a.order.lastAction?'继续检查当前阶段，不会重放已点击的动作。':'等待官网页面上的购买入口。'};});
    if(enabled){await reconcileAlarm();void tick(before.order.lastAction?'resume':'start',token);}return app;
  })().finally(()=>{startPromise=null;});return startPromise;
}
async function handle(message,sender){
  if(!message||typeof message!=='object')throw new Error('无效消息。');
  if(isContent(sender)){
    if(message.type==='GET_RECORDING')return {enabled:false};
    if(['PAGE_TICK','CHECKOUT_READY'].includes(message.type)){const app=await read();if(app.running&&app.tabId===sender.tab.id&&(message.type==='CHECKOUT_READY'||message.runToken===app.order.token))void tick(message.type==='CHECKOUT_READY'?'navigation':'timer',app.order.token);return {accepted:true};}
    throw new Error('此操作须从插件面板发起。');
  }
  if(!isPanel(sender))throw new Error('不受支持的消息来源。');
  switch(message.type){
    case 'GET_STATE':return read();
    case 'SAVE_CONFIG':{const config=normalizeConfig(message.config);await stop('已暂停，准备更新设置。');return update(a=>{const targetChanged=a.config.partNumber!==config.partNumber||a.config.productUrl!==config.productUrl;if(targetChanged&&(a.order.cartMutated||a.order.uncertain))throw new Error('此流程已有购物袋或结果不确定的动作，不能直接改换商品。请先在官网核对当前订单。');if(targetChanged){a.tabId=null;a.order=initial().order;a.stage='idle';a.scans=0;a.clicks=0;a.refreshes=0;a.errors=0;a.lastScanAt=0;a.nextRetryAt=0;}a.config=config;a.configRevision++;a.error='';a.notice='设置仅保存在本机。';a.order.message=targetChanged?'目标已切换；点击开始后打开新商品页。':'设置已保存；可继续当前阶段。';});}
    case 'START':case 'RESUME':return start();
    case 'STOP':case 'CANCEL_ORDER':return stop();
    case 'CHECK_NOW':{const app=await read();return app.running?tick('manual',app.order.token):app;}
    case 'TEST_NOTIFICATION':await notify('shike-test','拾刻 · 提醒测试','需要人工处理或订单流程结束时会这样提醒。');return read();
    case 'OPEN_PRODUCT':{const app=await read(),tab=await dedicatedTab(app);return update(a=>{a.tabId=tab.id;});}
    case 'OPEN_BAG':{const app=await read();if(app.running)throw new Error('请先暂停当前流程。');if(Number.isInteger(app.tabId))await chrome.tabs.update(app.tabId,{url:'https://www.apple.com.cn/shop/bag',active:true});else{const tab=await chrome.tabs.create({url:'https://www.apple.com.cn/shop/bag',active:true});await update(a=>{a.tabId=tab.id;});}return read();}
    case 'RESET':return update(a=>{if(a.running)throw new Error('请先暂停当前流程。');const completed=a.order.status==='awaitingPayment'&&a.order.stage==='awaitingPayment'&&!a.order.uncertain;if(!completed&&(a.order.cartMutated||a.order.uncertain))throw new Error('当前流程已有购物袋或订单动作，不能自动清空重放；请在官网核对后继续原流程。');a.order=initial().order;a.tabId=null;a.stage='idle';a.error='';a.notice='已建立新任务。原网页、购物袋和订单未改变。';a.scans=0;a.clicks=0;a.refreshes=0;a.errors=0;a.nextRetryAt=0;a.generation++;});
    default:throw new Error('未知操作。');
  }
}
chrome.runtime.onMessage.addListener((message,sender,sendResponse)=>{handle(message,sender).then(state=>sendResponse({ok:true,state}),error=>sendResponse({ok:false,error:brief(error.message)}));return true;});
chrome.alarms.onAlarm.addListener(alarm=>{if(alarm.name===ALARM)void tick('recovery');});
chrome.tabs.onUpdated.addListener((id,change)=>{if(change.status==='complete')void read().then(app=>{if(app.running&&app.tabId===id)void tick('navigation',app.order.token);});});
chrome.tabs.onRemoved.addListener(id=>{void read().then(app=>{if(app.tabId===id&&app.running)void pauseRun(app.order.token,'执行标签已关闭。请先检查购物袋或订单，不会自动新建并重放。',{uncertain:app.order.uncertain,error:false});});});
chrome.notifications.onClicked.addListener(()=>{void read().then(app=>{if(Number.isInteger(app.tabId))void chrome.tabs.update(app.tabId,{active:true}).catch(()=>{});});});
async function initialize(){const app=await update(a=>{if(a.order.lastAction?.status==='dispatching'){a.running=false;a.order.status='paused';a.order.uncertain=true;a.order.lastAction.status='uncertain';a.nextRetryAt=0;a.order.message='后台重启，按钮执行结果不确定。请核对官网后继续，不会自动重复点击。';}});await reconcileAlarm();if(app.running)void tick('recovery',app.order.token);}
chrome.runtime.onStartup.addListener(()=>{void initialize();});
chrome.runtime.onInstalled.addListener(()=>{void initialize();});
void initialize();
