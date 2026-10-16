import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';
import * as core from '../core.mjs';

const source=(await readFile(new URL('../background.mjs',import.meta.url),'utf8')).replace(/^import[^\n]+\n/,'');
const clone=value=>structuredClone(value);
const entry=core.DEFAULT_CONFIG.productUrl;
const deferred=()=>{let resolve,reject;const promise=new Promise((done,fail)=>{resolve=done;reject=fail;});return {resolve,reject,promise};};
const plan=(stage,action,extra={})=>({ok:true,documentId:'fixture-document',url:entry,stage,ready:Boolean(action),safeToReload:false,expectedNext:[],...(action?{action}:{}),...extra});
const stored=(extra={})=>({schemaVersion:2,config:core.normalizeConfig(core.DEFAULT_CONFIG),running:false,tabId:7,
  order:{status:'paused',token:'old-run',entryUrl:entry,cartMutated:false,uncertain:false,lastAction:null,awaitedStage:null},...extra});

async function worker({saved,probe,action,reload,scheduleAvailable=true,tabUrl=entry}={}){
  let app=saved?clone(saved):undefined,now=1900000000000,timerId=0;
  const events={},timers=new Map(),alarms=new Map(),tabs=new Map();
  if(saved?.tabId!==null&&Number.isInteger(saved?.tabId))tabs.set(saved.tabId,{id:saved.tabId,url:tabUrl});
  const calls={actions:[],probes:0,reloads:0,created:0,updates:0,cancelled:0,scheduled:[],fetch:0};
  const event=name=>({addListener(listener){(events[name]??=[]).push(listener);}});
  const flush=async(count=12)=>{for(let i=0;i<count;i++)await new Promise(setImmediate);};
  class ClockDate extends Date{constructor(...args){super(...(args.length?args:[now]));}static now(){return now;}}
  const chrome={
    runtime:{id:'fixture-extension',getURL:path=>`chrome-extension://fixture-extension/${path}`,onMessage:event('message'),onStartup:event('startup'),onInstalled:event('installed')},
    storage:{local:{async get(){return {app:app?clone(app):undefined};},async set(value){app=clone(value.app);}}},
    alarms:{async get(name){return alarms.get(name);},async create(name,value){alarms.set(name,clone(value));},async clear(name){return alarms.delete(name);},onAlarm:event('alarm')},
    notifications:{async create(){},onClicked:event('notification')},
    tabs:{async get(id){if(!tabs.has(id))throw new Error('missing tab');return clone(tabs.get(id));},
      async create(value){calls.created++;const id=tabs.size?Math.max(...tabs.keys())+1:7;const tab={id,url:value.url};tabs.set(id,tab);return clone(tab);},
      async update(id,value){calls.updates++;if(!tabs.has(id))throw new Error('missing tab');Object.assign(tabs.get(id),value);return clone(tabs.get(id));},
      async reload(){calls.reloads++;return reload?.();},onUpdated:event('tabUpdated'),onRemoved:event('tabRemoved'),
      async sendMessage(id,message){
        if(message.type==='PAGE_PROBE'){calls.probes++;return probe?probe(message,calls):plan('blocked',null,{requiresHuman:true,reason:'fixture requires user'});}
        if(message.type==='PAGE_ACTION'){calls.actions.push(clone(message));return action?action(message,calls):{ok:true,clicked:true,phase:'checkout'};}
        if(message.type==='PAGE_SCHEDULE'){calls.scheduled.push(clone(message));if(!scheduleAvailable)throw new Error('no content');return {ok:true};}
        if(message.type==='CANCEL_EXECUTION'){calls.cancelled++;return {ok:true,cancelled:true};}
        throw new Error('unexpected message');
      }},
  };
  const context=vm.createContext({chrome,...core,URL,AbortController,crypto:webcrypto,Date:ClockDate,console,
    setTimeout:(fn,delay)=>{const id=++timerId;timers.set(id,{fn,at:now+delay});return id;},clearTimeout:id=>timers.delete(id),
    fetch:()=>{calls.fetch++;throw new Error('network APIs forbidden');}});
  new vm.Script(source,{filename:'background.mjs'}).runInContext(context);
  const send=(message,sender={id:chrome.runtime.id,url:chrome.runtime.getURL('panel.html')})=>new Promise(resolve=>events.message[0](message,sender,resolve));
  const advance=async(ms)=>{now+=ms;for(const [id,timer] of [...timers])if(timer.at<=now){timers.delete(id);timer.fn();}await flush();};
  const pageTick=async(token=app.order.token)=>{await send({type:'PAGE_TICK',runToken:token,documentId:'fixture-document'},{id:chrome.runtime.id,url:entry,frameId:0,tab:{id:app.tabId}});await flush();};
  await flush();
  return {send,flush,advance,pageTick,calls,alarms,timers,tabs,events,snapshot:()=>clone(app)};
}

test('idle initialization does not open tabs or use request APIs; web pages cannot start it',async()=>{
  const w=await worker();
  assert.equal(w.snapshot().running,false);
  assert.equal(w.calls.created,0);assert.equal(w.calls.fetch,0);
  const response=await w.send({type:'START'},{id:'other-extension',url:entry,tab:{id:7}});
  assert.equal(response.ok,false);assert.equal(w.calls.created,0);
});

test('unavailable product refreshes respect interval and maximum, without any purchase click',async()=>{
  const w=await worker({probe:()=>plan('product',null,{safeToReload:true})});
  await w.send({type:'SAVE_CONFIG',config:{...core.DEFAULT_CONFIG,maxRefreshes:2}});
  await w.send({type:'START'});await w.flush();
  assert.equal(w.calls.reloads,1);assert.equal(w.calls.created,1);
  w.events.tabUpdated[0](7,{status:'complete'});await w.flush();
  assert.equal(w.calls.reloads,1,'page completion cannot bypass the retry interval');
  await w.advance(3000);await w.pageTick();assert.equal(w.calls.reloads,2);
  await w.advance(3000);await w.pageTick();
  assert.equal(w.snapshot().running,false);assert.match(w.snapshot().order.message,/刷新上限/);
  assert.equal(w.calls.actions.length,0);assert.equal(w.calls.fetch,0);assert.equal(w.alarms.size,0);
});

test('a failed entrance document without a content script may only reload its approved entry',async()=>{
  const w=await worker({saved:stored(),tabUrl:'chrome-error://chromewebdata/',scheduleAvailable:false});
  await w.send({type:'START'});await w.flush();
  assert.equal(w.calls.reloads,1);assert.equal(w.calls.actions.length,0);assert.equal(w.calls.fetch,0);
  assert.equal(w.timers.size,1);await w.send({type:'STOP'});assert.equal(w.timers.size,0);
});

test('checkout pages and any flow that mutated a bag are never refreshed',async()=>{
  for(const cartMutated of [false,true]){
    const w=await worker({saved:stored({order:{...stored().order,cartMutated}}),tabUrl:cartMutated?entry:'https://secure6.www.apple.com.cn/shop/checkout?_s=Review',
      probe:()=>plan(cartMutated?'product':'review',null,{safeToReload:true})});
    await w.send({type:'START'});await w.flush();await w.send({type:'CHECK_NOW'});
    assert.equal(w.calls.reloads,0);assert.equal(w.calls.actions.length,0);await w.send({type:'STOP'});
  }
});

for(const reason of ['验证码需要人工处理','短信验证需要人工处理','条款需要人工确认']){
  test(`human interruption pauses before clicking: ${reason}`,async()=>{
    const w=await worker({probe:()=>plan('blocked',null,{requiresHuman:true,reason})});
    await w.send({type:'START'});await w.flush();
    assert.equal(w.snapshot().running,false);assert.equal(w.calls.actions.length,0);assert.equal(w.calls.reloads,0);
    assert.equal(w.snapshot().order.message,reason);
  });
}

test('uncertain Add to Bag is not repeated on resume; proven next stage can continue in the same tab',async()=>{
  let stage='product';
  const w=await worker({probe:()=>stage==='product'?plan('product','addBag',{expectedNext:['attach','bag'],mutatesCart:true}):plan('attach','viewBag',{expectedNext:['bag']}),
    action:message=>{if(message.action==='addBag')throw new Error('port closed after click');return {ok:true,clicked:true,phase:'attach'};}});
  await w.send({type:'START'});await w.flush();assert.equal(w.snapshot().order.uncertain,true);
  await w.send({type:'RESUME'});await w.flush();assert.equal(w.calls.actions.length,1);assert.equal(w.calls.reloads,0);
  stage='attach';await w.send({type:'RESUME'});await w.flush();
  assert.deepEqual(w.calls.actions.map(a=>a.action),['addBag','viewBag']);assert.equal(w.calls.created,1);
  await w.send({type:'STOP'});
});

test('a confirmed click waiting on its old document is never replayed by another scan',async()=>{
  const w=await worker({probe:()=>plan('product','addBag',{expectedNext:['attach','bag'],mutatesCart:true})});
  await w.send({type:'START'});await w.flush();
  await w.send({type:'CHECK_NOW'});await w.advance(1000);await w.pageTick();
  assert.equal(w.calls.actions.length,1);assert.equal(w.calls.reloads,0);assert.equal(w.snapshot().clicks,1);
  await w.send({type:'STOP'});
});

test('uncertain submit never repeats; a proven order confirmation stops without payment',async()=>{
  let submitted=false;
  const w=await worker({probe:()=>submitted?plan('awaitingPayment'):plan('review','submitOrder',{expectedNext:['awaitingPayment']}),action:()=>{throw new Error('unknown submit outcome');}});
  await w.send({type:'SAVE_CONFIG',config:{...core.DEFAULT_CONFIG,maxTotal:20000,submitEnabled:true}});
  await w.send({type:'START'});await w.flush();await w.send({type:'RESUME'});await w.flush();
  assert.equal(w.calls.actions.length,1);assert.equal(w.calls.reloads,0);
  submitted=true;await w.send({type:'RESUME'});await w.flush();
  assert.equal(w.snapshot().order.status,'awaitingPayment');assert.equal(w.snapshot().running,false);
  assert.equal(w.calls.actions.length,1);
});

test('stop during a pending probe prevents any click, stale timer, or late state publication',async()=>{
  const pending=deferred();let first=true;
  const w=await worker({probe:()=>{if(first){first=false;return pending.promise;}return plan('blocked',null,{requiresHuman:true});}});
  await w.send({type:'START'});await w.flush();const oldToken=w.snapshot().order.token;
  await w.send({type:'STOP'});pending.resolve(plan('product','addBag',{mutatesCart:true}));await w.flush();
  assert.equal(w.calls.actions.length,0);assert.equal(w.snapshot().scans,0);assert.equal(w.snapshot().running,false);
  await w.send({type:'RESUME'});await w.flush();const scans=w.snapshot().scans;
  await w.pageTick(oldToken);assert.equal(w.snapshot().scans,scans);assert.equal(w.calls.actions.length,0);
});

test('a cancelled, definitely unclicked response clears uncertainty without restarting the flow',async()=>{
  const pending=deferred();
  const w=await worker({probe:()=>plan('product','addBag',{expectedNext:['bag'],mutatesCart:true}),action:()=>pending.promise});
  await w.send({type:'START'});await w.flush();assert.equal(w.calls.actions.length,1);
  await w.send({type:'STOP'});pending.resolve({ok:false,clicked:false,reason:'cancelled before click'});await w.flush();
  assert.equal(w.snapshot().running,false);assert.equal(w.snapshot().order.uncertain,false);
  assert.equal(w.snapshot().order.cartMutated,false);assert.equal(w.snapshot().clicks,0);assert.equal(w.calls.cancelled>0,true);
});

test('worker restart pauses an uncertain dispatch and safely recovers a confirmed waiting state',async()=>{
  const last={id:'old-action',action:'addBag',stage:'product',documentId:'fixture-document',status:'dispatching',at:1900000000000,clicked:false};
  const uncertain=await worker({saved:stored({running:true,order:{...stored().order,cartMutated:true,uncertain:true,lastAction:last,awaitedStage:['bag']}})});
  assert.equal(uncertain.snapshot().running,false);assert.equal(uncertain.snapshot().order.uncertain,true);
  assert.equal(uncertain.calls.actions.length,0);
  const waiting=await worker({saved:stored({running:true,order:{...stored().order,cartMutated:true,lastAction:{...last,status:'confirmed',clicked:true},awaitedStage:['bag']}}),
    probe:()=>plan('product','addBag',{mutatesCart:true,expectedNext:['bag']})});
  assert.equal(waiting.snapshot().running,true);assert.equal(waiting.calls.actions.length,0);assert.equal(waiting.calls.reloads,0);
  await waiting.send({type:'STOP'});
});

test('a stale reload failure cannot pause the newer resumed generation',async()=>{
  const pending=deferred();let first=true;
  const w=await worker({probe:()=>{const safeToReload=first;first=false;return plan('product',null,{safeToReload});},reload:()=>pending.promise});
  await w.send({type:'START'});await w.flush();assert.equal(w.calls.reloads,1);
  await w.send({type:'STOP'});const resumed=await w.send({type:'RESUME'});const token=resumed.state.order.token;
  pending.reject(new Error('old navigation failed'));await w.flush();
  assert.equal(w.snapshot().order.token,token);assert.equal(w.snapshot().running,true);
  assert.equal(w.snapshot().error,'');await w.send({type:'STOP'});
});

test('changing products cannot cross an in-flight cart mutation during config saving',async()=>{
  const pending=deferred();
  const w=await worker({probe:()=>plan('product','addBag',{expectedNext:['attach','bag'],mutatesCart:true}),action:()=>pending.promise});
  await w.send({type:'START'});await w.flush();assert.equal(w.snapshot().order.cartMutated,true);
  const response=await w.send({type:'SAVE_CONFIG',config:{...core.DEFAULT_CONFIG,partNumber:'MJYJ4CH/A',productUrl:'https://www.apple.com.cn/shop/product/MJYJ4CH/A'}});
  assert.equal(response.ok,false);assert.equal(w.snapshot().config.partNumber,core.DEFAULT_CONFIG.partNumber);
  assert.equal(w.snapshot().running,false);pending.resolve({ok:true,clicked:true});await w.flush();
  assert.equal(w.snapshot().order.cartMutated,true);assert.equal(w.calls.actions.length,1);
});

test('post-submit processing only waits, even after an uncertain result, until confirmation appears',async()=>{
  let stage='review';
  const w=await worker({probe:()=>stage==='review'?plan('review','submitOrder',{expectedNext:['awaitingPayment']}):plan(stage),action:()=>{throw new Error('unknown submit result');}});
  await w.send({type:'SAVE_CONFIG',config:{...core.DEFAULT_CONFIG,maxTotal:20000,submitEnabled:true}});
  await w.send({type:'START'});await w.flush();stage='processing';
  await w.send({type:'RESUME'});await w.flush();
  assert.equal(w.snapshot().running,true);assert.equal(w.calls.actions.length,1);assert.equal(w.calls.reloads,0);
  await w.advance(120000);await w.pageTick();assert.equal(w.calls.actions.length,1);assert.equal(w.snapshot().running,true);
  stage='awaitingPayment';await w.send({type:'CHECK_NOW'});await w.flush();
  assert.equal(w.snapshot().order.status,'awaitingPayment');assert.equal(w.snapshot().running,false);
});

test('completed RESET only clears local state; the next configured task opens a fresh entry tab',async()=>{
  const w=await worker({saved:stored({order:{...stored().order,status:'awaitingPayment',stage:'awaitingPayment',cartMutated:true,uncertain:false}}),
    probe:()=>plan('product',null)});
  const response=await w.send({type:'RESET'});assert.equal(response.ok,true);
  assert.equal(w.snapshot().tabId,null);assert.equal(w.snapshot().running,false);assert.equal(w.snapshot().order.lastAction,null);
  assert.equal(w.calls.created,0);assert.equal(w.calls.updates,0);assert.equal(w.calls.actions.length,0);assert.equal(w.calls.reloads,0);
  assert.equal(w.tabs.size,1,'the old order page remains untouched');
  const productUrl='https://www.apple.com.cn/shop/product/MJYJ4CH/A';
  assert.equal((await w.send({type:'SAVE_CONFIG',config:{...core.DEFAULT_CONFIG,partNumber:'MJYJ4CH/A',productUrl}})).ok,true);
  assert.equal(w.snapshot().running,false);assert.equal(w.calls.created,0);
  await w.send({type:'START'});await w.flush();assert.equal(w.calls.created,1);assert.equal(w.tabs.get(w.snapshot().tabId).url,productUrl);
  assert.equal(w.calls.actions.length,0);await w.send({type:'STOP'});
});

test('switching an untouched target detaches the old tab and starts only the explicitly selected new entry',async()=>{
  const w=await worker({probe:()=>plan('product',null)});
  await w.send({type:'START'});await w.flush();const oldTabId=w.snapshot().tabId,oldToken=w.snapshot().order.token;
  assert.equal(w.calls.created,1);await w.send({type:'STOP'});
  const newUrl='https://www.apple.com.cn/shop/product/MJYJ4CH/A';
  const response=await w.send({type:'SAVE_CONFIG',config:{...core.DEFAULT_CONFIG,partNumber:'MJYJ4CH/A',productUrl:newUrl}});
  assert.equal(response.ok,true);assert.equal(w.snapshot().tabId,null);assert.equal(w.snapshot().order.entryUrl,'');
  assert.equal(w.snapshot().order.lastAction,null);assert.equal(w.snapshot().stage,'idle');assert.equal(w.snapshot().running,false);
  assert.equal(w.calls.created,1);assert.equal(w.calls.updates,0);assert.equal(w.tabs.get(oldTabId).url,entry);
  await w.send({type:'PAGE_TICK',runToken:oldToken,documentId:'fixture-document'},
    {id:'fixture-extension',url:entry,frameId:0,tab:{id:oldTabId}});await w.flush();
  assert.equal(w.calls.probes,1,'old document ticks cannot scan a detached target');
  await w.send({type:'START'});await w.flush();
  assert.equal(w.calls.created,2);assert.notEqual(w.snapshot().tabId,oldTabId);
  assert.equal(w.tabs.get(w.snapshot().tabId).url,newUrl);assert.equal(w.snapshot().order.entryUrl,newUrl);
  assert.equal(w.tabs.get(oldTabId).url,entry);assert.equal(w.calls.actions.length,0);
  const scans=w.calls.probes;
  await w.send({type:'PAGE_TICK',runToken:oldToken,documentId:'fixture-document'},
    {id:'fixture-extension',url:entry,frameId:0,tab:{id:oldTabId}});await w.flush();
  assert.equal(w.calls.probes,scans,'the previous tab cannot drive a newly started task');
  await w.send({type:'STOP'});
});

test('stop and a rejected config change preserve completed proof for the new-task reset',async()=>{
  const message='fixture order completed';
  const w=await worker({saved:stored({order:{...stored().order,status:'awaitingPayment',stage:'awaitingPayment',message,cartMutated:true,uncertain:false}})});
  await w.send({type:'STOP'});
  assert.equal(w.snapshot().order.status,'awaitingPayment');assert.equal(w.snapshot().order.message,message);
  const response=await w.send({type:'SAVE_CONFIG',config:{...core.DEFAULT_CONFIG,partNumber:'MJYJ4CH/A',productUrl:'https://www.apple.com.cn/shop/product/MJYJ4CH/A'}});
  assert.equal(response.ok,false);assert.equal(w.snapshot().order.status,'awaitingPayment');assert.equal(w.snapshot().order.stage,'awaitingPayment');
  assert.equal(w.snapshot().order.message,message);assert.equal((await w.send({type:'RESET'})).ok,true);
  assert.equal(w.snapshot().tabId,null);assert.equal(w.calls.created,0);assert.equal(w.calls.actions.length,0);
});

test('submit permission and positive amount are independently enforced by the worker',async()=>{
  for(const config of [{...core.DEFAULT_CONFIG,maxTotal:20000,submitEnabled:false},{...core.DEFAULT_CONFIG,maxTotal:0,submitEnabled:true}]){
    const w=await worker({probe:()=>plan('review','submitOrder',{expectedNext:['awaitingPayment']})});
    await w.send({type:'SAVE_CONFIG',config});await w.send({type:'START'});await w.flush();
    assert.equal(w.calls.actions.length,0);assert.equal(w.snapshot().running,false);
  }
});

test('mock guest workflow advances by observed page actions, including native field changes, once per step',async()=>{
  const sequence=[['product','addBag','attach'],['attach','viewBag','bag'],['bag','checkout','signIn'],['signIn','guest','fulfillment'],
    ['fulfillment','delivery','fulfillment'],['fulfillment','shippingContinue','shipping'],['shipping','fillShipping','shipping'],
    ['shipping','shippingContinue','billing'],['billing','selectPayment','billing'],['billing','billingContinue','review'],['review','submitOrder','awaitingPayment']];
  let index=0;
  const w=await worker({probe:()=>{if(index===sequence.length)return plan('awaitingPayment');const [stage,action,next]=sequence[index];return plan(stage,action,{expectedNext:[next],documentId:`document-${stage}`,mutatesCart:action==='addBag'});},
    action:message=>{assert.equal(message.action,sequence[index][1]);index++;return {ok:true,clicked:message.action!=='fillShipping',changed:message.action==='fillShipping'};}});
  await w.send({type:'SAVE_CONFIG',config:{...core.DEFAULT_CONFIG,maxTotal:20000,submitEnabled:true}});
  await w.send({type:'START'});await w.flush();
  for(let i=0;i<20&&w.snapshot().running;i++){await w.send({type:'CHECK_NOW'});await w.flush();}
  assert.equal(w.snapshot().order.status,'awaitingPayment');assert.equal(w.calls.actions.length,sequence.length);
  assert.equal(new Set(w.calls.actions.map(a=>a.actionId)).size,sequence.length);
  assert.equal(w.snapshot().clicks,sequence.length-1);assert.equal(w.calls.created,1);
  assert.equal(w.calls.fetch,0);assert.equal(w.calls.reloads,0);
});
