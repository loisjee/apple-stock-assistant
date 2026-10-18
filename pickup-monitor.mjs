import {restoreStockHistory, recordStockHistory} from './stock-history.mjs';
import {isSafeEntryUrl, normalizeConfig} from './core.mjs';

// This monitor reads the public pickup dialog through a dedicated product tab.
// It never uses checkout controls, stock endpoints, cookies, or cart messages.
export const DEFAULT_PICKUP_CONFIG = Object.freeze({
  partNumber: 'MK2T4CH/A', productUrl: 'https://www.apple.com.cn/shop/product/MK2T4CH/A',
  productName: 'iPhone Duo 1TB 星光白色', address: '', intervalSeconds: 60,
  maxStores: 10, notifyEnabled: true,
});
const KEY='pickupMonitorState', ALARM='pickup-monitor-recovery';
const brief=value=>String(value||'').slice(0,500);
function textSetting(raw,fallback,limit,label){
  if(raw===undefined)raw=fallback;
  if(typeof raw!=='string'||/[\u0000-\u001f\u007f]/.test(raw))throw new Error(`${label}格式不正确。`);
  const value=raw.replace(/\s+/g,' ').trim();
  if(value.length>limit)throw new Error(`${label}最多填写 ${limit} 个字符。`);
  return value;
}
function integerSetting(raw,fallback,min,max,label){const value=raw===undefined||raw===''?fallback:Number(raw);if(!Number.isInteger(value)||value<min||value>max)throw new Error(`${label}须为 ${min} 至 ${max} 的整数。`);return value;}
export function normalizePickupConfig(input={}){
  if(!input||typeof input!=='object'||Array.isArray(input))throw new Error('监控设置格式不正确。');
  const base=normalizeConfig({partNumber:input.partNumber??DEFAULT_PICKUP_CONFIG.partNumber,productUrl:input.productUrl});
  if(input.notifyEnabled!==undefined&&typeof input.notifyEnabled!=='boolean')throw new Error('到货提醒须为开启或关闭。');
  return {partNumber:base.partNumber,productUrl:base.productUrl,
    productName:textSetting(input.productName,DEFAULT_PICKUP_CONFIG.productName,160,'商品配置'),
    address:textSetting(input.address,'',250,'当前位置'),
    intervalSeconds:integerSetting(input.intervalSeconds,60,30,3600,'检查间隔（秒）'),
    maxStores:integerSetting(input.maxStores,10,1,20,'展示门店数'),notifyEnabled:input.notifyEnabled!==false};
}
function initial(){return {schemaVersion:1,config:normalizePickupConfig(DEFAULT_PICKUP_CONFIG),running:false,status:'idle',notice:'输入商品配置与当前位置，检查附近门店的自提库存。',error:'',checks:0,lastCheckAt:0,nextCheckAt:0,tabId:null,stores:[],stockHistory:restoreStockHistory(),lastNotified:{},stale:false,generation:0,runToken:'',waitingForLoad:false,singleCheck:false};}
function restore(raw){
  const value=initial();if(raw?.schemaVersion!==1)return value;
  try{return {...value,...raw,config:normalizePickupConfig(raw.config),stockHistory:restoreStockHistory(raw.stockHistory),stores:Array.isArray(raw.stores)?raw.stores:[],lastNotified:raw.lastNotified&&typeof raw.lastNotified==='object'&&!Array.isArray(raw.lastNotified)?raw.lastNotified:{}};}catch{return {...value,error:'已存储的监控设置无效，请重新保存。',status:'error'};}
}
function cleanStores(values,maxStores){
  if(!Array.isArray(values))throw new Error('门店结果格式不正确。');
  const seen=new Set(),stores=[];
  for(const raw of values){
    if(!raw||typeof raw!=='object'||!['available','unavailable','unknown'].includes(raw.availability))continue;
    const name=brief(raw.name).trim();if(!name)continue;
    const id=brief(raw.id||`${name}|${raw.address||''}`).trim();if(seen.has(id))continue;seen.add(id);
    stores.push({id,name,address:brief(raw.address),distanceText:brief(raw.distanceText),availability:raw.availability,availabilityText:brief(raw.availabilityText),pickupText:brief(raw.pickupText)});
    if(stores.length>=maxStores)break;
  }
  return stores;
}

export function installPickupMonitor(chrome){
  let mutation=Promise.resolve(),alarmMutation=Promise.resolve(),startPromise=null;
  const inFlight=new Map();
  const update=fn=>{const job=mutation.then(async()=>{const stored=await chrome.storage.local.get(KEY),state=restore(stored[KEY]);await fn(state);await chrome.storage.local.set({[KEY]:state});return state;});mutation=job.catch(()=>{});return job;};
  const read=async()=>{await mutation;const stored=await chrome.storage.local.get(KEY);return restore(stored[KEY]);};
  const current=(state,token)=>state.running&&state.runToken===token;
  const trusted=sender=>{if(sender.id!==chrome.runtime.id)return false;try{const actual=new URL(sender.url),expected=new URL(chrome.runtime.getURL('monitor.html'));return actual.protocol===expected.protocol&&actual.hostname===expected.hostname&&['/monitor.html','/panel.html'].includes(actual.pathname);}catch{return false;}};
  const reconcile=()=>{const job=alarmMutation.then(async()=>{const state=await read();if(!state.running)return chrome.alarms.clear(ALARM);await chrome.alarms.create(ALARM,{when:Math.max(Date.now()+30000,state.nextCheckAt||0),periodInMinutes:0.5});});alarmMutation=job.catch(()=>{});return job;};
  const cancelPage=async(tabId,runToken)=>{if(Number.isInteger(tabId))try{await chrome.tabs.sendMessage(tabId,{type:'PICKUP_PAGE_CANCEL',runToken},{frameId:0});}catch{}};
  async function stop(message='库存监控已暂停。'){
    const state=await update(s=>{s.running=false;s.status='paused';s.notice=message;s.nextCheckAt=0;s.waitingForLoad=false;s.singleCheck=false;s.generation++;});
    await reconcile();await cancelPage(state.tabId,state.runToken);return state;
  }
  async function notify(id,title,message){try{await chrome.notifications.create(id,{type:'basic',iconUrl:chrome.runtime.getURL('icons/icon128.png'),title,message:brief(message)});return true;}catch{return false;}}
  async function pause(token,message){let changed=false;const state=await update(s=>{if(!current(s,token))return;changed=true;s.running=false;s.status='paused';s.error='';s.notice=brief(message);s.nextCheckAt=0;s.waitingForLoad=false;s.singleCheck=false;s.stale=s.stores.length>0;});if(changed){await reconcile();await cancelPage(state.tabId,token);}return state;}
  async function finishFailure(token,message,{reload=false}={}){
    let changed=false;const state=await update(s=>{if(!current(s,token))return;changed=true;s.status='error';s.error=brief(message);s.notice=s.stores.length?'本次未取得有效结果，以下保留上次门店记录。':'本次未取得有效结果，将按间隔继续检查。';s.stale=true;s.lastCheckAt=Date.now();s.checks++;s.waitingForLoad=false;s.nextCheckAt=s.singleCheck?0:Date.now()+s.config.intervalSeconds*1000;if(s.singleCheck){s.running=false;s.singleCheck=false;}});
    if(!changed)return state;
    if(reload&&current(state,token)){
      await cancelPage(state.tabId,token);
      try{const tab=await chrome.tabs.get(state.tabId),live=await read();if(!current(live,token))return live;if(isSafeEntryUrl(tab.url))await chrome.tabs.reload(state.tabId);else if(/^chrome-error:\/\//.test(tab.url||''))await chrome.tabs.update(state.tabId,{url:state.config.productUrl,active:false});}catch{}
    }
    await reconcile();return read();
  }
  async function doCheck(token,force=false){
    let state=await read();if(!current(state,token))return state;
    if(!force&&state.nextCheckAt>Date.now())return state;
    let tab;try{tab=await chrome.tabs.get(state.tabId);}catch{return pause(token,'监控标签页已关闭。点击开始可重新打开商品页。');}
    // A newly created tab can still expose an empty/about:blank URL while its
    // approved product navigation is pending. Wait for commit before validating.
    if(tab.status==='loading'){
      await update(s=>{if(current(s,token)){s.status='checking';s.notice='商品页正在加载，等待官网完成后读取库存。';s.waitingForLoad=true;s.nextCheckAt=Date.now()+30000;}});await reconcile();return read();
    }
    if(!isSafeEntryUrl(tab.url)){
      if(/^chrome-error:\/\//.test(tab.url||''))return finishFailure(token,'商品入口暂时无法打开，正在等待官网恢复。',{reload:true});
      return pause(token,'监控标签页已离开商品页。请重新打开目标商品；不会进入购物袋或结账。');
    }
    await update(s=>{if(current(s,token)){s.status='checking';s.notice='正在读取官网附近门店的自提库存。';s.error='';s.nextCheckAt=0;s.waitingForLoad=false;}});
    if(!current(await read(),token))return read();
    let result,timer;
    try{result=await Promise.race([chrome.tabs.sendMessage(state.tabId,{type:'PICKUP_PAGE_CHECK',config:state.config,runToken:token},{frameId:0}),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('官网门店检查超时。')),25000);})]);}
    catch(error){if(timer)clearTimeout(timer);return finishFailure(token,error.message||'暂时无法读取商品页面，将稍后刷新重试。',{reload:true});}
    finally{if(timer)clearTimeout(timer);}
    state=await read();if(!current(state,token))return state;
    if(result?.requiresHuman)return pause(token,result.reason||'官网需要人工处理定位、登录或安全验证。完成后重新开始监控。');
    if(result?.ok!==true||!Array.isArray(result.stores))return finishFailure(token,result?.reason||'官网未返回可识别的门店结果。',{reload:result?.retryable===true});
    const stores=cleanStores(result.stores,state.config.maxStores);
    if(!stores.length)return finishFailure(token,result.reason||'官网暂未展示附近门店，等待下次检查。',{reload:result.retryable===true});
    let newlyAvailable=[];
    const next=await update(s=>{
      if(!current(s,token))return;
      s.stores=stores;s.stale=false;s.error='';s.checks++;s.lastCheckAt=Date.now();s.stockHistory=recordStockHistory(s.stockHistory,s.config,stores,s.lastCheckAt);s.waitingForLoad=false;
      const available=stores.filter(store=>store.availability==='available');s.status=available.length?'available':'watching';
      s.notice=available.length?`官网显示 ${available.length} 家门店可自提；请打开官网核对并下单。`:'已检查附近门店，继续等待可自提库存。';
      for(const store of stores){const key=JSON.stringify([s.config.partNumber,s.config.address.toLowerCase(),store.id]);if(store.availability==='unavailable')s.lastNotified[key]=false;else if(store.availability==='available'){if(s.lastNotified[key]!==true)newlyAvailable.push(store);s.lastNotified[key]=true;}}
      s.nextCheckAt=s.singleCheck?0:Date.now()+s.config.intervalSeconds*1000;if(s.singleCheck){s.running=false;s.singleCheck=false;}
    });
    // Persist transition before notifying. Unknown/error results never re-arm an alert.
    const live=await read();
    if(live.generation===next.generation&&live.status!=='paused'&&next.runToken===token&&next.config.notifyEnabled&&newlyAvailable.length){
      const names=newlyAvailable.map(store=>store.name).join('、');
      const notified=await notify('pickup-available','附近门店可以自提',`${next.config.productName||next.config.partNumber}：${names}。库存可能变化，请到官网确认。`);
      if(!notified)await update(s=>{if(s.generation!==next.generation||s.runToken!==token)return;for(const store of newlyAvailable){const key=JSON.stringify([s.config.partNumber,s.config.address.toLowerCase(),store.id]);s.lastNotified[key]=false;}s.notice='已发现可自提库存，但系统通知未能显示。请检查通知权限；下次检查有货时会重试提醒。';});
    }
    await reconcile();return read();
  }
  function check(token,force=false){if(inFlight.has(token))return inFlight.get(token);const job=doCheck(token,force).catch(error=>finishFailure(token,error.message||'库存检查遇到错误。')).finally(()=>inFlight.delete(token));inFlight.set(token,job);return job;}
  async function ownTab(state,{active=false}={}){
    if(Number.isInteger(state.tabId)){try{const tab=await chrome.tabs.get(state.tabId);if(isSafeEntryUrl(tab.url)){if(active)await chrome.tabs.update(tab.id,{active:true});return tab;}}catch{}}
    return chrome.tabs.create({url:state.config.productUrl,active});
  }
  function start(singleCheck=false){
    if(startPromise)return startPromise;
    startPromise=(async()=>{
      const before=await read();if(!before.config.address)throw new Error('请先填写当前位置、城市或邮政编码。');
      if(before.running){if(singleCheck)void check(before.runToken,true);return before;}
      const tab=await ownTab(before),token=crypto.randomUUID();let enabled=false;
      const state=await update(s=>{if(s.generation!==before.generation)return;enabled=true;s.running=true;s.singleCheck=singleCheck;s.generation++;s.runToken=token;s.tabId=tab.id;s.status='checking';s.error='';s.notice='正在打开目标商品并检查附近门店。';s.waitingForLoad=tab.status==='loading';s.nextCheckAt=0;});
      if(enabled){await reconcile();void check(token,true);}return state;
    })().finally(()=>{startPromise=null;});return startPromise;
  }
  async function handle(message,sender){
    if(!trusted(sender))throw new Error('库存监控须从插件面板发起。');
    switch(message.type){
      case 'PICKUP_GET_STATE':return read();
      case 'PICKUP_SAVE_CONFIG':{
        const config=normalizePickupConfig(message.config);let previous;
        await update(s=>{previous={tabId:s.tabId,runToken:s.runToken};s.running=false;s.generation++;s.nextCheckAt=0;s.waitingForLoad=false;s.singleCheck=false;s.status='paused';const changed=s.config.partNumber!==config.partNumber||s.config.productUrl!==config.productUrl||s.config.address!==config.address;s.config=config;s.error='';s.notice='监控设置仅保存在本机。';if(changed){s.tabId=null;s.stores=[];s.stale=false;s.checks=0;s.lastCheckAt=0;s.status='idle';}});
        await reconcile();await cancelPage(previous.tabId,previous.runToken);return read();
      }
      case 'PICKUP_START':return start();
      case 'PICKUP_STOP':return stop();
      case 'PICKUP_CHECK_NOW':return start(true);
      case 'PICKUP_OPEN':{const before=await read(),tab=await ownTab(before,{active:true});return update(s=>{if(s.generation===before.generation)s.tabId=tab.id;});}
      case 'PICKUP_TEST_NOTIFICATION':if(!await notify('pickup-test','附近自提 · 提醒测试','附近门店首次出现可自提库存时会这样提醒。'))throw new Error('无法显示系统通知，请检查浏览器与系统的通知权限。');return read();
      default:throw new Error('未知库存监控操作。');
    }
  }
  chrome.runtime.onMessage.addListener((message,sender,sendResponse)=>{if(typeof message?.type!=='string'||!message.type.startsWith('PICKUP_')||message.type.startsWith('PICKUP_PAGE_'))return false;handle(message,sender).then(state=>sendResponse({ok:true,state}),error=>sendResponse({ok:false,error:brief(error.message)}));return true;});
  chrome.alarms.onAlarm.addListener(alarm=>{if(alarm.name===ALARM)void read().then(s=>{if(s.running)void check(s.runToken);});});
  chrome.tabs.onUpdated.addListener((id,change)=>{if(change.status==='complete')void read().then(s=>{if(s.running&&s.tabId===id)void check(s.runToken,s.waitingForLoad);});});
  chrome.tabs.onRemoved.addListener(id=>{void read().then(s=>{if(s.running&&s.tabId===id)void pause(s.runToken,'监控标签页已关闭。点击开始可重新打开商品页。');});});
  chrome.notifications.onClicked.addListener(id=>{if(!id.startsWith('pickup-'))return;void read().then(async s=>{if(Number.isInteger(s.tabId))try{await chrome.tabs.update(s.tabId,{active:true});}catch{}});});
  async function initialize(){const s=await update(state=>{if(state.running){state.status='watching';state.notice='后台已恢复，将继续检查附近门店。';state.waitingForLoad=true;state.nextCheckAt=Math.min(state.nextCheckAt||Date.now(),Date.now());}});await reconcile();if(s.running)void check(s.runToken,true);}
  chrome.runtime.onStartup.addListener(()=>{void initialize();});chrome.runtime.onInstalled.addListener(()=>{void initialize();});
  const ready=initialize();return {ready};
}
