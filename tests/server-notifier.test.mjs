import test from 'node:test';
import assert from 'node:assert/strict';
import {createWebhookNotifier} from '../server/notifier.mjs';

const payload={event:'pickup.available',productName:'iPhone 示例 1TB',partNumber:'MK2T4CH/A',address:'用户私密位置',checkedAt:1900000000000,stores:[{id:'R001',name:'Apple 示例店',address:'门店地址',availability:'available',availabilityText:'今天可取货',pickupText:'可自提',distanceText:'2 公里'}]};

test('unconfigured notifier is dashboard-only and HTTP destinations require explicit loopback permission',()=>{
  assert.equal(createWebhookNotifier(),null);
  for(const url of ['invalid','http://example.com/hooks','http://127.0.0.1:9000/hooks','https://user:password@example.com/hooks','https://example.com/hooks#secret'])assert.throws(()=>createWebhookNotifier({url}));
  assert.equal(typeof createWebhookNotifier({url:'http://127.0.0.1:9000/hooks',allowHttpLoopback:true}),'function');assert.throws(()=>createWebhookNotifier({url:'http://example.com/hooks',allowHttpLoopback:true}));
});

test('generic webhook sends a bounded JSON event without location or credentials and rejects redirects',async()=>{
  const requests=[];const notify=createWebhookNotifier({url:'https://notifications.example/hooks?token=secret',fetchImpl:async(url,options)=>{requests.push({url,options});return {ok:true,status:204};}});
  assert.deepEqual(await notify(payload),{ok:true});assert.equal(requests.length,1);assert.equal(requests[0].options.method,'POST');assert.equal(requests[0].options.redirect,'error');
  const body=JSON.parse(requests[0].options.body);assert.equal(body.event,'pickup.available');assert.equal(body.stores[0].name,'Apple 示例店');assert.equal(body.checkedAt,payload.checkedAt);assert.equal('address' in body,false);assert.equal('address' in body.stores[0],false);assert.doesNotMatch(requests[0].options.body,/私密|secret/);
});

test('webhook failures never expose destination, response body or thrown network secrets',async()=>{
  for(const fetchImpl of [async()=>({ok:false,status:500}),async()=>({ok:true,status:302}),async()=>{throw new Error('https://secret.example/token=abc response private');}]){
    const notify=createWebhookNotifier({url:'https://secret.example/hooks?token=abc',fetchImpl});await assert.rejects(notify(payload),error=>{assert.match(error.message,/通知发送失败/);assert.doesNotMatch(error.message,/secret|abc|private/);return true;});
  }
});

test('webhook timeout aborts its request and caller cancellation is forwarded',async()=>{
  let timeout,cleared=false;
  const notify=createWebhookNotifier({url:'https://notifications.example/hooks',timers:{setTimeout(fn){timeout=fn;return 1;},clearTimeout(){cleared=true;}},fetchImpl:async(_url,{signal})=>new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(new Error('aborted')),{once:true}))});
  const pending=notify(payload);timeout();await assert.rejects(pending,/通知发送失败/);assert.equal(cleared,true);
  const controller=new AbortController();const cancelled=notify(payload,{signal:controller.signal});controller.abort();await assert.rejects(cancelled,/通知发送失败/);
});
