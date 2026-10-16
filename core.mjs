// Pure configuration and public-page helpers; no network or browser actions.
const PART_PATTERN = /^[A-Z0-9]{5,20}(?:\/[A-Z0-9]{1,4})?$/;
const SHOP_HOST = /^(?:www|secure\d*\.www)\.apple\.com\.cn$/;
const CHECKOUT_STAGE = /^(?:Fulfillment|Shipping|Billing|Review)(?:-init)?$/i;
const SHIPPING_LIMITS = Object.freeze({
  lastName: 50, firstName: 50, province: 60, city: 60, district: 60,
  detailAddress: 250, recipientPhone: 30, contactPhone: 30, email: 254,
});
const FIELD_LABELS = Object.freeze({
  lastName: '姓氏', firstName: '名字', province: '省份', city: '城市', district: '区县',
  detailAddress: '详细地址', recipientPhone: '收货人手机', contactPhone: '联系手机', email: '电子邮箱',
});

export const DEFAULT_CONFIG = Object.freeze({
  partNumber: 'MK2T4CH/A', productUrl: 'https://www.apple.com.cn/shop/product/MK2T4CH/A',
  fulfillment: 'delivery', paymentMethod: 'alipay', retrySeconds: 3, maxRefreshes: 0,
  maxTotal: 0, quantity: 1, submitEnabled: false,
  shipping: Object.freeze(Object.fromEntries(Object.keys(SHIPPING_LIMITS).map((key) => [key, '']))),
});

function asUrl(raw) {
  try {
    if (typeof raw === 'string') return new URL(raw);
    if (raw && typeof raw.href === 'string') return new URL(raw.href);
    if (raw && typeof raw.origin === 'string' && typeof raw.pathname === 'string') {
      return new URL(`${raw.origin}${raw.pathname}${raw.search || ''}`);
    }
  } catch { /* Invalid input is handled by the caller. */ }
  return null;
}

export function isAppleShopUrl(raw) {
  const url = asUrl(raw);
  return Boolean(url && url.protocol === 'https:' && !url.username && !url.password && !url.port
    && SHOP_HOST.test(url.hostname) && (url.pathname === '/shop' || url.pathname.startsWith('/shop/')));
}

export function isSafeEntryUrl(raw) {
  const url = asUrl(raw);
  if (!url || !isAppleShopUrl(url) || url.hostname !== 'www.apple.com.cn') return false;
  return /^\/shop\/(?:product\/[A-Z0-9]{5,20}(?:\/[A-Z0-9]{1,4})?(?:\/[^?#]*)?|buy-[a-z-]+(?:\/[^?#]*)?)\/?$/i.test(url.pathname);
}

export function publicStageUrl(raw) {
  const url = asUrl(raw);
  if (!url || !isAppleShopUrl(url)) return null;
  const stages = url.searchParams.getAll('_s');
  if (stages.length > 1 || (stages.length === 1 && !CHECKOUT_STAGE.test(stages[0]))) return null;
  const clean = new URL(`${url.origin}${url.pathname.replace(/\/+$/, '') || '/'}`);
  if (stages.length) clean.searchParams.set('_s', stages[0]);
  return clean.href;
}

function integerSetting(raw, fallback, minimum, maximum, label) {
  const value = raw === undefined || raw === '' ? fallback : Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label}须为 ${minimum} 至 ${maximum} 的整数。`);
  }
  return value;
}

function normalizeShipping(input) {
  if (input !== undefined && (input === null || typeof input !== 'object' || Array.isArray(input))) {
    throw new Error('收货资料格式不正确，请重新填写。');
  }
  const shipping = {};
  for (const [key, limit] of Object.entries(SHIPPING_LIMITS)) {
    const raw = input?.[key] ?? '';
    if (typeof raw !== 'string') throw new Error(`${FIELD_LABELS[key]}须为文字。`);
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(raw)) throw new Error(`${FIELD_LABELS[key]}含有无效字符。`);
    const value = raw.replace(/\s+/g, ' ').trim();
    if (value.length > limit) throw new Error(`${FIELD_LABELS[key]}最多填写 ${limit} 个字符。`);
    shipping[key] = value;
  }
  for (const key of ['recipientPhone', 'contactPhone']) {
    const phone = shipping[key].replace(/^(?:\+86|0086)\s*/, '').replace(/[ -]/g, '');
    if (phone && !/^1[3-9]\d{9}$/.test(phone)) throw new Error(`${FIELD_LABELS[key]}须为有效的中国大陆 11 位手机号码。`);
    shipping[key] = phone;
  }
  if (shipping.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(shipping.email)) throw new Error('请输入有效的电子邮箱地址。');
  return shipping;
}

export function normalizeConfig(input = {}) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new Error('设置格式不正确。');
  const partNumber = String(input.partNumber ?? DEFAULT_CONFIG.partNumber).trim().toUpperCase();
  if (!PART_PATTERN.test(partNumber)) throw new Error('请输入有效的 Apple 商品编号，例如 MK2T4CH/A。');
  const defaultUrl = `https://www.apple.com.cn/shop/product/${partNumber}`;
  const suppliedUrl = input.productUrl === undefined || input.productUrl === '' ? defaultUrl : input.productUrl;
  if (!isSafeEntryUrl(suppliedUrl)) throw new Error('商品链接须为 https://www.apple.com.cn/shop/ 下的商品或选购页面。');
  const product = asUrl(suppliedUrl);
  product.search = '';
  product.hash = '';
  const fulfillment = input.fulfillment ?? DEFAULT_CONFIG.fulfillment;
  if (!['delivery', 'pickup'].includes(fulfillment)) throw new Error('请选择送货或到店取货。');
  const paymentMethod = input.paymentMethod ?? DEFAULT_CONFIG.paymentMethod;
  if (!['alipay', 'wechat'].includes(paymentMethod)) throw new Error('请选择支付宝或微信支付。');
  const retrySeconds = integerSetting(input.retrySeconds, DEFAULT_CONFIG.retrySeconds, 3, 30, '刷新间隔（秒）');
  const maxRefreshes = integerSetting(input.maxRefreshes, DEFAULT_CONFIG.maxRefreshes, 0, 300, '最多刷新次数');
  const quantity = integerSetting(input.quantity, 1, 1, 1, '购买数量');
  const maxTotal = input.maxTotal === undefined || input.maxTotal === '' ? 0 : Number(input.maxTotal);
  if (!Number.isFinite(maxTotal) || maxTotal < 0 || maxTotal > 1000000
    || Math.abs(maxTotal * 100 - Math.round(maxTotal * 100)) > 0.000001) {
    throw new Error('订单金额上限须为 0 至 1000000 元，最多保留两位小数；0 表示尚未设置。');
  }
  if (input.submitEnabled !== undefined && typeof input.submitEnabled !== 'boolean') throw new Error('允许提交订单设置须为开启或关闭。');
  // Incomplete shipping and a zero amount may be saved. The page flow must pause
  // for manual completion and require a positive maximum before submitting.
  return { partNumber, productUrl: product.href, fulfillment, paymentMethod, retrySeconds, maxRefreshes,
    maxTotal, quantity, submitEnabled: input.submitEnabled === true, shipping: normalizeShipping(input.shipping) };
}
