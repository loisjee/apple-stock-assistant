import test from 'node:test';
import assert from 'node:assert/strict';
import {recordStockHistory, restoreStockHistory, STOCK_HISTORY_LIMIT} from '../stock-history.mjs';
const config = {partNumber:'MK2P4CH/A',productName:'iPhone Duo 512GB 星光白色',address:'上海市杨浦区'};
const store = (availability, id='R1') => ({id,name:'五角场',availability,distanceText:'1.77 km',pickupText:'今天可取货'});
const start = Date.parse('2026-10-17T16:00:00Z');

test('arrival events use fresh observations; unknown, missing, errors and continuing availability never rearm',()=>{
  let h = restoreStockHistory(null,start);
  h = recordStockHistory(h,config,[store('available')],start+60000);
  assert.equal(h.events.length,1);assert.equal(h.events[0].kind,'first-observed');assert.equal(h.events[0].observedAt,start+60000);
  for(const stores of [[store('available')],[store('unknown')],[],[store('available')]]) h=recordStockHistory(h,config,stores,start+120000);
  assert.equal(h.events.length,1);
  h=recordStockHistory(h,config,[store('unavailable')],start+180000);
  h=recordStockHistory(h,config,[store('unavailable')],start+240000);
  h=recordStockHistory(h,config,[store('available')],start+300000);
  assert.equal(h.events.length,2);assert.equal(h.events[1].kind,'restocked');assert.equal(h.events[1].lastUnavailableAt,start+240000);
  assert.equal(h.events[1].location,config.address);assert.equal(h.events[1].storeName,'五角场');
});

test('product and region have separate persistent baselines and retain earlier events',()=>{
  let h=recordStockHistory(null,config,[store('available')],start);
  for(const next of [{...config,address:'上海市黄浦区'},{...config,partNumber:'OTHERCH/A'}])h=recordStockHistory(h,next,[store('available')],start+60000);
  h=recordStockHistory(restoreStockHistory(JSON.parse(JSON.stringify(h)),start+120000),config,[store('available')],start+120000);
  assert.equal(h.events.length,3);assert.equal(h.startedAt,start);
});

test('legacy migration has no invented events and malformed persisted history is sanitized and bounded',()=>{
  const legacy={stores:[store('available')],lastCheckAt:start-86400000};
  const h=restoreStockHistory(legacy,start);assert.deepEqual(h.events,[]);assert.equal(h.startedAt,start);
  assert.equal(recordStockHistory(h,config,[store('available')],start+60000).events[0].observedAt,start+60000);
  assert.equal(restoreStockHistory({version:1,events:[null,{observedAt:NaN},{}],observations:[null,{key:'x',availability:'unknown'}]},start).events.length,0);
  let many=restoreStockHistory(null,start);
  for(let i=0;i<STOCK_HISTORY_LIMIT+5;i++)many=recordStockHistory(many,config,[store('available',`R${i}`)],start+i*60000);
  assert.equal(many.events.length,STOCK_HISTORY_LIMIT);assert.equal(many.observations.length,STOCK_HISTORY_LIMIT);
  assert.equal(many.events[0].observedAt,start+5*60000);
});
