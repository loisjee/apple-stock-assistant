import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
const source = await readFile(new URL('../pickup-page.js', import.meta.url), 'utf8');
const context = vm.createContext({ URL });
vm.runInContext(source, context);
const h = context.__shikePickupInternals;

test('pickup adapter only accepts specific Apple product pages, never cart, checkout, credentials or other hosts', () => {
  for (const value of ['https://www.apple.com.cn/shop/product/MK2T4CH/A', 'https://www.apple.com.cn/shop/buy-iphone/iphone-18-pro/mjyj4ch/a']) assert.equal(h.allowedPage(value), true);
  for (const value of ['https://www.apple.com.cn/shop/bag', 'https://secure6.www.apple.com.cn/shop/checkout', 'https://www.apple.com.cn/shop/buy-iphone/iphone-18-pro?step=attach', 'https://www.apple.com.cn.evil.invalid/shop/product/MK2T4CH/A', 'https://someone@www.apple.com.cn/shop/product/MK2T4CH/A', 'http://www.apple.com.cn/shop/product/MK2T4CH/A', 'https://www.apple.com.cn:8443/shop/product/MK2T4CH/A']) assert.equal(h.allowedPage(value), false);
  assert.equal(h.exactSku('/shop/product/mk2t4ch/a', 'MK2T4CH/A'), true);
  assert.equal(h.exactSku('/shop/product/XMK2T4CH/A', 'MK2T4CH/A'), false);
  assert.equal(h.exactSku('/shop/product/MK2T4CH/AB', 'MK2T4CH/A'), false);
});

test('only explicit per-store pickup status is available; negative phrases override positive substrings', () => {
  for (const value of ['今天可取货 店内取货', '可于明天提供', '取货：今天', 'Available today']) assert.equal(h.availability(value), 'available');
  for (const value of ['不可取货', '目前无货', '取货：今天 暂不提供取货', 'not available for pickup']) assert.equal(h.availability(value), 'unavailable');
  for (const value of ['查看供货情况', '店内取货', 'Apple 上海环贸 iapm', '正在加载', '今天']) assert.equal(h.availability(value), 'unknown');
  assert.equal(h.regionMatches('四川', '四川省成都市锦江区'), true);
  assert.equal(h.regionMatches('上海', '上海市徐汇区'), true);
  assert.equal(h.regionMatches('继续', '继续'), false);
  assert.equal(h.stripRegion('四川省成都市锦江区', '四川'), '成都市锦江区');
});

let chromium;
try { ({ chromium } = await import('playwright')); } catch { /* pure guards remain portable */ }
const skuUrl = 'https://www.apple.com.cn/shop/product/MK2T4CH/A';
const row = (name, status, distance = '2.3 km') => `<li data-store-id="${name.replace(/\s/g, '')}"><h3>${name}</h3><p class="store-address">上海市徐汇区示例路 1 号</p><p>${distance}</p><p class="availability">${status}</p><input type="radio" value="${name}" onclick="window.storeClicks++"></li>`;
const list = () => row('Apple 上海环贸 iapm', '今天可取货 店内取货') + row('Apple 静安', '不可取货', '5.9 km') + row('Apple 南京东路', '正在查询', '6.5 km');
const shell = dialog => `<main><h1>iPhone Duo 1TB 星光白色</h1><button onclick="window.cartClicks++">添加到购物袋</button><button id="open" onclick="document.querySelector('#pickup').hidden=false">查看供货情况</button></main><section id="pickup" role="dialog" aria-label="iPhone 供货情况" hidden><h2>iPhone 供货情况</h2>${dialog}<button onclick="window.continueClicks++">继续</button></section>`;

async function fixture(t, html, url = skuUrl) {
  let browser;
  try { browser = await chromium.launch({ headless: true, channel: 'chrome' }); } catch { browser = await chromium.launch({ headless: true }); }
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.route('**/*', route => route.fulfill({ status: 200, contentType: 'text/html', body: '<html><head><title>Pickup fixture</title></head><body></body></html>' }));
  await page.goto(url); await page.setContent(html);
  await page.evaluate(() => {
    window.cartClicks = 0; window.continueClicks = 0; window.storeClicks = 0; window.overlayEvents = []; window.monitorScrolls = 0;
    HTMLElement.prototype.scrollIntoView = () => { window.monitorScrolls++; };
    window.__shikeOverlay = { suspend: () => window.overlayEvents.push('hide'), resume: () => window.overlayEvents.push('show') };
    window.chrome = { runtime: { id: 'pickup-fixture', getURL: path => `chrome-extension://pickup-fixture/${path}`, onMessage: { addListener: listener => window.pickupListener = listener } } };
    window.sendPickup = (message, sender = { id: 'pickup-fixture', url: 'chrome-extension://pickup-fixture/pickup-background.mjs' }) => new Promise(resolve => { const pending = window.pickupListener(message, sender, resolve); if (!pending && !['PICKUP_PAGE_CHECK', 'PICKUP_PAGE_CANCEL'].includes(message.type)) resolve(null); });
  });
  await page.addScriptTag({ content: source });
  const send = (address = '200030', overrides = {}) => page.evaluate(message => window.sendPickup(message), { type: 'PICKUP_PAGE_CHECK', config: { partNumber: 'MK2T4CH/A', address, maxStores: 10 }, runToken: 'pickup-test', ...overrides });
  return { page, send };
}

function postalFixture({ stale = false, invalid = false } = {}) {
  return shell(`<p>显示此地提供的选项：<button id="location">100000</button></p><form onsubmit="return false"><label for="postal">邮政编码</label><input id="postal" value="100000"><button type="button" id="search" onclick="document.querySelector('#location').textContent=document.querySelector('#postal').value; ${stale ? '' : `document.querySelector('#stores').innerHTML=window.newRows; window.searches++;`}">搜索</button></form><p>前往此地附近的 Apple Store 零售店取货：<span id="where">100000</span></p><ul id="stores" aria-label="门店">${row('Apple 旧地址门店', '今天可取货')}</ul><script>window.searches=0;window.newRows=${JSON.stringify(invalid ? '<li>加载失败</li>' : list())};</script>`);
}

test('Chromium pickup: postal update, nearest rows, explicit unavailable/unknown, fresh repeat and no purchase actions', { skip: !chromium }, async t => {
  const { page, send } = await fixture(t, postalFixture());
  const first = await send();
  assert.equal(first.stage, 'checked');
  assert.deepEqual(first.stores.map(store => store.name), ['Apple 上海环贸 iapm', 'Apple 静安', 'Apple 南京东路']);
  assert.deepEqual(first.stores.map(store => store.availability), ['available', 'unavailable', 'unknown']);
  assert.equal(first.stores[0].distanceText, '2.3 km');
  assert.equal(first.stores[0].address, '上海市徐汇区示例路 1 号');
  const second = await send(); assert.equal(second.stage, 'checked');
  assert.equal(await page.evaluate(() => window.searches), 2, 'each check must query through the public UI again');
  assert.equal(await page.evaluate(() => window.monitorScrolls), 0, 'monitor DOM clicks must not scroll or close popovers through deferred scroll handlers');
  assert.deepEqual(await page.evaluate(() => [window.cartClicks, window.continueClicks, window.storeClicks]), [0, 0, 0]);
  assert.equal(await page.evaluate(() => window.overlayEvents.filter(value => value === 'hide').length), await page.evaluate(() => window.overlayEvents.filter(value => value === 'show').length));
});

test('Chromium pickup: changed address heading and old-row styling cannot attribute an unchanged store list to the new address', { skip: !chromium }, async t => {
  const { page, send } = await fixture(t, postalFixture({ stale: true }));
  await page.evaluate(() => {
    const search = document.querySelector('#search'), original = search.onclick;
    search.onclick = () => { original(); const row = document.querySelector('#stores li'); row.classList.add('selected'); row.hidden = false; };
  });
  const result = await send();
  assert.equal(result.stage, 'waitingResults'); assert.equal(result.stores.length, 0);
  assert.match(result.reason, /旧位置/);
});

test('Chromium pickup: province/district municipality picker and accessible radio-only rows', { skip: !chromium }, async t => {
  const html = shell(`<p>显示此地提供的选项：<button id="location" onclick="document.querySelector('#regions').hidden=false">上海</button></p><div id="regions" hidden><button role="tab">省份</button><button onclick="document.querySelector('#regions').innerHTML='<button role=tab>上海 省份</button><button role=tab>区</button><button id=district>徐汇区</button>'; document.querySelector('#district').onclick=()=>{document.querySelector('#regions').hidden=true;document.querySelector('#stores').innerHTML=window.nextStores}">上海</button></div><p>前往此地附近的 Apple Store 零售店取货：上海</p><div id="stores" aria-label="门店"><div role="radio" aria-label="Apple 旧门店 上海, 上海 50 km 今天可取货 店内取货" tabindex="0"></div></div><script>window.nextStores='<div role="radio" aria-label="Apple 上海环贸 iapm 上海, 上海 5.32 km 今天可取货 店内取货" tabindex="0" style="width:200px;height:40px"></div>';</script>`);
  const { send } = await fixture(t, html);
  const result = await send('上海市徐汇区');
  assert.equal(result.stage, 'checked', result.reason); assert.equal(result.stores[0].name, 'Apple 上海环贸 iapm');
  assert.equal(result.stores[0].availability, 'available'); assert.equal(result.stores[0].distanceText, '5.32 km');
});

test('Chromium pickup: SKU mismatch prevents opening the modal and CAPTCHA requires manual action', { skip: !chromium }, async t => {
  const { page, send } = await fixture(t, postalFixture(), 'https://www.apple.com.cn/shop/product/ABCDECH/A');
  assert.equal((await send()).stage, 'productMismatch');
  assert.equal(await page.locator('#pickup').isVisible(), false);
  await page.goto(skuUrl); await page.setContent('<main><h1>安全验证</h1><p>请完成验证码</p><button>同意并继续</button></main>');
  await page.evaluate(() => { window.chrome = { runtime: { id: 'pickup-fixture', getURL: path => `chrome-extension://pickup-fixture/${path}`, onMessage: { addListener: listener => window.pickupListener = listener } } }; window.sendPickup = message => new Promise(resolve => window.pickupListener(message, { id: 'pickup-fixture' }, resolve)); });
  await page.addScriptTag({ content: source });
  const result = await send(); assert.equal(result.stage, 'human'); assert.equal(result.requiresHuman, true);
});

test('Chromium pickup: cancellation interrupts waits; a new token can run later', { skip: !chromium }, async t => {
  const { page, send } = await fixture(t, postalFixture({ stale: true }));
  const pending = send();
  await page.waitForTimeout(250);
  const cancelled = await page.evaluate(() => window.sendPickup({ type: 'PICKUP_PAGE_CANCEL', runToken: 'pickup-test' }));
  assert.equal(cancelled.cancelled, true); assert.equal((await pending).stage, 'cancelled');
  await page.evaluate(() => { document.querySelector('#search').onclick = () => { document.querySelector('#location').textContent='200030'; document.querySelector('#stores').innerHTML=window.newRows; }; });
  assert.equal((await send('200030', { runToken: 'new-run' })).stage, 'checked');
});

test('Chromium pickup: changed modal configuration is rejected even while the product URL retains the target SKU', { skip: !chromium }, async t => {
  const options = `<fieldset><label><input type="radio" name="model" checked>iPhone Duo</label><label><input type="radio" name="color" value="white" checked>星光白色</label><label><input type="radio" name="color" id="wrong-color" value="blue">冰川蓝色</label><label><input type="radio" name="capacity" checked>1TB<sup><a href="#footnote-1" aria-label="脚注 1">1</a></sup></label></fieldset>`;
  const { page, send } = await fixture(t, postalFixture().replace('<h2>iPhone 供货情况</h2>', `<h2>iPhone 供货情况</h2>${options}`));
  assert.equal((await send()).stage, 'checked');
  await page.locator('#wrong-color').check();
  const mismatch = await send();
  assert.equal(mismatch.stage, 'productMismatch'); assert.equal(mismatch.stores.length, 0);
  assert.equal(await page.evaluate(() => window.searches), 1, 'mismatched SKU must not trigger an address query');
  await page.locator('input[name="color"][value="white"]').check();
  await page.evaluate(() => { const capacity = document.querySelector('input[name="capacity"]'); capacity.parentElement.replaceChildren(capacity, document.createTextNode('2TB')); });
  const wrongCapacity = await send(); assert.equal(wrongCapacity.stage, 'productMismatch'); assert.equal(wrongCapacity.diagnostic.code, 'CONFIG_CAPACITY');
  assert.equal(await page.evaluate(() => window.searches), 1, 'wrong 2TB capacity must remain blocked after removing a 1TB footnote');
});

test('Chromium pickup: whole store-list wrapper cannot become a fabricated combined available store; extra-results controls remain untouched', { skip: !chromium }, async t => {
  const radios = `<div class="store-list"><div role="radio" aria-label="Apple 上海环贸 iapm 上海, 上海 5.32 km 今天可取货 店内取货" style="height:30px;width:200px"></div><div role="radio" aria-label="Apple 静安 上海, 上海 5.83 km 不可取货 店内取货" style="height:30px;width:200px"></div><button onclick="window.moreClicks++">查看更多零售店</button></div>`;
  const { page, send } = await fixture(t, postalFixture());
  await page.evaluate(html => { window.newRows = html; window.moreClicks = 0; }, radios);
  const result = await send();
  assert.equal(result.stage, 'checked'); assert.equal(result.stores.length, 2);
  assert.deepEqual(result.stores.map(store => store.availability), ['available', 'unavailable']);
  assert.deepEqual(result.stores.map(store => store.name), ['Apple 上海环贸 iapm', 'Apple 静安']);
  assert.equal(await page.evaluate(() => window.moreClicks), 0);
});

test('Chromium pickup: public no-nearby-store response is distinct from unavailable stock or a malformed page', { skip: !chromium }, async t => {
  const { page, send } = await fixture(t, postalFixture());
  await page.evaluate(() => { window.newRows = '<li>附近没有 Apple Store 零售店</li>'; });
  const result = await send(); assert.equal(result.stage, 'noStores'); assert.equal(result.stores.length, 0); assert.equal(result.retryable, true);
});

test('Chromium pickup: delayed store-name opener inside inline wrappers uses bounded pickup-caption context', { skip: !chromium }, async t => {
  const late = `<section><p>立即订购。取货 (店内)：今天</p><span><span id="late-opener"></span></span></section><button onclick="window.cartClicks++">AppleCare+</button><script>setTimeout(() => { const b=document.createElement('button');b.textContent='Apple 成都太古里';b.onclick=()=>document.querySelector('#pickup').hidden=false;document.querySelector('#late-opener').append(b);}, 300);</script>`;
  const html = postalFixture().replace('<button id="open" onclick="document.querySelector(\'#pickup\').hidden=false">查看供货情况</button>', late);
  const { page, send } = await fixture(t, html);
  const result = await send();
  assert.equal(result.stage, 'checked', result.reason);
  assert.deepEqual(await page.evaluate(() => [window.cartClicks, window.continueClicks, window.storeClicks]), [0, 0, 0]);
});

test('Chromium pickup: repeated region checks reopen a city location button after its postal label changes, through nested inline wrappers', { skip: !chromium }, async t => {
  const html = shell(`<p>显示此地提供的选项：<span id="location-wrap"><button id="location" onclick="window.showRegions()">610000</button></span></p><div id="regions" hidden></div><p>前往此地附近的 Apple Store 零售店取货：上海</p><ul id="stores" aria-label="门店">${row('Apple 旧地址门店', '不可取货')}</ul>`);
  const { page, send } = await fixture(t, html);
  await page.evaluate(stores => {
    window.regionQueries = 0; window.provinceResets = 0; window.locationOpens = 0;
    const regions = document.querySelector('#regions');
    const showDistrict = () => {
      regions.innerHTML = '<button role="tab" aria-selected="false" id="reset-province">上海 省份</button><button role="tab" aria-selected="true">徐汇区 区</button><button id="district">徐汇区</button>';
      document.querySelector('#reset-province').onclick = () => { window.provinceResets++; showProvince(); };
      document.querySelector('#district').onclick = () => {
        window.regionQueries++; regions.hidden = true;
        document.querySelector('#location-wrap').innerHTML = '<span><span><button id="location" onclick="window.showRegions()">上海</button></span></span>';
        document.querySelector('#stores').innerHTML = stores;
      };
    };
    const showProvince = () => {
      regions.innerHTML = '<button role="tab" aria-selected="true">省份</button><button id="province">上海</button>';
      document.querySelector('#province').onclick = showDistrict;
    };
    window.showRegions = () => { window.locationOpens++; if (window.locationOpens === 1) return; regions.hidden = false; if (window.regionQueries) showDistrict(); else showProvince(); };
  }, list());
  const first = await send('上海市徐汇区'); assert.equal(first.stage, 'checked', first.reason);
  const second = await send('上海市徐汇区'); assert.equal(second.stage, 'checked', second.reason);
  assert.equal(await page.evaluate(() => window.regionQueries), 2);
  assert.equal(await page.evaluate(() => window.locationOpens), 3, 'ignored first click may retry the read-only opener exactly once');
  assert.equal(await page.evaluate(() => window.provinceResets), 1, 'reopened remembered district layer must reset to province before matching a full address');
  assert.deepEqual(second.stores.map(store => store.availability), ['available', 'unavailable', 'unknown']);
  assert.deepEqual(await page.evaluate(() => [window.cartClicks, window.continueClicks, window.storeClicks]), [0, 0, 0]);
});

test('Chromium pickup: replaced location control fails safely with a bounded local diagnostic, and never clicks a detached node', { skip: !chromium }, async t => {
  const { page, send } = await fixture(t, postalFixture());
  await page.evaluate(() => {
    document.querySelector('form').hidden = true;
    const control = document.querySelector('#location');
    const overlay = window.__shikeOverlay;
    window.__shikeOverlay = { suspend() { overlay.suspend(); if (!document.querySelector('#pickup').hidden) queueMicrotask(() => control.replaceWith(control.cloneNode(true))); }, resume: overlay.resume };
  });
  const result = await send();
  assert.equal(result.stage, 'waitingPage');
  assert.equal(result.diagnostic.step, 'open-location');
  assert.equal(result.diagnostic.code, 'PICKUP_BUTTON_UNAVAILABLE');
  assert.deepEqual(await page.evaluate(() => [window.cartClicks, window.continueClicks, window.storeClicks]), [0, 0, 0]);
});

test('Chromium pickup: a check stops at its elapsed deadline rather than continuing location actions after expiration', { skip: !chromium }, async t => {
  const { page, send } = await fixture(t, postalFixture({ stale: true }));
  const pending = send();
  await page.waitForTimeout(250);
  await page.evaluate(() => { const actualNow = Date.now.bind(Date); Date.now = () => actualNow() + 30000; });
  const result = await pending;
  assert.equal(result.stage, 'waitingPage'); assert.equal(result.diagnostic.code, 'PICKUP_TIMEOUT');
  assert.equal(result.stores.length, 0);
  assert.deepEqual(await page.evaluate(() => [window.cartClicks, window.continueClicks, window.storeClicks]), [0, 0, 0]);
});
