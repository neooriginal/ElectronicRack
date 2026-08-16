// Client-side storage for rack access keys. The server never has the plaintext
// secret — only a salted hash — so this is the only place it can live once the
// BLE read that produced it is gone. Losing every copy means reconnecting over
// Bluetooth to read it again; there is no server-side recovery, by design.

const STORE_KEY = "rackKeys.v1";
const KEY_PREFIX = "rack1";

function loadAll() {
  try {
    return JSON.parse(localStorage.getItem(STORE_KEY) || "{}");
  } catch {
    return {};
  }
}

function saveAll(obj) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(obj));
  } catch {
    // Private browsing / storage disabled — the session cookie still works
    // for this tab, it just won't be remembered for next time.
  }
}

// One string that carries both fields, so there's exactly one thing to copy
// and one thing to paste. `rackId` is hex, `secret` is 32 hex chars, so a dot
// separator can never collide with either.
export function encodeKey(rackId, secret) {
  return `${KEY_PREFIX}.${rackId}.${secret}`;
}

export function decodeKey(text) {
  const m = new RegExp(`^${KEY_PREFIX}\\.([0-9a-f]{6,32})\\.([0-9a-f]{32})$`).exec(
    String(text || "").trim().toLowerCase()
  );
  return m ? { rackId: m[1], secret: m[2] } : null;
}

export function remember(rackId, secret, name) {
  const all = loadAll();
  all[rackId] = { secret, name: name || all[rackId]?.name || "", savedAt: Date.now() };
  saveAll(all);
}

export function forget(rackId) {
  const all = loadAll();
  delete all[rackId];
  saveAll(all);
}

export function savedRacks() {
  return Object.entries(loadAll())
    .map(([rackId, v]) => ({ rackId, ...v }))
    .sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
}

export function getSecret(rackId) {
  return loadAll()[rackId]?.secret || null;
}
