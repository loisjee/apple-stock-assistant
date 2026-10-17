/* Nearby pickup monitoring uses only Apple's rendered product page and location controls. */
(() => {
  'use strict';
  const tidy = value => String(value ?? '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
  const canon = value => tidy(value).replace(/[\s·，,。]/g, '').toLowerCase();
  const buttons = 'button,[role="button"],input[type="button"],input[type="submit"]';
  const rowSelector = 'li,[role="listitem"],[role="radio"],input[type="radio"],[data-autom*="store"],[class*="store"],[class*="Store"]';
  const NO_STOCK = /不可取货|无法取货|不提供.{0,8}取货|暂不.{0,8}取货|目前无货|暂时无货|暂无供应|无现货|缺货|无货|暂不可用|not available|unavailable|out of stock/i;
  const YES_STOCK = /(?:可于.{0,24}(?:提供|取货)|(?:今天|明天|即日|当天)(?:可|即可)?取货|(?:可|可以)(?:店内)?取货|店内有货|现货供应|可提供取货|(?:取货|pickup)\s*[:：]\s*(?:今天|明天|today|tomorrow)|available\s+(?:today|tomorrow|for pickup))/i;
  const DISTANCE = /(?:\d+(?:[.,]\d+)?)\s*(?:公里|千米|km|米|miles?)(?![a-z])/i;
  const LOCATION_LABEL = /邮政编码|邮编|所在城市|城市或|所在地区|位置|地址|postal|zip|location|city/i;
  const REGION_SUFFIX = /(?:特别行政区|维吾尔自治区|壮族自治区|回族自治区|自治区|自治州|地区|省|市|区|县|旗)$/;
  const KNOWN_PRODUCTS = Object.freeze({ 'MK2T4CH/A': 'iPhone Duo 1TB 星光白色', 'MK2P4CH/A': 'iPhone Duo 512GB 星光白色', 'MJYJ4CH/A': 'iPhone 18 Pro Max 1TB 冰川蓝色' });
  const STOP_TEXT = /(?:安全验证|验证码|人机验证|滑动验证|请证明你|验证你是真人|完成验证|verify you are human|captcha|同意并继续|隐私政策.*中国境外|登录你的 Apple|登录你的Apple|sign in to your apple)/i;

  function allowedPage(value) {
    try {
      const url = new URL(value);
      return url.protocol === 'https:' && url.hostname === 'www.apple.com.cn' && !url.port && !url.username && !url.password && /^\/shop\/(?:product\/|buy-[^/]+(?:\/|$))/i.test(url.pathname) && !url.searchParams.has('step');
    } catch { return false; }
  }
  function validSku(value) { return /^[A-Z0-9]{5,12}\/A$/.test(tidy(value).toUpperCase()); }
  function exactSku(text, sku) {
    const escaped = tidy(sku).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return validSku(sku) && new RegExp(`(?:^|[^A-Z0-9])${escaped}(?:$|[^A-Z0-9])`, 'i').test(String(text || ''));
  }
  function availability(value) {
    const text = tidy(value);
    return NO_STOCK.test(text) ? 'unavailable' : YES_STOCK.test(text) ? 'available' : 'unknown';
  }
  function regionMatches(label, remaining) {
    const text = canon(label), address = canon(remaining);
    if (!text || text.length < 2 || text.length > 14 || /\d|Apple|零售店|继续|取货|供货|位置|保存|关闭|返回|地区|城市|省份|地址/i.test(text)) return false;
    const short = text.replace(REGION_SUFFIX, '');
    return address.startsWith(text) || (short.length >= 2 && address.startsWith(short));
  }
  function stripRegion(address, label) {
    let value = canon(address), region = canon(label);
    if (!value.startsWith(region)) region = region.replace(REGION_SUFFIX, '');
    if (!value.startsWith(region)) return value;
    value = value.slice(region.length).replace(/^(?:特别行政区|维吾尔自治区|壮族自治区|回族自治区|自治区|自治州|地区|省|市|区|县|旗)/, '');
    return value;
  }
  const internals = { tidy, canon, allowedPage, validSku, exactSku, availability, regionMatches, stripRegion };
  if (typeof module !== 'undefined' && module.exports) module.exports = internals;
  if (typeof document === 'undefined') { globalThis.__shikePickupInternals = internals; return; }
  const runtime = globalThis.chrome?.runtime;
  const serverInit = !runtime?.onMessage && globalThis.__shikePickupServerInit === true;
  if (serverInit) delete globalThis.__shikePickupServerInit;
  if (window.top !== window || (!runtime?.onMessage && !serverInit)) return;
  if (globalThis.__shikePickupPageInstalled) return;
  globalThis.__shikePickupPageInstalled = true;
  let active = null;
  const extensionOrigin = runtime?.getURL?.('') || '';

  function visible(element) {
    if (!element?.isConnected || element.closest('[hidden],[inert],[aria-hidden="true"]')) return false;
    const css = getComputedStyle(element);
    return css.display !== 'none' && css.visibility !== 'hidden' && css.opacity !== '0' && element.getClientRects().length > 0;
  }
  function label(element) {
    return tidy(element.getAttribute('aria-label') || (element.tagName === 'INPUT' ? element.value : element.innerText || element.textContent));
  }
  function usable(element) { return visible(element) && !element.disabled && element.getAttribute('aria-disabled') !== 'true'; }
  function all(root, selector) { return [...root.querySelectorAll(selector)].filter(visible); }
  function unique(elements) { const list = [...new Set(elements)]; return list.length === 1 ? list[0] : null; }
  function response(stage, reason, extra = {}) { return { ok: true, stage, stores: [], reason, ...extra }; }
  function guard(run) {
    if (active !== run || run.cancelled) throw new Error('PICKUP_CANCELLED');
    if (Date.now() >= run.deadline) throw new Error('PICKUP_TIMEOUT');
    if (!allowedPage(location.href)) throw new Error('PICKUP_LEFT_PRODUCT');
    if (run.root) {
      run.configurationDiagnostic = {};
      if (!configurationMatches(run.root, run.config, run.configurationDiagnostic)) throw new Error('PICKUP_WRONG_CONFIGURATION');
    }
  }
  function stopForHuman() {
    const modal = all(document, '[role="dialog"],dialog,[aria-modal="true"]').map(node => tidy(node.innerText));
    const body = tidy(document.body?.innerText);
    return modal.some(text => STOP_TEXT.test(text)) || (body.length < 2500 && STOP_TEXT.test(body));
  }
  async function pause(run, ms = 120) {
    guard(run);
    await new Promise(resolve => {
      let complete = false, timer;
      const finish = () => {
        if (complete) return;
        complete = true; clearTimeout(timer); observer.disconnect(); run.wakeWaiters.delete(finish); resolve();
      };
      // Mutation delivery is prompt in an inactive tab; polling timers can be throttled there.
      const observer = new MutationObserver(finish);
      observer.observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['aria-busy', 'aria-label', 'aria-checked', 'aria-expanded', 'class', 'hidden', 'disabled', 'value', 'checked', 'style'] });
      run.wakeWaiters.add(finish);
      timer = setTimeout(finish, Math.min(ms, Math.max(0, run.deadline - Date.now())));
      if (run.cancelled || active !== run) finish();
    });
    guard(run);
  }
  function cancelRun(run) {
    run.cancelled = true;
    for (const wake of [...run.wakeWaiters]) wake();
  }
  async function until(run, predicate, limit = 3500) {
    const end = Math.min(run.deadline, Date.now() + limit);
    do {
      guard(run);
      if (stopForHuman()) throw new Error('PICKUP_HUMAN');
      const result = predicate();
      if (result) return result;
      if (Date.now() >= end) break;
      await pause(run);
    } while (Date.now() <= end);
    return null;
  }
  async function click(run, element) {
    guard(run);
    if (!usable(element)) throw new Error('PICKUP_BUTTON_UNAVAILABLE');
    const overlay = globalThis.__shikeOverlay;
    let suspended = false;
    try {
      if (typeof overlay?.suspend === 'function') { overlay.suspend(); suspended = true; }
      // Do not scroll an inactive monitoring tab: delayed scroll handlers can close its popover.
      // A DOM click does not need an animation frame or a timer, both throttled in inactive tabs.
      await Promise.resolve();
      guard(run);
      if (!usable(element)) throw new Error('PICKUP_BUTTON_UNAVAILABLE');
      element.click();
    } finally {
      if (suspended) { try { overlay.resume?.(); } catch { /* restoration never retries an action */ } }
    }
  }
  function skuEvidence(sku) {
    let url = location.href;
    try { url = decodeURIComponent(url); } catch { /* malformed URL does not add evidence */ }
    if (exactSku(url, sku)) return true;
    return all(document, '[data-autom*="part"],[data-autom*="sku"],[data-part-number],input:checked,option:checked')
      .some(node => exactSku(`${node.getAttribute('data-part-number') || ''} ${node.value || ''} ${label(node)}`, sku));
  }
  function productLabelText(element) {
    if (!element) return '';
    const footnotes = 'sup,[role="doc-noteref"],a[href*="#footnote"],[aria-label^="脚注"],[aria-label^="footnote" i],[class*="footnote"]';
    if (!element.querySelector(footnotes)) return element.innerText || element.textContent || '';
    const clone = element.cloneNode(true);
    for (const note of clone.querySelectorAll(footnotes)) note.remove();
    return clone.textContent || '';
  }
  function selectedLabel(node) {
    const labelled = (node.getAttribute('aria-labelledby') || '').split(/\s+/).map(id => productLabelText(document.getElementById(id))).join(' ');
    const associated = [...node.labels || []].map(productLabelText).join(' ');
    return tidy(node.getAttribute('aria-label') || labelled || associated || productLabelText(node) || node.value).replace(/\s*(?:脚注|footnote)\s*\d+\s*$/i, '').trim();
  }
  function exactProductSummary(root, expected) {
    const matches = all(root, 'h1,h2,h3,h4,p,span,div,[data-autom*="productName"],[data-autom*="product-name"]')
      .filter(node => canon(tidy(node.innerText || node.textContent)) === canon(expected));
    // A summary's layout wrappers repeat its text. Count only its deepest exact
    // match, while separate summaries/recommendations remain ambiguous.
    const leaves = matches.filter(node => !matches.some(child => child !== node && node.contains(child)));
    return !!expected && leaves.length === 1;
  }
  function configurationMatches(root, config, diagnostic = {}) {
    const mismatch = dimension => { diagnostic.dimension = dimension; return false; };
    if (!skuEvidence(config.partNumber)) return mismatch('sku');
    const sku = tidy(config.partNumber).toUpperCase();
    const expected = tidy(KNOWN_PRODUCTS[sku] || config.productName);
    const known = KNOWN_PRODUCTS[sku];
    const summaryMatches = exactProductSummary(root, expected);
    if (!known) {
      if (!expected) return mismatch('nameMissing');
      if (!summaryMatches) return mismatch('productSummary');
    }
    const dimensions = [...root.querySelectorAll('input[type="radio"],[role="radio"]')]
      .filter(node => visible(node) || [...node.labels || []].some(visible))
      .map(selectedLabel).filter(value => /iPhone|(?:^|\s)\d+\s*(?:GB|TB)(?:$|\s)|色/i.test(value));
    if (!dimensions.length) return summaryMatches || mismatch('modelSummary');
    const checked = [...root.querySelectorAll('input[type="radio"]:checked,[role="radio"][aria-checked="true"],button[aria-pressed="true"]')]
      .filter(node => visible(node) || [...node.labels || []].some(visible)).map(selectedLabel);
    const parts = /^(iPhone.+?)\s+(\d+\s*(?:GB|TB))\s+(.+)$/i.exec(expected);
    if (!parts) return checked.some(value => canon(value) === canon(expected));
    const [model, capacity, color] = parts.slice(1).map(canon);
    const modelChoices = dimensions.filter(value => /^iPhone/i.test(value));
    const selectedModels = checked.filter(value => /^iPhone/i.test(value));
    const selectedCapacity = checked.filter(value => /^\d+\s*(?:GB|TB)$/i.test(value));
    const selectedColors = checked.filter(value => /色$/.test(value) || canon(value).replace(/色$/, '') === color.replace(/色$/, ''));
    if (modelChoices.length) {
      if (selectedModels.length !== 1 || canon(selectedModels[0]) !== model) return mismatch('model');
    } else if (!summaryMatches) return mismatch('modelSummary');
    if (selectedCapacity.length !== 1 || canon(selectedCapacity[0]) !== capacity) return mismatch('capacity', checked.filter(value => /^\d+\s*(?:GB|TB)/i.test(value)));
    if (selectedColors.length !== 1 || canon(selectedColors[0]).replace(/色$/, '') !== color.replace(/色$/, '')) return mismatch('color', selectedColors);
    return true;
  }
  function findPickupRoot() {
    const dialogs = all(document, '[role="dialog"],dialog,[aria-modal="true"]');
    const match = dialogs.filter(node => /(?:供货情况|取货(?:日期|地点|时间|选项)|零售店取货|pickup availability|store availability)/i.test(tidy(node.innerText)));
    if (match.length) return match.sort((a, b) => tidy(a.innerText).length - tidy(b.innerText).length)[0];
    const heading = unique(all(document, 'h1,h2,h3,[role="heading"]').filter(node => /^(?:iPhone\s*)?供货情况$|^零售店取货$|^pickup availability$/i.test(label(node))));
    if (!heading) return null;
    let node = heading.parentElement;
    for (let depth = 0; node && depth < 5; depth++, node = node.parentElement) {
      if (node === document.body) break;
      if (all(node, buttons).some(button => /^\d{6}$/.test(label(button))) || node.querySelector('input[type="radio"]')) return node;
    }
    return null;
  }
  function opener() {
    const caption = /^(?:查看供货情况|查看取货日期|查看取货地点|查看取货选项|查看店内供货情况|查看零售店供货情况|check availability|check pickup availability)$/i;
    const direct = all(document, buttons).filter(node => {
      if (caption.test(tidy(node.innerText || node.textContent)) || caption.test(label(node))) return true;
      if (!/^查看供货情况\s+iPhone.{1,100}$/i.test(label(node))) return false;
      let parent = node.parentElement;
      for (let depth = 0; parent && depth < 4; depth++, parent = parent.parentElement) {
        if (parent === document.body || parent === document.documentElement || tidy(parent.innerText).length > 500) break;
        if (/取货|店内|零售店|pickup/i.test(tidy(parent.innerText))) return true;
      }
      return false;
    });
    if (direct.length === 1) return direct[0];
    const stores = all(document, buttons).filter(node => {
      if (!/^Apple\s*[^\s]/i.test(label(node)) || /Apple\s*(?:Care|Pay|Store)/i.test(label(node))) return false;
      // Apple's store-name button can sit several inline wrappers below the pickup caption.
      let parent = node.parentElement;
      for (let depth = 0; parent && depth < 4; depth++, parent = parent.parentElement) {
        if (parent === document.body || parent === document.documentElement) break;
        const text = tidy(parent.innerText);
        if (text.length > 500) break;
        if (/取货|pickup/i.test(text)) return true;
      }
      return false;
    });
    return unique(stores);
  }
  function locationControl(root) {
    const explicit = all(root, buttons).filter(node => /^\d{6}$/.test(label(node)) || /^(?:更改位置|更改地址|选择地点|选择地区|选择城市|更改邮编|编辑位置|change location|change postal code)$/i.test(label(node)));
    if (explicit.length) return unique(explicit);
    const contextual = unique(all(root, buttons).filter(node => {
      const text = label(node);
      if (text.length < 2 || text.length > 16 || /取货|供货|继续|iPhone|Apple|省份|城市|区县|关闭|保存/i.test(text)) return false;
      let parent = node.parentElement;
      for (let depth = 0; parent && depth < 4; depth++, parent = parent.parentElement) {
        if (parent === document.body || parent === document.documentElement) break;
        const context = tidy(parent.innerText);
        if (context.length > 500) break;
        // The location caption's own block has one button. A containing region menu
        // has several; never mistake a province choice for the current location.
        if (/显示此地提供的选项|显示此位置|提供的选项|options for/i.test(context)) return all(parent, buttons).length === 1;
        if (parent === root) break;
      }
      return false;
    }));
    return contextual;
  }
  function regionButtons(root, remaining, fixedControl = null) {
    const control = fixedControl || locationControl(root);
    return all(root, buttons).filter(node => node !== control && node.getAttribute('role') !== 'tab' && regionMatches(label(node), remaining));
  }
  function locationInputs(root) {
    return all(root, 'input:not([type]),input[type="text"],input[type="search"]').filter(node => {
      const named = `${node.getAttribute('aria-label') || ''} ${node.placeholder || ''} ${[...node.labels || []].map(item => item.innerText).join(' ')}`;
      return LOCATION_LABEL.test(named) && !node.readOnly && !node.disabled;
    });
  }
  function locationSummary(root) {
    return all(root, 'button,h2,h3,h4,p,[data-autom*="location"],[class*="location"],[class*="Location"]')
      .filter(node => !node.matches('input') && (node.tagName === 'BUTTON' || /附近|此地|位置|邮编|取货地点|near|location/i.test(label(node))))
      .map(node => label(node)).join(' ');
  }
  function addressConfirmed(root, address) {
    const summary = canon(locationSummary(root));
    const query = canon(address);
    if (/^\d{6}$/.test(query)) return new RegExp(`(?:^|[^0-9])${query}(?:$|[^0-9])`).test(locationSummary(root));
    return query.length >= 2 && summary.includes(query);
  }
  function inputSetter(run, input, value) {
    guard(run);
    if (!usable(input) || input.readOnly || !locationInputs(input.closest('form') || input.parentElement).includes(input)) throw new Error('PICKUP_ADDRESS_UNSUPPORTED');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, value);
    guard(run); input.dispatchEvent(new Event('input', { bubbles: true }));
    guard(run); input.dispatchEvent(new Event('change', { bubbles: true }));
  }
  function searchButton(input, root) {
    let scope = input.form || input.parentElement;
    for (let i = 0; scope && i < 4; i++, scope = scope.parentElement) {
      const matches = all(scope, buttons).filter(node => /^(?:搜索|查找|查找零售店|搜索零售店|查看供货情况|更新位置|更新|应用|确定|search|update|apply)$/i.test(label(node)));
      if (matches.length === 1) return matches[0];
      if (scope === root) break;
    }
    return null;
  }

  function rowText(row) {
    const accessible = tidy(row.getAttribute('aria-label'));
    return /^Apple(?:\s|[\u3400-\u9fff])/i.test(accessible) ? accessible : tidy(row.innerText);
  }
  function storeName(row) {
    const headings = all(row, '[data-autom*="storeName"],[data-autom*="store-name"],[class*="storename"],[class*="store-name"],h2,h3,h4,strong,b');
    const candidates = [...headings.map(label), ...String(row.innerText || '').split(/\n/).map(tidy), rowText(row)];
    for (let name of candidates) {
      if (!/^Apple(?:\s|[\u3400-\u9fff])/i.test(name) || /^Apple\s*(?:Store|Care|Pay|零售店)/i.test(name)) continue;
      name = name.split(/(?:\s+(?:取货|不可取货|无法取货|今天|明天|地址|距离)|[:：])/)[0];
      name = name.replace(/\s+([^\s,，]+)\s*[,，]\s*\1(?:\s.*)?$/, '');
      const distance = DISTANCE.exec(name); if (distance) name = name.slice(0, distance.index).trim();
      if (name.length >= 6 && name.length <= 70) return name;
    }
    return null;
  }
  function storeRows(root) {
    const raw = [...root.querySelectorAll(rowSelector)].flatMap(node => node.matches('input[type="radio"]') ? [node, ...node.labels || []] : [node]);
    const candidates = [...new Set(raw)].filter(visible).filter(node => {
      if (!storeName(node) || rowText(node).length > 1200) return false;
      const names = all(node, 'h2,h3,h4,[data-autom*="storeName"],[data-autom*="store-name"],[role="radio"],input[type="radio"]').map(selectedLabel).filter(text => /^Apple(?:\s|[\u3400-\u9fff])/i.test(text));
      const radios = [...node.querySelectorAll('[role="radio"],input[type="radio"]')].filter(child => visible(child) || [...child.labels || []].some(visible));
      return radios.length <= 1 && new Set(names).size <= 1 && (rowText(node).match(/Apple(?:\s|[\u3400-\u9fff])/gi) || []).length <= 1;
    });
    // Prefer a complete list item containing its status over a nested store-name span.
    return candidates.filter(node => !candidates.some(parent => parent !== node && parent.contains(node) && parent.matches('li,[role="listitem"],[role="radio"]')))
      .filter(node => !candidates.some(child => child !== node && node.contains(child) && child.matches('li,[role="listitem"],[role="radio"]')));
  }
  function parseStore(row) {
    const text = rowText(row), name = storeName(row);
    if (!name) return null;
    const statusElements = all(row, '[data-autom*="availability"],[data-autom*="Availability"],[class*="availability"],[class*="Availability"],[data-autom*="pickup"],[class*="pickup"]');
    const knownStatus = statusElements.map(label).filter(value => availability(value) !== 'unknown');
    const value = knownStatus.length ? knownStatus.join(' ') : text;
    const state = availability(value);
    const lines = String(row.innerText || row.getAttribute('aria-label') || '').split(/\n/).map(tidy).filter(Boolean);
    const pickupText = (knownStatus.join(' ') || lines.filter(line => /取货|提供|available|unavailable|pickup/i.test(line)).join(' ')).slice(0, 260);
    const addressElements = all(row, '[data-autom*="address"],[class*="address"],[class*="Address"],address');
    const address = (addressElements.map(label).join(' ') || lines.filter(line => line !== name && /(?:省|市|区|县|路|街|巷|号|road|street)/i.test(line) && !/取货|提供|供货|Apple/.test(line)).join(' ')).slice(0, 240);
    const radio = row.matches('input[type="radio"]') ? row : row.querySelector('input[type="radio"]');
    const id = tidy(row.getAttribute('data-store-id') || row.getAttribute('data-storeid') || radio?.value || name).slice(0, 80);
    return { id, name, address, distanceText: DISTANCE.exec(text)?.[0] || '', availability: state, availabilityText: (pickupText || '官网未提供可确认的取货状态').slice(0, 260), pickupText };
  }
  function unavailableSummary(root) {
    return unique(all(root, buttons).filter(node => /^距离最近的\s*\d+\s*家零售店今日无货[。.]*$/.test(label(node))));
  }
  function noStores(root) { return /没有(?:找到)?(?:附近的)?(?:Apple\s*Store\s*)?零售店|未找到.{0,16}零售店|附近没有.{0,16}零售店/i.test(tidy(root.innerText)); }
  function readStores(root, maxStores) {
    const stores = storeRows(root).map(parseStore).filter(Boolean);
    const seen = new Set();
    return stores.filter(store => !seen.has(store.id) && seen.add(store.id)).slice(0, maxStores);
  }
  function watchRows(root) {
    const oldRows = storeRows(root), oldTexts = oldRows.map(rowText), oldSummary = unavailableSummary(root), oldSummaryText = oldSummary ? label(oldSummary) : '';
    let touched = false;
    const observer = new MutationObserver(records => {
      if (records.some(record => oldRows.some(row => row === record.target || row.contains(record.target) || [...record.removedNodes].some(node => node === row || node.nodeType === 1 && node.contains(row))))) touched = true;
    });
    observer.observe(root, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['aria-label', 'value'] });
    return { disconnect: () => observer.disconnect(), changed: () => touched || oldRows.some((node, index) => !node.isConnected || rowText(node) !== oldTexts[index]) || storeRows(root).some(node => !oldRows.includes(node)) || unavailableSummary(root) !== oldSummary || oldSummary && (!oldSummary.isConnected || label(oldSummary) !== oldSummaryText), hadRows: oldRows.length > 0 || !!oldSummary };
  }
  function busy(root) { return all(root, '[aria-busy="true"],[role="progressbar"],[data-autom*="loading"],[class*="loading-spinner"],img[alt="loading"],img[aria-label="loading"]').length > 0; }

  async function setRegion(run, root, address) {
    run.step = 'open-location';
    let control = locationControl(root);
    const editorPresent = () => locationInputs(root).length || all(root, '[role="tab"]').some(node => /(?:省份|城市|区县|区)$/.test(label(node))) || regionButtons(root, address, control).length;
    if (!editorPresent() && control) await click(run, control);
    run.step = 'wait-location';
    let editor = await until(run, editorPresent, 2200);
    if (!editor) {
      // Before hydration the location button can be present without its click handler.
      // Retry only this harmless opener, once, after proving no editor was opened.
      const current = locationControl(root);
      if (current && usable(current)) {
        control = current; run.step = 'reopen-location';
        await click(run, current);
        run.step = 'wait-reopened-location';
        editor = await until(run, editorPresent, 2200);
      }
    }
    if (!editor) {
      return { ok: false, reason: '官网位置选择器暂不支持自动输入，请在监控标签页手动选择省、市、区后继续。', diagnostic: { step: run.step, code: control ? 'EDITOR_MISSING' : 'LOCATION_CONTROL_MISSING' } };
    }
    // Apple remembers the last district tab when the location picker is reopened.
    // Return to the province tab before matching the beginning of a full address.
    const provinceTab = unique(all(root, '[role="tab"]').filter(node => /省份$/.test(label(node))));
    if (provinceTab && provinceTab.getAttribute('aria-selected') !== 'true') {
      run.step = 'reset-province-tab';
      await click(run, provinceTab);
    }
    const inputs = locationInputs(root);
    if (inputs.length === 1) {
      const input = inputs[0];
      run.step = 'fill-location';
      inputSetter(run, input, address);
      const submit = searchButton(input, root);
      if (!submit || !usable(submit)) return { ok: false, reason: '未找到唯一的位置查询按钮，请在官网手动设置位置。' };
      const watcher = watchRows(root);
      try {
        run.step = 'query-location';
        await click(run, submit);
        run.step = 'wait-store-list';
        const ready = await until(run, () => !busy(root) && addressConfirmed(root, address) && (!watcher.hadRows || watcher.changed()) && (readStores(root, run.maxStores).length || noStores(root) || unavailableSummary(root)), 6500);
        return ready ? { ok: true, changed: true } : { ok: false, retryable: true, reason: '尚未核验到新位置对应的门店结果，已忽略可能残留的旧位置列表。' };
      } finally { watcher.disconnect(); }
    }
    if (inputs.length > 1) return { ok: false, reason: '官网存在多个位置输入框，无法唯一确定，请手动选择位置。' };
    let remaining = canon(address), selected = [], watcher = null;
    try {
      for (let depth = 0; depth < 3; depth++) {
        run.step = `find-region-${depth + 1}`;
        const region = await until(run, () => {
          const matches = regionButtons(root, remaining, control);
          return unique(matches);
        }, 2200);
        if (!region) break;
        const text = label(region);
        watcher?.disconnect(); watcher = watchRows(root);
        run.step = `select-region-${depth + 1}`;
        await click(run, region);
        selected.push(text); remaining = stripRegion(remaining, text);
        if (selected.length >= 2 && !regionButtons(root, remaining, control).length) {
          // Location pickers usually commit after selecting the district. Never click the product modal's Continue.
          const exactCommit = all(root, buttons).filter(node => /^(?:确认位置|更新位置|应用位置|确认地区|确定位置)$/i.test(label(node)));
          if (exactCommit.length === 1) { run.step = 'commit-location'; await click(run, exactCommit[0]); }
          const last = selected[selected.length - 1];
          const short = canon(last).replace(REGION_SUFFIX, '');
          run.step = 'wait-region-results';
          const ready = await until(run, () => {
            const summary = canon(locationSummary(root));
            const pickerClosed = !all(root, buttons).some(node => /^(?:省份|城市|区县|地区)$/.test(label(node)));
            const changed = !watcher.hadRows || watcher.changed();
            return !busy(root) && changed && (readStores(root, run.maxStores).length || noStores(root) || unavailableSummary(root)) && (summary.includes(canon(last)) || (short.length >= 2 && summary.includes(short)) || pickerClosed && (selected.length === 3 || selected.length === 2 && /^(?:北京|上海|天津|重庆)/.test(canon(selected[0])) && /(?:区|县)$/.test(last)));
          }, 6000);
          if (ready) return { ok: true, changed: true };
        }
      }
      return { ok: false, retryable: false, reason: '未能完整核验所选省、市、区和刷新后的门店列表，请在官网手动选择位置。' };
    } finally { watcher?.disconnect(); }
  }

  async function check(run) {
    try {
      run.step = 'verify-product';
      guard(run);
      if (stopForHuman()) return response('human', '官网要求验证码、登录或隐私确认，请在监控标签页完成后继续。', { requiresHuman: true, retryable: false });
      if (!skuEvidence(run.config.partNumber)) return response('productMismatch', '当前官网页面未显示目标商品编号；请核对具体型号、容量和颜色对应的商品链接。', { requiresHuman: true, retryable: false });
      let root = findPickupRoot();
      if (!root) {
        run.step = 'find-pickup-opener';
        const button = await until(run, opener, 2500);
        if (!button) return response('waitingPage', '尚未找到官网取货供货情况入口，将等待页面恢复。', { retryable: true });
        run.step = 'open-pickup';
        await click(run, button);
        run.step = 'wait-pickup';
        root = await until(run, findPickupRoot, 3500);
        if (!root) return response('waitingPage', '取货供货情况窗口尚未加载。', { retryable: true });
      }
      run.root = root; guard(run);
      // Each message reapplies the location through public controls, refreshing availability instead of reusing a stale modal.
      const result = await setRegion(run, root, run.config.address);
      guard(run);
      if (!result.ok) return response(result.retryable ? 'waitingResults' : 'locationRequired', result.reason, { requiresHuman: !result.retryable, retryable: !!result.retryable, ...(result.diagnostic ? { diagnostic: result.diagnostic } : {}) });
      const summary = unavailableSummary(root);
      if (summary && !storeRows(root).length) {
        run.step = 'expand-unavailable-stores';
        await click(run, summary);
        await until(run, () => storeRows(root).length, 3500);
        guard(run);
      }
      run.step = 'read-stores';
      const stores = readStores(root, run.maxStores);
      if (!stores.length) {
        const text = tidy(root.innerText);
        if (noStores(root)) return response('noStores', '官网显示此位置附近未找到可查询的零售店。', { retryable: true });
        return response('waitingResults', '尚未读取到可核验的门店列表。', { retryable: true });
      }
      const availableCount = stores.filter(store => store.availability === 'available').length;
      return { ok: true, stage: 'checked', stores, reason: availableCount ? `官网显示 ${availableCount} 家门店可以取货；按官网附近门店顺序展示。` : stores.some(store => store.availability === 'unknown') ? '部分门店状态暂不能确认；未将未知状态判定为有货。' : '已显示的附近门店目前均不可取货。', retryable: true };
    } catch (error) {
      if (error.message === 'PICKUP_CANCELLED') return response('cancelled', '库存监控已暂停。', { retryable: false });
      if (error.message === 'PICKUP_WRONG_CONFIGURATION') return response('productMismatch', '供货窗口当前所选型号、颜色或容量与监控目标不符，请恢复目标配置后继续。', { requiresHuman: true, retryable: false, diagnostic: { step: run.step || 'verify-product', code: `CONFIG_${String(run.configurationDiagnostic?.dimension || 'unknown').toUpperCase()}` } });
      if (error.message === 'PICKUP_HUMAN') return response('human', '官网要求验证码、登录或隐私确认，请手动完成。', { requiresHuman: true, retryable: false });
      if (error.message === 'PICKUP_LEFT_PRODUCT') return response('blocked', '页面已离开商品选择页，库存监控未继续操作。', { requiresHuman: true, retryable: false });
      const code = /^PICKUP_[A-Z_]+$/.test(String(error.message)) ? error.message : ['TypeError', 'ReferenceError', 'SyntaxError', 'RangeError'].includes(error.name) ? error.name : 'DOM_ERROR';
      const diagnostic = { step: run.step || 'unknown', code };
      return response('waitingPage', '官网取货页面结构或控件暂不可用，将等待下一次检查。', { retryable: true, diagnostic });
    }
  }
  function requestCheck(config = {}, token) {
    config = config && typeof config === 'object' ? config : {};
    if (typeof token !== 'string' || !token || token.length > 120 || !validSku(config.partNumber) || typeof config.address !== 'string' || !tidy(config.address) || config.address.length > 200) {
      return Promise.resolve({ ok: false, error: '监控商品编号、查询位置或运行标识无效。' });
    }
    if (!allowedPage(location.href)) return Promise.resolve(response('blocked', '仅能在苹果中国官网具体商品页监控库存。', { requiresHuman: true, retryable: false }));
    const signature = JSON.stringify([tidy(config.partNumber).toUpperCase(), tidy(config.address), Number(config.maxStores) || 10]);
    if (active && !active.cancelled && active.token === token && active.signature === signature) return active.promise;
    if (active) cancelRun(active);
    const run = { token, signature, config, cancelled: false, wakeWaiters: new Set(), deadline: Date.now() + 14500, maxStores: Math.max(1, Math.min(20, Number(config.maxStores) || 10)) };
    active = run;
    run.promise = check(run).finally(() => { if (active === run) active = null; });
    return run.promise;
  }
  function requestCancel(token) {
    if (active && (!token || token === active.token)) cancelRun(active);
    return { ok: true, cancelled: true };
  }
  function serverReady(config = {}) {
    if (!allowedPage(location.href) || stopForHuman()) return true;
    const entry = findPickupRoot() || opener();
    if (!entry) return false;
    if (skuEvidence(config?.partNumber)) return true;
    // A different explicitly rendered SKU should reach check's mismatch gate
    // promptly; readiness itself never authorizes a click or reports inventory.
    return all(document, '[data-autom*="part"],[data-autom*="sku"],[data-part-number],input:checked,option:checked')
      .some(node => /(?:^|[^A-Z0-9])[A-Z0-9]{5,12}\/A(?:$|[^A-Z0-9])/i.test(`${node.getAttribute('data-part-number') || ''} ${node.value || ''} ${label(node)}`));
  }
  if (serverInit) {
    // Installed only by an explicit server bootstrap in its dedicated browser.
    // The extension's isolated world never publishes a page-origin command API.
    Object.defineProperty(globalThis, '__shikePickupAdapter', {
      value: Object.freeze({ check: requestCheck, cancel: requestCancel, ready: serverReady }), configurable: false, writable: false,
    });
  }
  if (runtime?.onMessage) runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (sender?.id !== runtime.id || sender.tab || sender.url && !sender.url.startsWith(extensionOrigin) || !message || typeof message !== 'object') return false;
    if (message.type === 'PICKUP_PAGE_CANCEL') { sendResponse(requestCancel(message.runToken)); return false; }
    if (message.type !== 'PICKUP_PAGE_CHECK') return false;
    requestCheck(message.config, message.runToken).then(sendResponse, () => sendResponse({ ok: false, error: '读取官网门店状态失败。' }));
    return true;
  });
})();
