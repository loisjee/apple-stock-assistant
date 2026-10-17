import test from 'node:test';
import assert from 'node:assert/strict';
import { createPickupBrowser, isReadonlyProductUrl } from '../server/browser.mjs';

const target = { partNumber: 'MK2T4CH/A', productUrl: 'https://www.apple.com.cn/shop/product/MK2T4CH/A', productName: 'iPhone Duo 1TB 星光白色', address: '200030', maxStores: 10 };
const storeRows = '<li data-store-id="R001"><h3>Apple 上海环贸 iapm</h3><p class="store-address">上海市徐汇区示例路 1 号</p><p>5.32 km</p><p class="availability">今天可取货 店内取货</p><input type="radio" onclick="window.purchaseClicks++"></li><li data-store-id="R002"><h3>Apple 静安</h3><p>5.83 km</p><p class="availability">不可取货</p></li>';
function fixtureHtml(stale = false) {
  return `<html lang="zh-CN"><head><title>Pickup fixture only</title></head><body><main><h1>iPhone Duo 1TB 星光白色</h1><button onclick="window.purchaseClicks++">添加到购物袋</button><button id="pickup-open" onclick="document.querySelector('#pickup').hidden=false">查看供货情况</button></main><section role="dialog" aria-label="iPhone 供货情况" id="pickup" hidden><h2>iPhone 供货情况</h2><span>iPhone Duo 1TB 星光白色</span><p>显示此地提供的选项：<button id="location">100000</button></p><form onsubmit="return false"><label>邮政编码<input id="postal" value="100000"></label><button type="button" onclick="window.searches++;document.querySelector('#location').textContent=document.querySelector('#postal').value;${stale ? '' : 'document.querySelector(\'#stores\').innerHTML=window.newRows;'}">搜索</button></form><ul id="stores" aria-label="门店"><li><h3>Apple 旧地址门店</h3><p>不可取货</p></li></ul><button onclick="window.purchaseClicks++">继续</button></section><script>window.purchaseClicks=0;window.searches=0;window.newRows=${JSON.stringify(storeRows)};</script></body></html>`;
}
let chromium;
try { ({ chromium } = await import('playwright')); } catch { /* browser fixtures optional for source-only installs */ }
async function launch() {
  try { return await chromium.launch({ headless: true, channel: 'chrome' }); } catch { return chromium.launch({ headless: true }); }
}
async function fixtureRunner(t, extra = {}) {
  const underlying = await launch();
  const contexts = [], pages = [], requests = [];
  const control = { stale: false, redirect: null, visibleSku: null, broken: false, delayedOpenerMs: 0, human: false, fulfillmentStatus: 0, noOpener: false, forceReadinessTimeout: false };
  const wrapped = {
    isConnected: () => underlying.isConnected(),
    async newContext(options) {
      const context = await underlying.newContext(options); contexts.push(context);
      context.on('page', page => pages.push(page));
      await context.route('**/*', route => {
        requests.push(route.request().url());
        if (new URL(route.request().url()).pathname === '/shop/fulfillment-messages') return route.fulfill({ status: control.fulfillmentStatus || 200, contentType: 'application/json', body: '{}' });
        let html = (control.human ? '<html><body><h1>安全验证</h1><p>请完成验证码</p></body></html>' : control.broken ? '<html><head><meta charset="utf-8"></head><body><h1>商店暂不可用</h1></body></html>' : fixtureHtml(control.stale)).replace('<main>', `<main>${control.visibleSku ? `<p data-autom="product-sku">${control.visibleSku}</p>` : ''}`);
        if (control.noOpener) html = html.replace('id="pickup-open"', 'id="pickup-open" hidden');
        if (control.fulfillmentStatus) html = html.replace('</body>', '<script>window.expectedFulfillment=true;fetch("/shop/fulfillment-messages?fae=true").then(()=>{window.fulfillmentCompleted=true});</script></body>');
        if (control.delayedOpenerMs) html = html.replace('id="pickup-open"', 'id="pickup-open" hidden').replace('</body>', `<script>setTimeout(()=>{document.querySelector('#pickup-open').hidden=false},${control.delayedOpenerMs});</script></body>`);
        return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: html });
      });
      // Redirect fixture: model the browser's final URL without issuing a 302 to
      // a remote origin (Playwright does not re-route an HTTP redirect's second hop).
      return new Proxy(context, { get(object, key) {
        if (key === 'newPage') return async () => {
          const current = await object.newPage();
          return new Proxy(current, { get(actual, property) {
            if (property === 'goto') return (url, opts) => actual.goto(control.redirect && url === target.productUrl ? control.redirect : url, opts);
            if (property === 'waitForFunction' && control.forceReadinessTimeout) return async () => {
              await actual.waitForFunction(() => document.readyState === 'complete' && (!window.expectedFulfillment || window.fulfillmentCompleted), null, { timeout: 5000 });
              const error = new Error('fixture readiness timeout'); error.name = 'TimeoutError'; throw error;
            };
            const value = Reflect.get(actual, property); return typeof value === 'function' ? value.bind(actual) : value;
          } });
        };
        const value = Reflect.get(object, key); return typeof value === 'function' ? value.bind(object) : value;
      } });
    },
  };
  const runner = await createPickupBrowser({ browser: wrapped, ...extra });
  t.after(async () => { await runner.close(); await underlying.close(); });
  return { runner, contexts, pages, requests, control, underlying };
}

test('server browser URL guard accepts exact public SKU product paths and rejects checkout, credentials, encoded paths, external URLs and mismatched SKU', () => {
  assert.equal(isReadonlyProductUrl(target.productUrl, target.partNumber), true);
  assert.equal(isReadonlyProductUrl('https://www.apple.com.cn/shop/buy-iphone/iphone-18-pro/mjyj4ch/a', 'MJYJ4CH/A'), true);
  for (const url of ['http://www.apple.com.cn/shop/product/MK2T4CH/A', 'https://evil.invalid/shop/product/MK2T4CH/A', 'https://www.apple.com.cn.evil.invalid/shop/product/MK2T4CH/A', 'https://user:secret@www.apple.com.cn/shop/product/MK2T4CH/A', 'https://www.apple.com.cn:8443/shop/product/MK2T4CH/A', 'https://www.apple.com.cn/shop/bag', 'https://www.apple.com.cn/shop/checkout', 'https://www.apple.com.cn/shop/product/MK2T4CH/A?step=attach', 'https://www.apple.com.cn/shop/product/MK2T4CH/A%2f..%2fbag', 'https://www.apple.com.cn/shop/buy-iphone']) assert.equal(isReadonlyProductUrl(url, target.partNumber), false, url);
  assert.equal(isReadonlyProductUrl(target.productUrl, 'MJYJ4CH/A'), false);
  assert.equal(isReadonlyProductUrl('https://www.apple.com.cn/shop/buy-iphone/iphone-duo'), true, 'read-only generic buy URL is safe during official redirects');
});

test('server browser rejects invalid targets before launch', async () => {
  let launches = 0;
  const runner = await createPickupBrowser({ chromium: { launch: () => { launches++; throw new Error('must not launch'); } } });
  for (const config of [{ ...target, productUrl: 'https://evil.invalid' }, { ...target, partNumber: 'wrong' }, { ...target, address: '' }, { ...target, maxStores: 99 }]) assert.equal((await runner.check(config)).ok, false);
  assert.equal(launches, 0); await runner.close();
});

test('server browser performs two fresh DOM checks without chrome runtime or purchase clicks', { skip: !chromium }, async t => {
  const { runner, pages, contexts, requests } = await fixtureRunner(t);
  const first = await runner.check(target);
  assert.equal(first.stage, 'checked', JSON.stringify(first));
  assert.deepEqual(first.stores.map(store => store.availability), ['available', 'unavailable']);
  assert.equal(first.stores[0].distanceText, '5.32 km');
  const second = await runner.check(target); assert.equal(second.stage, 'checked', second.reason);
  assert.equal(contexts.length, 1); assert.equal(pages.length, 1, 'one dedicated page is reused');
  assert.equal(await pages[0].evaluate(() => typeof globalThis.chrome?.runtime), 'undefined');
  assert.equal(await pages[0].evaluate(() => window.searches), 2);
  assert.equal(await pages[0].evaluate(() => window.purchaseClicks), 0);
  assert.deepEqual(requests, [target.productUrl], 'fixture router saw only the initial read-only product navigation');
});

test('server browser cancels active and queued checks promptly, closes stale page, and recovers for the next run', { skip: !chromium }, async t => {
  const { runner, pages, contexts, control } = await fixtureRunner(t);
  control.stale = true;
  const active = new AbortController(), queued = new AbortController();
  const first = runner.check(target, { signal: active.signal });
  while (!pages.length) await new Promise(resolve => setTimeout(resolve, 10));
  await pages[0].waitForFunction(() => window.searches === 1);
  const next = runner.check(target, { signal: queued.signal });
  const before = Date.now(); queued.abort(); assert.equal((await next).stage, 'cancelled');
  active.abort(); assert.equal((await first).stage, 'cancelled');
  assert.ok(Date.now() - before < 2000, 'AbortSignal must not wait for a page timer');
  control.stale = false;
  const recovered = await runner.check(target); assert.equal(recovered.stage, 'checked', recovered.reason);
  assert.equal(contexts.length, 2); assert.equal(pages[0].isClosed(), true);
  assert.equal(await pages.at(-1).evaluate(() => window.purchaseClicks), 0);
});

test('server browser recreates a crashed/closed page on the next check', { skip: !chromium }, async t => {
  const { runner, pages, contexts } = await fixtureRunner(t);
  assert.equal((await runner.check(target)).stage, 'checked');
  await pages[0].close();
  assert.equal((await runner.check(target)).stage, 'checked');
  assert.equal(contexts.length, 2);
});

test('server browser closes and rebuilds after a browser process disconnect', { skip: !chromium }, async t => {
  const launched = [];
  const factory = { async launch() {
    const browser = await launch(); launched.push(browser);
    return { isConnected: () => browser.isConnected(), close: () => browser.close(), async newContext(options) {
      const context = await browser.newContext(options);
      await context.route('**/*', route => route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: fixtureHtml() }));
      return context;
    } };
  } };
  const runner = await createPickupBrowser({ chromium: factory });
  t.after(async () => { await runner.close(); await Promise.allSettled(launched.map(browser => browser.close())); });
  assert.equal((await runner.check(target)).stage, 'checked'); await launched[0].close();
  assert.equal((await runner.check(target)).stage, 'checked'); assert.equal(launched.length, 2);
});

test('server browser blocks a direct top-level cart navigation before the fixture router can serve it', { skip: !chromium }, async t => {
  const { runner, pages, requests } = await fixtureRunner(t);
  assert.equal((await runner.check(target)).stage, 'checked');
  await assert.rejects(pages[0].goto('https://www.apple.com.cn/shop/bag'));
  assert.equal(requests.some(url => /\/shop\/bag/.test(url)), false);
  assert.equal((await runner.check(target)).stage, 'checked', 'next safe check recovers from the aborted navigation');
});

test('server browser check timeout is independent of a stalled page wait and safely recovers', { skip: !chromium }, async t => {
  const { runner, control, pages } = await fixtureRunner(t, { checkTimeoutMs: 250 });
  control.stale = true;
  const result = await runner.check(target);
  assert.equal(result.stage, 'waitingPage'); assert.equal(result.diagnostic.code, 'BROWSER_TIMEOUT'); assert.equal(result.stores.length, 0);
  control.stale = false;
  assert.equal((await runner.check(target)).stage, 'checked');
  assert.equal(pages[0].isClosed(), true);
});


test('server browser accepts a read-only generic buy final URL while the DOM still proves the target SKU', { skip: !chromium }, async t => {
  const { runner, control, pages } = await fixtureRunner(t);
  control.redirect = 'https://www.apple.com.cn/shop/buy-iphone/iphone-duo'; control.visibleSku = target.partNumber;
  const result = await runner.check(target);
  assert.equal(result.stage, 'checked', JSON.stringify(result));
  assert.equal(pages[0].url(), control.redirect);
  assert.equal(await pages[0].evaluate(() => window.purchaseClicks), 0);
});

test('server browser rejects a wrong SKU rendered after a safe generic buy redirect', { skip: !chromium }, async t => {
  const { runner, control, pages } = await fixtureRunner(t);
  control.redirect = 'https://www.apple.com.cn/shop/buy-iphone/iphone-duo'; control.visibleSku = 'MJYJ4CH/A';
  const result = await runner.check(target);
  assert.equal(result.stage, 'productMismatch'); assert.equal(result.requiresHuman, true); assert.equal(result.stores.length, 0);
  assert.equal(await pages[0].evaluate(() => window.searches), 0);
});


test('server browser refreshes a retryable failed product page on its next check rather than retaining a maintenance screen', { skip: !chromium }, async t => {
  const { runner, control, contexts } = await fixtureRunner(t, { checkTimeoutMs: 600 });
  control.broken = true;
  const missing = await runner.check(target); assert.equal(missing.stage, 'waitingPage'); assert.equal(missing.retryable, true);
  control.broken = false;
  const recovered = await runner.check(target); assert.equal(recovered.stage, 'checked', JSON.stringify(recovered));
  assert.equal(contexts.length, 2);
});


test('server browser waits for a pickup entry rendered after 2.5 seconds before starting the DOM check', { skip: !chromium }, async t => {
  const { runner, control, pages } = await fixtureRunner(t);
  control.delayedOpenerMs = 3200;
  const result = await runner.check(target);
  assert.equal(result.stage, 'checked', JSON.stringify(result));
  assert.equal(await pages[0].evaluate(() => window.searches), 1);
  assert.equal(await pages[0].evaluate(() => window.purchaseClicks), 0);
});

test('an official page-owned fulfillment HTTP failure reports a safe diagnostic and resets on the next check', { skip: !chromium }, async t => {
  const { runner, control, requests } = await fixtureRunner(t);
  Object.assign(control, { fulfillmentStatus: 541, noOpener: true, forceReadinessTimeout: true });
  const failed = await runner.check(target);
  assert.equal(failed.stage, 'waitingPage'); assert.equal(failed.retryable, true); assert.equal(failed.stores.length, 0);
  assert.deepEqual(failed.diagnostic, { step: 'server-browser', code: 'OFFICIAL_HTTP_ERROR', httpStatus: 541 });
  assert.match(failed.reason, /HTTP 541/); assert.doesNotMatch(JSON.stringify(failed), /https:|fulfillment-messages|fae=/);
  assert.ok(requests.some(url => new URL(url).pathname === '/shop/fulfillment-messages'), 'only the fixture page itself requests the fulfillment resource');
  control.fulfillmentStatus = 0;
  const next = await runner.check(target); assert.equal(next.diagnostic.code, 'READINESS_TIMEOUT'); assert.equal('httpStatus' in next.diagnostic, false);
});

test('server browser cancels while waiting for readiness without waiting for the delayed entry', { skip: !chromium }, async t => {
  const { runner, control, pages } = await fixtureRunner(t);
  control.delayedOpenerMs = 10000;
  const controller = new AbortController(), pending = runner.check(target, { signal: controller.signal });
  while (!pages.length) await new Promise(resolve => setTimeout(resolve, 10));
  await pages[0].waitForFunction(target => typeof globalThis.__shikePickupAdapter?.ready === 'function' && !globalThis.__shikePickupAdapter.ready(target), target);
  const before = Date.now(); controller.abort();
  assert.equal((await pending).stage, 'cancelled'); assert.ok(Date.now() - before < 2000);
  control.delayedOpenerMs = 0;
  assert.equal((await runner.check(target)).stage, 'checked');
});

test('server readiness immediately lets a CAPTCHA page reach the human-action gate', { skip: !chromium }, async t => {
  const { runner, control } = await fixtureRunner(t);
  control.human = true;
  const before = Date.now(), result = await runner.check(target);
  assert.equal(result.stage, 'human'); assert.equal(result.requiresHuman, true); assert.equal(result.stores.length, 0);
  assert.ok(Date.now() - before < 3000, 'human verification must not wait the normal readiness timeout');
});
