// Independent from notification delivery: retries must never create arrival events.
export const STOCK_HISTORY_LIMIT = 500;
const text = (value, max) => String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, max);
const timestamp = value => Number.isSafeInteger(value) && value > 0 && value < 8640000000000000;
const keyFor = (config, id) => JSON.stringify([config.partNumber.toUpperCase(), config.address.trim().toLowerCase(), id]);

export function restoreStockHistory(raw, now = Date.now()) {
  const history = {version: 1, startedAt: timestamp(raw?.startedAt) ? raw.startedAt : now, events: [], observations: []};
  if (raw?.version !== 1) return history;
  for (const row of Array.isArray(raw.events) ? raw.events.slice(-STOCK_HISTORY_LIMIT) : []) {
    if (!row || !timestamp(row.observedAt) || !['first-observed', 'restocked'].includes(row.kind) || !row.storeId || !row.partNumber) continue;
    history.events.push({observedAt: row.observedAt, kind: row.kind,
      lastUnavailableAt: timestamp(row.lastUnavailableAt) && row.lastUnavailableAt <= row.observedAt ? row.lastUnavailableAt : 0,
      partNumber: text(row.partNumber, 24), productName: text(row.productName, 160), location: text(row.location, 250),
      storeId: text(row.storeId, 500), storeName: text(row.storeName, 160), distanceText: text(row.distanceText, 80), pickupText: text(row.pickupText, 160)});
  }
  for (const row of Array.isArray(raw.observations) ? raw.observations.slice(-STOCK_HISTORY_LIMIT) : []) {
    if (!row || typeof row.key !== 'string' || row.key.length > 2000 || !['available', 'unavailable'].includes(row.availability)) continue;
    history.observations.push({key: row.key, availability: row.availability, lastUnavailableAt: timestamp(row.lastUnavailableAt) ? row.lastUnavailableAt : 0});
  }
  return history;
}

export function recordStockHistory(raw, config, stores, observedAt) {
  const history = restoreStockHistory(raw, observedAt);
  const observations = new Map(history.observations.map(row => [row.key, row]));
  for (const store of stores) {
    // Missing, unknown and failed checks are not evidence that stock disappeared.
    if (!['available', 'unavailable'].includes(store.availability)) continue;
    const key = keyFor(config, store.id), previous = observations.get(key);
    if (store.availability === 'available' && previous?.availability !== 'available') {
      history.events.push({observedAt, kind: previous?.availability === 'unavailable' ? 'restocked' : 'first-observed',
        lastUnavailableAt: previous?.lastUnavailableAt || 0,
        partNumber: config.partNumber, productName: config.productName, location: config.address,
        storeId: store.id, storeName: store.name, distanceText: store.distanceText || '', pickupText: store.pickupText || store.availabilityText || ''});
    }
    observations.delete(key);
    observations.set(key, {key, availability: store.availability,
      lastUnavailableAt: store.availability === 'unavailable' ? observedAt : previous?.lastUnavailableAt || 0});
  }
  history.events = history.events.slice(-STOCK_HISTORY_LIMIT);
  history.observations = [...observations.values()].slice(-STOCK_HISTORY_LIMIT);
  return history;
}
