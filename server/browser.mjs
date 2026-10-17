import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

const adapterSource = await readFile(new URL('../pickup-page.js', import.meta.url), 'utf8');
const bootstrap = `globalThis.__shikePickupServerInit = true;\n${adapterSource}`;
const tidy = value => String(value ?? '').replace(/\s+/g, ' ').trim();
const skuPattern = /^[A-Z0-9]{5,12}\/A$/;

export function isReadonlyProductUrl(value, partNumber) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.hostname !== 'www.apple.com.cn' || url.port || url.username || url.password || url.searchParams.has('step') || /%|\\/.test(url.pathname)) return false;
    const path = url.pathname.replace(/\/$/, '');
    if (!/^\/shop\/(?:product\/[a-z0-9]{5,12}\/a|buy-[a-z0-9-]+(?:\/[a-z0-9-]+)*)$/i.test(path)) return false;
    if (!partNumber) return true;
    if (url.search) return false;
    const sku = tidy(partNumber).toUpperCase();
    return skuPattern.test(sku) && path.toUpperCase().endsWith(`/${sku}`);
  } catch { return false; }
}

function normalizeTarget(config) {
  const partNumber = tidy(config?.partNumber).toUpperCase();
  if (!skuPattern.test(partNumber)) throw new Error('请填写有效的 Apple 商品编号。');
  if (!isReadonlyProductUrl(config?.productUrl, partNumber)) throw new Error('请使用包含目标商品编号的苹果中国官网具体商品链接；购物袋、结账及其他网站不受支持。');
  const address = tidy(config?.address);
  if (!address || address.length > 200) throw new Error('请填写不超过 200 字的查询位置。');
  const maxStores = Number(config.maxStores ?? 10);
  if (!Number.isInteger(maxStores) || maxStores < 1 || maxStores > 20) throw new Error('门店数量必须为 1 至 20。');
  const productName = tidy(config.productName);
  if (productName.length > 200) throw new Error('商品名称过长。');
  const url = new URL(config.productUrl); url.hash = '';
  return { partNumber, productUrl: url.href, productName, address, maxStores };
}
const cancelled = () => ({ ok: true, stage: 'cancelled', stores: [], reason: '库存监控已暂停。', retryable: false });
const unavailable = (reason, code) => ({ ok: true, stage: 'waitingPage', stores: [], reason, retryable: true, diagnostic: { step: 'server-browser', code } });
const timedOut = () => unavailable('官网页面本轮检查超时，将等待下次检查。', 'BROWSER_TIMEOUT');

/** Dedicated read-only product-page runner. No account profile, API requests, or purchase steps. */
export async function createPickupBrowser(options = {}) {
  const navigationTimeout = Number(options.navigationTimeoutMs ?? 30000);
  const checkTimeout = Number(options.checkTimeoutMs ?? 35000);
  if (![navigationTimeout, checkTimeout].every(value => Number.isFinite(value) && value > 0 && value <= 120000)) throw new Error('浏览器超时设置无效。');
  let browser = options.browser || options.page?.context?.().browser?.() || null;
  let ownsBrowser = false, context = null, page = null, ownsContext = false;
  let initialPage = options.page || null, closed = false, version = 0, activeController = null, pageNeedsReload = false;
  let queue = Promise.resolve();
  const retiring = new Set(), initializing = new Set();
  function track(set, promise) { set.add(promise); promise.finally(() => set.delete(promise)).catch(() => {}); return promise; }
  function interrupted(signal) { if (closed || signal?.aborted) throw new Error('PICKUP_RUN_ABORTED'); }
  function retirePage() {
    version++;
    const oldContext = context, oldPage = page, closeContext = ownsContext;
    context = null; page = null; ownsContext = false; pageNeedsReload = false;
    const pending = Promise.resolve().then(() => closeContext ? oldContext?.close() : oldPage?.close()).catch(() => {});
    return track(retiring, pending);
  }
  async function preparePage(signal) {
    interrupted(signal);
    if (page && !pageNeedsReload && !page.isClosed() && (!browser || browser.isConnected())) return page;
    if (page || context) await retirePage();
    const expectedVersion = version;
    const stillCurrent = () => !closed && !signal.aborted && version === expectedVersion;
    let candidateContext, candidatePage, candidateContextOwned = false;
    if (initialPage && !initialPage.isClosed()) {
      candidatePage = initialPage; initialPage = null;
      candidateContext = candidatePage.context();
    } else {
      initialPage = null;
      if (!browser || !browser.isConnected()) {
        const chromium = options.chromium || (await import('playwright')).chromium;
        const launchOptions = { headless: options.headless !== false, timeout: navigationTimeout };
        if (options.executablePath) launchOptions.executablePath = options.executablePath;
        else if (options.channel) launchOptions.channel = options.channel;
        const launched = await chromium.launch(launchOptions);
        if (!stillCurrent()) { await launched.close().catch(() => {}); throw new Error('PICKUP_RUN_ABORTED'); }
        browser = launched; ownsBrowser = true;
      }
      candidateContext = await browser.newContext({ locale: 'zh-CN', timezoneId: 'Asia/Shanghai', viewport: { width: 1280, height: 960 } });
      candidateContextOwned = true;
      if (!stillCurrent()) { await candidateContext.close().catch(() => {}); throw new Error('PICKUP_RUN_ABORTED'); }
      candidatePage = await candidateContext.newPage();
    }
    if (!stillCurrent()) {
      await (candidateContextOwned ? candidateContext.close() : candidatePage.close()).catch(() => {});
      throw new Error('PICKUP_RUN_ABORTED');
    }
    context = candidateContext; page = candidatePage; ownsContext = candidateContextOwned;
    // Block unsafe direct navigations. Playwright routes only the first HTTP URL
    // in a redirect chain; the final page is checked again before any DOM action.
    await candidatePage.route('**/*', async route => {
      const request = route.request();
      let topLevel = false;
      try { topLevel = request.isNavigationRequest() && request.frame() === candidatePage.mainFrame(); } catch { /* unsupported worker request is not a top-level navigation */ }
      if (topLevel && !isReadonlyProductUrl(request.url())) { pageNeedsReload = true; return route.abort('blockedbyclient'); }
      return route.fallback();
    });
    await candidatePage.addInitScript({ content: bootstrap });
    candidatePage.on('popup', popup => { void popup.close().catch(() => {}); });
    interrupted(signal);
    return candidatePage;
  }
  async function perform(config, signal) {
    if (closed || signal?.aborted) return cancelled();
    const controller = new AbortController(); activeController = controller;
    const externalAbort = () => controller.abort('cancelled');
    signal?.addEventListener('abort', externalAbort, { once: true });
    if (signal?.aborted) externalAbort();
    const runToken = `server-${randomUUID()}`;
    let timer, abortListener, responsePage, officialHttpStatus = null;
    const observeResponse = response => {
      try {
        const url = new URL(response.url()), status = response.status();
        if (url.origin === 'https://www.apple.com.cn' && url.pathname === '/shop/fulfillment-messages'
          && response.request().frame() === responsePage.mainFrame() && Number.isInteger(status) && status >= 400 && status <= 599) officialHttpStatus = status;
      } catch { /* Ignore non-page/service-worker responses and malformed URLs. */ }
    };
    const aborted = new Promise(resolve => {
      abortListener = () => {
        const current = page;
        if (current && !current.isClosed()) void current.evaluate(token => globalThis.__shikePickupAdapter?.cancel(token), runToken).catch(() => {});
        void retirePage();
        resolve(controller.signal.reason === 'timeout' ? timedOut() : cancelled());
      };
      controller.signal.addEventListener('abort', abortListener, { once: true });
      if (controller.signal.aborted) abortListener();
    });
    const work = (async () => {
      const initialization = preparePage(controller.signal);
      const current = await track(initializing, initialization);
      interrupted(controller.signal);
      responsePage = current;
      current.on('response', observeResponse);
      if (current.url() !== config.productUrl) await current.goto(config.productUrl, { waitUntil: 'domcontentloaded', timeout: navigationTimeout });
      interrupted(controller.signal);
      if (!isReadonlyProductUrl(current.url())) return { ok: true, stage: 'blocked', stores: [], reason: '官网已离开目标商品页，监控已停止。', requiresHuman: true, retryable: false };
      timer = setTimeout(() => controller.abort('timeout'), checkTimeout);
      const installed = await current.evaluate(() => typeof globalThis.__shikePickupAdapter?.check === 'function');
      if (!installed) await current.evaluate(bootstrap);
      interrupted(controller.signal);
      try {
        const readiness = await current.waitForFunction(target => globalThis.__shikePickupAdapter?.ready(target) === true, config, { polling: 100, timeout: Math.min(15000, checkTimeout) });
        await readiness.dispose();
      } catch (error) {
        if (controller.signal.aborted || error.name !== 'TimeoutError') throw error;
        await retirePage();
        if (officialHttpStatus !== null) return { ...unavailable(`官网供货信息请求失败（HTTP ${officialHttpStatus}），本轮没有库存结果。`, 'OFFICIAL_HTTP_ERROR'), diagnostic: { step: 'server-browser', code: 'OFFICIAL_HTTP_ERROR', httpStatus: officialHttpStatus } };
        return unavailable('官网取货供货信息尚未加载，将等待下一次检查。', 'READINESS_TIMEOUT');
      }
      interrupted(controller.signal);
      const result = await current.evaluate(({ target, token }) => globalThis.__shikePickupAdapter.check(target, token), { target: config, token: runToken });
      if (result?.retryable === true && !result.requiresHuman && result.stage !== 'checked') await retirePage();
      return result;
    })().catch(async () => {
      if (controller.signal.aborted || closed) return controller.signal.reason === 'timeout' ? timedOut() : cancelled();
      await retirePage();
      return unavailable('官网页面暂时无法加载或浏览器已断开，将在下次检查重新打开。', 'BROWSER_UNAVAILABLE');
    });
    try { return await Promise.race([work, aborted]); }
    finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', externalAbort);
      controller.signal.removeEventListener('abort', abortListener);
      responsePage?.off('response', observeResponse);
      if (activeController === controller) activeController = null;
    }
  }
  return Object.freeze({
    check(config, { signal } = {}) {
      let target;
      try { target = normalizeTarget(config); }
      catch (error) { return Promise.resolve({ ok: false, error: error.message, retryable: false }); }
      if (closed || signal?.aborted) return Promise.resolve(cancelled());
      // Each runner owns one page; callers cannot overlap mutations on it.
      const task = queue.then(() => perform(target, signal));
      queue = task.catch(() => {});
      if (!signal) return task;
      // A queued request can be cancelled without waiting for the active request.
      return new Promise(resolve => {
        const abort = () => resolve(cancelled());
        signal.addEventListener('abort', abort, { once: true });
        task.then(resolve, () => resolve(unavailable('浏览器检查暂时失败。', 'BROWSER_UNAVAILABLE'))).finally(() => signal.removeEventListener('abort', abort));
        if (signal.aborted) abort();
      });
    },
    async close() {
      if (closed) return;
      closed = true;
      activeController?.abort('closed');
      await retirePage();
      await queue;
      await Promise.allSettled([...initializing, ...retiring]);
      if (ownsBrowser && browser) await browser.close().catch(() => {});
      browser = null;
    },
  });
}
