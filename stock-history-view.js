// Shared by the extension panel and the authenticated server dashboard.
(() => {
  const $ = id => document.getElementById(id);
  const date = new Intl.DateTimeFormat('sv-SE', {timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'});
  const hour = new Intl.DateTimeFormat('en-GB', {timeZone: 'Asia/Shanghai', hour: '2-digit', hourCycle: 'h23'});
  const time = at => date.format(new Date(at));
  let state = null;
  function rows() {
    const values = state?.stockHistory?.events || [], config = state?.config;
    return values.filter(row => Number.isFinite(row.observedAt) && row.observedAt > 0 &&
      ($('history-scope').value === 'all' || row.partNumber === config?.partNumber && row.location.trim().toLowerCase() === config?.address.trim().toLowerCase()))
      .slice().sort((a, b) => b.observedAt - a.observedAt);
  }
  function node(tag, value, className) {const element = document.createElement(tag); element.textContent = value; if (className) element.className = className; return element;}
  function render(next) {
    state = next;
    $('show-history').disabled = !state;
    const current = (state?.stockHistory?.events || []).filter(row => row.partNumber === state.config.partNumber && row.location.trim().toLowerCase() === state.config.address.trim().toLowerCase());
    $('show-history').textContent = `有货记录 · ${current.length}`;
    if (!state) {if ($('stock-history').open) $('stock-history').close(); $('history-list').replaceChildren(); return;}
    if (!$('stock-history').open) return;
    const events = rows(), counts = new Map();
    for (const row of events) {const h = hour.format(new Date(row.observedAt)); counts.set(h, (counts.get(h) || 0) + 1);}
    $('history-hours').replaceChildren(...[...counts].sort(([a], [b]) => a.localeCompare(b)).map(([h, count]) => node('span', `${h} 时 · ${count} 店次`, 'hour-chip')));
    $('history-summary').textContent = events.length ? `共 ${events.length} 条门店有货记录 · 北京时间` : '尚无有货记录。监控暂停或检查失败期间不会产生记录。';
    $('history-since').textContent = state.stockHistory?.startedAt ? `记录始于 ${time(state.stockHistory.startedAt)}，此前历史无法补回。` : '升级后首次检查开始记录，此前历史无法补回。';
    $('export-history').disabled = !events.length;
    $('history-list').replaceChildren(...events.map(row => {
      const item = document.createElement('li');
      item.append(node('time', time(row.observedAt), 'arrival-time'), node('strong', row.storeName),
        node('p', `${row.productName || row.partNumber} · ${row.partNumber}`, 'arrival-detail'),
        node('p', `${row.location}${row.distanceText ? ' · ' + row.distanceText : ''}`, 'arrival-detail'),
        node('p', row.kind === 'restocked' ? '无货后再次检测到有货' : '首次检测到有货', 'arrival-kind'));
      if (row.lastUnavailableAt) item.append(node('p', `上次确认无货：${time(row.lastUnavailableAt)}`, 'arrival-detail'));
      if (row.pickupText) item.append(node('p', row.pickupText, 'arrival-detail'));
      return item;
    }));
  }
  $('show-history').addEventListener('click', () => {if (state) {$('stock-history').showModal(); render(state);}});
  $('close-history').addEventListener('click', () => $('stock-history').close());
  $('history-scope').addEventListener('change', () => render(state));
  $('export-history').addEventListener('click', () => {
    const events = rows(); if (!events.length) return;
    const cell = value => {let s = String(value ?? ''); if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; return '"' + s.replace(/"/g, '""') + '"';};
    const data = [['首次检测到有货（北京时间）', '记录类型', '商品配置', '商品编号', '监控地区', '门店', '距离', '上次确认无货（北京时间）', '取货信息'],
      ...events.map(row => [time(row.observedAt), row.kind === 'restocked' ? '无货后再次有货' : '首次观测', row.productName, row.partNumber, row.location, row.storeName, row.distanceText, row.lastUnavailableAt ? time(row.lastUnavailableAt) : '', row.pickupText])];
    const url = URL.createObjectURL(new Blob(['\ufeff' + data.map(row => row.map(cell).join(',')).join('\r\n')], {type: 'text/csv;charset=utf-8'}));
    const link = document.createElement('a'); link.href = url; link.download = 'apple-pickup-stock-history.csv'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  window.StockHistoryView = {render};
})();
