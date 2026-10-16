import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../checkout.js', import.meta.url), 'utf8');
const context = vm.createContext({ URL });
vm.runInContext(source, context);
const h = context.__shikeCheckoutInternals;
const record = value => ({ label: '订单总额', value });
const quantity = value => ({ label: '数量', value });
const guarded = overrides => h.validateGuard({ total: h.totalFromRecords([record('RMB 13,999.00')]), quantity: h.quantityFromRecords([quantity('1')]), text: 'iPhone Pro Max MK2T4CH/A', ...overrides }, { maxTotal: 14000, quantity: 1, expectedProduct: 'MK2T4CH/A' });

test('only exact order submission labels are treated as submission; payment labels are blocked', () => {
  for (const label of ['下订单', '提交订单', '确认订单', 'Place your order']) assert.equal(h.actionForLabel(label), 'submitOrder');
  for (const label of ['立即支付', '继续前往付款', 'Apple Pay', '支付宝', 'Pay now', '选择微信支付', '继续选择付款方式并支付', 'Continue to payment']) assert.equal(h.actionForLabel(label), 'payment');
  for (const label of ['继续', '查看购物袋', '确认地址', '查看确认订单帮助', '继续选择付款方式', 'Continue to payment method', '以游客身份继续']) assert.equal(h.actionForLabel(label), 'click');
});

test('recorder text allowlist excludes names, addresses, contact details and arbitrary account text', () => {
  assert.equal(h.safeLabel('  继续\n '), '继续');
  assert.equal(h.safeLabel('以游客身份继续'), '以游客身份继续');
  assert.equal(h.safeLabel('继续选择付款方式'), '继续选择付款方式');
  assert.equal(h.safeLabel('Continue to payment method'), 'Continue to payment method');
  assert.equal(h.safeLabel('继续填写送货地址'), '继续填写送货地址');
  assert.equal(h.safeLabel('继续填写送货地址：测试收货人'), null);
  assert.equal(h.safeLabel('继续选择付款方式并支付'), null);
  assert.equal(h.safeLabel('检查订单'), '检查订单');
  for (const label of ['张三', '13800138000', 'someone@example.com', '收货地址', '上海市某某路 123 号', '我的账号', '任意未知文案']) assert.equal(h.safeLabel(label), null);
});

test('provider selection is allowed only for exact merchant Billing-stage radios', () => {
  const input = { tag: 'input', type: 'radio', label: '支付宝', url: 'https://secure6.www.apple.com.cn/shop/checkout?_s=Billing-init' };
  assert.equal(h.providerRadioAllowed(input), true);
  assert.equal(h.providerRadioAllowed({ ...input, label: '微信支付' }), true);
  assert.equal(h.providerRadioAllowed({ ...input, tag: 'div', type: undefined, role: 'radio' }), true);
  for (const override of [{ tag: 'button' }, { tag: 'a' }, { type: 'checkbox' }, { label: '支付宝分期' }, { label: '信用卡' }, { label: '立即支付宝付款' },
    { url: 'https://secure6.www.apple.com.cn/shop/checkout?_s=Shipping-init' },
    { url: 'https://secure6.www.apple.com.cn/shop/checkout?_s=Review-init' },
    { url: 'https://secure6.www.apple.com.cn/shop/checkout' },
    { url: 'https://secure6.www.apple.com.cn/shop/checkout/payment?_s=Billing-init' },
    { url: 'https://example.invalid/shop/checkout?_s=Billing-init' }]) assert.equal(h.providerRadioAllowed({ ...input, ...override }), false);
});

test('only supported HTTPS Apple shop origins and the recorded page path match', () => {
  assert.equal(h.allowedOrigin('https://www.apple.com.cn'), true);
  assert.equal(h.allowedOrigin('https://secure5.www.apple.com.cn'), true);
  for (const origin of ['http://www.apple.com.cn', 'https://www.apple.com.cn.example.com', 'https://store.apple.com.cn', 'https://secure5.store.apple.com', 'https://www.apple.com.cn:8443', 'https://name:secret@www.apple.com.cn']) assert.equal(h.allowedOrigin(origin), false);
  assert.equal(h.locationMatches({ url: 'https://www.apple.com.cn/shop/bag/?x=ignored' }, { origin: 'https://www.apple.com.cn', pathname: '/shop/bag' }), true);
  assert.equal(h.locationMatches({ url: 'https://www.apple.com.cn/shop/bag' }, { origin: 'https://www.apple.com.cn', pathname: '/shop/checkout' }), false);
});

test('recorded URL preserves only public Apple checkout stage, never session or contact queries', () => {
  const shipping = 'https://secure10.www.apple.com.cn/shop/checkout?_s=Shipping-init';
  const current = { origin: 'https://secure10.www.apple.com.cn', pathname: '/shop/checkout', search: '?session=fake-session&_s=Shipping-init&email=fake%40example.invalid#fake-fragment' };
  assert.equal(h.publicPageUrl(current), shipping);
  assert.equal(h.publicPageUrl(`${shipping}&token=fake-secret#fake-fragment`), shipping);
  assert.equal(h.locationMatches({ url: shipping }, current), true);
  assert.equal(h.locationMatches({ url: shipping }, { ...current, search: '?_s=Review-init' }), false);
  assert.equal(h.locationMatches({ url: shipping }, { ...current, search: '?_s=Billing-init' }), false);
  assert.equal(h.locationMatches({ url: shipping }, { ...current, search: '' }), false);
  assert.equal(h.locationMatches({ url: shipping.split('?')[0] }, current), false, 'Old stage-less steps must be recorded again');
  assert.equal(h.publicPageUrl(`${shipping}&_s=Review-init`), null, 'Duplicate stage values are ambiguous');
  assert.equal(h.publicPageUrl('https://secure10.www.apple.com.cn/shop/checkout?_s=fake-session-token'), null);
  assert.equal(h.publicPageUrl('https://www.apple.com.cn/shop/buy-iphone/fixture?colour=blue&token=fake-secret'), 'https://www.apple.com.cn/shop/buy-iphone/fixture');
});

test('builtin semantic stages distinguish checkout states and never classify payment as an action stage', () => {
  assert.equal(h.semanticStage('https://www.apple.com.cn/shop/product/MK2T4CH/A'), 'product');
  assert.equal(h.semanticStage('https://www.apple.com.cn/shop/buyflow/attach'), 'attach');
  assert.equal(h.semanticStage('https://www.apple.com.cn/shop/buy-iphone/iphone-18-pro?product=mjyj4ch/a&step=attach'), 'attach');
  assert.equal(h.semanticStage('https://www.apple.com.cn/shop/buy-iphone/iphone-18-pro?step=attach&step=other'), 'blocked');
  assert.equal(h.semanticStage('https://secure6.www.apple.com.cn/shop/checkout?_s=Shipping-init'), 'shipping');
  assert.equal(h.semanticStage('https://secure6.www.apple.com.cn/shop/checkout?_s=Review'), 'review');
  assert.equal(h.semanticStage('https://secure6.www.apple.com.cn/shop/checkout/payment'), 'blocked');
  assert.equal(h.semanticStage('https://secure6.www.apple.com.cn/shop/checkout/status'), 'processing');
  assert.equal(h.semanticStage('https://secure6.www.apple.com.cn/shop/checkout/interstitial'), 'processing');
  assert.equal(h.semanticStage('https://secure6.www.apple.com.cn/shop/checkout/interstitial', '你的订单正在等待付款。订单 #W900000001'), 'awaitingPayment');
});

test('order total must be a uniquely labeled RMB total', () => {
  assert.equal(h.totalFromRecords([record('¥13,999.00')]).total, 13999);
  assert.equal(h.totalFromRecords([record('CNY 13999')]).total, 13999);
  assert.equal(h.totalFromRecords([record('13999 元')]).total, 13999);
  assert.equal(h.totalFromRecords([record('¥13,999.00 元')]).total, 13999);
  assert.equal(h.totalFromRecords([{ label: '小计', value: '¥13,999' }]).ok, false);
  assert.equal(h.totalFromRecords([record('13,999.00')]).ok, false);
  assert.equal(h.totalFromRecords([record('¥13,999 + ¥10')]).ok, false);
  assert.equal(h.totalFromRecords([record('¥13,999'), record('¥12,999')]).ok, false);
  assert.equal(h.totalFromRecords([record('¥13,999'), record('¥13,999')]).ok, true);
  assert.equal(h.totalFromRecords([record('¥0')]).ok, false);
  for (const amount of ['¥13,99', '¥1,234.567', '¥13,999.00.1', '¥13,999,']) assert.equal(h.totalFromRecords([record(amount)]).ok, false);
});

test('quantity must be one explicit field, never inferred from a product name or defaulted', () => {
  assert.equal(h.quantityFromRecords([quantity('1')]).quantity, 1);
  assert.equal(h.quantityFromRecords([]).ok, false);
  assert.equal(h.quantityFromRecords([quantity('1'), quantity('1')]).ok, false);
  assert.equal(h.quantityFromRecords([quantity('iPhone 18')]).ok, false);
  assert.equal(h.quantityFromRecords([{ label: '分期', value: '1' }]).ok, false);
});

test('confirmation requires an actual order number and accepted/pending order state', () => {
  assert.equal(h.phaseFromText('订单编号 W123456789 已收到您的订单，等待付款'), 'awaitingPayment');
  assert.equal(h.phaseFromText('订单号：W123456789 订单已确认'), 'awaitingPayment');
  assert.equal(h.phaseFromText('订单号：W123456789 尚未付款'), 'awaitingPayment');
  assert.equal(h.phaseFromText('Order number W123456789 Thank you for your order'), 'awaitingPayment');
  assert.equal(h.phaseFromText('你的订单正在等待付款。请点击 现在支付 以前往支付宝尽快完成付款。付款务必在30分钟内完成。订单 #W900000001'), 'awaitingPayment');
  assert.equal(h.phaseFromText('订单 #W900000001 下订单'), 'checkout');
  assert.equal(h.phaseFromText('订单确认 总计 ¥13,999 下订单'), 'checkout');
  assert.equal(h.phaseFromText('订单编号说明 下订单'), 'checkout');
  assert.equal(h.phaseFromText('等待付款'), 'checkout');
});

test('submit guard checks final SKU, price cap and explicit expected quantity', () => {
  assert.equal(guarded().ok, true);
  assert.equal(guarded({ text: 'iPhone Pro Max 1TB' }).ok, false);
  assert.equal(guarded({ text: 'iPhone Pro Max XMK2T4CH/A' }).ok, false);
  assert.equal(guarded({ total: h.totalFromRecords([record('¥14,001')]) }).ok, false);
  assert.equal(guarded({ quantity: h.quantityFromRecords([quantity('2')]) }).ok, false);
  assert.equal(guarded({ quantity: h.quantityFromRecords([]) }).ok, false);
});

test('known full-name fallback requires one Review-stage item row with exact model, capacity, color and explicit quantity', () => {
  const name = 'iPhone 18 Pro Max 1TB 冰川蓝色';
  const url = 'https://secure6.www.apple.com.cn/shop/checkout?_s=Review';
  const row = { headings: [name], text: `${name} 数量 1 RMB 16,499` };
  const verify = lists => h.knownProductFromLists(lists, 'MJYJ4CH/A', url);
  const namedProduct = verify([{ rows: [row] }]);
  assert.equal(namedProduct.ok, true);
  assert.equal(namedProduct.quantity, 1);
  assert.equal(namedProduct.name, name);
  assert.equal(h.validateGuard({ total: h.totalFromRecords([record('RMB 16,499')]), quantity: h.quantityFromRecords([]), text: name, namedProduct }, { maxTotal: 16500, quantity: 1, expectedProduct: 'MJYJ4CH/A' }).ok, true);
  assert.equal(h.validateGuard({ total: h.totalFromRecords([record('RMB 16,500')]), quantity: h.quantityFromRecords([]), text: name, namedProduct }, { maxTotal: 16500, quantity: 1, expectedProduct: 'MJYJ4CH/A' }).ok, false);
  for (const lists of [[], [{ rows: [] }], [{ rows: [row, row] }], [{ rows: [row] }, { rows: [row] }],
    [{ rows: [{ ...row, headings: ['iPhone 18 Pro Max 512GB 冰川蓝色'] }] }],
    [{ rows: [{ ...row, headings: ['iPhone 18 Pro Max 1TB 星光白色'] }] }],
    [{ rows: [{ ...row, text: `${name} RMB 16,499` }] }],
    [{ rows: [{ ...row, text: `${name} 数量 1 RMB 16,499 配件 RMB 99` }] }]]) assert.equal(verify(lists).ok, false);
  assert.equal(h.knownProductFromLists([{ rows: [row] }], 'UNKNOWNCH/A', url).ok, false);
  assert.equal(h.knownProductFromLists([{ rows: [row] }], 'MJYJ4CH/A', url.replace('Review', 'Billing-init')).ok, false);
  const wrongQuantity = verify([{ rows: [{ ...row, text: `${name} 数量 2 RMB 16,499` }] }]);
  assert.equal(h.validateGuard({ total: h.totalFromRecords([record('RMB 16,499')]), quantity: h.quantityFromRecords([]), text: name, namedProduct: wrongQuantity }, { maxTotal: 16500, quantity: 1, expectedProduct: 'MJYJ4CH/A' }).ok, false);
});

// Optional real Chromium DOM verification. Install Playwright locally to run this
// portion; it uses fixture pages only and never contacts Apple or submits an order.
let chromium;
try { ({ chromium } = await import('playwright')); }
catch {
  /* Pure guard tests above remain portable without browser dependencies. */
}

test('Chromium fixtures: record, rehearse, guarded submit, payment interception, duplicate prevention', { skip: !chromium }, async t => {
  let browser;
  try { browser = await chromium.launch({ headless: true, channel: 'chrome' }); }
  catch { browser = await chromium.launch({ headless: true }); }
  t.after(() => browser.close());
  const sku = '<p data-autom="review-part-number">MK2T4CH/A</p>';
  const totals = '<dl><dt>订单总额</dt><dd>RMB 13,999.00</dd></dl>';
  const quantities = '<p><span>数量</span><span data-autom="review-item-quantity">1</span></p>';
  const button = '<button data-autom="place-order" onclick="window.fixtureClicks++">下订单</button>';
  const guard = { maxTotal: 14000, quantity: 1, expectedProduct: 'MK2T4CH/A' };
  const step = { version: 1, url: 'https://www.apple.com.cn/shop/checkout/review', kind: 'submitOrder', label: '下订单', locator: { kind: 'data-autom', value: 'place-order', tag: 'button' } };
  const page = await browser.newPage();
  await page.route('**/*', route => route.fulfill({ status: 200, contentType: 'text/html', body: '<html><head><title>Fixture only</title></head><body></body></html>' }));
  async function load(html) {
    await page.goto(step.url);
    await page.setContent(`<main>${html}</main>`);
    await page.evaluate(() => {
      window.fixtureClicks = 0;
      window.fixtureMessages = [];
      window.overlayEvents = [];
      window.__shikeOverlay = { suspend: () => window.overlayEvents.push('suspend'), resume: () => window.overlayEvents.push('resume') };
      window.chrome = { runtime: { id: 'checkout-fixture', getURL: path => `chrome-extension://checkout-fixture/${path}`, onMessage: { addListener: listener => { window.fixtureListener = listener; } }, sendMessage: async message => { window.fixtureMessages.push(message); return { ok: true, state: { enabled: false } }; } } };
      window.fixtureMessage = message => new Promise(resolve => window.fixtureListener(message, { id: 'checkout-fixture', url: 'chrome-extension://checkout-fixture/background.mjs' }, resolve));
    });
    await page.addScriptTag({ content: source });
  }
  const send = message => page.evaluate(message => window.fixtureMessage(message), message);
  await load(sku + totals + quantities + button);
  let result = await send({ type: 'EXECUTE_STEP', step, guard, dryRun: true });
  assert.equal(result.ok, true);
  assert.equal(result.clicked, false);
  assert.equal(result.total, 13999);
  assert.equal(await page.evaluate(() => window.fixtureClicks), 0);

  await load(sku + totals + quantities + button);
  const cancelled = await page.evaluate(async ({ step, guard }) => {
    const pending = window.fixtureMessage({ type: 'EXECUTE_STEP', step, guard, dryRun: false });
    await window.fixtureMessage({ type: 'CANCEL_EXECUTION' });
    return pending;
  }, { step, guard });
  assert.equal(cancelled.ok, false);
  assert.match(cancelled.reason, /取消/);
  assert.equal(await page.evaluate(() => window.fixtureClicks), 0);
  assert.deepEqual(await page.evaluate(() => window.overlayEvents), ['suspend', 'resume']);

  await load(sku + totals + quantities + button);
  result = await send({ type: 'EXECUTE_STEP', step, guard, dryRun: false });
  assert.equal(result.ok, true);
  assert.equal(result.clicked, true);
  assert.equal(await page.evaluate(() => window.fixtureClicks), 1);
  assert.deepEqual(await page.evaluate(() => window.overlayEvents), ['suspend', 'resume']);
  result = await send({ type: 'EXECUTE_STEP', step, guard, dryRun: false });
  assert.equal(result.ok, false);
  assert.equal(await page.evaluate(() => window.fixtureClicks), 1);

  for (const fixture of [totals + quantities + button, sku + quantities + button, sku + totals + button,
    sku + totals + quantities + '<p><span>数量</span><span>1</span></p>' + button,
    sku + totals.replace('13,999', '14,999') + quantities + button]) {
    await load(fixture);
    result = await send({ type: 'EXECUTE_STEP', step, guard, dryRun: false });
    assert.equal(result.ok, false);
    assert.equal(await page.evaluate(() => window.fixtureClicks), 0);
  }

  await load(sku + totals + quantities + '<button data-autom="place-order" onclick="window.fixtureClicks++">立即支付</button>');
  result = await send({ type: 'EXECUTE_STEP', step, guard, dryRun: false });
  assert.equal(result.ok, false);
  assert.match(result.reason, /付款/);
  assert.equal(await page.evaluate(() => window.fixtureClicks), 0);

  await load('<p>订单编号 W123456789 等待付款</p>' + button);
  result = await send({ type: 'EXECUTE_STEP', step, guard, dryRun: false });
  assert.equal(result.phase, 'awaitingPayment');
  assert.equal(result.clicked, false);
  assert.equal(await page.evaluate(() => window.fixtureClicks), 0);

  await load(sku + totals + quantities + button);
  result = await send({ type: 'EXECUTE_STEP', step: { ...step, kind: 'click' }, guard, dryRun: false });
  assert.equal(result.ok, false);
  assert.equal(await page.evaluate(() => window.fixtureClicks), 0);
  const spoofResult = await page.evaluate(message => window.fixtureListener(message, { id: 'checkout-fixture', tab: { id: 3 }, url: location.href }, () => { throw new Error('Untrusted sender was answered'); }), { type: 'EXECUTE_STEP', step, guard, dryRun: false });
  assert.equal(spoofResult, false);
  assert.equal(await page.evaluate(() => window.fixtureClicks), 0);

  await send({ type: 'SET_RECORDING', enabled: true });
  await page.getByRole('button', { name: '下订单', exact: true }).click({ modifiers: ['Alt'] });
  const recorded = await page.evaluate(() => window.fixtureMessages.filter(message => message.type === 'RECORD_STEP'));
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].step.kind, 'submitOrder');
  assert.equal(recorded[0].step.url, step.url);
  assert.equal(await page.evaluate(() => window.fixtureClicks), 0);

  await load('<button data-autom="payment-now" onclick="window.fixtureClicks++">立即支付</button>');
  await send({ type: 'SET_RECORDING', enabled: true });
  await page.getByRole('button', { name: '立即支付', exact: true }).click({ modifiers: ['Alt'] });
  assert.equal(await page.evaluate(() => window.fixtureMessages.filter(message => message.type === 'RECORD_STEP').length), 0);
  assert.equal(await page.evaluate(() => window.fixtureClicks), 0);

  // The observed shipping-section button only navigates to payment-method selection.
  const navigationStep = { ...step, kind: 'click', label: '继续选择付款方式', locator: { kind: 'text', value: '继续选择付款方式', tag: 'button' } };
  await load('<form action="/shop/checkout/payment"><button type="button" onclick="window.fixtureClicks++">继续选择付款方式</button></form>');
  result = await send({ type: 'EXECUTE_STEP', step: navigationStep, guard, dryRun: false });
  assert.equal(result.ok, true);
  assert.equal(result.clicked, true);
  assert.equal(await page.evaluate(() => window.fixtureClicks), 1);

  // A known charging intent still wins over a misleading navigation label.
  await load('<button data-autom="pay-now" onclick="window.fixtureClicks++">继续选择付款方式</button>');
  result = await send({ type: 'EXECUTE_STEP', step: navigationStep, guard, dryRun: false });
  assert.equal(result.ok, false);
  assert.equal(await page.evaluate(() => window.fixtureClicks), 0);

  // Observed generic address-section navigation is safe; actual personal-address text is not.
  await load('<button id="shipping-address-continue" type="button" onclick="window.fixtureClicks++">继续填写送货地址</button>');
  await send({ type: 'SET_RECORDING', enabled: true });
  await page.getByRole('button', { name: '继续填写送货地址', exact: true }).click({ modifiers: ['Alt'] });
  const addressNav = await page.evaluate(() => window.fixtureMessages.find(message => message.type === 'RECORD_STEP')?.step);
  assert.equal(addressNav.kind, 'click');
  assert.equal(addressNav.label, '继续填写送货地址');
  assert.equal(addressNav.locator.kind, 'text');
  assert.equal(await page.evaluate(() => window.fixtureClicks), 0);
  await send({ type: 'SET_RECORDING', enabled: false });
  result = await send({ type: 'EXECUTE_STEP', step: addressNav, guard, dryRun: false });
  assert.equal(result.ok, true);
  assert.equal(await page.evaluate(() => window.fixtureClicks), 1);

  await load('<button data-autom="address-choice" onclick="window.fixtureClicks++">收货地址：测试收货人，测试路 123 号</button>');
  await send({ type: 'SET_RECORDING', enabled: true });
  await page.getByRole('button').click({ modifiers: ['Alt'] });
  assert.equal(await page.evaluate(() => window.fixtureMessages.filter(message => message.type === 'RECORD_STEP').length), 0);
  assert.equal(await page.evaluate(() => window.fixtureMessages.filter(message => message.type === 'RECORD_ERROR').length), 1);
  assert.equal(await page.evaluate(() => window.fixtureClicks), 0);

  // Same URL path is not sufficient: Apple's _s stage must also match.
  await load('<button type="button" onclick="window.fixtureClicks++">继续选择付款方式</button>');
  await page.evaluate(() => history.replaceState({}, '', '/shop/checkout/review?_s=Shipping-init&token=fake-private-value'));
  await send({ type: 'SET_RECORDING', enabled: true });
  await page.getByRole('button', { name: '继续选择付款方式', exact: true }).click({ modifiers: ['Alt'] });
  const stageStep = await page.evaluate(() => window.fixtureMessages.find(message => message.type === 'RECORD_STEP').step);
  assert.equal(stageStep.url, `${step.url}?_s=Shipping-init`);
  assert.equal(stageStep.version, 2);
  assert.equal(JSON.stringify(stageStep).includes('fake-private-value'), false);
  await send({ type: 'SET_RECORDING', enabled: false });
  await page.evaluate(() => history.replaceState({}, '', '/shop/checkout/review?_s=Review-init'));
  result = await send({ type: 'EXECUTE_STEP', step: stageStep, guard, dryRun: false });
  assert.equal(result.ok, false);
  assert.match(result.reason, /结账阶段/);
  assert.equal(await page.evaluate(() => window.fixtureClicks), 0);
  await page.evaluate(() => history.replaceState({}, '', '/shop/checkout/review?_s=Shipping-init&session=fake-other-session'));
  result = await send({ type: 'EXECUTE_STEP', step: stageStep, guard, dryRun: false });
  assert.equal(result.ok, true);
  assert.equal(await page.evaluate(() => window.fixtureClicks), 1);

  // A merchant billing radio chooses a provider without authorizing any payment.
  await load('<label><input type="radio" name="provider" data-autom="billing-payment-option" onclick="window.fixtureClicks++">支付宝</label><button type="button">检查订单</button>');
  await page.evaluate(() => history.replaceState({}, '', '/shop/checkout?_s=Billing-init'));
  await send({ type: 'SET_RECORDING', enabled: true });
  await page.getByText('支付宝', { exact: true }).click({ modifiers: ['Alt'] });
  const providerStep = await page.evaluate(() => window.fixtureMessages.find(message => message.type === 'RECORD_STEP')?.step);
  assert.equal(providerStep.kind, 'click');
  assert.equal(providerStep.label, '支付宝');
  assert.equal(await page.getByRole('radio', { name: '支付宝', exact: true }).isChecked(), false);
  assert.equal(await page.evaluate(() => window.fixtureClicks), 0);
  await send({ type: 'SET_RECORDING', enabled: false });
  result = await send({ type: 'EXECUTE_STEP', step: providerStep, guard, dryRun: false });
  assert.equal(result.ok, true);
  assert.equal(await page.getByRole('radio', { name: '支付宝', exact: true }).isChecked(), true);
  assert.equal(await page.evaluate(() => window.fixtureClicks), 1);

  await page.evaluate(() => history.replaceState({}, '', '/shop/checkout?_s=Shipping-init'));
  result = await send({ type: 'EXECUTE_STEP', step: { ...providerStep, url: 'https://www.apple.com.cn/shop/checkout?_s=Shipping-init' }, guard, dryRun: false });
  assert.equal(result.ok, false);
  assert.match(result.reason, /付款/);
  assert.equal(await page.evaluate(() => window.fixtureClicks), 1);

  for (const markup of ['<button data-autom="billing-payment-option" onclick="window.fixtureClicks++">支付宝</button>',
    '<a href="/shop/checkout" data-autom="billing-payment-option" onclick="window.fixtureClicks++">支付宝</a>',
    '<label><input type="radio" data-autom="pay-now" onclick="window.fixtureClicks++">支付宝</label>',
    '<form action="/shop/checkout/payment"><label><input type="radio" onclick="window.fixtureClicks++">支付宝</label></form>']) {
    await load(markup);
    await page.evaluate(() => history.replaceState({}, '', '/shop/checkout?_s=Billing-init'));
    await send({ type: 'SET_RECORDING', enabled: true });
    await page.getByText('支付宝', { exact: true }).click({ modifiers: ['Alt'] });
    assert.equal(await page.evaluate(() => window.fixtureMessages.filter(message => message.type === 'RECORD_STEP').length), 0);
    assert.equal(await page.evaluate(() => window.fixtureClicks), 0);
  }

  const knownName = 'iPhone 18 Pro Max 1TB 冰川蓝色';
  const knownRow = `<li><h2>${knownName}</h2><span>数量 1 RMB 16,499</span></li>`;
  const knownTotals = '<dl><dt>小计</dt><dd>RMB 16,499</dd><dt>运费</dt><dd>免费</dd><dt>总计</dt><dd>RMB 16,499</dd></dl>';
  const knownGuard = { maxTotal: 16500, quantity: 1, expectedProduct: 'MJYJ4CH/A' };
  const knownStep = { ...step, url: 'https://www.apple.com.cn/shop/checkout?_s=Review' };
  async function loadReview(markup) {
    await load(markup + knownTotals + button);
    await page.evaluate(() => history.replaceState({}, '', '/shop/checkout?_s=Review'));
  }
  await loadReview(`<ul>${knownRow}</ul>`);
  result = await send({ type: 'EXECUTE_STEP', step: knownStep, guard: knownGuard, dryRun: true });
  assert.equal(result.ok, true);
  assert.equal(result.quantity, 1);
  assert.equal(await page.evaluate(() => window.fixtureClicks), 0);
  result = await send({ type: 'EXECUTE_STEP', step: knownStep, guard: knownGuard, dryRun: false });
  assert.equal(result.ok, true);
  assert.equal(await page.evaluate(() => window.fixtureClicks), 1);
  for (const markup of [`<footer><ul>${knownRow}</ul></footer>`,
    `<ul>${knownRow.replace('1TB', '512GB')}</ul>`, `<ul>${knownRow.replace('冰川蓝色', '星光白色')}</ul>`,
    `<ul>${knownRow}${knownRow}</ul>`,
    `<ul>${knownRow}</ul><ul><li><h2>USB-C 电源适配器</h2>数量 1 RMB 99</li></ul>`,
    `<ul>${knownRow}</ul><ul><li>配件 数量 1 RMB 99</li></ul>`,
    `<ul><li><h2>${knownName}</h2><h3>USB-C 电源适配器</h3>数量 1 RMB 16,499 RMB 99</li></ul>`,
    `<ul><li><h2>${knownName}</h2>RMB 16,499</li></ul>`]) {
    await loadReview(markup);
    result = await send({ type: 'EXECUTE_STEP', step: knownStep, guard: knownGuard, dryRun: false });
    assert.equal(result.ok, false);
    assert.equal(await page.evaluate(() => window.fixtureClicks), 0);
  }

  await loadReview('<p>你的订单正在等待付款。请点击 现在支付 以前往支付宝尽快完成付款。</p><a href="#">订单 #W900000001</a>');
  result = await send({ type: 'GET_CHECKOUT_PHASE' });
  assert.equal(result.phase, 'awaitingPayment');
  result = await send({ type: 'EXECUTE_STEP', step: knownStep, guard: knownGuard, dryRun: false });
  assert.equal(result.phase, 'awaitingPayment');
  assert.equal(result.clicked, false);
  assert.equal(await page.evaluate(() => window.fixtureClicks), 0);
});

test('builtin click flow: local product-to-pending-payment fixtures, staged forms, dedupe and human gates', { skip: !chromium }, async t => {
  let browser;
  try { browser = await chromium.launch({ channel: 'chrome', headless: true }); }
  catch { browser = await chromium.launch({ headless: true }); }
  t.after(() => browser.close());
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => route.fulfill({ status: 200, contentType: 'text/html', body: '<html><body></body></html>' }));
  const config = { partNumber: 'MK2T4CH/A', productUrl: 'https://www.apple.com.cn/shop/product/MK2T4CH/A', fulfillment: 'delivery', paymentMethod: 'wechat', quantity: 1, maxTotal: 20000, submitEnabled: true,
    shipping: { lastName: '测试', firstName: '用户', province: '测试省', city: '测试市', district: '测试区', detailAddress: '仅用于本地 fixture 的虚构地址', recipientPhone: '00000000000', contactPhone: '00000000000', email: 'fixture@example.invalid' } };
  async function load(path, markup) {
    await page.goto(`https://www.apple.com.cn${path}`);
    await page.setContent(`<main>${markup}</main>`);
    await page.evaluate(() => {
      window.fixtureClicks = 0;
      window.fixtureMessages = [];
      window.inputEvents = [];
      window.overlayEvents = [];
      window.__shikeOverlay = { suspend: () => window.overlayEvents.push('suspend'), resume: () => window.overlayEvents.push('resume') };
      document.addEventListener('input', event => window.inputEvents.push(event.target.id));
      window.chrome = { runtime: { id: 'builtin-fixture', getURL: path => `chrome-extension://builtin-fixture/${path}`, onMessage: { addListener: listener => { window.fixtureListener = listener; } }, sendMessage: async message => { window.fixtureMessages.push(message); return { ok: true, state: { enabled: false } }; } } };
      window.fixtureMessage = message => new Promise(resolve => window.fixtureListener(message, { id: 'builtin-fixture', url: 'chrome-extension://builtin-fixture/background.mjs' }, resolve));
    });
    await page.addScriptTag({ content: source });
  }
  const send = message => page.evaluate(message => window.fixtureMessage(message), message);
  const probe = () => send({ type: 'PAGE_PROBE', config });
  let nextId = 0;
  async function act(expectedAction) {
    const current = await probe();
    assert.equal(current.ok, true);
    assert.equal(current.ready, true, current.reason);
    assert.equal(current.action, expectedAction);
    assert.ok(current.documentId);
    const result = await send({ type: 'PAGE_ACTION', runToken: 'fixture-run', actionId: `action-${++nextId}`, documentId: current.documentId, action: current.action, config });
    assert.equal(result.ok, true, result.reason);
    assert.ok(result.clicked || result.changed);
    return { result, current };
  }
  const button = (name, attributes = '') => `<button type="button" ${attributes} onclick="window.fixtureClicks++">${name}</button>`;

  await load('/shop/product/MK2T4CH/A', '<p>入口暂不可用</p>');
  let current = await probe();
  assert.equal(current.stage, 'product');
  assert.equal(current.ready, false);
  assert.equal(current.safeToReload, true);
  await page.locator('main').evaluate(element => { element.innerHTML = '<button type="button" onclick="window.fixtureClicks++">添加到购物袋</button>'; });
  current = await probe();
  assert.equal(current.action, 'addBag');
  const addMessage = { type: 'PAGE_ACTION', runToken: 'fixture-run', actionId: 'add-once', documentId: current.documentId, action: 'addBag', config };
  const concurrent = await page.evaluate(message => Promise.all([window.fixtureMessage(message), window.fixtureMessage(message)]), addMessage);
  assert.equal(concurrent.filter(result => result.clicked).length, 1);
  assert.equal(concurrent.filter(result => result.uncertain).length, 1);
  assert.equal(await page.evaluate(() => window.fixtureClicks), 1);
  assert.deepEqual(await page.evaluate(() => window.overlayEvents), ['suspend', 'resume']);
  current = await probe();
  assert.equal(current.ready, false);
  assert.equal(current.safeToReload, false);
  assert.equal((await send({ ...addMessage, actionId: 'different-id' })).ok, false);
  assert.equal(await page.evaluate(() => window.fixtureClicks), 1);

  await load('/shop/buyflow/attach', button('查看购物袋'));
  await act('viewBag');
  await load('/shop/buy-iphone/iphone-18-pro?product=mjyj4ch/a&step=attach', '<h2>iPhone 18 Pro Max 1TB 冰川蓝色</h2>' + button('查看购物袋') + button('添加到购物袋'));
  current = await probe();
  assert.equal(current.stage, 'attach');
  assert.equal(current.action, 'viewBag');
  assert.equal(current.safeToReload, false);
  await act('viewBag');
  assert.equal(await page.evaluate(() => window.fixtureClicks), 1);
  await load('/shop/bag', '<select data-autom="bag-item-quantity"><option selected>1</option></select>' + button('结账'));
  await act('checkout');
  await load('/shop/bag', button('结账') + '<select data-autom="bag-item-quantity"><option selected>1</option></select>' + button('结账'));
  await act('checkout');
  assert.equal(await page.evaluate(() => window.fixtureClicks), 1);
  await load('/shop/bag', '<form action="/shop/checkout">' + button('结账') + '</form><form action="/shop/checkout/payment">' + button('结账') + '</form>');
  current = await probe();
  assert.equal(current.ready, false);
  assert.equal(current.requiresHuman, true);
  assert.equal(await page.evaluate(() => window.fixtureClicks), 0);
  await load('/shop/signIn', '<label>密码<input type="password"></label>' + button('以游客身份继续'));
  await act('guest');

  await load('/shop/checkout?_s=Fulfillment-init', '<label><input type="radio" name="fulfillment" onclick="window.fixtureClicks++">为我送货</label><label><input type="radio" name="fulfillment">我要取货</label>' + button('继续填写送货地址'));
  await act('delivery');
  current = await probe();
  assert.equal(current.action, 'shippingContinue');
  await act('shippingContinue');

  await load('/shop/checkout?_s=Fulfillment-init', '<label><input type="radio" name="fulfillment">为我送货</label><label><input type="radio" name="fulfillment" checked>我要取货</label>');
  const pickupProbe = await send({ type: 'PAGE_PROBE', config: { ...config, fulfillment: 'pickup' } });
  assert.equal(pickupProbe.ready, false);
  assert.equal(pickupProbe.requiresHuman, true);
  assert.match(pickupProbe.reason, /门店和取货时间/);

  const region = (key, label, value) => `<label>${label}<select id="${key}" name="${key}"><option value="">请选择</option><option value="fixture">${value}</option></select></label>`;
  const input = (key, label, type = 'text') => `<label>${label}<input id="${key}" name="${key}" type="${type}" required></label>`;
  await load('/shop/checkout?_s=Shipping-init', region('province', '省份', '测试省') + region('city', '城市', '测试市') + region('district', '区县', '测试区') + input('lastName', '姓氏') + input('firstName', '名字') + input('detailAddress', '详细地址') + input('recipientPhone', '收货人手机号码', 'tel') + input('contactPhone', '联系人手机号码', 'tel') + input('email', '电子邮件地址', 'email') + button('继续选择付款方式'));
  for (const action of ['selectProvince', 'selectCity', 'selectDistrict', 'fillShipping']) await act(action);
  assert.equal(await page.locator('#detailAddress').inputValue(), config.shipping.detailAddress);
  assert.ok((await page.evaluate(() => window.inputEvents)).includes('detailAddress'));
  current = await probe();
  assert.equal(current.action, 'shippingContinue');
  await page.locator('main').evaluate(element => element.insertAdjacentHTML('beforeend', '<button id="verify-phone" type="button" onclick="window.fixtureClicks++">验证</button>'));
  current = await probe();
  assert.equal(current.stage, 'shipping');
  assert.equal(current.ready, false);
  assert.equal(current.requiresHuman, true);
  assert.match(current.reason, /手动点击“验证”/);
  const beforeVerify = await send({ type: 'PAGE_ACTION', runToken: 'fixture-run', actionId: 'must-verify-first', documentId: current.documentId, action: 'shippingContinue', config });
  assert.equal(beforeVerify.ok, false);
  assert.equal(beforeVerify.clicked, false);
  assert.equal(await page.evaluate(() => window.fixtureClicks), 0);
  await page.locator('#verify-phone').evaluate(element => element.outerHTML = '<span role="img" aria-label="验证成功">验证成功</span>');
  current = await probe();
  assert.equal(current.action, 'shippingContinue');
  await page.locator('main').evaluate(element => element.insertAdjacentHTML('beforeend', '<label id="otp-wrap">短信验证码<input autocomplete="one-time-code"></label>'));
  current = await probe();
  assert.equal(current.stage, 'blocked');
  assert.equal(current.requiresHuman, true);
  assert.equal(current.ready, false);
  await page.locator('#otp-wrap').evaluate(element => element.remove());
  await act('shippingContinue');

  await load('/shop/checkout?_s=Billing-init', '<label><input type="radio" name="provider">支付宝</label><label><input type="radio" name="provider" onclick="window.fixtureClicks++">微信支付</label>' + button('检查订单'));
  await act('selectPayment');
  assert.equal(await page.getByRole('radio', { name: '微信支付', exact: true }).isChecked(), true);
  current = await probe();
  assert.equal(current.action, 'billingContinue');
  await act('billingContinue');

  await load('/shop/checkout?_s=Review', '<ul><li><h2>iPhone Duo 1TB 星光白色</h2>数量 1 RMB 9,999</li></ul><dl><dt>总计</dt><dd>RMB 9,999</dd></dl><label><input type="checkbox" id="legal">我已阅读并同意条款与隐私政策</label>' + button('立即下单'));
  current = await probe();
  assert.equal(current.requiresHuman, true);
  assert.equal(current.ready, false);
  await page.locator('#legal').check(); // Explicit fixture user gesture; engine never ticks terms.
  current = await probe();
  assert.equal(current.action, 'submitOrder');
  assert.equal(current.guard.total, 9999);
  const submitted = await act('submitOrder');
  assert.equal(submitted.result.clicked, true);
  assert.equal(await page.evaluate(() => window.fixtureClicks), 1);
  assert.equal((await probe()).ready, false);

  for (const path of ['/shop/checkout/status', '/shop/checkout/interstitial']) {
    await load(path, '<p>正在处理，请稍候。</p>');
    current = await probe();
    assert.equal(current.stage, 'processing');
    assert.equal(current.ready, false);
    assert.equal(current.safeToReload, false);
    assert.equal(current.action, undefined);
    assert.equal(current.requiresHuman, undefined);
  }

  await load('/shop/checkout/interstitial', '<h1>你的订单正在等待付款。</h1><p>请点击现在支付以前往支付宝。</p><a href="#">订单 #W900000001</a>' + button('现在支付'));
  current = await probe();
  assert.equal(current.stage, 'awaitingPayment');
  assert.equal(current.ready, false);
  assert.equal(current.action, undefined);
  const forbidden = await send({ type: 'PAGE_ACTION', runToken: 'fixture-run', actionId: 'no-pay', documentId: current.documentId, action: 'submitOrder', config });
  assert.equal(forbidden.clicked, false);
  assert.equal(await page.evaluate(() => window.fixtureClicks), 0);

  await load('/shop/product/MK2T4CH/A', button('添加到购物袋'));
  current = await probe();
  const cancelled = await page.evaluate(async ({ current, config }) => {
    const pending = window.fixtureMessage({ type: 'PAGE_ACTION', runToken: 'fixture-run', actionId: 'cancelled-add', documentId: current.documentId, action: 'addBag', config });
    await window.fixtureMessage({ type: 'CANCEL_EXECUTION' });
    return pending;
  }, { current, config });
  assert.equal(cancelled.clicked, false);
  assert.equal(await page.evaluate(() => window.fixtureClicks), 0);
  assert.deepEqual(await page.evaluate(() => window.overlayEvents), ['suspend', 'resume']);
  assert.equal((await send({ type: 'PAGE_ACTION', runToken: 'fixture-run', actionId: 'stale', documentId: 'stale-document', action: 'addBag', config })).ok, false);
  await send({ type: 'PAGE_SCHEDULE', runToken: 'fixture-run', delayMs: 100 });
  await page.waitForFunction(() => window.fixtureMessages.some(message => message.type === 'PAGE_TICK'));
  assert.equal(await page.evaluate(() => window.fixtureMessages.find(message => message.type === 'PAGE_TICK').documentId), current.documentId);
  await page.evaluate(() => { window.fixtureMessages = []; });
  await send({ type: 'PAGE_SCHEDULE', runToken: 'fixture-run', delayMs: 100 });
  await send({ type: 'CANCEL_EXECUTION' });
  await page.waitForTimeout(150);
  assert.equal(await page.evaluate(() => window.fixtureMessages.filter(message => message.type === 'PAGE_TICK').length), 0);
  assert.deepEqual(errors, []);
});
