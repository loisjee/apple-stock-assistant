import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
let chromium;
try{({chromium}=await import('playwright'));}catch{}
const origin='http://127.0.0.1:48657';
const presetUrl='https://www.apple.com.cn/shop/buy-iphone/iphone-18-pro/mjyj4ch/a';
const config={productName:'iPhone Duo 1TB 星光白色',partNumber:'MK2T4CH/A',productUrl:'https://www.apple.com.cn/shop/product/MK2T4CH/A',address:'',intervalSeconds:60,maxStores:10,notifyEnabled:true};
const defaults=()=>({config:structuredClone(config),running:false,status:'idle',notice:'',error:'',checks:0,lastCheckAt:0,nextCheckAt:0,stores:[],stale:false,notificationsEnabled:false});
const store=(availability,id)=>({id,name:`官网排序门店 ${id}`,address:'本地测试地区',distanceText:`${id} 公里`,availability,availabilityText:availability==='available'?'今天可取货':availability==='unknown'?'等待官网返回':'暂时无法自提',pickupText:''});

test('server monitor dashboard with intercepted local API only',{skip:!chromium},async t=>{
  let browser;try{browser=await chromium.launch({channel:'chrome',headless:true});}catch{browser=await chromium.launch({headless:true});}t.after(()=>browser.close());
  const context=await browser.newContext({viewport:{width:900,height:1000},deviceScaleFactor:2});
  const assets=Object.fromEntries(await Promise.all([['/','index.html'],['/app.js','app.js'],['/style.css','style.css']].map(async([key,file])=>[key,await readFile(new URL(`../server/public/${file}`,import.meta.url),'utf8')])));
  let authenticated=false,state=defaults(),failPath='',expired=false,holdPath='',releaseHold,stateUnauthorizedOnce=false;
  const calls=[],external=[],errors=[];
  await context.route('**/*',async route=>{
    const request=route.request(),url=new URL(request.url());
    if(url.origin!==origin){external.push(request.url());return route.abort();}
    if(Object.hasOwn(assets,url.pathname))return route.fulfill({status:200,contentType:url.pathname.endsWith('.js')?'text/javascript':url.pathname.endsWith('.css')?'text/css':'text/html',body:assets[url.pathname]});
    if(!url.pathname.startsWith('/api/'))return route.fulfill({status:404,body:''});
    let body={};if(request.method()==='POST')body=request.postDataJSON();
    calls.push({path:url.pathname,method:request.method(),body,headers:request.headers()});
    const json=(status,value)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(value)});
    if(url.pathname==='/api/login'){
      if(body.password!=='unit-test-password')return json(401,{ok:false,error:'管理密码不正确。'});
      authenticated=true;expired=false;return json(200,{ok:true});
    }
    if(!authenticated||expired)return json(401,{ok:false,error:'需要登录。'});
    if(url.pathname==='/api/state'&&stateUnauthorizedOnce){stateUnauthorizedOnce=false;return json(401,{ok:false,error:'会话刚刚失效。'});}
    if(url.pathname==='/api/session')return json(200,{ok:true,authenticated:true});
    if(url.pathname===holdPath)await new Promise(resolve=>{releaseHold=resolve;});
    if(url.pathname===failPath){failPath='';return json(400,{ok:false,error:'本地模拟：官网读取失败。'});}
    switch(url.pathname){
      case '/api/state':break;
      case '/api/config':state.config=structuredClone(body.config);state.running=false;state.status='idle';state.stores=[];state.checks=0;state.lastCheckAt=0;break;
      case '/api/start':state.running=true;state.status='watching';state.nextCheckAt=Date.now()+60000;break;
      case '/api/stop':state.running=false;state.status='paused';state.nextCheckAt=0;break;
      case '/api/check':state.checks++;state.lastCheckAt=Date.now();break;
      case '/api/logout':authenticated=false;return json(200,{ok:true});
      default:return json(404,{ok:false,error:'未知 API'});
    }
    return json(200,{ok:true,state:structuredClone(state)});
  });
  context.on('page',page=>page.on('pageerror',error=>errors.push(error.message)));
  const page=await context.newPage();await page.goto(origin);

  await t.test('unauthenticated view needs password and sends required POST headers',async()=>{
    await page.locator('#login-view').waitFor({state:'visible'});
    assert.equal(await page.locator('#dashboard').isVisible(),false);
    assert.match(await page.locator('.login-note').innerText(),/关闭本页.*继续检查/);
    await page.locator('#password').fill('incorrect');await page.locator('#login-button').click();
    await page.locator('#login-error').filter({hasText:'管理密码不正确'}).waitFor();
    assert.equal(await page.locator('#dashboard').isVisible(),false);
    await page.locator('#password').fill('unit-test-password');await page.locator('#login-button').click();
    await page.locator('#dashboard').waitFor({state:'visible'});
    assert.equal(await page.locator('#password').inputValue(),'');
    assert.equal(await page.locator('#notification-label').innerText(),'未配置推送');
    assert.equal(await page.locator('#toggle').isDisabled(),true);
    assert.equal(await page.locator('#stores .store').count(),0);
    assert.equal(await page.evaluate(()=>localStorage.length+sessionStorage.length),0);
    const login=calls.find(call=>call.path==='/api/login');assert.equal(login.headers['content-type'],'application/json');assert.equal(login.headers['x-monitor-request'],'1');
  });

  await t.test('settings presets and exact monitor config schema',async()=>{
    await page.locator('#configure').click();
    assert.equal(await page.locator('#address').inputValue(),'');
    assert.match(await page.locator('#push-help').innerText(),/服务器未配置推送/);
    await page.locator('#preset').selectOption('test');
    assert.equal(await page.locator('#part-number').inputValue(),'MJYJ4CH/A');
    assert.equal(await page.locator('#product-url').inputValue(),presetUrl);
    for(const value of ['29','3601','30.5']){await page.locator('#interval-seconds').fill(value);assert.equal(await page.locator('#interval-seconds').evaluate(input=>input.checkValidity()),false);}
    await page.locator('#interval-seconds').fill('90');await page.locator('#max-stores').fill('5');await page.locator('#address').fill('测试省 测试市 测试区');await page.locator('#notify-enabled').uncheck();
    await page.locator('#save-settings').click();
    await page.waitForFunction(()=>!document.getElementById('settings').open);
    const saved=calls.findLast(call=>call.path==='/api/config');
    assert.deepEqual(Object.keys(saved.body),['config']);
    assert.deepEqual(Object.keys(saved.body.config).sort(),Object.keys(config).sort());
    assert.equal(saved.body.config.intervalSeconds,90);assert.equal(saved.body.config.maxStores,5);assert.equal(saved.body.config.productUrl,presetUrl);assert.equal(saved.body.config.notifyEnabled,false);
    assert.equal(await page.locator('#toggle').isDisabled(),false);
    assert.match(await page.locator('#product-name').innerText(),/iPhone 18 Pro Max/);
    assert.match(await page.locator('.server-note').innerText(),/关闭本页不影响监控.*服务器停止期间不会检查/);
  });

  await t.test('start, stop, one-shot checks and pending duplicate guard',async()=>{
    await page.locator('#toggle').click();await page.locator('#toggle').filter({hasText:'暂停'}).waitFor();
    assert.equal(calls.at(-1).path,'/api/start');
    await page.locator('#toggle').click();await page.locator('#toggle').filter({hasText:'开始监控'}).waitFor();assert.equal(calls.at(-1).path,'/api/stop');
    holdPath='/api/check';
    await page.evaluate(()=>{document.getElementById('check-now').click();document.getElementById('check-now').click();document.getElementById('toggle').click();});
    await page.waitForFunction(()=>document.getElementById('configure').disabled);
    while(!releaseHold)await new Promise(resolve=>setTimeout(resolve,10));
    assert.equal(calls.filter(call=>call.path==='/api/check').length,1);
    holdPath='';releaseHold();releaseHold=null;
    await page.waitForFunction(()=>!document.getElementById('check-now').disabled);
    assert.equal(await page.locator('#checks').innerText(),'1');
  });

  await t.test('errors stay visible and configuration failure keeps settings open',async()=>{
    failPath='/api/check';await page.locator('#check-now').click();
    await page.locator('#notice').filter({hasText:'本地模拟：官网读取失败'}).waitFor();
    assert.equal(await page.locator('#check-now').isDisabled(),false);
    failPath='/api/config';await page.locator('#configure').click();await page.locator('#save-settings').click();
    await page.locator('#settings-error').filter({hasText:'本地模拟：官网读取失败'}).waitFor();
    assert.equal(await page.locator('#settings').evaluate(dialog=>dialog.open),true);await page.locator('#close-settings').click();
  });

  await t.test('an older failed poll does not override a newer successful operation',async()=>{
    holdPath='/api/state';failPath='/api/state';
    await page.evaluate(()=>{window.oldPoll=loadState();});
    while(!releaseHold)await new Promise(resolve=>setTimeout(resolve,10));
    await page.locator('#check-now').click();await page.waitForFunction(()=>!document.getElementById('check-now').disabled);
    holdPath='';releaseHold();releaseHold=null;
    await page.evaluate(()=>window.oldPoll);
    assert.equal(await page.locator('#dashboard').isVisible(),true);
    assert.equal(await page.locator('#notice').isVisible(),false);
  });

  await t.test('official order, unknown state, stale results, and plain-text unsafe values',async()=>{
    state.notificationsEnabled=true;state.config.notifyEnabled=true;state.status='available';state.stale=true;state.stores=[store('unknown','1'),{...store('available','2'),name:'<img src=x onerror=alert(1)>'},store('unavailable','3')];
    await page.locator('#check-now').click();await page.waitForFunction(()=>document.querySelectorAll('.store').length===3);
    assert.deepEqual(await page.locator('.store-name').allTextContents(),['官网排序门店 1','<img src=x onerror=alert(1)>','官网排序门店 3']);
    assert.equal(await page.locator('.store img').count(),0);assert.equal(await page.locator('.availability.unknown').innerText(),'未知');
    assert.equal(await page.locator('#status-title').innerText(),'上次发现可自提');assert.equal(await page.locator('#freshness').innerText(),'上次结果 · 已过期');
    assert.equal(await page.locator('#available-count').innerText(),'1');assert.equal(await page.locator('#notification-label').innerText(),'服务器推送已开');
    state.stale=false;state.stores=[store('unknown','1'),store('available','2'),store('unavailable','3')];await page.locator('#check-now').click();await page.waitForFunction(()=>!document.getElementById('stores').classList.contains('stale'));
    await mkdir(fileURLToPath(new URL('../test-artifacts/',import.meta.url)),{recursive:true});
    await page.locator('.shell').screenshot({path:fileURLToPath(new URL('../test-artifacts/server-monitor-preview.png',import.meta.url))});
    await page.setViewportSize({width:320,height:720});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    await page.locator('#configure').click();assert.equal(await page.locator('#settings').evaluate(dialog=>dialog.scrollWidth<=dialog.clientWidth),true);await page.locator('#close-settings').click();
  });

  await t.test('expired authentication returns to login, then logout ends the session',async()=>{
    stateUnauthorizedOnce=true;await page.reload();await page.locator('#login-view').waitFor({state:'visible'});
    assert.equal(await page.locator('#dashboard').isVisible(),false,'a session expiring between session check and state load cannot reveal the dashboard');
    await page.locator('#password').fill('unit-test-password');await page.locator('#login-button').click();await page.locator('#dashboard').waitFor({state:'visible'});
    expired=true;await page.locator('#check-now').click();await page.locator('#login-view').waitFor({state:'visible'});
    assert.match(await page.locator('#login-error').innerText(),/登录已过期/);assert.equal(await page.locator('#dashboard').isVisible(),false);
    await page.locator('#password').fill('unit-test-password');await page.locator('#login-button').click();await page.locator('#dashboard').waitFor({state:'visible'});
    await page.locator('#logout').click();await page.locator('#login-view').waitFor({state:'visible'});assert.equal(authenticated,false);
    assert.equal(calls.at(-1).path,'/api/logout');
  });
  for(const call of calls.filter(call=>call.method==='POST')){assert.equal(call.headers['content-type'],'application/json');assert.equal(call.headers['x-monitor-request'],'1');}
  assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
});
