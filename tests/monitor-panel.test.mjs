import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

let chromium;
try { ({ chromium } = await import('playwright')); } catch {}
const monitorUrl=new URL('../monitor.html',import.meta.url).href;
const testUrl='https://www.apple.com.cn/shop/buy-iphone/iphone-18-pro/mjyj4ch/a';

test('pickup monitor panel in isolated local Chromium', {skip:!chromium},async t=>{
  let browser;
  try{browser=await chromium.launch({channel:'chrome',headless:true});}catch{browser=await chromium.launch({headless:true});}
  t.after(()=>browser.close());
  const context=await browser.newContext({viewport:{width:1000,height:800},deviceScaleFactor:2});
  const blocked=[],errors=[];
  await context.route(/^https?:\/\//,route=>{blocked.push(route.request().url());return route.abort();});
  context.on('page',page=>page.on('pageerror',error=>errors.push(error.message)));
  const page=await context.newPage();
  await page.goto(monitorUrl);
  await page.locator('#status-tag').filter({hasText:'演示模式'}).waitFor();

  await t.test('demo is compact, explicit, and never treats unknown as available',async()=>{
    assert.equal((await page.locator('body').boundingBox()).width,310);
    assert.ok((await page.locator('body').boundingBox()).height<=578);
    assert.equal(await page.locator('#collapse').isVisible(),false);
    assert.match(await page.locator('#notice').innerText(),/界面预览.*未连接官网/);
    assert.match(await page.locator('#fineprint').innerText(),/示例库存.*不会操作官网或下单/);
    assert.equal(await page.locator('#freshness').innerText(),'示例数据');
    assert.equal(await page.locator('.availability.available').count(),0);
    assert.equal(await page.locator('.availability.unknown').innerText(),'未知');
    assert.equal(await page.locator('#toggle').isDisabled(),true);
    assert.equal(await page.locator('#check-now').isDisabled(),true);
    await mkdir(fileURLToPath(new URL('../test-artifacts/',import.meta.url)),{recursive:true});
    await page.locator('body').screenshot({path:fileURLToPath(new URL('../test-artifacts/monitor-preview.png',import.meta.url))});
  });

  await t.test('presets, location before start, and native interval/store limits',async()=>{
    await page.locator('#configure').click();
    assert.equal(await page.locator('#address').inputValue(),'');
    assert.match(await page.locator('#address').getAttribute('placeholder'),/省份.*城市.*区县/);
    assert.match(await page.locator('#settings .field-help').innerText(),/无需门牌号.*非地图路线距离/);
    await page.locator('#preset').selectOption('test');
    assert.equal(await page.locator('#product-name-input').inputValue(),'iPhone 18 Pro Max 1TB 冰川蓝色');
    assert.equal(await page.locator('#part-number').inputValue(),'MJYJ4CH/A');
    assert.equal(await page.locator('#product-url').inputValue(),testUrl);
    assert.equal(await page.locator('#interval-seconds').getAttribute('min'),'30');
    assert.equal(await page.locator('#interval-seconds').getAttribute('max'),'3600');
    for(const value of ['29','3601','30.5']){await page.locator('#interval-seconds').fill(value);assert.equal(await page.locator('#interval-seconds').evaluate(input=>input.checkValidity()),false);}
    await page.locator('#interval-seconds').fill('60');
    assert.equal(await page.locator('#max-stores').getAttribute('min'),'1');
    assert.equal(await page.locator('#max-stores').getAttribute('max'),'20');
    await page.locator('#address').fill('测试省 测试市 测试区');
    await page.locator('#save-settings').click();
    assert.equal(await page.locator('#settings').evaluate(dialog=>dialog.open),false);
    assert.match(await page.locator('#product-name').innerText(),/iPhone 18 Pro Max/);
    assert.equal(await page.locator('#toggle').isDisabled(),false);
    await page.locator('#toggle').click();
    assert.equal(await page.locator('#toggle').innerText(),'暂停');
    assert.match(await page.locator('#notice').innerText(),/预览.*不会打开或操作真实网站/);
    await page.locator('#check-now').click();
    assert.equal(await page.locator('#checks').innerText(),'1');
    await page.locator('#toggle').click();
    assert.equal(await page.locator('#toggle').innerText(),'开始监控');
    assert.equal(context.pages().length,1);
  });

  const extensionPage=await context.newPage();
  await extensionPage.setViewportSize({width:310,height:578});
  await extensionPage.addInitScript(()=>{
    window.rpcMessages=[];window.failNext='';window.releaseRpc=null;
    window.fixtureState={config:{productName:'iPhone Duo 1TB 星光白色',partNumber:'MK2T4CH/A',productUrl:'https://www.apple.com.cn/shop/product/MK2T4CH/A',address:'测试省 测试市 测试区',intervalSeconds:60,maxStores:10,notifyEnabled:true},running:false,status:'idle',notice:'',error:'',checks:4,lastCheckAt:Date.now(),nextCheckAt:0,tabId:42,stale:false,stores:[{id:'one',name:'官网排序第一店',address:'示例地址一',distanceText:'8 公里',availability:'unknown',availabilityText:'官网未返回结果',pickupText:''},{id:'two',name:'官网排序第二店',address:'示例地址二',distanceText:'',availability:'unavailable',availabilityText:'当前无法自提',pickupText:''}]};
    window.chrome={runtime:{id:'local-monitor-fixture',sendMessage:async message=>{
      window.rpcMessages.push(message);
      if(window.holdType===message.type)await new Promise(resolve=>{window.releaseRpc=resolve;});
      if(window.failNext===message.type){window.failNext='';return{ok:false,error:'本地模拟错误，请检查监控页。'};}
      const state=window.fixtureState;
      switch(message.type){
        case 'PICKUP_GET_STATE':break;
        case 'PICKUP_SAVE_CONFIG':state.config=structuredClone(message.config);state.running=false;break;
        case 'PICKUP_START':state.running=true;state.status='watching';state.nextCheckAt=Date.now()+60000;break;
        case 'PICKUP_STOP':state.running=false;state.status='paused';state.nextCheckAt=0;break;
        case 'PICKUP_CHECK_NOW':state.checks++;break;
        case 'PICKUP_OPEN':break;
        case 'PICKUP_TEST_NOTIFICATION':state.notice='本地模拟：提醒测试完成';break;
        default:return{ok:false,error:'未知消息'};
      }
      return{ok:true,state:structuredClone(state)};
    }},storage:{onChanged:{addListener:listener=>{window.fixtureStorageListener=listener;}}}};
  });
  await extensionPage.goto(monitorUrl);
  await extensionPage.locator('#status-tag').filter({hasText:'页面读取'}).waitFor();

  await t.test('exact config RPC schema, compact settings, and official proximity order',async()=>{
    assert.equal(await extensionPage.locator('html').evaluate(element=>element.classList.contains('preview-mode')),false);
    assert.equal(await extensionPage.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    assert.deepEqual(await extensionPage.locator('.store-name').allTextContents(),['官网排序第一店','官网排序第二店']);
    assert.equal(await extensionPage.locator('#available-count').innerText(),'0');
    await extensionPage.locator('#configure').click();
    await extensionPage.locator('#preset').selectOption('test');
    await extensionPage.locator('#interval-seconds').fill('30');
    await extensionPage.locator('#max-stores').fill('5');
    await extensionPage.locator('#notify-enabled').uncheck();
    assert.equal(await extensionPage.locator('#settings').evaluate(dialog=>dialog.scrollWidth<=dialog.clientWidth),true);
    await extensionPage.locator('#save-settings').click();
    await extensionPage.waitForFunction(()=>window.rpcMessages.at(-1)?.type==='PICKUP_SAVE_CONFIG');
    const message=await extensionPage.evaluate(()=>window.rpcMessages.at(-1));
    assert.deepEqual(Object.keys(message).sort(),['config','type']);
    assert.deepEqual(Object.keys(message.config).sort(),['productName','partNumber','productUrl','address','intervalSeconds','maxStores','notifyEnabled'].sort());
    assert.equal(message.config.productUrl,testUrl);assert.equal(message.config.intervalSeconds,30);assert.equal(message.config.maxStores,5);assert.equal(message.config.notifyEnabled,false);
  });

  await t.test('exact controls and duplicate actions prevented while RPC is pending',async()=>{
    for(const [id,type]of[['toggle','PICKUP_START'],['toggle','PICKUP_STOP'],['check-now','PICKUP_CHECK_NOW'],['open-monitor','PICKUP_OPEN'],['test-notification','PICKUP_TEST_NOTIFICATION']]){
      await extensionPage.locator(`#${id}`).click();await extensionPage.waitForFunction(type=>window.rpcMessages.at(-1)?.type===type,type);
    }
    await extensionPage.evaluate(()=>{window.holdType='PICKUP_CHECK_NOW';document.getElementById('check-now').click();document.getElementById('open-monitor').click();document.getElementById('check-now').click();});
    await extensionPage.waitForFunction(()=>typeof window.releaseRpc==='function');
    assert.equal(await extensionPage.locator('#toggle').isDisabled(),true);
    assert.equal(await extensionPage.locator('#configure').isDisabled(),true);
    const last=await extensionPage.evaluate(()=>window.rpcMessages.slice(-2).map(message=>message.type));
    assert.deepEqual(last,['PICKUP_TEST_NOTIFICATION','PICKUP_CHECK_NOW']);
    await extensionPage.evaluate(()=>{window.holdType='';window.releaseRpc();});
    await extensionPage.waitForFunction(()=>!document.getElementById('check-now').disabled);
  });

  await t.test('operation and save errors remain visible',async()=>{
    await extensionPage.evaluate(()=>{window.failNext='PICKUP_CHECK_NOW';});
    await extensionPage.locator('#check-now').click();
    await extensionPage.waitForFunction(()=>!document.getElementById('check-now').disabled);
    assert.match(await extensionPage.locator('#notice').innerText(),/本地模拟错误/);
    await extensionPage.evaluate(()=>{window.failNext='PICKUP_SAVE_CONFIG';});
    await extensionPage.locator('#configure').click();await extensionPage.locator('#save-settings').click();
    assert.equal(await extensionPage.locator('#settings').evaluate(dialog=>dialog.open),true);
    assert.match(await extensionPage.locator('#settings-error').innerText(),/本地模拟错误/);
    await extensionPage.locator('#close-settings').click();
  });

  await t.test('storage only updates monitor state, marks stale, and renders unsafe strings as plain text',async()=>{
    await extensionPage.evaluate(()=>{const next=structuredClone(window.fixtureState);next.checks=20;window.fixtureStorageListener({app:{newValue:next}},'local');});
    assert.notEqual(await extensionPage.locator('#checks').innerText(),'20');
    await extensionPage.evaluate(()=>{
      const next=structuredClone(window.fixtureState);next.checks=20;next.status='available';next.stale=true;next.running=false;
      next.stores=[{id:'available',name:'<img src=x onerror=alert(1)>',address:'<script>bad()</script>',availability:'available',availabilityText:'当日可取',pickupText:''},{id:'unknown',name:'未知店',availability:'unknown',availabilityText:'请稍后重试'}];
      window.fixtureStorageListener({pickupMonitorState:{newValue:next}},'local');
    });
    assert.equal(await extensionPage.locator('#checks').innerText(),'20');
    assert.equal(await extensionPage.locator('#status-title').innerText(),'上次发现可自提');
    assert.equal(await extensionPage.locator('#freshness').innerText(),'上次结果 · 已过期');
    assert.equal(await extensionPage.locator('.store img,.store script').count(),0);
    assert.match(await extensionPage.locator('.store-name').first().innerText(),/^<img/);
    assert.equal(await extensionPage.locator('#available-count').innerText(),'1');
    assert.equal(await extensionPage.locator('.availability.unknown').innerText(),'未知');
  });


  await t.test('arrival history shows Beijing dates, filters targets, exports safely and stays compact',async()=>{
    await extensionPage.evaluate(()=>{
      const next=structuredClone(window.fixtureState),at=Date.parse('2026-10-17T16:04:05Z');
      const event={observedAt:at,kind:'restocked',lastUnavailableAt:at-60000,productName:next.config.productName,partNumber:next.config.partNumber,location:next.config.address,storeId:'R1',storeName:'=SUM(1,2)',distanceText:'1 km',pickupText:'<img src=x onerror=alert(1)>'};
      next.stockHistory={version:1,startedAt:at-120000,events:[event,{...event,observedAt:at-3600000,storeName:'另一地区',location:'其他地区',kind:'first-observed',lastUnavailableAt:0}],observations:[]};
      window.fixtureStorageListener({pickupMonitorState:{newValue:next}},'local');
    });
    assert.equal(await extensionPage.locator('#show-history').innerText(),'有货记录 · 1');
    await extensionPage.locator('#show-history').click();
    assert.match(await extensionPage.locator('#history-list').innerText(),/2026-10-18 00:04:05/);
    assert.match(await extensionPage.locator('#history-list').innerText(),/上次确认无货：2026-10-18 00:03:05/);
    assert.equal(await extensionPage.locator('#history-list img').count(),0);
    assert.equal(await extensionPage.locator('#history-hours').innerText(),'00 时 · 1 店次');
    assert.equal(await extensionPage.locator('#stock-history').evaluate(el=>el.scrollWidth<=el.clientWidth),true);
    const downloadPromise=extensionPage.waitForEvent('download');await extensionPage.locator('#export-history').click();
    const download=await downloadPromise,stream=await download.createReadStream(),chunks=[];for await(const chunk of stream)chunks.push(chunk);
    const csv=Buffer.concat(chunks).toString('utf8');assert.match(csv,/2026-10-18 00:04:05/);assert.match(csv,/"'=SUM\(1,2\)"/);assert.doesNotMatch(csv,/另一地区/);
    await extensionPage.locator('#history-scope').selectOption('all');assert.equal(await extensionPage.locator('#history-list li').count(),2);
    await mkdir(fileURLToPath(new URL('../test-artifacts/',import.meta.url)),{recursive:true});
    await extensionPage.evaluate(()=>{
      const next=structuredClone(window.fixtureState),at=Date.parse('2026-10-17T16:04:05Z');
      const example={observedAt:at,kind:'restocked',lastUnavailableAt:at-60000,partNumber:'MK2P4CH/A',productName:'iPhone Duo 512GB 星光白色',location:'上海市杨浦区（界面示例）',storeId:'demo1',storeName:'五角场（示例）',distanceText:'1.77 公里',pickupText:'今天可取货（示例）'};
      next.config={...next.config,partNumber:example.partNumber,address:example.location};
      next.stockHistory={version:1,startedAt:at-86400000,events:[{...example,observedAt:at-3600000,kind:'first-observed',lastUnavailableAt:0,storeId:'demo2',storeName:'环球港（示例）'},example],observations:[]};
      window.fixtureStorageListener({pickupMonitorState:{newValue:next}},'local');
    });
    await extensionPage.locator('#stock-history').screenshot({path:fileURLToPath(new URL('../test-artifacts/stock-history-preview.png',import.meta.url))});
    await extensionPage.locator('#close-history').click();
  });

  await t.test('embedded navigation preserves query and collapse uses exact trusted parent',async()=>{
    const embedded=await context.newPage();
    const suffix=`?embedded=1&parent=${encodeURIComponent('https://secure6.www.apple.com.cn')}`;
    await embedded.goto(`${monitorUrl}${suffix}`);
    await embedded.locator('#status-tag').filter({hasText:'演示模式'}).waitFor();
    assert.equal(await embedded.locator('#collapse').isVisible(),true);
    assert.equal(await embedded.locator('#purchase-link').getAttribute('href'),`panel.html${suffix}`);
    await embedded.evaluate(()=>{window.messages=[];window.postMessage=(message,origin)=>window.messages.push({message,origin});});
    await embedded.locator('#collapse').click();
    assert.deepEqual(await embedded.evaluate(()=>window.messages),[{message:{type:'SHIKE_COLLAPSE'},origin:'https://secure6.www.apple.com.cn'}]);
    await embedded.close();
  });
  assert.deepEqual(errors,[]);assert.deepEqual(blocked,[]);
});
