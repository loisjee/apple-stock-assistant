import test from 'node:test';
import assert from 'node:assert/strict';
import * as core from '../core.mjs';
const { DEFAULT_CONFIG, normalizeConfig, isAppleShopUrl, isSafeEntryUrl, publicStageUrl } = core;
const entry = 'https://www.apple.com.cn/shop/product/MK2T4CH/A';
const testEntry = 'https://www.apple.com.cn/shop/buy-iphone/iphone-18-pro/mjyj4ch/a';

test('exports only pure configuration and page helpers', () => {
  assert.deepEqual(Object.keys(core).sort(), ['DEFAULT_CONFIG', 'normalizeConfig', 'isAppleShopUrl', 'isSafeEntryUrl', 'publicStageUrl'].sort());
});

test('defaults target one Duo, with no private contact data', () => {
  const config = normalizeConfig();
  assert.deepEqual(config, DEFAULT_CONFIG);
  assert.equal(config.productUrl, entry);
  assert.equal(config.quantity, 1);
  assert.equal(config.retrySeconds, 3);
  assert.equal(config.maxRefreshes, 0);
  assert.equal(config.maxTotal, 0);
  assert.equal(config.submitEnabled, false);
  assert.ok(Object.values(config.shipping).every((value) => value === ''));
  assert.ok(Object.isFrozen(DEFAULT_CONFIG) && Object.isFrozen(DEFAULT_CONFIG.shipping));
  config.shipping.city = '测试城市';
  assert.equal(DEFAULT_CONFIG.shipping.city, '');
});

test('normalizes the observed test product and form values', () => {
  const config = normalizeConfig({ partNumber: ' mjyj4ch/a ', productUrl: testEntry,
    fulfillment: 'pickup', paymentMethod: 'wechat', retrySeconds: '5', maxRefreshes: '100', maxTotal: '16499', quantity: '1' });
  assert.equal(config.partNumber, 'MJYJ4CH/A');
  assert.equal(config.productUrl, testEntry);
  assert.equal(config.fulfillment, 'pickup');
  assert.equal(config.paymentMethod, 'wechat');
  assert.equal(config.retrySeconds, 5);
  assert.equal(config.maxRefreshes, 100);
  assert.equal(config.maxTotal, 16499);
});

test('known Apple shopping hosts are exact, HTTPS only, and have shop paths', () => {
  for (const host of ['www.apple.com.cn', 'secure.www.apple.com.cn', 'secure6.www.apple.com.cn', 'secure10.www.apple.com.cn']) {
    assert.equal(isAppleShopUrl(`https://${host}/shop/checkout`), true);
  }
  for (const url of ['http://www.apple.com.cn/shop/bag', 'https://www.apple.com.cn.evil.example/shop/bag',
    'https://secure5.store.apple.com.cn/shop/checkout', 'https://www.apple.com/cn/shop/bag',
    'https://www.apple.com.cn:8443/shop/bag', 'https://user:password@www.apple.com.cn/shop/bag',
    'https://www.apple.com.cn/shopper', 'https://www.apple.com.cn/iphone', 'not a URL']) assert.equal(isAppleShopUrl(url), false, url);
});

test('entry links are limited to public product and buy pages', () => {
  for (const url of [entry, testEntry, 'https://www.apple.com.cn/shop/buy-iphone/iphone-duo']) assert.equal(isSafeEntryUrl(url), true);
  for (const url of ['https://www.apple.com.cn/shop/bag', 'https://www.apple.com.cn/shop/checkout',
    'https://secure.www.apple.com.cn/shop/product/MK2T4CH/A', 'https://www.apple.com.cn/shop/product/',
    'javascript:alert(1)', 'https://www.apple.com.cn/shop/product/../../bag']) assert.equal(isSafeEntryUrl(url), false);
  assert.throws(() => normalizeConfig({ productUrl: 'https://www.apple.com.cn/shop/bag' }), /商品链接/);
});

test('saved entry URL contains no query/session data or fragment', () => {
  assert.equal(normalizeConfig({ productUrl: `${entry}?session=synthetic-private&other=value#bag` }).productUrl, entry);
});

test('stage URL preserves only valid symbolic checkout stage', () => {
  assert.equal(publicStageUrl('https://secure6.www.apple.com.cn/shop/checkout/?_s=Shipping-init&session=synthetic#private'),
    'https://secure6.www.apple.com.cn/shop/checkout?_s=Shipping-init');
  assert.equal(publicStageUrl(`${entry}?tracking=synthetic#variant`), entry);
  assert.equal(publicStageUrl({ origin: 'https://secure.www.apple.com.cn', pathname: '/shop/checkout', search: '?_s=Review&secret=synthetic' }),
    'https://secure.www.apple.com.cn/shop/checkout?_s=Review');
  assert.equal(publicStageUrl({ href: entry }), entry);
  for (const value of ['?_s=Shipping&_s=Review', '?_s=private-session-token', '?_s=Billing%26private']) {
    assert.equal(publicStageUrl(`https://secure.www.apple.com.cn/shop/checkout${value}`), null);
  }
  assert.equal(publicStageUrl('https://evil.example/shop/checkout?_s=Review'), null);
});

test('validates required SKU, refresh bounds and quantity one', () => {
  for (const partNumber of ['', '../MK2T4', 'MK2T4CH/A?x=1', '商品编号', '1234']) assert.throws(() => normalizeConfig({ partNumber }), /商品编号/);
  for (const retrySeconds of [0, 2, 31, 3.5, 'oops']) assert.throws(() => normalizeConfig({ retrySeconds }), /刷新间隔/);
  for (const maxRefreshes of [-1, 301, 1.5, 'oops']) assert.throws(() => normalizeConfig({ maxRefreshes }), /刷新次数/);
  for (const quantity of [0, 2, 1.5, 'oops']) assert.throws(() => normalizeConfig({ quantity }), /购买数量/);
  assert.equal(normalizeConfig({ retrySeconds: 30, maxRefreshes: 300 }).maxRefreshes, 300);
});

test('amount allows cents and unset zero but rejects invalid limits', () => {
  for (const maxTotal of [0, 0.01, 16499.99, 1000000]) assert.equal(normalizeConfig({ maxTotal }).maxTotal, maxTotal);
  for (const maxTotal of [-1, Infinity, NaN, 1000000.01, 1.001, 'oops']) assert.throws(() => normalizeConfig({ maxTotal }), /金额上限/);
  assert.equal(normalizeConfig({ submitEnabled: true, maxTotal: 0 }).submitEnabled, true);
});

test('fulfillment/payment/submit values are explicit enums or booleans', () => {
  assert.throws(() => normalizeConfig({ fulfillment: 'either' }), /送货或到店/);
  assert.throws(() => normalizeConfig({ paymentMethod: 'bankCard' }), /支付宝或微信/);
  assert.throws(() => normalizeConfig({ submitEnabled: 'true' }), /开启或关闭/);
});

test('incomplete contact fields may be saved and supplied contacts are validated', () => {
  const shipping = { lastName: '测试', firstName: '用户', city: '测试城市',
    recipientPhone: '+86 138-0000-0000', contactPhone: '13900000000', email: 'dummy@example.invalid' };
  const config = normalizeConfig({ shipping });
  assert.equal(config.shipping.recipientPhone, '13800000000');
  assert.equal(config.shipping.contactPhone, '13900000000');
  assert.equal(config.shipping.detailAddress, '');
  assert.equal(config.shipping.email, 'dummy@example.invalid');
  for (const recipientPhone of ['12345', '10000000000', '138000000000', '138abc00000']) {
    assert.throws(() => normalizeConfig({ shipping: { recipientPhone } }), /11 位/);
  }
  for (const email of ['bad', 'bad@@example.invalid', 'a b@example.invalid']) assert.throws(() => normalizeConfig({ shipping: { email } }), /电子邮箱/);
});

test('field lengths, control characters and unsupported private fields are handled', () => {
  assert.throws(() => normalizeConfig({ shipping: { detailAddress: '字'.repeat(251) } }), /250/);
  assert.throws(() => normalizeConfig({ shipping: { firstName: '字'.repeat(51) } }), /50/);
  assert.throws(() => normalizeConfig({ shipping: { firstName: 'dummy\u0000name' } }), /无效字符/);
  assert.throws(() => normalizeConfig({ shipping: { recipientPhone: 13800000000 } }), /须为文字/);
  assert.throws(() => normalizeConfig({ shipping: [] }), /收货资料/);
  assert.equal('password' in normalizeConfig({ shipping: { password: 'synthetic-unused' } }).shipping, false);
  assert.equal('location' in normalizeConfig({ location: '123456' }), false);
  assert.throws(() => normalizeConfig(null), /设置格式/);
});
