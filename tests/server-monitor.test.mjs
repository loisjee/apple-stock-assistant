import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PickupMonitor,normalizeServerConfig} from '../server/monitor.mjs';
import {DEFAULT_PICKUP_CONFIG} from '../pickup-monitor.mjs';

const config={...DEFAULT_PICKUP_CONFIG,address:'成都市锦江区',intervalSeconds:30};
const store=(availability='available')=>({id:'R001',name:'Apple 示例门店',address:'门店公开地址',distanceText:'2 公里',availability,availabilityText:availability==='available'?'今天可取货':'无货',pickupText:'官网状态'});
const result=availability=>({ok:true,stores:[store(availability)]});
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
const flush=async(count=15)=>{for(let i=0;i<count;i++)await new Promise(setImmediate);};
function clock(){let now=1900000000000,id=0;const tasks=new Map();return {now:()=>now,tasks,timers:{setTimeout(fn,delay){const key=++id;tasks.set(key,{fn,at:now+delay});return key;},clearTimeout(key){tasks.delete(key);}},async advance(ms){now+=ms;for(const [key,task] of [...tasks])if(task.at<=now){tasks.delete(key);task.fn();}await flush();}};}
async function fixture(t,{check,notify,saved}={}){
  const directory=await mkdtemp(join(tmpdir(),'apple-pickup-server-')),storePath=join(directory,'state.json'),time=clock(),calls={checks:[],notifications:[],closed:0},checkWaiters=[];
  if(saved)await writeFile(storePath,JSON.stringify(saved));
  const browser={async check(value,{signal}){calls.checks.push({config:structuredClone(value),signal});for(const waiter of checkWaiters)if(calls.checks.length>=waiter.count)waiter.resolve();return check?check(value,{signal}):result('unavailable');},async close(){calls.closed++;}};
  const notifier=notify===null?null:async(payload,options)=>{calls.notifications.push(structuredClone(payload));return notify?notify(payload,options):{ok:true};};
  const monitor=new PickupMonitor({browser,storePath,notify:notifier,now:time.now,timers:time.timers});await monitor.init();
  t.after(async()=>{await monitor.close();await rm(directory,{recursive:true,force:true});});
  return {monitor,browser,storePath,time,calls,directory,waitForCheck(count=1){return calls.checks.length>=count?Promise.resolve():new Promise(resolve=>checkWaiters.push({count,resolve}));},async save(extra={}){return monitor.saveConfig({...config,...extra});}};
}

test('server config strips purchase fields and rejects unsafe targets, step queries and oversized addresses',()=>{
  const normalized=normalizeServerConfig({...config,shipping:{email:'private@example.test'},submitEnabled:true,cookies:'secret',webhookUrl:'https://secret.invalid'});
  assert.deepEqual(Object.keys(normalized).sort(),['address','intervalSeconds','maxStores','notifyEnabled','partNumber','productName','productUrl'].sort());
  for(const productUrl of ['https://www.apple.com.cn/shop/product/MK2T4CH/A?step=attach','https://www.apple.com.cn/shop/buy-iphone?anything=1','https://www.apple.com.cn/shop/buy-iphone','https://www.apple.com.cn/shop/product/MJYJ4CH/A','https://www.apple.com.cn/shop/buy-iphone/checkout','https://secure6.www.apple.com.cn/shop/checkout','https://example.com/shop/product/MK2T4CH/A'])assert.throws(()=>normalizeServerConfig({...config,productUrl}));
  assert.throws(()=>normalizeServerConfig({...config,address:'a'.repeat(201)}));assert.throws(()=>normalizeServerConfig({...config,intervalSeconds:29}));assert.equal(normalizeServerConfig({...config,address:'a'.repeat(200)}).address.length,200);
});

test('manual check persists private atomic state and start schedules periodic checks without overlapping',async t=>{
  const w=await fixture(t);await w.save();await w.monitor.checkNow();assert.equal(w.monitor.state().running,false);assert.equal(w.monitor.state().checks,1);assert.equal(w.time.tasks.size,0);
  const persisted=JSON.parse(await readFile(w.storePath,'utf8'));assert.equal(persisted.stores[0].availability,'unavailable');assert.equal((await stat(w.storePath)).mode&0o777,0o600);
  await w.monitor.start();assert.equal(w.time.tasks.size,1);await w.time.advance(0);await w.monitor.checkNow();assert.equal(w.monitor.state().running,true);assert.equal(w.calls.checks.length,2);assert.equal(w.time.tasks.size,1);
  await w.time.advance(30000);await w.monitor.checkNow();assert.ok(w.calls.checks.length>=3);assert.equal(w.monitor.state().nextCheckAt,w.time.now()+30000);
  await w.monitor.stop();assert.equal(w.time.tasks.size,0);assert.equal(w.monitor.state().running,false);
});

test('concurrent manual checks coalesce into a single browser check',async t=>{
  const pending=deferred();const w=await fixture(t,{check:()=>pending.promise});await w.save();const first=w.monitor.checkNow(),second=w.monitor.checkNow();await w.waitForCheck();assert.equal(w.calls.checks.length,1);
  pending.resolve(result('available'));await Promise.all([first,second]);assert.equal(w.monitor.state().checks,1);assert.equal(w.calls.notifications.length,1);
});

test('STOP aborts and discards late results without notifying or starting another check',async t=>{
  const pending=deferred();const w=await fixture(t,{check:()=>pending.promise});await w.save();const check=w.monitor.checkNow();await w.waitForCheck();await w.monitor.stop();assert.equal(w.calls.checks[0].signal.aborted,true);
  pending.resolve(result('available'));await check;assert.equal(w.monitor.state().running,false);assert.equal(w.monitor.state().status,'paused');assert.equal(w.monitor.state().checks,0);assert.equal(w.calls.notifications.length,0);assert.equal(w.monitor.state().stores.length,0);
});

test('saving a new configuration aborts old work and serializes its replacement until old browser work settles',async t=>{
  const pending=deferred();let first=true;const w=await fixture(t,{check:()=>{if(first){first=false;return pending.promise;}return result('unavailable');}});await w.save();const old=w.monitor.checkNow();await w.waitForCheck();await w.save({address:'上海市黄浦区'});const next=w.monitor.checkNow();await flush();assert.equal(w.calls.checks.length,1);
  pending.resolve(result('available'));await Promise.all([old,next]);assert.equal(w.calls.checks.length,2);assert.equal(w.calls.checks[0].signal.aborted,true);assert.equal(w.calls.checks[1].config.address,'上海市黄浦区');assert.equal(w.monitor.state().stores[0].availability,'unavailable');assert.equal(w.calls.notifications.length,0);
});

test('an old START waiting for persistence cannot reset a newer run timer after STOP and restart',async t=>{
  const w=await fixture(t);await w.save();const gate=deferred(),persist=w.monitor._persist.bind(w.monitor);let first=true;
  w.monitor._persist=async()=>{if(first){first=false;await gate.promise;}return persist();};
  const oldStart=w.monitor.start();await w.monitor.stop();await w.monitor.start();await w.monitor.checkNow();const deadline=[...w.time.tasks.values()][0].at;assert.equal(deadline,w.time.now()+30000);
  gate.resolve();await oldStart;assert.equal([...w.time.tasks.values()][0].at,deadline);await w.time.advance(0);assert.equal(w.calls.checks.length,1,'stale START must not trigger a second immediate check');
});

test('a persistence failure after reading stock pauses instead of retrying at zero delay or notifying',async t=>{
  let brokenPath;const w=await fixture(t,{check:()=>{w.monitor.storePath=brokenPath;return result('available');}});await w.save();await w.monitor.start();
  const validPath=w.storePath,parentFile=join(w.directory,'not-a-directory');await writeFile(parentFile,'occupied');brokenPath=join(parentFile,'state.json');
  await assert.rejects(w.monitor.checkNow(),/状态无法保存/);assert.equal(w.monitor.state().running,false);assert.equal(w.monitor.state().status,'error');assert.equal(w.time.tasks.size,0);assert.equal(w.calls.notifications.length,0);
  await w.time.advance(3600000);assert.equal(w.calls.checks.length,1);w.monitor.storePath=validPath;
});

test('errors retain last good data and availability dedupe survives unknown results and service restarts',async t=>{
  let mode='available';const w=await fixture(t,{check:()=>{if(mode==='error')throw new Error('secret webhook URL https://secret.invalid');return result(mode);}});await w.save();await w.monitor.checkNow();assert.equal(w.calls.notifications.length,1);
  mode='error';await w.monitor.checkNow();assert.equal(w.monitor.state().stale,true);assert.equal(w.monitor.state().stores[0].availability,'available');assert.doesNotMatch(JSON.stringify(w.monitor.state()),/secret\.invalid/);
  mode='unknown';await w.monitor.checkNow();mode='available';await w.monitor.checkNow();assert.equal(w.calls.notifications.length,1);
  mode='unavailable';await w.monitor.checkNow();mode='available';await w.monitor.checkNow();assert.equal(w.calls.notifications.length,2);
  const saved=JSON.parse(await readFile(w.storePath,'utf8'));const restored=await fixture(t,{saved,check:()=>result('available')});await restored.monitor.checkNow();assert.equal(restored.calls.notifications.length,0);assert.equal(restored.monitor.state().stale,false);
});

test('notification failure is retried while dashboard inventory remains available',async t=>{
  let first=true;const w=await fixture(t,{check:()=>result('available'),notify:()=>{if(first){first=false;throw new Error('secret notification URL');}return {ok:true};}});await w.save();await w.monitor.checkNow();
  assert.equal(w.monitor.state().status,'available');assert.equal(w.monitor.state().stores[0].availability,'available');assert.match(w.monitor.state().notification.lastError,/通知发送失败/);assert.doesNotMatch(JSON.stringify(w.monitor.state()),/secret notification/);
  await w.monitor.checkNow();assert.equal(w.calls.notifications.length,2);assert.equal(w.monitor.state().notification.lastError,'');await w.monitor.checkNow();assert.equal(w.calls.notifications.length,2);
});

test('dashboard-only mode neither calls a notifier nor consumes future alert transitions',async t=>{
  const w=await fixture(t,{check:()=>result('available'),notify:null});await w.save();await w.monitor.checkNow();assert.equal(w.monitor.state().notification.configured,false);assert.match(w.monitor.state().notice,/仪表盘/);assert.deepEqual(w.monitor.state().lastNotified,{});
});

test('enabling reminders after a disabled check may announce continuing stock once',async t=>{
  const w=await fixture(t,{check:()=>result('available')});await w.save({notifyEnabled:false});await w.monitor.checkNow();assert.equal(w.calls.notifications.length,0);assert.deepEqual(w.monitor.state().lastNotified,{});
  await w.save({notifyEnabled:true});await w.monitor.checkNow();assert.equal(w.calls.notifications.length,1);await w.monitor.checkNow();assert.equal(w.calls.notifications.length,1);
});

test('a browser human gate pauses periodic monitoring and records bounded history/errors',async t=>{
  let blocked=false;const w=await fixture(t,{check:()=>blocked?{ok:false,requiresHuman:true,reason:'ignore private injected detail'}:{ok:false,stores:[]}});await w.save();
  for(let i=0;i<105;i++)await w.monitor.checkNow();assert.equal(w.monitor.state().history.length,100);assert.equal(w.monitor.state().errors.length,20);
  blocked=true;await w.monitor.start();await w.monitor.checkNow();assert.equal(w.monitor.state().running,false);assert.equal(w.monitor.state().status,'paused');assert.equal(w.time.tasks.size,0);assert.doesNotMatch(JSON.stringify(w.monitor.state()),/private injected/);
});

test('close preserves running intent for daemon restart, while explicit stop remains stopped after restart',async t=>{
  const w=await fixture(t);await w.save();await w.monitor.start();await w.monitor.close();assert.equal(w.calls.closed,1);assert.equal(w.time.tasks.size,0);
  const running=JSON.parse(await readFile(w.storePath,'utf8'));assert.equal(running.running,true);const resumed=await fixture(t,{saved:running});assert.equal(resumed.monitor.state().running,true);assert.equal(resumed.time.tasks.size,1);await resumed.time.advance(0);await resumed.monitor.checkNow();assert.equal(resumed.monitor.state().checks,1);
  await resumed.monitor.stop();const stopped=JSON.parse(await readFile(resumed.storePath,'utf8'));const paused=await fixture(t,{saved:stopped});assert.equal(paused.monitor.state().running,false);assert.equal(paused.time.tasks.size,0);assert.equal(paused.calls.checks.length,0);
});

test('state snapshots cannot mutate configuration and corrupt persisted state fails safely',async t=>{
  const w=await fixture(t);const state=w.monitor.state();state.config.address='injected';assert.equal(w.monitor.state().config.address,'');assert.throws(()=>new PickupMonitor({browser:{}}));
  const corrupt=await fixture(t,{saved:{schemaVersion:1,config:{...config,productUrl:'https://evil.invalid'}}});assert.equal(corrupt.monitor.state().running,false);assert.equal(corrupt.monitor.state().status,'error');assert.match(corrupt.monitor.state().error,/无法读取/);
});
