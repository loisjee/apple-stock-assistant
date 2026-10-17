import test from 'node:test';
import assert from 'node:assert/strict';
import {installPickupMonitor,normalizePickupConfig,DEFAULT_PICKUP_CONFIG} from '../pickup-monitor.mjs';

const clone=value=>structuredClone(value),KEY='pickupMonitorState';
const config={...DEFAULT_PICKUP_CONFIG,address:'成都市锦江区'};
const entry=config.productUrl;
const store=(availability='available',id='R001')=>({id,name:`Apple 门店 ${id}`,address:'示例路 1 号',distanceText:'约 2 公里',availability,availabilityText:availability==='available'?'今天可取货':'暂无库存',pickupText:'官网自提状态'});
const result=availability=>({ok:true,stage:'results',stores:[store(availability)]});
const deferred=()=>{let resolve,reject;const promise=new Promise((done,fail)=>{resolve=done;reject=fail;});return {promise,resolve,reject};};
async function worker({saved,probe,loading=false,tabUrl=entry,createdTabUrl,create,onSet,notification}={}){
  let state=saved?clone(saved):undefined;
  const tabs=new Map(),alarms=new Map(),events={},calls={created:[],checks:[],cancelled:[],reloads:[],updates:[],notifications:[]};
  if(saved?.tabId)tabs.set(saved.tabId,{id:saved.tabId,url:tabUrl,status:loading?'loading':'complete'});
  const event=name=>({addListener(fn){(events[name]??=[]).push(fn);}});
  const chrome={
    runtime:{id:'fixture-extension',getURL:path=>`chrome-extension://fixture-extension/${path}`,onMessage:event('message'),onStartup:event('startup'),onInstalled:event('installed')},
    storage:{local:{async get(key){assert.equal(key,KEY);return {[KEY]:state?clone(state):undefined};},async set(value){assert.deepEqual(Object.keys(value),[KEY]);state=clone(value[KEY]);onSet?.(clone(state));}}},
    alarms:{async get(name){return alarms.get(name);},async create(name,value){alarms.set(name,clone(value));},async clear(name){return alarms.delete(name);},onAlarm:event('alarm')},
    notifications:{async create(id,value){calls.notifications.push({id,...clone(value)});return notification?.(id,value);},onClicked:event('notification')},
    tabs:{async get(id){if(!tabs.has(id))throw new Error('missing tab');return clone(tabs.get(id));},
      async create(value){calls.created.push(clone(value));if(create)await create();const id=tabs.size?Math.max(...tabs.keys())+1:9;const tab={id,url:createdTabUrl??value.url,status:loading?'loading':'complete',...(createdTabUrl!==undefined?{pendingUrl:value.url}:{})};tabs.set(id,tab);return clone(tab);},
      async update(id,value){calls.updates.push({id,...clone(value)});if(!tabs.has(id))throw new Error('missing tab');Object.assign(tabs.get(id),value);return clone(tabs.get(id));},
      async reload(id){calls.reloads.push(id);},onUpdated:event('tabUpdated'),onRemoved:event('tabRemoved'),
      async sendMessage(id,message,options){assert.deepEqual(options,{frameId:0});if(message.type==='PICKUP_PAGE_CANCEL'){calls.cancelled.push({id,...clone(message)});return {ok:true};}assert.equal(message.type,'PICKUP_PAGE_CHECK');calls.checks.push({id,...clone(message)});return probe?probe(message,calls):result('unavailable');}},
  };
  const flush=async(count=12)=>{for(let i=0;i<count;i++)await new Promise(setImmediate);};
  const installed=installPickupMonitor(chrome);await installed.ready;await flush();
  const send=(message,sender={id:chrome.runtime.id,url:chrome.runtime.getURL('monitor.html')})=>new Promise(resolve=>{const accepted=events.message[0](message,sender,resolve);if(accepted===false)resolve(undefined);});
  return {send,flush,calls,events,tabs,alarms,snapshot:()=>clone(state),async config(extra={}){return send({type:'PICKUP_SAVE_CONFIG',config:{...config,...extra}});},async check(){await send({type:'PICKUP_CHECK_NOW'});await flush();}};
}

test('pickup settings restrict polling, stores, target URL and local location',()=>{
  assert.deepEqual(normalizePickupConfig(),DEFAULT_PICKUP_CONFIG);
  for(const intervalSeconds of [0,29,3601,30.5,'abc'])assert.throws(()=>normalizePickupConfig({...config,intervalSeconds}));
  for(const maxStores of [0,21,1.5])assert.throws(()=>normalizePickupConfig({...config,maxStores}));
  for(const productUrl of ['https://example.com/shop/product/MK2T4CH/A','https://www.apple.com.cn/shop/bag','https://secure6.www.apple.com.cn/shop/checkout'])assert.throws(()=>normalizePickupConfig({...config,productUrl}));
  assert.throws(()=>normalizePickupConfig({...config,address:'a'.repeat(251)}));
  assert.throws(()=>normalizePickupConfig({...config,notifyEnabled:'true'}));
  assert.equal(normalizePickupConfig({...config,productUrl:`${entry}?token=private#anything`}).productUrl,entry);
});

test('idle monitor does not open a tab; only extension panel messages can start it',async()=>{
  const w=await worker();assert.equal(w.calls.created.length,0);assert.equal(w.snapshot().running,false);
  assert.equal(await w.send({type:'GET_STATE'}),undefined,'purchase messages belong to the existing worker');
  assert.equal(await w.send({type:'PICKUP_PAGE_CHECK'}),undefined,'content messages cannot invoke monitor RPC');
  for(const sender of [{id:'other-extension',url:'chrome-extension://fixture-extension/monitor.html'},{id:'fixture-extension',url:entry,tab:{id:9}},{id:'fixture-extension',url:'chrome-extension://fixture-extension/untrusted.html'}]){
    const response=await w.send({type:'PICKUP_START'},sender);assert.equal(response.ok,false);
  }
  assert.equal(w.calls.created.length,0);assert.equal((await w.send({type:'PICKUP_START'})).ok,false,'empty address requires configuration');
});

test('monitor creates an inactive dedicated product tab and never sends purchase actions',async()=>{
  const w=await worker();await w.config({intervalSeconds:90});await w.send({type:'PICKUP_START'});await w.flush();
  assert.deepEqual(w.calls.created,[{url:entry,active:false}]);assert.equal(w.calls.checks.length,1);
  assert.equal(w.snapshot().status,'watching');assert.equal(w.snapshot().running,true);assert.equal(w.snapshot().stores[0].availability,'unavailable');
  assert.ok(w.snapshot().nextCheckAt-Date.now()>85000);assert.equal(w.alarms.size,1);
  assert.equal([...w.alarms.values()][0].periodInMinutes,0.5);
  await w.send({type:'PICKUP_STOP'});assert.equal(w.alarms.size,0);assert.equal(w.calls.cancelled.at(-1).runToken,w.snapshot().runToken);
});

test('a custom polling interval schedules the next exact deadline instead of rounding to alarm ticks',async()=>{
  const w=await worker();await w.config({intervalSeconds:45});await w.send({type:'PICKUP_START'});await w.flush();
  assert.equal([...w.alarms.values()][0].when,w.snapshot().nextCheckAt);
  assert.ok(w.snapshot().nextCheckAt-Date.now()>40000);await w.send({type:'PICKUP_STOP'});
});

test('loading tab is read once when ready and unrelated tab updates are ignored',async()=>{
  const w=await worker({loading:true});await w.config();await w.send({type:'PICKUP_START'});await w.flush();assert.equal(w.calls.checks.length,0);
  w.events.tabUpdated[0](123,{status:'complete'});await w.flush();assert.equal(w.calls.checks.length,0);
  w.tabs.get(9).status='complete';w.events.tabUpdated[0](9,{status:'complete'});w.events.tabUpdated[0](9,{status:'complete'});await w.flush();
  assert.equal(w.calls.checks.length,1);w.events.tabUpdated[0](9,{status:'complete'});await w.flush();assert.equal(w.calls.checks.length,1,'navigation cannot bypass interval');
  w.events.alarm[0]({name:'pickup-monitor-recovery'});await w.flush();assert.equal(w.calls.checks.length,1,'early recovery alarm cannot bypass interval');
  await w.send({type:'PICKUP_STOP'});
});

for(const createdTabUrl of ['','about:blank']){
  test(`a new loading tab with ${JSON.stringify(createdTabUrl)} waits for its pending product navigation before URL validation`,async()=>{
    const w=await worker({loading:true,createdTabUrl});await w.config();await w.send({type:'PICKUP_CHECK_NOW'});await w.flush();
    assert.equal(w.tabs.get(9).pendingUrl,entry);assert.equal(w.snapshot().running,true);assert.equal(w.snapshot().waitingForLoad,true);assert.equal(w.snapshot().status,'checking');assert.equal(w.calls.checks.length,0);assert.equal(w.calls.reloads.length,0);
    Object.assign(w.tabs.get(9),{url:entry,status:'complete'});delete w.tabs.get(9).pendingUrl;w.events.tabUpdated[0](9,{status:'complete'});await w.flush();
    assert.equal(w.calls.checks.length,1);assert.equal(w.snapshot().checks,1);assert.equal(w.snapshot().running,false,'a single manual check finishes after the real product page loads');assert.equal(w.snapshot().status,'watching');
  });
}

test('availability notifications are de-duped through failures and unknown results; proven unavailable re-arms',async()=>{
  let mode='available';const w=await worker({probe:()=>{if(mode==='error')throw new Error('offline');return result(mode);}});await w.config();
  await w.check();assert.equal(w.calls.notifications.length,1);assert.equal(w.snapshot().running,false);
  await w.check();assert.equal(w.calls.notifications.length,1);
  mode='error';await w.check();assert.equal(w.snapshot().stale,true);assert.equal(w.snapshot().stores[0].availability,'available');assert.match(w.snapshot().error,/offline/);
  mode='unknown';await w.check();mode='available';await w.check();assert.equal(w.calls.notifications.length,1,'unknown/error does not re-arm');
  mode='unavailable';await w.check();mode='available';await w.check();assert.equal(w.calls.notifications.length,2,'proven unavailable then available re-arms');
  await w.config({address:'上海市黄浦区'});await w.check();assert.equal(w.calls.notifications.length,3,'a different search location has its own transition');
});

test('disabled notifications still retain transition history, so toggling reminders does not announce old stock',async()=>{
  const w=await worker({probe:()=>result('available')});await w.config({notifyEnabled:false});await w.check();assert.equal(w.calls.notifications.length,0);
  await w.config({notifyEnabled:true});await w.check();assert.equal(w.calls.notifications.length,0);
  await w.send({type:'PICKUP_TEST_NOTIFICATION'});assert.equal(w.calls.notifications[0].id,'pickup-test');
});

test('a failed stock notification retains inventory and retries on the next successful check',async()=>{
  let first=true;const w=await worker({probe:()=>result('available'),notification:()=>{if(first){first=false;throw new Error('notifications disabled');}}});await w.config();
  await w.check();assert.equal(w.calls.notifications.length,1);assert.equal(w.snapshot().stores[0].availability,'available');assert.equal(w.snapshot().status,'available');assert.match(w.snapshot().notice,/通知未能显示/);assert.ok(Object.values(w.snapshot().lastNotified).every(value=>value===false));
  await w.check();assert.equal(w.calls.notifications.length,2);assert.ok(Object.values(w.snapshot().lastNotified).every(value=>value===true));
  await w.check();assert.equal(w.calls.notifications.length,2,'a successful retry then de-duplicates continuing stock');
});

test('the test-notification RPC reports a system notification failure instead of claiming success',async()=>{
  const w=await worker({notification:()=>{throw new Error('notification permission denied');}});
  const response=await w.send({type:'PICKUP_TEST_NOTIFICATION'});assert.equal(response.ok,false);assert.match(response.error,/无法显示系统通知/);assert.equal(w.snapshot().running,false);assert.equal(w.calls.notifications.length,1);
});

test('stop cancels pending page work and prevents late results, notifications, or stores from being published',async()=>{
  const pending=deferred();const w=await worker({probe:()=>pending.promise});await w.config();await w.send({type:'PICKUP_START'});await w.flush();
  assert.equal(w.calls.checks.length,1);await w.send({type:'PICKUP_STOP'});pending.resolve(result('available'));await w.flush();
  assert.equal(w.snapshot().running,false);assert.equal(w.snapshot().checks,0);assert.equal(w.snapshot().stores.length,0);assert.equal(w.calls.notifications.length,0);assert.equal(w.alarms.size,0);
  assert.equal(w.calls.cancelled.at(-1).runToken,w.calls.checks[0].runToken);
});

test('a stop queued when availability is persisted prevents a subsequent notification',async()=>{
  let stopWhenAvailable;
  const w=await worker({probe:()=>result('available'),onSet:state=>{if(state.status==='available')stopWhenAvailable?.();}});await w.config();
  stopWhenAvailable=()=>{stopWhenAvailable=null;void w.send({type:'PICKUP_STOP'});};
  await w.send({type:'PICKUP_START'});await w.flush();assert.equal(w.snapshot().running,false);assert.equal(w.snapshot().status,'paused');assert.equal(w.calls.notifications.length,0);
});

test('a new run can progress while a cancelled previous page request is still pending',async()=>{
  const pending=deferred();let first=true;const w=await worker({probe:()=>{if(first){first=false;return pending.promise;}return result('unavailable');}});await w.config();await w.send({type:'PICKUP_START'});await w.flush();await w.send({type:'PICKUP_STOP'});
  await w.send({type:'PICKUP_START'});await w.flush();assert.equal(w.snapshot().checks,1);assert.equal(w.snapshot().status,'watching');
  pending.resolve(result('available'));await w.flush();assert.equal(w.snapshot().checks,1);assert.equal(w.snapshot().stores[0].availability,'unavailable');assert.equal(w.calls.notifications.length,0);await w.send({type:'PICKUP_STOP'});
});

test('saving a different target cancels the old check and keeps its late stock out of the new search',async()=>{
  const pending=deferred();const w=await worker({probe:()=>pending.promise});await w.config();await w.send({type:'PICKUP_START'});await w.flush();
  await w.config({address:'北京市朝阳区'});pending.resolve(result('available'));await w.flush();
  assert.equal(w.snapshot().config.address,'北京市朝阳区');assert.equal(w.snapshot().running,false);assert.equal(w.snapshot().tabId,null);assert.equal(w.snapshot().stores.length,0);assert.equal(w.calls.notifications.length,0);
  assert.equal(w.calls.cancelled.at(-1).runToken,w.calls.checks[0].runToken);
});

test('stopping during tab creation does not start a new monitor after creation resolves',async()=>{
  const pending=deferred();const w=await worker({create:()=>pending.promise});await w.config();const start=w.send({type:'PICKUP_START'});await w.flush();await w.send({type:'PICKUP_STOP'});pending.resolve();await start;await w.flush();
  assert.equal(w.snapshot().running,false);assert.equal(w.calls.checks.length,0);assert.equal(w.alarms.size,0);
});

test('human gate pauses monitoring and checkout navigation is never refreshed or acted upon',async()=>{
  const w=await worker({probe:()=>({ok:false,stage:'blocked',stores:[],requiresHuman:true,reason:'请在官网完成安全验证'})});await w.config();await w.send({type:'PICKUP_START'});await w.flush();
  assert.equal(w.snapshot().status,'paused');assert.equal(w.snapshot().running,false);assert.match(w.snapshot().notice,/安全验证/);assert.equal(w.calls.reloads.length,0);
  w.tabs.get(9).url='https://secure6.www.apple.com.cn/shop/checkout';await w.send({type:'PICKUP_START'});await w.flush();
  assert.equal(w.calls.created.length,2,'a different product tab is created; checkout is untouched');assert.equal(w.calls.reloads.length,0);await w.send({type:'PICKUP_STOP'});
});

test('read failures retain last good stores and refresh only a safe dedicated product page',async()=>{
  let fail=false;const w=await worker({probe:()=>{if(fail)throw new Error('no receiving end');return result('available');}});await w.config();await w.send({type:'PICKUP_START'});await w.flush();
  fail=true;await w.send({type:'PICKUP_CHECK_NOW'});await w.flush();assert.equal(w.calls.reloads.length,1);assert.equal(w.snapshot().stale,true);assert.equal(w.snapshot().stores[0].availability,'available');
  w.tabs.get(9).url='https://secure6.www.apple.com.cn/shop/checkout';await w.send({type:'PICKUP_CHECK_NOW'});await w.flush();assert.equal(w.calls.reloads.length,1);assert.equal(w.snapshot().running,false);assert.equal(w.snapshot().status,'paused');
});

test('saved running state resumes after a service-worker restart without re-announcing known stock',async()=>{
  const source=await worker({probe:()=>result('available')});await source.config();await source.send({type:'PICKUP_START'});await source.flush();const saved=source.snapshot();await source.send({type:'PICKUP_STOP'});
  const w=await worker({saved,probe:()=>result('available')});assert.equal(w.snapshot().running,true);assert.equal(w.calls.created.length,0);assert.equal(w.calls.checks.length,1);assert.equal(w.calls.notifications.length,0);
  assert.equal(w.snapshot().checks,saved.checks+1);await w.send({type:'PICKUP_STOP'});
});

test('only pickup notifications focus the dedicated monitor tab and closing it pauses recovery',async()=>{
  const w=await worker();await w.config();await w.send({type:'PICKUP_START'});await w.flush();w.events.notification[0]('shike-order');await w.flush();assert.equal(w.calls.updates.length,0);
  w.events.notification[0]('pickup-available');await w.flush();assert.deepEqual(w.calls.updates,[{id:9,active:true}]);
  w.events.tabRemoved[0](123);await w.flush();assert.equal(w.snapshot().running,true);w.events.tabRemoved[0](9);await w.flush();assert.equal(w.snapshot().running,false);assert.equal(w.alarms.size,0);
});
