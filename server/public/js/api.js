// Thin fetch wrapper for the server API. Session is a cookie set by
// POST /api/session after the browser reads the rack's identity over BLE.

const REQ_TIMEOUT_MS = 8000;

export const inflight = { n: 0, listeners: new Set() };
function begin() {
  inflight.n++;
  inflight.listeners.forEach((fn) => fn(inflight.n));
}
function end() {
  inflight.n = Math.max(0, inflight.n - 1);
  inflight.listeners.forEach((fn) => fn(inflight.n));
}

async function req(path, { method = "GET", body, headers, timeout = REQ_TIMEOUT_MS } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeout);
  begin();
  try {
    const r = await fetch(path, {
      method,
      credentials: "same-origin",
      signal: ctl.signal,
      headers: body === undefined && !headers ? undefined : { "Content-Type": "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      const err = new Error(data.error || r.statusText || `HTTP ${r.status}`);
      err.status = r.status;
      err.data = data;
      throw err;
    }
    return data;
  } finally {
    clearTimeout(timer);
    end();
  }
}

export const api = {
  session: (rackId, secret) =>
    req("/api/session", { method: "POST", body: { rackId }, headers: { Authorization: `Bearer ${secret}` } }),
  logout: () => req("/api/logout", { method: "POST" }),
  bootstrap: () => req("/api/bootstrap"),
  inventory: () => req("/api/inventory"),
  bin: (row, col) => req(`/api/bin?row=${row}&col=${col}`),
  putConfig: (cfg) => req("/api/config", { method: "PUT", body: cfg }),
  place: (body) => req("/api/stock/place", { method: "POST", body }),
  adjust: (body) => req("/api/stock/adjust", { method: "POST", body }),
  set: (body) => req("/api/stock/set", { method: "POST", body }),
  clear: (body) => req("/api/stock/clear", { method: "POST", body }),
};
