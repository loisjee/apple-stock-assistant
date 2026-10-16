/* Apple 中国官网结账动作录制器。仅操作用户已登录的页面，不读取或填写付款资料。 */
(() => {
  'use strict';

  const normalize = value => String(value ?? '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
  const normalizePath = value => String(value || '/').replace(/\/+$/, '') || '/';
  const SUBMIT_LABEL = /^(?:下订单|提交订单|确认订单|立即下单|确认并提交订单|提交我的订单|place(?: your)? order|submit order)$/i;
  // Observed navigation to the next checkout section; this does not authorize a payment action.
  const PAYMENT_NAV_LABEL = /^(?:继续选择付款方式|continue to payment method)$/i;
  // Generic navigation text can mention an address without containing a user's address.
  const PUBLIC_NAV_LABEL = /^(?:继续填写送货地址|继续选择付款方式|continue to payment method)$/i;
  const PROVIDER_RADIO_LABEL = /^(?:支付宝|微信支付)$/;
  const PAYMENT_LABEL = /(?:支付|付款|apple\s*pay|支付宝|微信|银联|信用卡|借记卡|银行卡|\bpay(?:ment)?\b|\bcredit\s*card\b|\bdebit\s*card\b)/i;
  const SAFE_LABEL = /^(?:继续|继续购物|继续结账|继续以访客身份结账|以访客身份结账|以游客身份继续|结账|立即结账|前往结账|查看购物袋|前往购物袋|加入购物袋|添加到购物袋|添加|选择|选取|确认|检查订单|完成|保存|确定|下一步|返回|配送|送货|送货上门|到店取货|自行取货|取货|免费配送|不添加|无需|不需要|不，谢谢|不用，谢谢|无 AppleCare\+ 服务|continue|checkout|check out|add to bag|view bag|review(?: your)? order|continue as guest|guest checkout|save|done|next|back|select|pickup|delivery|shipping|no thanks|\d{1,2})$/i;
  const PRIVATE_TEXT = /(?:@|\b\d{7,}\b|地址|收货人|姓名|联系人|手机号|电话|邮箱|邮编|address|phone|e-mail|email|contact|recipient|postal|billing)/i;
  const TOTAL_LABEL = /^(?:总计|总额|合计|订单总计|订单总额|订单合计|应付总额|应付款|总付款|total|order total|grand total)(?:[：:]|\s)*$/i;
  const QUANTITY_LABEL = /^(?:数量|商品数量|购买数量|quantity|qty)(?:[：:]|\s)*$/i;
  // Narrow public product mappings verified for the two configured examples.
  // Unknown part numbers must still be visible verbatim on the final page.
  const VERIFIED_PRODUCT_NAMES = Object.freeze({
    'MJYJ4CH/A': 'iPhone 18 Pro Max 1TB 冰川蓝色',
    'MK2T4CH/A': 'iPhone Duo 1TB 星光白色'
  });
  // Apple uses one /shop/checkout path for several public checkout stages.
  // Only these symbolic stage names may be recorded; session/auth query data is discarded.
  const CHECKOUT_STAGE = /^(?:Fulfillment|Shipping|Billing|Review)(?:-init)?$/i;
  const CLICKABLE = 'button,a[href],input[type="radio"],input[type="checkbox"],[role="button"],[role="radio"],[role="checkbox"]';

  function actionForLabel(value) {
    const text = normalize(value);
    if (PAYMENT_NAV_LABEL.test(text)) return 'click';
    if (PAYMENT_LABEL.test(text)) return 'payment';
    if (SUBMIT_LABEL.test(text)) return 'submitOrder';
    return 'click';
  }

  function safeLabel(value) {
    const label = normalize(value);
    if (label.length <= 80 && PUBLIC_NAV_LABEL.test(label)) return label;
    return label.length <= 80 && !PRIVATE_TEXT.test(label) && (SAFE_LABEL.test(label) || SUBMIT_LABEL.test(label) || PAYMENT_NAV_LABEL.test(label) || PROVIDER_RADIO_LABEL.test(label)) ? label : null;
  }

  function allowedOrigin(value) {
    try {
      const url = new URL(value);
      return url.protocol === 'https:' && !url.username && !url.password && !url.port && /^(?:www|secure\d*\.www)\.apple\.com\.cn$/.test(url.hostname);
    } catch { return false; }
  }

  function publicPageUrl(current) {
    try {
      const original = new URL(typeof current === 'string' ? current : current.href || `${current.origin}${current.pathname}${current.search || ''}`);
      if (!allowedOrigin(original.href)) return null;
      const stages = original.searchParams.getAll('_s');
      if (stages.length > 1 || (stages.length === 1 && !CHECKOUT_STAGE.test(stages[0]))) return null;
      const clean = new URL(`${original.origin}${normalizePath(original.pathname)}`);
      if (stages.length) clean.searchParams.set('_s', stages[0]);
      return clean.href;
    } catch { return null; }
  }

  function locationMatches(step, current) {
    if (!step) return false;
    const recorded = publicPageUrl(step.url || `${step.origin}${step.path}`);
    const actual = publicPageUrl(current);
    return recorded !== null && actual !== null && recorded === actual;
  }

  function providerRadioAllowed({ tag, type, role, label, url }) {
    if (!PROVIDER_RADIO_LABEL.test(normalize(label))) return false;
    const tagName = String(tag || '').toLowerCase();
    if (tagName === 'a' || tagName === 'button') return false;
    if (tagName === 'input' ? type !== 'radio' : role !== 'radio') return false;
    const clean = publicPageUrl(url);
    if (!clean) return false;
    const page = new URL(clean);
    return normalizePath(page.pathname) === '/shop/checkout' && /^Billing(?:-init)?$/i.test(page.searchParams.get('_s') || '');
  }

  function semanticStage(url, text = '') {
    if (!allowedOrigin(url)) return 'blocked';
    if (phaseFromText(text) === 'awaitingPayment') return 'awaitingPayment';
    try {
      const page = new URL(url);
      const path = normalizePath(page.pathname);
      if (/\/(?:payment|pay)(?:\/|$)/i.test(path)) return 'blocked';
      if (/^\/shop\/checkout(?:\/|$)/i.test(path)) {
        if (/^\/shop\/checkout\/(?:status|interstitial)$/i.test(path)) return 'processing';
        const clean = publicPageUrl(url);
        if (!clean) return 'blocked';
        const state = new URL(clean).searchParams.get('_s') || '';
        const match = /^(Fulfillment|Shipping|Billing|Review)(?:-init)?$/i.exec(state);
        return match ? match[1].toLowerCase() : 'unknown';
      }
      if (/^\/shop\/signIn(?:\/|$)/i.test(path)) return 'signIn';
      if (/^\/shop\/bag$/i.test(path)) return 'bag';
      if (/\/(?:attach|buyflow\/attach)(?:\/|$)/i.test(path)) return 'attach';
      if (/^\/shop\/(?:buy-|product\/)/i.test(path)) {
        const steps = page.searchParams.getAll('step');
        if (steps.includes('attach')) return steps.length === 1 ? 'attach' : 'blocked';
        return 'product';
      }
      return 'unknown';
    } catch { return 'blocked'; }
  }

  function moneyValues(value) {
    const text = normalize(value);
    const matches = [...text.matchAll(/(?:[¥￥]\s*|\b(?:RMB|CNY)\s*)(\d[\d,.]*)(?:\s*元)?|(?<![\d.,])(\d[\d,.]*)\s*元/gi)];
    return matches.map(match => {
      const amount = match[1] || match[2];
      return /^(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{1,2})?$/.test(amount) ? Number(amount.replace(/,/g, '')) : NaN;
    });
  }

  // Records are label/value pairs, not an arbitrary price found somewhere in body text.
  function totalFromRecords(records) {
    const candidates = records.filter(record => record.verifiedLabel || TOTAL_LABEL.test(normalize(record.label)))
      .map(record => moneyValues(record.value));
    if (!candidates.length) return { ok: false, reason: '未找到可核验的人民币订单总额。' };
    if (candidates.some(values => values.length !== 1 || !Number.isFinite(values[0]))) return { ok: false, reason: '订单总额包含多个金额、格式异常或没有明确的人民币金额，已停止。' };
    const distinct = [...new Set(candidates.map(values => values[0]))];
    if (distinct.length !== 1 || distinct[0] <= 0) return { ok: false, reason: '页面订单总额不明确，已停止。' };
    return { ok: true, total: distinct[0] };
  }

  function quantityFromRecords(records) {
    if (records.length !== 1) return { ok: false, reason: records.length ? '页面存在多个商品数量，无法唯一核验，已停止。' : '未找到明确的商品数量，已停止。' };
    const record = records[0];
    if (!record.verifiedLabel && !QUANTITY_LABEL.test(normalize(record.label))) return { ok: false, reason: '商品数量字段不明确，已停止。' };
    const value = normalize(record.value);
    if (!/^[1-9]\d*$/.test(value)) return { ok: false, reason: '商品数量不是明确的正整数，已停止。' };
    return { ok: true, quantity: Number(value) };
  }

  function phaseFromText(value) {
    const text = normalize(value);
    const orderNumber = /订单(?:编)?号\s*[：:#]?\s*[A-Z0-9][A-Z0-9-]{5,}/i.test(text) || /订单\s*#\s*W[A-Z0-9]{6,}(?![A-Z0-9])/i.test(text) || /order\s*(?:number|no\.?|#)\s*[：:#]?\s*[A-Z0-9][A-Z0-9-]{5,}/i.test(text);
    const accepted = /(?:待付款|待支付|等待付款|等待支付|尚未付款|尚未支付|订单已提交|订单已确认|已收到您的订单|订单正在处理|感谢(?:您的)?(?:订购|购买)|thank you for your order|order (?:has been |is )?(?:placed|confirmed|received)|awaiting payment|pending payment)/i.test(text);
    return orderNumber && accepted ? 'awaitingPayment' : 'checkout';
  }

  function productMatches(text, product) {
    const expected = normalize(product).toUpperCase().replace(/\s+/g, '');
    if (!/^[A-Z0-9]{5,12}(?:[A-Z]{1,3})?\/[A-Z]$/.test(expected)) return false;
    const haystack = normalize(text).toUpperCase();
    const escaped = expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(?:^|[^A-Z0-9])${escaped}(?:$|[^A-Z0-9])`).test(haystack.replace(/\s*\/\s*/g, '/'));
  }

  function knownProductFromLists(lists, product, currentUrl) {
    const sku = normalize(product).toUpperCase();
    const expectedName = VERIFIED_PRODUCT_NAMES[sku];
    const failure = reason => ({ ok: false, reason });
    const clean = publicPageUrl(currentUrl);
    if (!expectedName || !clean) return failure('没有可用的完整商品名称核验规则。');
    const page = new URL(clean);
    if (normalizePath(page.pathname) !== '/shop/checkout' || !/^Review(?:-init)?$/i.test(page.searchParams.get('_s') || '')) return failure('完整商品名称核验仅适用于官网订单检查阶段。');
    if (!Array.isArray(lists) || lists.length !== 1 || lists[0].rows?.length !== 1) return failure('无法确认订单仅有一个商品行，已停止。');
    const row = lists[0].rows[0];
    if (!Array.isArray(row.headings) || row.headings.length !== 1 || normalize(row.headings[0]) !== expectedName) return failure('商品行的完整机型、容量或颜色与预期不符，已停止。');
    const text = normalize(row.text);
    const quantityLabels = text.match(/数量|\bquantity\b|\bqty\b/gi) || [];
    const quantities = [...text.matchAll(/(?:数量|\bquantity\b|\bqty\b)\s*[：:]?\s*([1-9]\d*)(?:\s*件)?(?=\s*(?:RMB|CNY|[¥￥]|$))/gi)];
    if (quantityLabels.length !== 1 || quantities.length !== 1) return failure('商品行未显示唯一、明确的商品数量，已停止。');
    const amounts = moneyValues(text);
    if (amounts.length !== 1 || !Number.isFinite(amounts[0]) || amounts[0] <= 0) return failure('商品行包含多个价格或价格不明确，无法排除附加商品，已停止。');
    return { ok: true, sku, name: expectedName, quantity: Number(quantities[0][1]), itemTotal: amounts[0] };
  }

  function validateGuard({ total, quantity, text, namedProduct }, guard = {}) {
    if (!Number.isFinite(guard.maxTotal) || guard.maxTotal <= 0) return { ok: false, reason: '请先设置大于 0 的订单金额上限。' };
    if (!Number.isInteger(guard.quantity) || guard.quantity < 1 || guard.quantity > 10) return { ok: false, reason: '请先设置 1–10 件的预期商品数量。' };
    if (!total.ok) return total;
    if (total.total > guard.maxTotal) return { ok: false, reason: `订单总额 ¥${total.total.toFixed(2)} 超过设定上限，已停止。` };
    let verifiedQuantity = quantity;
    let productVerification = 'visibleSku';
    if (!productMatches(text, guard.expectedProduct)) {
      const expectedSku = normalize(guard.expectedProduct).toUpperCase();
      if (!namedProduct?.ok || namedProduct.sku !== expectedSku || namedProduct.name !== VERIFIED_PRODUCT_NAMES[expectedSku]) return { ok: false, reason: namedProduct?.reason || '确认页未显示完整型号编号，也无法在唯一商品行核验已知型号的完整机型、容量、颜色和数量。请在官网手动核对并下单。' };
      if (namedProduct.itemTotal !== total.total) return { ok: false, reason: '订单总额与唯一商品行金额不一致，无法排除附加费用或商品，已停止。' };
      verifiedQuantity = { ok: true, quantity: namedProduct.quantity };
      productVerification = 'verifiedFullName';
    }
    if (!verifiedQuantity?.ok) return verifiedQuantity || { ok: false, reason: '未找到明确的商品数量，已停止。' };
    if (verifiedQuantity.quantity !== guard.quantity) return { ok: false, reason: `页面商品数量为 ${verifiedQuantity.quantity}，与预期 ${guard.quantity} 不符，已停止。` };
    return { ok: true, total: total.total, quantity: verifiedQuantity.quantity, productVerification };
  }

  const helpers = { normalize, normalizePath, actionForLabel, safeLabel, allowedOrigin, publicPageUrl, locationMatches, providerRadioAllowed, semanticStage, moneyValues, totalFromRecords, quantityFromRecords, phaseFromText, productMatches, knownProductFromLists, validateGuard };
  // Node tests execute the same guard code without a browser or extension privileges.
  if (typeof document === 'undefined' || typeof chrome === 'undefined' || !chrome.runtime?.id) {
    globalThis.__shikeCheckoutInternals = helpers;
    return;
  }
  if (globalThis.__shikeCheckoutLoaded) return;
  globalThis.__shikeCheckoutLoaded = true;

  let recording = false;
  let executing = false;
  let submitAttempted = false;
  let executionGeneration = 0;
  const documentId = typeof crypto?.randomUUID === 'function' ? crypto.randomUUID() : `document-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const dispatchedActions = new Map();
  let builtinCartMutated = false;
  let scheduleTimer = null;
  const runtime = chrome.runtime;
  const extensionOrigin = runtime.getURL('');
  const tell = message => { try { const pending = runtime.sendMessage(message); if (pending?.catch) pending.catch(() => {}); } catch { /* page is unloading */ } };
  const pageText = () => normalize(document.body?.innerText || '');

  function visible(element) {
    if (!element?.isConnected || element.closest('dialog:not([open]),[hidden],[inert],[aria-hidden="true"]')) return false;
    const style = getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
    return element.getClientRects().length > 0;
  }

  function elementLabel(element) {
    if (element.tagName === 'INPUT') {
      const labels = [...(element.labels || [])].map(label => label.innerText).join(' ');
      return normalize(element.getAttribute('aria-label') || labels || element.getAttribute('title'));
    }
    return normalize(element.getAttribute('aria-label') || element.innerText || element.getAttribute('title'));
  }

  function textsForElement(element) {
    return [elementLabel(element), normalize(element.innerText), normalize(element.getAttribute('title')), normalize(element.getAttribute('data-autom'))].filter(Boolean);
  }

  function actionForElement(element) {
    const labels = textsForElement(element);
    // data-autom and input[type=submit] names can expose intent concealed by a short visible label.
    const semantic = normalize([element.id, element.getAttribute('name'), element.getAttribute('data-autom'), element.getAttribute('formaction'), element.closest('form')?.getAttribute('action')].join(' '));
    const destination = `${element.getAttribute('href') || ''} ${element.getAttribute('formaction') || ''} ${element.closest('form')?.getAttribute('action') || ''}`;
    const paymentSectionNavigation = PAYMENT_NAV_LABEL.test(elementLabel(element));
    const chargingSemantic = /(?:applepay|payment[-_ ]?(?:submit|confirm)|pay[-_ ]?now|submit[-_ ]?payment)/i.test(semantic);
    const paymentDestination = /(?:payment|apple[-_]?pay|[/-]pay(?:[/?#]|$))/i.test(destination);
    if (!chargingSemantic && !paymentDestination && providerRadioAllowed({ tag: element.tagName, type: element.type, role: element.getAttribute('role'), label: elementLabel(element), url: location.href })) return 'click';
    if (labels.some(label => actionForLabel(label) === 'payment') || chargingSemantic || (!paymentSectionNavigation && paymentDestination)) return 'payment';
    if (labels.some(label => actionForLabel(label) === 'submitOrder') || /(?:place[-_ ]?order|submit[-_ ]?order)/i.test(semantic)) return 'submitOrder';
    return 'click';
  }

  function safeAttribute(value) {
    return /^[A-Za-z][A-Za-z0-9_.:-]{0,95}$/.test(value || '') && !PRIVATE_TEXT.test(value);
  }

  function locatorMatches(locator, elements) {
    if (!locator || !['id', 'data-autom', 'aria-label', 'text'].includes(locator.kind) || typeof locator.value !== 'string' || locator.value.length > 100) return [];
    if (['aria-label', 'text'].includes(locator.kind) && !safeLabel(locator.value)) return [];
    return elements.filter(element => {
      if (locator.tag && element.tagName.toLowerCase() !== locator.tag) return false;
      if (locator.type && element.getAttribute('type')?.toLowerCase() !== locator.type) return false;
      if (locator.kind === 'id') return element.id === locator.value;
      if (locator.kind === 'data-autom') return element.getAttribute('data-autom') === locator.value;
      if (locator.kind === 'aria-label') return normalize(element.getAttribute('aria-label')) === locator.value;
      return elementLabel(element) === locator.value;
    });
  }

  function makeLocator(element) {
    const base = { tag: element.tagName.toLowerCase() };
    if (element.tagName === 'INPUT') base.type = element.type.toLowerCase();
    const possible = [];
    if (safeAttribute(element.id)) possible.push({ ...base, kind: 'id', value: element.id });
    if (safeAttribute(element.getAttribute('data-autom'))) possible.push({ ...base, kind: 'data-autom', value: element.getAttribute('data-autom') });
    const aria = safeLabel(element.getAttribute('aria-label'));
    if (aria) possible.push({ ...base, kind: 'aria-label', value: aria });
    const text = safeLabel(elementLabel(element));
    if (text) possible.push({ ...base, kind: 'text', value: text });
    const all = [...document.querySelectorAll(CLICKABLE)].filter(visible);
    return possible.find(locator => locatorMatches(locator, all).length === 1) || null;
  }

  function recordClick(event) {
    if (!recording || !event.altKey || !event.isTrusted) return;
    const target = event.target instanceof Element ? event.target : null;
    let element = target?.closest(CLICKABLE) || null;
    if (!element) {
      const control = target?.closest('label')?.control;
      if (control?.matches('input[type="radio"],input[type="checkbox"]')) element = control;
    }
    // Alt + click is a recording gesture, never a request to carry out checkout.
    event.preventDefault();
    event.stopImmediatePropagation();
    if (!element || !visible(element)) { tell({ type: 'RECORD_ERROR', reason: '请按住 Alt / Option 点击可见的按钮、链接、单选框或复选框。' }); return; }
    const label = elementLabel(element);
    if (element.matches('input:not([type="radio"]):not([type="checkbox"])') || (PRIVATE_TEXT.test(label) && !PUBLIC_NAV_LABEL.test(label))) {
      tell({ type: 'RECORD_ERROR', reason: '不能录制地址、联系人、账号或付款信息。请在官网手动设置。' }); return;
    }
    const action = actionForElement(element);
    if (action === 'payment') { tell({ type: 'RECORD_ERROR', reason: '付款操作不能录制，插件将在订单提交后停止。' }); return; }
    const locator = makeLocator(element);
    if (!locator) { tell({ type: 'RECORD_ERROR', reason: '这个控件没有安全且唯一的定位方式，未录制。' }); return; }
    const url = publicPageUrl(location);
    if (!url) { tell({ type: 'RECORD_ERROR', reason: '当前结账阶段参数无法核验，未录制。请在官网手动完成此步。' }); return; }
    tell({ type: 'RECORD_STEP', step: { version: 2, url, locator, label: safeLabel(elementLabel(element)) || '已录制按钮', kind: action } });
  }

  function totalRecords() {
    const records = [];
    const direct = [...document.querySelectorAll('[data-autom],[id]')].filter(element => {
      const marker = `${element.getAttribute('data-autom') || ''} ${element.id || ''}`;
      return visible(element) && !/(?:sub[-_]?total|subtotal|installment|monthly)/i.test(marker) && /(?:order[-_]?total|grand[-_]?total|(?:bag|checkout|summary)[-_]total(?:[-_]price)?|total[-_]price)/i.test(marker);
    });
    for (const element of direct) {
      if (direct.some(other => other !== element && element.contains(other))) continue;
      records.push({ verifiedLabel: true, value: normalize(element.innerText || element.textContent) });
    }
    // Prefer exact, visible labels and a short adjacent price row over body-wide regexes.
    for (const label of document.querySelectorAll('dt,th,label,span,p,div,strong')) {
      if (!visible(label) || !TOTAL_LABEL.test(normalize(label.innerText))) continue;
      if ([...label.children].some(child => TOTAL_LABEL.test(normalize(child.innerText)))) continue;
      const next = label.nextElementSibling;
      const row = label.parentElement;
      let value = '';
      if (next && visible(next) && moneyValues(next.innerText).length) value = normalize(next.innerText);
      else if (row && normalize(row.innerText).length <= 180) value = normalize(row.innerText);
      if (value) records.push({ label: normalize(label.innerText), value });
    }
    return records;
  }

  function quantityRecords() {
    const candidates = new Map();
    const put = (element, record) => {
      if (!visible(element)) return;
      const existingAncestor = [...candidates.keys()].find(candidate => candidate.contains(element));
      if (existingAncestor) candidates.delete(existingAncestor);
      if ([...candidates.keys()].some(candidate => element.contains(candidate))) return;
      candidates.set(element, record);
    };
    for (const element of document.querySelectorAll('[data-autom],[name],[id],[aria-label]')) {
      if (!visible(element)) continue;
      const marker = normalize([element.getAttribute('data-autom'), element.getAttribute('name'), element.id, element.getAttribute('aria-label')].join(' '));
      if (!/(?:\bquantity\b|(?:^|[-_])qty(?:$|[-_])|数量)/i.test(marker)) continue;
      if (element.tagName === 'SELECT' || (element.tagName === 'INPUT' && ['number', 'text', 'tel'].includes(element.type))) {
        put(element, { verifiedLabel: true, value: element.value });
      } else if (!element.matches('button,a,[role="button"]')) {
        const value = normalize(element.innerText || element.textContent).replace(/^(?:商品数量|购买数量|数量|quantity|qty)\s*[：:]?\s*/i, '');
        if (/^\d+$/.test(value)) put(element, { verifiedLabel: true, value });
      }
    }
    for (const label of document.querySelectorAll('dt,th,label,span,p,div')) {
      if (!visible(label) || !QUANTITY_LABEL.test(normalize(label.innerText))) continue;
      if ([...label.children].some(child => QUANTITY_LABEL.test(normalize(child.innerText)))) continue;
      let valueNode = label.nextElementSibling;
      if (label.tagName === 'LABEL' && label.htmlFor) valueNode = document.getElementById(label.htmlFor) || valueNode;
      if (valueNode && visible(valueNode)) {
        const value = 'value' in valueNode ? valueNode.value : normalize(valueNode.innerText);
        if (/^\d+$/.test(normalize(value))) put(valueNode, { label: normalize(label.innerText), value });
      }
    }
    return [...candidates.values()];
  }

  function namedProductEvidence(product) {
    const excluded = 'footer,header,nav,aside,[role="contentinfo"],[role="banner"],[role="navigation"],[role="complementary"],[aria-label*="推荐"],[data-autom*="recommend" i],[data-autom*="cross-sell" i],[data-autom*="upsell" i]';
    const mains = [...document.querySelectorAll('main,[role="main"]')].filter(element => visible(element) && !element.closest(excluded));
    if (mains.length !== 1) return { ok: false, reason: '无法唯一确认官网订单主内容区域，已停止。' };
    const expectedName = VERIFIED_PRODUCT_NAMES[normalize(product).toUpperCase()];
    const candidates = [];
    for (const list of mains[0].querySelectorAll('ul,ol,[role="list"]')) {
      if (!visible(list) || list.closest(excluded)) continue;
      const rows = [...list.children].filter(element => visible(element) && !element.matches('script,style,template') && !element.closest(excluded));
      const records = rows.map(row => ({
        headings: [...row.querySelectorAll('h1,h2,h3,h4,h5,h6,[role="heading"]')].filter(element => visible(element) && !element.closest(excluded)).map(element => normalize(element.innerText)),
        text: normalize(row.innerText)
      }));
      // Count every apparent priced/quantity-bearing product list, including extras.
      const productList = records.some(row => row.headings.includes(expectedName) || /(?:数量|\bquantity\b|\bqty\b)\s*[：:]?\s*\d/i.test(row.text) || (row.headings.length && moneyValues(row.text).length));
      if (productList) candidates.push({ element: list, rows: records });
    }
    // Nested lists can expose the same row twice. Use the innermost product lists;
    // separate accessory lists still count separately and make verification fail.
    const distinct = candidates.filter(candidate => !candidates.some(other => other !== candidate && candidate.element.contains(other.element)));
    return knownProductFromLists(distinct.map(({ rows }) => ({ rows })), product, location.href);
  }

  function submissionSnapshot(text, guard) {
    return {
      total: totalFromRecords(totalRecords()),
      quantity: quantityFromRecords(quantityRecords()),
      text,
      namedProduct: productMatches(text, guard?.expectedProduct) ? undefined : namedProductEvidence(guard?.expectedProduct)
    };
  }

  function overlayBlocks(element) {
    const rect = element.getBoundingClientRect();
    const x = Math.max(0, Math.min(innerWidth - 1, rect.left + rect.width / 2));
    const y = Math.max(0, Math.min(innerHeight - 1, rect.top + rect.height / 2));
    const top = document.elementFromPoint(x, y);
    return !top || (top !== element && !element.contains(top));
  }

  function safeLink(element) {
    if (element.tagName !== 'A') return true;
    try {
      const target = new URL(element.getAttribute('href'), location.href);
      return allowedOrigin(target.href) && /^\/shop(?:\/|$)/.test(target.pathname) && (!element.target || element.target === '_self');
    } catch { return false; }
  }

  function enabled(element) {
    return visible(element) && !element.disabled && !element.matches(':disabled,[aria-disabled="true"]') && !element.closest('[inert]');
  }

  function clickableLabel(element) {
    return normalize(elementLabel(element)).replace(/[。！!]+$/, '');
  }

  function controlsFor(labels, scope = document) {
    const allowed = new Set(labels.map(normalize));
    const found = [...scope.querySelectorAll(CLICKABLE)].filter(element => visible(element) && allowed.has(clickableLabel(element)));
    // Native label wrappers are resolved to their real radio/checkbox controls.
    return [...new Set(found)];
  }

  function oneControl(labels, scope = document) {
    const choices = controlsFor(labels, scope);
    return choices.length === 1 ? choices[0] : null;
  }

  function selected(element) {
    if (!element) return false;
    if (element.tagName === 'INPUT' && ['radio', 'checkbox'].includes(element.type)) return element.checked;
    return ['aria-checked', 'aria-pressed', 'aria-selected'].some(name => element.getAttribute(name) === 'true');
  }

  function inputLabel(element) {
    return normalize(element.getAttribute('aria-label') || [...(element.labels || [])].map(label => label.innerText).join(' ') || element.getAttribute('placeholder'));
  }

  function humanInterruption() {
    const captcha = [...document.querySelectorAll('input,iframe,[role="dialog"],dialog[open]')].find(element => visible(element) && /captcha|人机验证|滑块验证|安全验证|验证码图片|拼图验证/i.test(normalize([element.id, element.getAttribute('name'), element.getAttribute('title'), element.getAttribute('aria-label')].join(' '))));
    if (captcha) return '官网需要完成安全验证，请在页面手动处理后继续。';
    const legalDialog = [...document.querySelectorAll('[role="dialog"],[aria-modal="true"],dialog[open]')].find(element => visible(element) && /条款|隐私|terms|privacy/i.test(normalize(element.innerText)));
    if (legalDialog) return '官网显示条款或隐私确认，请阅读并自行处理后继续。';
    const otp = [...document.querySelectorAll('input')].find(element => visible(element) && !element.disabled && /验证码|动态码|一次性|verification code|one.time.code|\botp\b/i.test(normalize([inputLabel(element), element.autocomplete, element.name, element.id].join(' '))));
    if (otp) return '请在官网手动完成短信或其他验证码验证，插件不会读取或填写验证码。';
    const legalCheckbox = [...document.querySelectorAll('input[type="checkbox"],[role="checkbox"]')].find(element => visible(element) && !selected(element) && /(?:同意|已阅读|接受).*(?:条款|隐私|协议)|terms|privacy/i.test(elementLabel(element)));
    if (legalCheckbox) return '请阅读并自行勾选官网条款或隐私确认，随后继续。';
    return '';
  }

  function productEvidence(config, element) {
    const expected = normalize(config.partNumber).toUpperCase();
    if (!/^[A-Z0-9]{5,16}\/[A-Z]$/.test(expected)) return false;
    if (productMatches(pageText(), expected)) return true;
    try {
      const page = new URL(location.href);
      if (productMatches(decodeURIComponent(page.pathname), expected) || page.searchParams.getAll('partNumber').length === 1 && page.searchParams.get('partNumber')?.toUpperCase() === expected) return true;
    } catch { /* malformed URL is not identity evidence */ }
    const scope = element?.closest('form') || document.querySelector('main,[role="main"]') || document;
    const skuNodes = [...scope.querySelectorAll('input[name="partNumber"],input[name$=".partNumber"],meta[itemprop="sku"],[itemprop="sku"]')];
    const values = [...new Set(skuNodes.map(node => normalize(node.value || node.getAttribute('content') || node.textContent).toUpperCase()).filter(Boolean))];
    if (values.length === 1 && values[0] === expected) return true;
    return [element, element?.closest('[data-part-number]')].filter(Boolean).some(node => node.getAttribute('data-part-number')?.toUpperCase() === expected);
  }

  const FIELD_SPECS = {
    lastName: { labels: ['姓', '姓氏', '姓氏（中文）'], keys: /(?:^|[._-])(?:lastName|lastname|last-name|familyName)$/i },
    firstName: { labels: ['名', '名字', '名字（中文）'], keys: /(?:^|[._-])(?:firstName|firstname|first-name|givenName)$/i },
    detailAddress: { labels: ['详细地址', '街道地址', '街道和门牌号', '地址行 1', '地址行1'], keys: /(?:^|[._-])(?:street|streetAddress|addressLine1|address-line1|detailAddress)$/i },
    recipientPhone: { labels: ['收货人手机号码', '收件人手机号码', '收货人手机号', '收件人手机号', '收货手机号码'], keys: /(?:^|[._-])(?:recipientPhone|shippingPhone|recipient-phone)$/i },
    contactPhone: { labels: ['联系人手机号码', '联系人手机号', '联系手机号码', '联系手机', '联系人电话'], keys: /(?:^|[._-])(?:contactPhone|contact-phone)$/i },
    email: { labels: ['电子邮件地址', '电子邮件', '邮箱', 'Email', 'Email Address'], keys: /(?:^|[._-])(?:email|emailAddress|email-address)$/i },
    province: { labels: ['省', '省份', '省/自治区/直辖市', '省份/直辖市', 'Province'], keys: /(?:^|[._-])(?:province|state)$/i },
    city: { labels: ['市', '城市', 'City'], keys: /(?:^|[._-])city$/i },
    district: { labels: ['区', '区县', '区/县', '县/区', 'District'], keys: /(?:^|[._-])(?:district|county)$/i }
  };

  function fieldCandidates(key) {
    const spec = FIELD_SPECS[key];
    return [...document.querySelectorAll('input,select,[role="combobox"]')].filter(element => {
      if (!visible(element) || element.tagName === 'INPUT' && !['text', 'tel', 'email', 'search'].includes(element.type)) return false;
      if (/验证码|动态码|一次性|password|captcha|\botp\b/i.test([inputLabel(element), element.name, element.id].join(' '))) return false;
      const marker = [element.getAttribute('data-autom'), element.name, element.id].filter(Boolean);
      return spec.labels.some(label => normalize(label).toLowerCase() === inputLabel(element).toLowerCase()) || marker.some(value => spec.keys.test(value));
    });
  }

  function fieldValue(element) {
    if (element.tagName === 'SELECT') return normalize(element.selectedOptions?.[0]?.textContent || element.value);
    return normalize(element.value ?? element.getAttribute('aria-valuetext') ?? element.textContent);
  }

  function regionPlan(key, value) {
    const suffix = `${key[0].toUpperCase()}${key.slice(1)}`;
    const menuOptions = [...document.querySelectorAll('[role="listbox"] [role="option"],[role="option"],dialog[open] button,[role="dialog"] button')].filter(element => visible(element) && normalize(elementLabel(element)) === normalize(value));
    if (menuOptions.length === 1) return { action: `choose${suffix}`, element: menuOptions[0], kind: 'click', expectedNext: ['shipping'] };
    if (menuOptions.length > 1) return { requiresHuman: true, reason: '地区菜单中存在多个同名选项，请在官网手动选择。' };
    const fields = fieldCandidates(key);
    if (fields.length > 1) return { requiresHuman: true, reason: '地区字段无法唯一定位，请在官网手动选择。' };
    const field = fields[0];
    if (!field) return { requiresHuman: true, reason: '官网地区控件暂不支持自动识别，请在页面手动选择省、市、区。' };
    if (fieldValue(field) === normalize(value)) return null;
    if (!enabled(field)) return { ready: false, reason: '正在等待地区选项加载。' };
    if (field.tagName === 'SELECT') {
      const options = [...field.options].filter(option => !option.disabled && normalize(option.textContent) === normalize(value));
      if (options.length !== 1) return { requiresHuman: true, reason: '官网地区选项与设置不一致，请在页面手动选择。' };
      return { action: `select${suffix}`, element: field, kind: 'select', value: options[0].value, expectedNext: ['shipping'] };
    }
    if (field.getAttribute('role') === 'combobox' || field.getAttribute('aria-haspopup')) return { action: `select${suffix}`, element: field, kind: 'click', expectedNext: ['shipping'] };
    return { requiresHuman: true, reason: '官网地区控件需要人工选择，请在页面完成后继续。' };
  }

  function basePlan(stage, config, data = {}) {
    return { ok: true, documentId, url: publicPageUrl(location) || `${location.origin}${location.pathname}`, stage, ready: false, safeToReload: false, expectedNext: [], ...data };
  }

  function clickPlan(stage, config, action, labels, expectedNext, extra = {}) {
    let elements = controlsFor(labels);
    // The real bag repeats the same normal checkout button above and below its
    // contents. Only this navigation action may choose an equivalent duplicate.
    if (action === 'checkout' && stage === 'bag' && elements.length > 1) {
      const context = elements[0].closest('main,[role="main"]');
      const label = clickableLabel(elements[0]).toLowerCase();
      const formTarget = element => {
        const form = element.form || element.closest('form');
        const target = element.getAttribute('formtarget') || form?.getAttribute('target') || '_self';
        const actionUrl = element.getAttribute('formaction') || form?.getAttribute('action') || '';
        try { return `${target}|${actionUrl ? new URL(actionUrl, location.href).href : ''}|${element.getAttribute('formmethod') || form?.getAttribute('method') || ''}`; }
        catch { return null; }
      };
      const destination = formTarget(elements[0]);
      const equivalent = context && destination !== null && elements.every(element => element.tagName === 'BUTTON' && element.closest('main,[role="main"]') === context && !element.closest('footer,header,nav,aside,[role="navigation"],[role="contentinfo"]') && clickableLabel(element).toLowerCase() === label && actionForElement(element) === 'click' && formTarget(element) === destination && !(element.getAttribute('formtarget') || element.form?.getAttribute('target'))?.match(/^(?!_self$).+/));
      if (equivalent) elements = elements.filter(enabled).slice(0, 1);
    }
    if (elements.length !== 1) return basePlan(stage, config, { requiresHuman: elements.length > 1, reason: elements.length > 1 ? '官网存在多个同名控件，请手动确认。' : '等待官网显示可用的下一步按钮。' });
    const element = elements[0];
    if (!enabled(element)) return basePlan(stage, config, { reason: '官网下一步按钮尚不可用，请等待页面就绪。' });
    if (!safeLink(element)) return basePlan(stage, config, { requiresHuman: true, reason: '官网链接将离开当前购物流程，请手动确认。' });
    if (actionForElement(element) === 'payment') return basePlan(stage, config, { requiresHuman: true, reason: '已拦截付款控件，插件不会执行付款。' });
    return basePlan(stage, config, { ready: true, action, element, kind: 'click', expectedNext, ...extra });
  }

  function builtinPlan(config = {}) {
    const text = pageText();
    let stage = semanticStage(location.href, text);
    if (stage === 'awaitingPayment') return basePlan(stage, config, { reason: '订单已进入待付款；自动操作已结束，请自行核对并付款。' });
    if (stage === 'blocked') return basePlan(stage, config, { requiresHuman: true, reason: '当前页面不支持自动操作或是付款页面，请在官网手动检查。' });
    const interruption = humanInterruption();
    if (interruption) return basePlan('blocked', config, { requiresHuman: true, reason: interruption });
    if (stage === 'processing') return basePlan(stage, config, { reason: '官网正在处理或加载订单结果，请等待；不会点击、刷新或重复提交。' });
    if (recording) return basePlan(stage, config, { requiresHuman: true, reason: '请先结束可选录制模式，再执行内置流程。' });
    if (document.readyState !== 'complete' || document.querySelector('main[aria-busy="true"],body[aria-busy="true"],[role="main"][aria-busy="true"]')) return basePlan(stage, config, { reason: '正在等待官网页面加载完成。' });
    if (Number(config.quantity) !== 1) return basePlan(stage, config, { requiresHuman: true, reason: '内置流程仅支持单件商品，请将数量设置为 1。' });
    // Attach screens occasionally retain a product URL after adding the item.
    if (stage === 'product' && controlsFor(['查看购物袋', '前往购物袋', 'View Bag']).length === 1 && /已(?:添加|加入)|添加成功|added to (?:your )?bag/i.test(text)) stage = 'attach';
    if (stage === 'product') {
      if (builtinCartMutated) return basePlan(stage, config, { reason: '本页已点击加入购物袋，正在等待官网跳转；不会刷新或再次加入。' });
      const plan = clickPlan(stage, config, 'addBag', ['添加到购物袋', '加入购物袋', 'Add to Bag'], ['attach', 'bag'], { mutatesCart: true });
      const matched = productEvidence(config, plan.element);
      if (!matched) return basePlan(stage, config, { requiresHuman: true, reason: '当前商品页无法核验完整 SKU。请打开包含对应编号的官网商品页面。' });
      if (plan.ready) return { ...plan, matchedProduct: true };
      return { ...plan, matchedProduct: true, safeToReload: !builtinCartMutated && !plan.requiresHuman, reason: plan.requiresHuman ? plan.reason : '商品入口暂未显示可用的加入购物袋按钮，等待兼容重试。' };
    }
    if (stage === 'attach') return clickPlan(stage, config, 'viewBag', ['查看购物袋', '前往购物袋', 'View Bag'], ['bag']);
    if (stage === 'bag') {
      const quantities = quantityRecords();
      if (quantities.length && (!quantityFromRecords(quantities).ok || quantityFromRecords(quantities).quantity !== 1)) return basePlan(stage, config, { requiresHuman: true, reason: '购物袋含多件或无法确认的商品，请仅保留目标商品 1 件。' });
      return clickPlan(stage, config, 'checkout', ['结账', '立即结账', '前往结账', 'Check Out', 'Checkout'], ['signIn', 'fulfillment', 'shipping', 'billing', 'review']);
    }
    if (stage === 'signIn') return clickPlan(stage, config, 'guest', ['以游客身份继续', '以访客身份结账', '继续以访客身份结账', 'Continue as Guest'], ['fulfillment', 'shipping']);
    if (stage === 'fulfillment') {
      const pickup = config.fulfillment === 'pickup';
      const choice = oneControl(pickup ? ['我要取货'] : ['为我送货']);
      if (choice && !selected(choice)) return clickPlan(stage, config, pickup ? 'pickup' : 'delivery', pickup ? ['我要取货'] : ['为我送货'], ['fulfillment', 'shipping']);
      if (!choice) return basePlan(stage, config, { requiresHuman: true, reason: '请选择官网送货或取货方式，插件无法唯一核验此控件。' });
      if (pickup) return basePlan(stage, config, { requiresHuman: true, reason: '已选择到店取货。请在官网手动确认门店和取货时间，并进入下一页后继续。' });
      return clickPlan(stage, config, 'shippingContinue', ['继续填写送货地址'], ['shipping']);
    }
    if (stage === 'shipping') {
      const shipping = config.shipping || {};
      for (const key of ['province', 'city', 'district']) {
        if (!normalize(shipping[key])) continue;
        const region = regionPlan(key, shipping[key]);
        if (region) return basePlan(stage, config, { ...region, ready: Boolean(region.action) });
      }
      const changes = [];
      for (const key of ['lastName', 'firstName', 'detailAddress', 'recipientPhone', 'contactPhone', 'email']) {
        const value = normalize(shipping[key]);
        if (!value) continue;
        const fields = fieldCandidates(key);
        if (fields.length !== 1 || fields[0].tagName !== 'INPUT') return basePlan(stage, config, { requiresHuman: true, reason: '有已设置的收货字段无法唯一定位，请在官网手动填写后继续。' });
        if (!enabled(fields[0])) return basePlan(stage, config, { reason: '正在等待收货字段可编辑。' });
        if (normalize(fields[0].value) !== value) changes.push({ element: fields[0], value });
      }
      if (changes.length) return basePlan(stage, config, { ready: true, action: 'fillShipping', kind: 'fill', fields: changes, element: changes[0].element, expectedNext: ['shipping'] });
      const verifyButtons = controlsFor(['验证']).filter(element => enabled(element) && (element.tagName === 'BUTTON' || element.getAttribute('role') === 'button'));
      if (verifyButtons.length) return basePlan(stage, config, { requiresHuman: true, reason: '请在官网手动点击“验证”并完成短信验证。插件不会发送、读取或填写验证码；验证成功后再继续。' });
      const incomplete = [...document.querySelectorAll('input,select')].some(element => visible(element) && !element.disabled && element.required && (!normalize(element.value) || element.validity?.valid === false));
      if (incomplete) return basePlan(stage, config, { requiresHuman: true, reason: '请在官网补全并核验必填收货信息，完成验证后继续。' });
      return clickPlan(stage, config, 'shippingContinue', ['继续选择付款方式', 'Continue to payment method'], ['billing']);
    }
    if (stage === 'billing') {
      const label = config.paymentMethod === 'wechat' ? '微信支付' : config.paymentMethod === 'alipay' ? '支付宝' : '';
      if (!label) return basePlan(stage, config, { requiresHuman: true, reason: '请先在插件选择支付宝或微信支付作为订单付款方式。' });
      const radios = controlsFor([label]).filter(element => providerRadioAllowed({ tag: element.tagName, type: element.type, role: element.getAttribute('role'), label: elementLabel(element), url: location.href }));
      if (radios.length !== 1) return basePlan(stage, config, { requiresHuman: true, reason: '官网付款方式单选框无法唯一定位，请手动选择后继续。' });
      if (!selected(radios[0])) {
        if (!enabled(radios[0]) || actionForElement(radios[0]) === 'payment') return basePlan(stage, config, { requiresHuman: true, reason: '付款方式单选框尚不可用或含付款操作，已停止。' });
        return basePlan(stage, config, { ready: true, action: 'selectPayment', element: radios[0], kind: 'click', expectedNext: ['billing'] });
      }
      return clickPlan(stage, config, 'billingContinue', ['检查订单'], ['review']);
    }
    if (stage === 'review') {
      const guard = { maxTotal: Number(config.maxTotal), quantity: Number(config.quantity), expectedProduct: config.partNumber };
      const checked = validateGuard(submissionSnapshot(text, guard), guard);
      if (!checked.ok) return basePlan(stage, config, { requiresHuman: true, reason: checked.reason });
      if (config.submitEnabled !== true) return basePlan(stage, config, { requiresHuman: true, guard: checked, matchedProduct: true, reason: '商品、数量和金额已通过核验；尚未启用允许提交订单。' });
      if (submitAttempted) return basePlan(stage, config, { requiresHuman: true, reason: '此页已经尝试提交订单，请检查官网订单状态，禁止自动重复提交。' });
      return clickPlan(stage, config, 'submitOrder', ['立即下单', '下订单', '提交订单', '确认订单', 'Place your order'], ['awaitingPayment'], { guard: checked, matchedProduct: true });
    }
    return basePlan(stage, config, { requiresHuman: true, reason: '当前官网页面尚未匹配已验证的流程，请在页面检查后继续。' });
  }

  function publicProbe(plan) {
    const { element, fields, value, kind, ...result } = plan;
    return result;
  }

  async function builtinAction(message) {
    if (message.documentId !== documentId || typeof message.runToken !== 'string' || !message.runToken || message.runToken.length > 100 || typeof message.actionId !== 'string' || !message.actionId || message.actionId.length > 120) return { ok: false, clicked: false, reason: '执行令牌或页面标识无效，已停止。' };
    const key = `${message.runToken}:${message.actionId}`;
    if (dispatchedActions.has(key)) return { ok: false, clicked: false, uncertain: true, reason: '此操作已派发，不能重复执行。请核对官网当前状态。' };
    if (executing) return { ok: false, clicked: false, reason: '本页已有操作正在执行，请勿重复触发。' };
    let plan = builtinPlan(message.config);
    if (!plan.ready || plan.action !== message.action) return { ok: false, clicked: false, requiresHuman: plan.requiresHuman, phase: plan.stage, reason: plan.reason || '官网当前步骤与请求不一致，未执行。' };
    if (dispatchedActions.size >= 100) return { ok: false, clicked: false, requiresHuman: true, reason: '本页操作次数已达到保护上限，请检查状态。' };
    dispatchedActions.set(key, 'dispatched');
    executing = true;
    const generation = executionGeneration;
    let mutationStarted = false;
    const ownOverlay = globalThis.__shikeOverlay;
    let overlaySuspended = false;
    try {
      if (typeof ownOverlay?.suspend === 'function') { overlaySuspended = true; ownOverlay.suspend(); }
      plan.element.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      if (generation !== executionGeneration || document.visibilityState !== 'visible') return { ok: false, clicked: false, reason: '执行已取消或官网标签未显示，未操作。' };
      const current = builtinPlan(message.config);
      if (!current.ready || current.action !== plan.action || current.stage !== plan.stage || current.element !== plan.element) return { ok: false, clicked: false, requiresHuman: current.requiresHuman, reason: current.reason || '官网页面已变化，未执行。' };
      plan = current;
      if (!enabled(plan.element) || overlayBlocks(plan.element) || !safeLink(plan.element)) return { ok: false, clicked: false, reason: '官网目标控件被遮挡或不可用，未操作。' };
      if (plan.kind === 'fill') {
        mutationStarted = true;
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        for (const field of plan.fields) {
          if (generation !== executionGeneration || !enabled(field.element)) throw new Error('cancelled');
          setter.call(field.element, field.value);
          field.element.dispatchEvent(new Event('input', { bubbles: true }));
          field.element.dispatchEvent(new Event('change', { bubbles: true }));
        }
        return { ok: true, clicked: false, changed: true, phase: plan.stage, documentId, expectedNext: plan.expectedNext, reason: '已填写已配置的收货字段，请等待官网校验。' };
      }
      if (plan.kind === 'select') {
        mutationStarted = true;
        Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(plan.element, plan.value);
        plan.element.dispatchEvent(new Event('input', { bubbles: true }));
        plan.element.dispatchEvent(new Event('change', { bubbles: true }));
        return { ok: true, clicked: false, changed: true, phase: plan.stage, documentId, expectedNext: plan.expectedNext, reason: '已选择地区，等待官网更新下一级选项。' };
      }
      if (actionForElement(plan.element) === 'payment') return { ok: false, clicked: false, requiresHuman: true, reason: '已拦截付款操作。' };
      if (plan.action === 'submitOrder') submitAttempted = true;
      if (plan.action === 'addBag') builtinCartMutated = true;
      mutationStarted = true;
      plan.element.click();
      return { ok: true, clicked: true, phase: plan.stage, documentId, mutatesCart: plan.action === 'addBag', expectedNext: plan.expectedNext, reason: plan.action === 'submitOrder' ? '提交按钮已点击，正在等待订单结果；禁止重复提交。' : '已点击官网当前步骤，等待下一页面。' };
    } catch {
      return { ok: false, clicked: false, changed: mutationStarted, uncertain: mutationStarted, requiresHuman: true, phase: plan.stage, reason: mutationStarted ? '官网操作结果不确定，已停止；请检查当前页面，禁止自动重复操作。' : '官网控件未能执行，已停止。' };
    } finally {
      if (overlaySuspended) { try { ownOverlay.resume?.(); } catch { /* panel restoration cannot replay an action */ } }
      executing = false;
    }
  }

  async function executeStep(message) {
    const generation = executionGeneration;
    if (executing) return { ok: false, clicked: false, reason: '已有结账步骤正在执行，请勿重复触发。' };
    if (recording) return { ok: false, clicked: false, reason: '正在录制，请先结束录制再执行。' };
    if (!allowedOrigin(location.origin) || !/\/shop(?:\/|$)/.test(location.pathname)) return { ok: false, clicked: false, reason: '当前页面不在支持的苹果中国商店路径内。' };
    const text = pageText();
    if (phaseFromText(text) === 'awaitingPayment') return { ok: true, clicked: false, phase: 'awaitingPayment', reason: '检测到订单已提交。自动操作已停止，请自行核对并付款。' };
    if (submitAttempted) return { ok: false, clicked: false, reason: '本页已经尝试提交订单；为防重复下单，请在官网人工检查。' };
    const step = message.step;
    if (!locationMatches(step, location)) return { ok: false, clicked: false, reason: '当前页面地址或结账阶段与录制步骤不一致，已停止。旧流程请重新录制。' };
    const candidates = locatorMatches(step.locator, [...document.querySelectorAll(CLICKABLE)]).filter(visible);
    if (candidates.length !== 1) return { ok: false, clicked: false, reason: candidates.length ? '找到多个匹配按钮，无法唯一定位，已停止。' : '录制的按钮不存在或不可见，已停止。' };
    const element = candidates[0];
    if (element.disabled || element.matches(':disabled,[aria-disabled="true"]') || element.closest('[inert]')) return { ok: false, clicked: false, reason: '目标按钮尚不可用，已停止。' };
    const action = actionForElement(element);
    if (action === 'payment' || step.kind === 'payment') return { ok: false, clicked: false, reason: '已拦截付款操作。请在官网手动付款。' };
    if (/(?:\/payment(?:\/|$)|\/pay(?:\/|$))/i.test(location.pathname)) return { ok: false, clicked: false, reason: '当前是付款页面，自动操作已停止。' };
    if (!safeLink(element)) return { ok: false, clicked: false, reason: '链接将离开受支持的官网购物页面或打开其他标签，已停止。' };
    if (!['click', 'submitOrder'].includes(step.kind)) return { ok: false, clicked: false, reason: '录制步骤类型无效，请重新录制。' };
    if ((step.kind === 'submitOrder') !== (action === 'submitOrder')) return { ok: false, clicked: false, reason: '下单按钮含义已改变，请重新核对。' };
    const phase = action === 'submitOrder' ? 'submitOrder' : 'checkout';
    let verified;
    if (phase === 'submitOrder') {
      verified = validateGuard(submissionSnapshot(text, message.guard), message.guard);
      if (!verified.ok) return { ...verified, clicked: false, phase };
    }
    if (message.dryRun !== false) return { ok: true, clicked: false, dryRun: true, phase, reason: phase === 'submitOrder' ? '演练通过：按钮、人民币总额、数量与型号均已核验；未点击。' : '演练通过：已定位唯一可用按钮；未点击。', ...(verified ? { total: verified.total, quantity: verified.quantity } : {}) };
    executing = true;
    const ownOverlay = globalThis.__shikeOverlay;
    let overlaySuspended = false;
    try {
      if (typeof ownOverlay?.suspend === 'function') { overlaySuspended = true; ownOverlay.suspend(); }
      element.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      if (generation !== executionGeneration || recording) return { ok: false, clicked: false, reason: '执行已取消，未点击按钮。' };
      if (document.visibilityState !== 'visible' || !locationMatches(step, location) || !safeLink(element)) return { ok: false, clicked: false, reason: '官网标签未显示或页面地址已改变，已停止。' };
      if (!visible(element) || element.disabled || element.getAttribute('aria-disabled') === 'true' || overlayBlocks(element)) return { ok: false, clicked: false, reason: '按钮被遮挡、移动或不可用，已停止。' };
      if (actionForElement(element) !== action || locatorMatches(step.locator, [...document.querySelectorAll(CLICKABLE)]).filter(visible).length !== 1) return { ok: false, clicked: false, reason: '页面按钮已改变，请重新核对。' };
      if (phase === 'submitOrder') {
        // Recheck after scrolling: a reactive checkout can change its total while rendering.
        verified = validateGuard(submissionSnapshot(pageText(), message.guard), message.guard);
        if (!verified.ok) return { ...verified, clicked: false, phase };
        if (generation !== executionGeneration) return { ok: false, clicked: false, reason: '执行已取消，未提交订单。' };
        submitAttempted = true;
      }
      element.click();
      return { ok: true, clicked: true, phase, reason: phase === 'submitOrder' ? '已点击提交订单；请等待官网确认，禁止重复提交。' : '已执行录制步骤。' };
    } catch {
      return { ok: false, clicked: false, phase, reason: phase === 'submitOrder' ? '提交结果不确定，请在官网人工检查订单，禁止自动重试。' : '页面操作未完成，已停止。' };
    } finally {
      if (overlaySuspended) { try { ownOverlay.resume?.(); } catch { /* panel restoration cannot replay an action */ } }
      executing = false;
    }
  }

  document.addEventListener('click', recordClick, true);
  runtime.onMessage.addListener((message, sender, sendResponse) => {
    const trusted = sender?.id === runtime.id && !sender.tab && (!sender.url || sender.url.startsWith(extensionOrigin));
    if (!trusted || !message || typeof message !== 'object') return false;
    if (message.type === 'CANCEL_EXECUTION') {
      executionGeneration++;
      clearTimeout(scheduleTimer);
      scheduleTimer = null;
      sendResponse({ ok: true, cancelled: true });
      return false;
    }
    if (message.type === 'PAGE_PROBE') {
      try { sendResponse(publicProbe(builtinPlan(message.config))); }
      catch { sendResponse({ ok: false, documentId, stage: 'blocked', ready: false, safeToReload: false, requiresHuman: true, reason: '官网页面结构暂不支持识别，请手动检查。' }); }
      return false;
    }
    if (message.type === 'PAGE_ACTION') {
      builtinAction(message).then(sendResponse, () => sendResponse({ ok: false, clicked: false, uncertain: true, requiresHuman: true, reason: '官网操作结果不确定，请检查页面；禁止自动重复操作。' }));
      return true;
    }
    if (message.type === 'PAGE_SCHEDULE') {
      const delayMs = Number(message.delayMs);
      if (typeof message.runToken !== 'string' || !message.runToken || message.runToken.length > 100 || !Number.isFinite(delayMs) || delayMs < 100 || delayMs > 60000) {
        sendResponse({ ok: false, reason: '页面调度参数无效。' }); return false;
      }
      clearTimeout(scheduleTimer);
      scheduleTimer = setTimeout(() => { scheduleTimer = null; tell({ type: 'PAGE_TICK', runToken: message.runToken, documentId }); }, delayMs);
      sendResponse({ ok: true, scheduled: true, documentId });
      return false;
    }
    if (message.type === 'SET_RECORDING') {
      recording = message.enabled === true;
      sendResponse({ ok: true, enabled: recording });
      return false;
    }
    if (message.type === 'GET_PAGE_INFO') {
      sendResponse({ documentId, url: publicPageUrl(location) || `${location.origin}${location.pathname}`, title: document.title, enabled: recording, recording, phase: phaseFromText(pageText()) });
      return false;
    }
    if (message.type === 'GET_CHECKOUT_PHASE') {
      sendResponse({ ok: true, phase: phaseFromText(pageText()), url: publicPageUrl(location) || `${location.origin}${location.pathname}` });
      return false;
    }
    if (message.type === 'EXECUTE_STEP') {
      executeStep(message).then(sendResponse, () => sendResponse({ ok: false, clicked: false, reason: '结账步骤执行失败，已停止。' }));
      return true;
    }
    return false;
  });
  try {
    const initial = runtime.sendMessage({ type: 'GET_RECORDING' });
    if (initial?.then) initial.then(result => { recording = result?.ok === true && result?.state?.enabled === true; }).catch(() => {});
  } catch { /* extension may have just been reloaded */ }
  tell({ type: 'CHECKOUT_READY', documentId, url: publicPageUrl(location) || `${location.origin}${location.pathname}` });
})();
