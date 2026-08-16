// Talks to the rack over Web Bluetooth. See docs/ble-protocol.md for the wire
// format this mirrors. Only Chrome/Edge on desktop and Android implement this
// API — there is no Safari/iOS path, by Apple's choice, not ours.

const SERVICE = "6e5f0001-b5a3-f393-e0a9-e50e24dcca9e";
const CHAR_IDENTITY = "6e5f0002-b5a3-f393-e0a9-e50e24dcca9e";
const CHAR_SECRET = "6e5f0003-b5a3-f393-e0a9-e50e24dcca9e";
const CHAR_COMMAND = "6e5f0004-b5a3-f393-e0a9-e50e24dcca9e";
const CHAR_EVENT = "6e5f0005-b5a3-f393-e0a9-e50e24dcca9e";

// Stays a few hundred bytes under the negotiated MTU so a chunk never needs a
// second write; the rack's BLE_MTU default is 517.
const CHUNK_BYTES = 450;

export const bleSupported = "bluetooth" in navigator;

// GATT operations that hang instead of rejecting are common enough on real
// hardware (a busy peripheral, a stalled connection) that every step needs a
// bound — otherwise "connect" just sits there forever with no feedback.
const STEP_TIMEOUT_MS = 10000;

function withTimeout(promise, label) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(
      () => reject(new Error(`timed out waiting for: ${label}`)),
      STEP_TIMEOUT_MS
    );
    promise.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); }
    );
  });
}

// Every step logs to the console as it starts, so a hang is visible in
// DevTools even when nothing ever rejects to show a toast for.
async function step(label, fn) {
  console.debug(`[ble] ${label}…`);
  try {
    const v = await withTimeout(fn(), label);
    console.debug(`[ble] ${label} ✓`);
    return v;
  } catch (e) {
    console.error(`[ble] ${label} FAILED:`, e);
    const wrapped = new Error(`${label}: ${e.message || e}`);
    // Preserve DOMException names (NotFoundError, SecurityError, …) so callers
    // can still special-case "user cancelled the picker" vs a real failure.
    wrapped.name = e.name || "Error";
    throw wrapped;
  }
}

class RackBLE {
  constructor() {
    this.device = null;
    this.server = null;
    this.cmdChar = null;
    this.listeners = new Set();
    this.identity = null;
    this._onDisconnected = this._onDisconnected.bind(this);
  }

  on(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  _emit(evt) {
    for (const fn of this.listeners) fn(evt);
  }

  get connected() {
    return !!this.server?.connected;
  }

  async connect() {
    if (!bleSupported) throw new Error("This browser has no Web Bluetooth. Use Chrome or Edge.");

    this.device = await step("choose device", () =>
      navigator.bluetooth.requestDevice({
        filters: [{ services: [SERVICE] }],
        optionalServices: [SERVICE],
      })
    );
    this.device.addEventListener("gattserverdisconnected", this._onDisconnected);

    this.server = await step("open GATT connection", () => this.device.gatt.connect());
    const svc = await step("find rack service", () => this.server.getPrimaryService(SERVICE));

    const identChar = await step("find identity characteristic", () => svc.getCharacteristic(CHAR_IDENTITY));
    const secretChar = await step("find secret characteristic", () => svc.getCharacteristic(CHAR_SECRET));
    this.cmdChar = await step("find command characteristic", () => svc.getCharacteristic(CHAR_COMMAND));
    const eventChar = await step("find event characteristic", () => svc.getCharacteristic(CHAR_EVENT));

    const identRaw = await step("read identity", () => identChar.readValue());
    const secretRaw = await step("read secret", () => secretChar.readValue());

    const identText = new TextDecoder().decode(identRaw);
    try {
      this.identity = JSON.parse(identText);
    } catch (e) {
      // A truncated read looks exactly like this: valid start, cut off mid-object.
      console.error("[ble] identity payload did not parse:", identText);
      throw new Error(`rack sent malformed identity (${identText.length} bytes) — try reconnecting`);
    }
    const secret = new TextDecoder().decode(secretRaw).trim();

    await step("subscribe to events", () => eventChar.startNotifications());
    eventChar.addEventListener("characteristicvaluechanged", (e) => {
      try {
        const json = JSON.parse(new TextDecoder().decode(e.target.value));
        this._emit(json);
      } catch {
        // Malformed frame from a busy device — drop it rather than crash the UI.
      }
    });

    return { ...this.identity, secret };
  }

  _onDisconnected() {
    this.cmdChar = null;
    this._emit({ t: "_disconnected" });
  }

  disconnect() {
    this.device?.gatt?.disconnect();
  }

  async send(obj) {
    if (!this.cmdChar) throw new Error("not connected to the rack");
    const bytes = new TextEncoder().encode(JSON.stringify(obj));
    // writeValueWithoutResponse is fire-and-forget and far faster under load;
    // acknowledged writes are reserved for commands whose loss would matter.
    await this.cmdChar.writeValueWithoutResponse(bytes);
  }

  // Splits a stock snapshot into MTU-sized chunks the rack reassembles by `seq`.
  async sendStock(cells) {
    const perChunk = 8;
    for (let i = 0; i < cells.length || i === 0; i += perChunk) {
      const slice = cells.slice(i, i + perChunk);
      const more = i + perChunk < cells.length;
      // eslint-disable-next-line no-await-in-loop
      await this.send({ t: "stock", seq: i / perChunk, more, cells: slice });
      if (cells.length === 0) break;
    }
  }

  locate(row, col) {
    return this.send({ t: "locate", row, col });
  }
  flash(row, col, color, ms) {
    return this.send({ t: "flash", row, col, color, ms });
  }
  mode(mode, extra = {}) {
    return this.send({ t: "mode", mode, ...extra });
  }
  identify(index) {
    return this.send({ t: "identify", index });
  }
  grid(rows, cols) {
    return this.send({ t: "grid", rows, cols });
  }
  wiring(w) {
    return this.send({ t: "wiring", ...w });
  }
  leds(cfg) {
    return this.send({ t: "leds", ...cfg });
  }
}

export const rack = new RackBLE();
export { CHUNK_BYTES };
