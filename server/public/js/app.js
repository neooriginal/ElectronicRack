import {
  CATEGORIES,
  COMMON_STARTERS,
  colorFor,
  loadNamedParts,
  makeCustom,
  searchInventory,
  searchLocal,
} from "./catalog.js";
import { api, inflight } from "./api.js";
import { rack, bleSupported } from "./ble.js";
import { checkUpdate, install as installOta } from "./ota.js";
import { encodeKey, decodeKey, remember, forget, savedRacks, getSecret } from "./keys.js";

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];

const state = {
  view: "find",
  q: "",
  named: [],
  namedReady: false,
  inventory: [],
  config: null,
  identity: null,
  rackId: null,
  currentSecret: null,
  // "connected" = signed in to a server session (works from anywhere).
  // "linked" = that session also has a live BLE connection right now, which is
  // the only way to actually move the lights or push new config to the rack.
  connected: false,
  linked: false,
  selected: null,
  placeCell: null,
  pendingCell: null,
  shareMode: false,
  cursor: 0,
  mapping: false,
  mapLed: 0,
  lastUndo: null,
  ota: null,
};

function toast(msg) {
  const el = $("#toast");
  el.hidden = false;
  el.textContent = msg;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.hidden = true; }, 2400);
}

async function withPending(btn, fn) {
  if (btn) btn.classList.add("pending");
  try {
    return await fn();
  } finally {
    if (btn) btn.classList.remove("pending");
  }
}

// Remote sessions (authenticated, no live BLE) are read-only: nothing physically
// confirms a bin got touched, so edits made from across town shouldn't silently
// pile up against a rack no one is looking at. This is a workflow guard, not a
// security boundary — the server still accepts writes from any valid session;
// it just isn't asked to while this is in effect.
function requireLink(doingWhat) {
  if (rack.connected) return true;
  toast(`Connect via Bluetooth to ${doingWhat || "make changes"} — you're viewing remotely`);
  return false;
}

function cellLabel(row, col) {
  let n = col + 1, s = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s + (row + 1);
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function occupiedMap() {
  const m = new Map();
  for (const item of state.inventory) {
    for (const loc of item.locs || []) m.set(`${loc.row},${loc.col}`, { item, loc });
  }
  return m;
}

function cellItems(cell) {
  if (!cell) return [];
  const out = [];
  for (const item of state.inventory) {
    const loc = (item.locs || []).find((l) => l.row === cell.row && l.col === cell.col);
    if (loc) out.push({ item, qty: loc.qty || 0 });
  }
  return out;
}

function defaultConfig() {
  return {
    rackName: "Bench Rack",
    rows: 6,
    cols: 6,
    leds: {
      pin: 13, count: 36, order: "GRB", brightness: 72, idleBrightness: 18,
      locateColor: "#3DD6E0", idleAnim: "breathe", startupAnim: "cascade",
    },
    wiring: { origin: "top-left", rowFirst: true, serpentine: true, offset: 0 },
    overrides: {},
    ui: { locateOnSelect: true, lowStockQty: 5 },
  };
}

function normalizeConfig(cfg) {
  const base = defaultConfig();
  if (!cfg || typeof cfg !== "object") return base;
  return {
    ...base,
    ...cfg,
    leds: { ...base.leds, ...(cfg.leds || {}) },
    wiring: { ...base.wiring, ...(cfg.wiring || {}) },
    ui: { ...base.ui, ...(cfg.ui || {}) },
    overrides: cfg.overrides || {},
  };
}

function firstEmpty() {
  const cfg = state.config;
  if (!cfg) return null;
  const occ = occupiedMap();
  for (let r = 0; r < (cfg.rows || 0); r++) {
    for (let c = 0; c < (cfg.cols || 0); c++) {
      if (!occ.has(`${r},${c}`)) return { row: r, col: c, cell: cellLabel(r, c) };
    }
  }
  return null;
}

function itemQty(item) {
  return (item.locs || []).reduce((a, l) => a + (l.qty || 0), 0);
}
function primaryLoc(item) {
  return (item.locs && item.locs[0]) || null;
}
function locCell(loc) {
  return loc.cell || cellLabel(loc.row, loc.col);
}

function findStockMatch(item) {
  return state.inventory.find(
    (it) => (item.id && it.id === item.id) || (it.name === item.name && (it.package || "") === (item.package || ""))
  ) || null;
}

// ---------- connect gate ----------

function renderSavedRacks() {
  const box = $("#savedRacks");
  if (!box) return;
  const list = savedRacks();
  if (!list.length) { box.innerHTML = ""; return; }
  box.innerHTML = `<div class="saved-list">${list.map((r) => `
    <button type="button" class="saved-row" data-rack="${esc(r.rackId)}">
      <span class="dot" aria-hidden="true"></span>
      <span class="rn">${esc(r.name || "Rack " + r.rackId.slice(-6))}</span>
      <span class="rid">${esc(r.rackId)}</span>
    </button>`).join("")}</div>`;
  box.querySelectorAll("[data-rack]").forEach((b) => {
    b.onclick = () => withPending(b, () => signInWithKey(b.dataset.rack, getSecret(b.dataset.rack)));
  });
}

function paintConnectGate() {
  const el = $("#connectGate");
  if (!el) return;
  el.hidden = state.connected;
  $("#app")?.toggleAttribute("inert", !state.connected);
  if (!bleSupported) {
    $("#gateUnsupported").hidden = false;
    $("#btnConnect").hidden = true;
  }
  if (!state.connected) renderSavedRacks();
}

async function pushDeviceState() {
  const cfg = state.config;
  await rack.leds({
    pin: cfg.leds.pin, count: cfg.leds.count, order: cfg.leds.order,
    brightness: cfg.leds.brightness, idleBrightness: cfg.leds.idleBrightness,
    locateColor: cfg.leds.locateColor, idleAnim: cfg.leds.idleAnim, startupAnim: cfg.leds.startupAnim,
  });
  await rack.grid(cfg.rows, cfg.cols);
  await rack.wiring(cfg.wiring);
  await pushStockSnapshot();
}

async function pushStockSnapshot() {
  const cells = [];
  const merged = new Map();
  for (const item of state.inventory) {
    const color = item.color || colorFor(item.category);
    for (const loc of item.locs || []) {
      const key = `${loc.row},${loc.col}`;
      const cur = merged.get(key) || { row: loc.row, col: loc.col, qty: 0, color };
      cur.qty += loc.qty || 0;
      merged.set(key, cur);
    }
  }
  for (const v of merged.values()) cells.push(v);
  await rack.sendStock(cells);
}

// Loads inventory/config from the server and shows the app. Does not touch
// BLE — this is the part that works identically whether we just paired or
// just signed in remotely with a saved key.
async function enterApp(name) {
  const boot = await api.bootstrap();
  state.config = normalizeConfig(boot.config);
  state.inventory = boot.inventory || [];
  state.connected = true;
  state.rackId = boot.rackId;
  // Falls back to whatever this device saved the last time it connected over
  // BLE, so "Access" in Settings works after a plain cookie restore too.
  if (!state.currentSecret) state.currentSecret = getSecret(boot.rackId);
  $("#rackName").textContent = state.config.rackName || "Bench Rack";
  paintConnectGate();
  paintSys();
  renderChips();
  renderResults();
  renderGrid();
  toast("Connected to " + (name || boot.name || "your rack"));
}

async function doConnect(triggerBtn) {
  const btn = triggerBtn || $("#btnConnect");
  try {
    await withPending(btn, async () => {
      const ident = await rack.connect();
      state.identity = ident;
      state.currentSecret = ident.secret;
      await api.session(ident.rackId, ident.secret);
    });
    state.linked = true;
    await enterApp();
    remember(state.identity.rackId, state.identity.secret, state.config.rackName);
    await pushDeviceState();
  } catch (e) {
    // NotFoundError covers two very different cases in Chrome and gives no way
    // to tell them apart: the user closed the picker, or the picker opened with
    // nothing in it because no rack was advertising. Silently returning here
    // hides real failures — always say something.
    if (e.name === "NotFoundError") {
      toast("No rack found. Check it's powered, nearby, and not already connected elsewhere.");
    } else if (e.name === "SecurityError") {
      toast("Bluetooth needs a secure page (https or localhost) — this page is neither.");
    } else {
      toast(e.message || "Could not connect");
    }
  }
}

// Signs in using a previously captured secret — no Bluetooth, so this works
// from anywhere and on any browser (including iPhone/Safari, which have no
// Web Bluetooth at all). Lights and live config pushes stay unavailable until
// something in this session also establishes a real BLE link.
async function signInWithKey(rackId, secret) {
  if (!rackId || !secret) { toast("That doesn't look like a valid access key"); return; }
  try {
    const res = await api.session(rackId, secret);
    remember(rackId, secret, res.name);
    state.currentSecret = secret;
    await enterApp(res.name);
  } catch (e) {
    if (e.status === 401) toast("That key doesn't match this rack — check you copied the whole thing");
    else toast(e.message || "Sign-in failed");
  }
}

async function signOut() {
  await api.logout().catch(() => {});
  if (rack.connected) rack.disconnect();
  state.connected = false;
  state.linked = false;
  state.inventory = [];
  state.identity = null;
  state.rackId = null;
  state.currentSecret = null;
  paintConnectGate();
  paintSys();
}

rack.on((evt) => {
  if (evt.t === "_disconnected") {
    // Losing the physical BLE link does not sign you out — the server session
    // is independent of it. Only lights and live pushes stop working.
    state.linked = false;
    paintSys();
    if (state.connected) toast("Bluetooth link dropped — inventory still works, lights won't until you reconnect");
  } else if (evt.t === "walk" && state.view === "rack") {
    renderGrid(evt.cell || cellLabel(evt.row, evt.col));
  } else if (evt.t === "err") {
    toast("Rack rejected the last update — retrying");
    pushStockSnapshot().catch(() => {});
  }
});

// ---------- header ----------

function paintSys() {
  const pip = $("#linkPip");
  const text = $("#sysText");
  if (inflight.n > 0) {
    pip.className = "pip busy";
    text.textContent = "saving…";
  } else if (state.linked) {
    pip.className = "pip ok";
    text.textContent = "connected";
  } else if (state.connected) {
    pip.className = "pip remote";
    text.textContent = "remote — read only";
  } else {
    pip.className = "pip warn";
    text.textContent = "not connected";
  }

  // Remote mode has no live radio to confirm a bin was actually touched, so
  // it's read-only — dim the controls that would otherwise write, and offer
  // the one click that upgrades this session to a full link.
  const readOnly = state.connected && !state.linked;
  document.body.classList.toggle("remote-readonly", readOnly);
  const headerConnect = $("#btnHeaderConnect");
  if (headerConnect) headerConnect.hidden = !readOnly;

  const chip = $("#otaChip");
  if (chip) {
    chip.hidden = !(state.ota && state.ota.available);
    chip.onclick = () => setView("settings");
  }
}

function setView(name) {
  state.view = name;
  $$(".tab").forEach((t) => t.classList.toggle("on", t.dataset.view === name));
  $$(".pane").forEach((p) => p.classList.toggle("on", p.id === "view-" + name));
  if (name === "rack") renderGrid();
  if (name === "settings") renderSettings();
  if (name === "find") $("#q").focus();
}

// ---------- find ----------

function renderChips() {
  const box = $("#chips");
  box.innerHTML = "";
  const occ = occupiedMap();
  const used = [...new Set([...occ.values()].map((v) => v.item.category))].slice(0, 6);
  const chips = used.length ? used : COMMON_STARTERS;
  for (const c of chips) {
    const b = document.createElement("button");
    b.className = "chip";
    b.textContent = c;
    b.addEventListener("click", () => { $("#q").value = c; state.q = c; onQuery(); $("#q").focus(); });
    box.appendChild(b);
  }
}

function collectResults() {
  const q = state.q.trim();
  const stock = searchInventory(q, state.inventory);
  const local = q ? searchLocal(q, state.named) : [];
  const custom = q ? makeCustom(q) : null;
  const stockKeys = new Set(stock.map((s) => (s.mpn || s.name).toLowerCase()));
  const localF = local.filter((p) => !stockKeys.has((p.mpn || p.name).toLowerCase()));
  return { stock, local: localF, custom };
}

function resultRow(item) {
  const wrap = document.createElement("div");
  wrap.className = "row";
  const loc = item.stock ? primaryLoc(item.stock) : null;
  const qty = item.stock ? itemQty(item.stock) : 0;
  const low = state.config && qty > 0 && qty <= (state.config.ui?.lowStockQty || 5);
  const tick = document.createElement("span");
  tick.className = "tick";
  tick.style.background = item.color || colorFor(item.category);
  const main = document.createElement("button");
  main.type = "button";
  main.className = "row-main";
  main.innerHTML = `
    <div class="name">${esc(item.name)}</div>
    <div class="meta">${esc([item.mpn, item.package, item.category].filter(Boolean).join(" · "))}</div>
    <span class="badges">
      ${loc ? `<span class="badge stock">${esc(locCell(loc))}</span>` : ""}
      ${low ? `<span class="badge low">low</span>` : ""}
    </span>`;
  main.addEventListener("click", () => selectPart(item));
  wrap.append(tick, main);
  if (item.stock && loc) {
    const step = document.createElement("div");
    step.className = "row-step";
    step.innerHTML = `<button type="button" data-d="-1" aria-label="Take one">−</button><span class="qty">${qty}</span><button type="button" data-d="1" aria-label="Put one">+</button>`;
    step.addEventListener("click", (e) => {
      const d = Number(e.target.dataset.d);
      if (!d) return;
      e.preventDefault();
      e.stopPropagation();
      quickAdjust(item, d);
    });
    wrap.appendChild(step);
  }
  return wrap;
}

async function quickAdjust(item, d) {
  if (!requireLink("adjust stock")) return;
  const stock = item.stock || findStockMatch(item);
  const loc = stock && primaryLoc(stock);
  if (!stock || !loc) return;
  try {
    const res = await api.adjust({ row: loc.row, col: loc.col, id: stock.id, delta: d });
    applyLocalItemQty(stock.id, loc, res.qty);
    renderResults();
    pushStockSnapshot().catch(() => {});
  } catch (e) { toast(e.message); }
}

function renderResults() {
  const root = $("#results");
  root.innerHTML = "";
  const q = state.q.trim();
  const { stock, local, custom } = collectResults();

  if (!q) {
    if (!stock.length) {
      root.innerHTML = `<p class="empty">${state.connected ? "Rack is empty. Search a value or name, or add your own part and drop it in a bin." : "Connect to your rack to see what's stocked."}</p>`;
    } else {
      const group = document.createElement("div");
      group.innerHTML = `<div class="group-h">In the rack<span>${stock.length}</span></div>`;
      const list = document.createElement("div");
      list.className = "list";
      // searchInventory() already sets .stock to the original item (with real
      // .locs); wrapping it again here would point .stock at the normalized,
      // locs-stripped shell instead and send every open sheet to a wrong bin.
      for (const it of stock) list.appendChild(resultRow(it));
      group.appendChild(list);
      root.appendChild(group);
    }
  } else {
    const groups = [
      ["In the rack", stock],
      ["Catalog", local],
    ];
    for (const [label, items] of groups) {
      if (!items.length) continue;
      const group = document.createElement("div");
      group.innerHTML = `<div class="group-h">${label}<span>${items.length}</span></div>`;
      const list = document.createElement("div");
      list.className = "list";
      for (const it of items) list.appendChild(resultRow(it));
      group.appendChild(list);
      root.appendChild(group);
    }
  }

  const cta = document.createElement("button");
  cta.type = "button";
  cta.className = "create-cta";
  cta.innerHTML = `<div><div class="name">${esc(custom ? `Add "${state.q.trim()}"` : "Add custom part")}</div><div class="meta">Name, category, package — then pick a bin</div></div>`;
  cta.addEventListener("click", () => openCustom(state.q.trim()));
  root.appendChild(cta);
}

function onQuery() {
  state.q = $("#q").value;
  $("#clearQ").hidden = !state.q;
  renderResults();
}

function openCustom(name, cell) {
  state.pendingCell = cell || null;
  selectPart(makeCustom(name || ""));
}

async function selectPart(item) {
  state.selected = item;
  const stock = item.stock || findStockMatch(item);
  if (stock) {
    state.selected.stock = stock;
    const loc = primaryLoc(stock);
    if (loc && state.config?.ui?.locateOnSelect !== false) rack.locate(loc.row, loc.col).catch(() => {});
    state.placeCell = loc ? { row: loc.row, col: loc.col, cell: loc.cell || cellLabel(loc.row, loc.col) } : firstEmpty();
  } else {
    state.placeCell = state.pendingCell || firstEmpty();
    if (state.placeCell && state.config?.ui?.locateOnSelect !== false) {
      rack.locate(state.placeCell.row, state.placeCell.col).catch(() => {});
    }
  }
  state.pendingCell = null;
  state.shareMode = false;
  openSheet();
}

// ---------- sheet ----------

function openSheet() {
  const item = state.selected;
  if (!item) return;
  const sheet = $("#sheet");
  const card = $("#sheetCard");
  const stock = item.stock;
  const loc = stock ? primaryLoc(stock) : null;
  const isNew = !stock;
  const qty = loc ? loc.qty : (isNew ? 1 : 0);
  const cell = state.placeCell;
  if (cellItems(cell).length > 1) state.shareMode = true;
  const share = state.shareMode;
  card.classList.toggle("compact", share);

  const catOpts = CATEGORIES.map((c) =>
    `<option value="${esc(c)}" ${c === (item.category || "other") ? "selected" : ""}>${esc(c)}</option>`).join("");

  card.innerHTML = `
    <div class="sheet-top">
      <div>
        <div class="cat">${isNew ? "new part" : esc(item.category || "part")}</div>
        <h2>${isNew ? "Add to rack" : esc(item.name)}</h2>
        ${isNew ? "" : `<div class="meta" style="color:var(--muted);margin-top:4px;font-size:13px">${esc([item.mpn, item.package].filter(Boolean).join(" · "))}</div>`}
      </div>
      <button class="close" id="sheetClose" aria-label="Close">✕</button>
    </div>
    ${isNew ? `<div class="sheet-fields">
      <label class="span2">Name<input id="cName" type="text" autocomplete="off" spellcheck="false" value="${esc(item.name)}" placeholder="e.g. flux, SN74HC595, leftover screws" /></label>
      <label>Category<select id="cCat">${catOpts}</select></label>
      <label>Package<input id="cPkg" type="text" autocomplete="off" value="${esc(item.package)}" placeholder="0805, DIP-8…" /></label>
    </div>` : ""}
    <div class="bin-mode${share ? " many" : ""}" role="radiogroup" aria-label="What this compartment holds">
      <span class="thumb" aria-hidden="true"></span>
      <button type="button" role="radio" data-mode="one" aria-checked="${share ? "false" : "true"}">One part</button>
      <button type="button" role="radio" data-mode="many" aria-checked="${share ? "true" : "false"}">Multiple parts</button>
    </div>
    ${share ? `<div class="bin-list" id="binList"></div>` : ""}
    <div class="sheet-sticky">
      <div class="stepper">
        <button id="dec">−</button>
        <div class="num"><input id="qty" type="number" min="0" inputmode="numeric" value="${qty}" /></div>
        <button id="inc">+</button>
      </div>
      ${share ? "" : `<div class="nudge-row">
        <button type="button" data-d="-5">−5</button>
        <button type="button" data-d="-1">−1</button>
        <button type="button" data-d="1">+1</button>
        <button type="button" data-d="5">+5</button>
      </div>`}
      <div class="actions">
        <button class="solid" id="btnLocate">${cell ? "Light " + cell.cell : "Pick a bin"}</button>
        <button class="ghost" id="btnPut">${share ? "Add to " + (cell ? cell.cell : "bin") : (stock ? "Done" : "Put in " + (cell ? cell.cell : "a bin"))}</button>
        ${stock && !share ? `<button class="danger" id="btnEmpty">Empty</button>` : ""}
      </div>
    </div>
    <div class="mini-grid" id="mini"></div>
    <div class="help">${share ? "This bin holds several parts, each counted on its own." : (stock ? "Hold +/− to count faster. Type a number to jump." : "Pick a bin, set how many you put in, done.")}</div>
  `;

  sheet.hidden = false;
  sheet.classList.add("is-open");
  $(".app")?.setAttribute("inert", "");
  $("#sheetClose").onclick = (e) => { e.stopPropagation(); closeSheet(); };
  sheet.onclick = (e) => { if (e.target === sheet) { e.preventDefault(); closeSheet(); } };
  $("#sheetCard").onclick = (e) => e.stopPropagation();
  $("#inc").onclick = () => nudge(1);
  $("#dec").onclick = () => nudge(-1);
  holdRepeat($("#inc"), () => nudge(1));
  holdRepeat($("#dec"), () => nudge(-1));
  card.querySelectorAll(".nudge-row [data-d]").forEach((b) => { b.onclick = () => nudge(Number(b.dataset.d)); });

  card.querySelectorAll(".bin-mode [data-mode]").forEach((b) => {
    b.onclick = () => {
      const wantShare = b.dataset.mode === "many";
      if (wantShare === state.shareMode) return;
      if (!wantShare && cellItems(state.placeCell).length > 1) {
        toast("Remove the extra parts first to make this a single-part bin");
        return;
      }
      applySheetFields();
      const typed = parseInt($("#qty")?.value, 10);
      state.shareMode = wantShare;
      openSheet();
      const input = $("#qty");
      if (input && Number.isFinite(typed)) input.value = String(typed);
    };
  });

  $("#btnLocate").onclick = () => { const c = state.placeCell; if (c) rack.locate(c.row, c.col).catch((e) => toast(e.message)); };
  const put = $("#btnPut");
  put.onclick = () => { if (stock && !share) closeSheet(); else withPending(put, () => commitQty()); };
  const empty = $("#btnEmpty");
  if (empty) empty.onclick = () => withPending(empty, () => clearCell());
  $("#qty").addEventListener("change", () => commitQty(true));
  paintMini();
  if (share) paintBinList();

  if (isNew) {
    $("#cCat")?.addEventListener("change", () => { if (state.selected) { state.selected.category = $("#cCat").value; paintMini(); } });
  }
}

function applySheetFields() {
  const item = state.selected;
  if (!item || item.stock) return;
  const name = $("#cName")?.value.trim();
  if (name != null && $("#cName")) item.name = name;
  if ($("#cCat")) item.category = $("#cCat").value;
  if ($("#cPkg")) item.package = $("#cPkg").value.trim();
  item.color = colorFor(item.category);
  item.source = item.source || "custom";
}

function paintMini() {
  const mini = $("#mini");
  if (!mini) return;
  const cfg = state.config || normalizeConfig(null);
  mini.innerHTML = "";
  mini.style.gridTemplateColumns = `repeat(${cfg.cols}, 1fr)`;
  const occ = occupiedMap();
  const sel = state.placeCell;
  for (let r = 0; r < cfg.rows; r++) {
    for (let c = 0; c < cfg.cols; c++) {
      const hit = occ.get(`${r},${c}`);
      const b = document.createElement("button");
      b.textContent = cellLabel(r, c);
      if (hit) b.classList.add("full");
      else b.classList.add("empty");
      if (sel && sel.row === r && sel.col === c) b.classList.add("pick");
      b.title = hit ? `${hit.item.name} × ${hit.loc.qty}` : "empty";
      b.onclick = async () => {
        const stock = state.selected?.stock;
        if (stock && primaryLoc(stock) && (primaryLoc(stock).row !== r || primaryLoc(stock).col !== c)) {
          if (!requireLink("move stock")) return;
          try {
            const from = primaryLoc(stock);
            await api.clear({ row: from.row, col: from.col, id: stock.id });
            const res = await api.place({ row: r, col: c, id: stock.id, name: stock.name, category: stock.category, package: stock.package, qty: itemQty(stock) });
            await refreshInventory();
            state.selected.stock = findStockMatch(state.selected);
            void res;
          } catch (e) { toast(e.message); }
        }
        state.placeCell = { row: r, col: c, cell: cellLabel(r, c) };
        rack.locate(r, c).catch(() => {});
        paintMini();
        paintBinList();
        const put = $("#btnPut");
        if (put && state.shareMode) put.textContent = "Add to " + state.placeCell.cell;
        else if (put && !state.selected?.stock) put.textContent = "Put in " + state.placeCell.cell;
        const light = $("#btnLocate");
        if (light) light.textContent = "Light " + state.placeCell.cell;
      };
      mini.appendChild(b);
    }
  }
}

function paintBinList() {
  const box = $("#binList");
  if (!box) return;
  const cell = state.placeCell;
  const rows = cellItems(cell);
  box.innerHTML = "";
  if (!rows.length) {
    box.innerHTML = `<p class="bin-empty">${esc(cell ? cell.cell : "This bin")} is empty — set an amount below to add the first part.</p>`;
    return;
  }
  for (const { item, qty } of rows) {
    const row = document.createElement("div");
    row.className = "bin-row";
    row.innerHTML = `
      <span class="tick" style="background:${esc(item.color || colorFor(item.category))}"></span>
      <span class="bin-name" title="${esc(item.name)}">${esc(item.name)}</span>
      <span class="bin-meta">${esc(item.package || item.category || "")}</span>
      <span class="bin-step">
        <button type="button" data-d="-1" aria-label="Take one ${esc(item.name)}">−</button>
        <span class="n">${qty}</span>
        <button type="button" data-d="1" aria-label="Add one ${esc(item.name)}">+</button>
      </span>
      <button type="button" class="bin-x" aria-label="Remove ${esc(item.name)} from ${esc(cell.cell)}">✕</button>`;
    row.querySelectorAll(".bin-step [data-d]").forEach((b) => { b.onclick = () => withPending(b, () => adjustInBin(item, Number(b.dataset.d))); });
    row.querySelector(".bin-x").onclick = (e) => withPending(e.currentTarget, () => removeFromBin(item));
    box.appendChild(row);
  }
}

async function adjustInBin(item, delta) {
  if (!requireLink("adjust stock")) return;
  const cell = state.placeCell;
  if (!cell) return;
  try {
    const res = await api.adjust({ row: cell.row, col: cell.col, id: item.id, delta });
    applyLocalItemQty(item.id, cell, res.qty);
    paintBinList();
    if (state.view === "rack") renderGrid();
    pushStockSnapshot().catch(() => {});
  } catch (e) { toast(e.message); }
}

async function removeFromBin(item) {
  if (!requireLink("remove a part")) return;
  const cell = state.placeCell;
  if (!cell) return;
  try {
    await api.clear({ row: cell.row, col: cell.col, id: item.id });
    applyLocalItemQty(item.id, cell, 0);
    paintBinList();
    if (state.view === "rack") renderGrid();
    pushStockSnapshot().catch(() => {});
    toast(item.name + " removed from " + cell.cell);
  } catch (e) { toast(e.message); }
}

function applyLocalItemQty(id, cell, qty) {
  const item = state.inventory.find((it) => it.id === id);
  if (!item) return;
  item.locs = (item.locs || []).filter((l) => locCell(l) !== cell.cell);
  if (qty > 0) item.locs.push({ row: cell.row, col: cell.col, cell: cell.cell, qty });
  item.qty = item.locs.reduce((a, l) => a + (l.qty || 0), 0);
  state.inventory = state.inventory.filter((i) => (i.locs || []).length);
}

function applyLocalPlace(item, cell, qty, id, share) {
  const existing = state.inventory.find((it) => (id && it.id === id) || findStockMatch(item) === it);
  const target = existing || {
    id: id || "", name: item.name, category: item.category || "other", package: item.package || "",
    mpn: item.mpn || "", color: item.color || colorFor(item.category), locs: [],
  };
  if (!share) {
    for (const other of state.inventory) {
      if (other === target) continue;
      other.locs = (other.locs || []).filter((l) => locCell(l) !== cell.cell);
      other.qty = (other.locs || []).reduce((a, l) => a + (l.qty || 0), 0);
    }
  }
  target.locs = (target.locs || []).filter((l) => locCell(l) !== cell.cell);
  if (qty > 0) target.locs.push({ row: cell.row, col: cell.col, cell: cell.cell, qty });
  target.qty = target.locs.reduce((a, l) => a + (l.qty || 0), 0);
  if (!existing && target.locs.length) state.inventory.push(target);
  state.inventory = state.inventory.filter((i) => (i.locs || []).length);
}

async function nudge(delta) {
  if (!requireLink("adjust stock")) return;
  const input = $("#qty");
  if (!input) return;
  const next = Math.max(0, (parseInt(input.value, 10) || 0) + delta);
  input.value = String(next);
  const stock = state.selected?.stock;
  const cell = state.placeCell;
  if (stock && cell && !state.shareMode) {
    applyLocalItemQty(stock.id, cell, next);
    try {
      const res = await api.adjust({ row: cell.row, col: cell.col, id: stock.id, delta });
      applyLocalItemQty(stock.id, cell, res.qty);
      pushStockSnapshot().catch(() => {});
    } catch (e) { toast(e.message); await refreshInventory(); }
  } else if (!stock && cell && next > 0 && !state.shareMode) {
    await commitQty(true);
  }
}

async function commitQty(fromInput) {
  if (!requireLink("save this")) return;
  applySheetFields();
  const cell = state.placeCell;
  if (!cell) { toast("No empty bin — open Grid and tap one, or raise rows/columns in Setup"); return; }
  const qty = Math.max(0, parseInt($("#qty").value, 10) || 0);
  const item = state.selected;
  if (!item.stock && !item.name) { toast("Name the part first"); $("#cName")?.focus(); return; }
  const share = state.shareMode;
  let res = null;
  try {
    if (item.stock && findStockMatch(item)) {
      const known = findStockMatch(item);
      res = await api.set({ row: cell.row, col: cell.col, qty, id: share ? known.id : undefined });
    } else {
      const payload = {
        name: item.name, category: item.category || "other", package: item.package || "",
        mpn: item.mpn || "", row: cell.row, col: cell.col, qty, share,
      };
      try {
        res = await api.place(payload);
      } catch (e) {
        if (e.status !== 409) throw e;
        const who = e.data?.occupant || "another part";
        if (!confirm(`${cell.cell} already holds ${who}. Replace it with ${item.name}?`)) {
          toast("Kept " + who + " in " + cell.cell);
          return;
        }
        res = await api.place({ ...payload, replace: true });
      }
    }
    applyLocalPlace(item, cell, qty, res?.id, share);
    state.selected.stock = findStockMatch(item);
    if (state.view === "find") renderResults();
    if (state.view === "rack") renderGrid();
    pushStockSnapshot().catch(() => {});
    if (fromInput) {
      const input = $("#qty");
      if (input) input.value = String(qty);
      paintMini();
      paintBinList();
      return;
    }
    toast(`${item.name} → ${cell.cell}`);
    openSheet();
  } catch (e) { toast(e.message); }
}

async function clearCell() {
  if (!requireLink("empty this bin")) return;
  const cell = state.placeCell;
  if (!cell) return;
  try {
    await api.clear({ row: cell.row, col: cell.col });
    await refreshInventory();
    pushStockSnapshot().catch(() => {});
    closeSheet();
    toast(cell.cell + " emptied");
  } catch (e) { toast(e.message); }
}

function closeSheet() {
  const sheet = $("#sheet");
  sheet.classList.remove("is-open");
  sheet.hidden = true;
  $(".app")?.removeAttribute("inert");
  if (state.view === "find") $("#q").focus();
}

function holdRepeat(el, fn) {
  if (!el) return;
  let t = null, iv = null;
  const stop = () => { clearTimeout(t); clearInterval(iv); t = iv = null; };
  el.addEventListener("pointerdown", () => { t = setTimeout(() => { iv = setInterval(fn, 90); }, 420); });
  ["pointerup", "pointerleave", "pointercancel"].forEach((ev) => el.addEventListener(ev, stop));
}

async function refreshInventory() {
  const inv = await api.inventory();
  state.inventory = inv.items || [];
  if (state.selected) state.selected.stock = findStockMatch(state.selected);
  if (state.view === "find") renderResults();
  if (state.view === "rack") renderGrid();
}

// ---------- grid ----------

function renderGrid(lit) {
  const g = $("#grid");
  const cfg = state.config || normalizeConfig(null);
  $("#rackTitle").textContent = `${cfg.cols} × ${cfg.rows}`;
  g.style.gridTemplateColumns = `repeat(${cfg.cols}, minmax(72px, 1fr))`;
  g.innerHTML = "";
  const occ = occupiedMap();
  for (let r = 0; r < cfg.rows; r++) {
    for (let c = 0; c < cfg.cols; c++) {
      const lab = cellLabel(r, c);
      const hit = occ.get(`${r},${c}`);
      const b = document.createElement("button");
      b.type = "button";
      b.className = "cell" + (hit ? "" : " empty") + (lab === lit ? " on" : "");
      b.innerHTML = `
        <div class="lab">${lab}</div>
        <div>
          <div class="cn">${hit ? esc(hit.item.name) : ""}</div>
          <div class="cq">${hit ? hit.loc.qty : ""}</div>
        </div>
        <span class="wash" style="background:${hit ? esc(hit.item.color || colorFor(hit.item.category)) : "transparent"}"></span>`;
      b.onclick = () => {
        if (hit) {
          selectPart({ ...hit.item, stock: hit.item });
        } else {
          rack.locate(r, c).catch(() => {});
          openCustom(state.q.trim(), { row: r, col: c, cell: lab });
        }
      };
      g.appendChild(b);
    }
  }
}

// ---------- settings ----------

function field(key, label, value, type = "text", extra = "") {
  return `<div class="field"><label>${label}</label><input data-k="${key}" type="${type}" value="${esc(value)}" ${extra} /></div>`;
}
function select(key, label, value, opts) {
  return `<div class="field"><label>${label}</label><select data-k="${key}">${opts.map(([v, l]) => `<option value="${v}" ${String(v) === String(value) ? "selected" : ""}>${l}</option>`).join("")}</select></div>`;
}
function check(key, label, value) {
  return `<div class="field"><label>${label}</label><label class="check"><input data-k="${key}" type="checkbox" ${value ? "checked" : ""} /> enabled</label></div>`;
}

let patchTimer = null;
function patchSoon() {
  clearTimeout(patchTimer);
  patchTimer = setTimeout(() => { patchFromSettings().catch((e) => toast(e.message)); }, 300);
}

async function patchFromSettings() {
  if (!requireLink("change setup")) return;
  const g = (k) => $("#settings [data-k='" + k + "']");
  const num = (k, fallback) => { const n = Number(g(k)?.value); return Number.isFinite(n) ? n : fallback; };
  const rows = Math.max(1, num("rows", state.config?.rows || 6));
  const cols = Math.max(1, num("cols", state.config?.cols || 6));
  const oldCells = (state.config?.rows || 0) * (state.config?.cols || 0);
  let ledCount = num("ledCount", 0);
  if (!ledCount || ledCount === oldCells) { ledCount = rows * cols; if (g("ledCount")) g("ledCount").value = String(ledCount); }

  const cfg = {
    rackName: g("rackName")?.value || state.config?.rackName || "Bench Rack",
    rows, cols,
    leds: {
      pin: num("pin", state.config?.leds?.pin || 13), count: ledCount,
      order: g("order")?.value || "GRB",
      brightness: num("brightness", 72), idleBrightness: num("idleBrightness", 18),
      locateColor: g("locateColor")?.value || "#3DD6E0",
      idleAnim: g("idleAnim")?.value || "breathe", startupAnim: g("startupAnim")?.value || "cascade",
    },
    wiring: {
      origin: g("origin")?.value || "top-left",
      rowFirst: (g("axis")?.value || "row") === "row",
      serpentine: !!g("serpentine")?.checked,
      offset: num("offset", 0),
    },
    overrides: state.config?.overrides || {},
    ui: state.config?.ui || {},
  };

  state.config = normalizeConfig(await api.putConfig(cfg));
  $("#rackName").textContent = state.config.rackName;
  // Saved either way; the rack only gets the update if a BLE session is live.
  try {
    await pushDeviceState();
  } catch (e) {
    toast("Saved. " + (e.message || "Connect via Bluetooth to apply it to the rack now."));
  }
}

async function startMap() {
  if (!rack.connected) { toast("Connect via Bluetooth to calibrate — this needs to see the lights"); return; }
  state.mapping = true;
  state.mapLed = 0;
  await rack.identify(0);
  toast("LED 0 is on — tap the bin that lit, in Grid");
  setView("rack");
}

function renderSettings() {
  const root = $("#settings");
  const cfg = state.config || normalizeConfig(null);
  root.innerHTML = `
    <div class="card">
      <h3>Rack</h3>
      <div class="fields">${field("rackName", "Name", cfg.rackName)}</div>
      <p class="help">Rack ID <code>${esc(state.rackId || "—")}</code></p>
    </div>
    <div class="card">
      <h3>Access</h3>
      <p class="help">
        ${state.linked
          ? "Bluetooth is connected — you can control the lights from here."
          : "You're signed in remotely: inventory works, but the lights need a live Bluetooth connection."}
      </p>
      ${!state.linked ? `<div class="row-btns" style="margin-top:8px"><button class="ghost" id="btnLinkNow">Connect via Bluetooth</button></div>` : ""}
      <div class="key-box" id="keyBox" style="margin-top:14px">
        ${state.currentSecret
          ? `<label class="span2">Access key<div class="key-row"><input readonly value="${esc(encodeKey(state.rackId, state.currentSecret))}" id="keyOut" /><button type="button" class="ghost" id="btnCopyKey">Copy</button></div></label>
             <p class="help">Anyone with this key can view and edit this rack's inventory from anywhere — treat it like a password. Only Bluetooth reveals it; the server can't show it to you again if you lose it.</p>`
          : `<p class="help">Connect via Bluetooth once to reveal and save this rack's access key for remote sign-in.</p>`}
      </div>
      <div class="row-btns" style="margin-top:12px">
        <button class="danger" id="btnForgetDevice">Sign out of this device</button>
      </div>
    </div>
    <div class="card">
      <h3>Grid</h3>
      <div class="fields">${field("rows", "Rows", cfg.rows, "number")}${field("cols", "Columns", cfg.cols, "number")}</div>
      <div class="row-btns" style="margin-top:8px">
        ${[[4, 4], [6, 6], [8, 6], [10, 8]].map(([r, c]) => `<button type="button" data-preset="${r},${c}">${r}×${c}</button>`).join("")}
      </div>
    </div>
    <div class="card">
      <h3>LEDs</h3>
      <div class="fields">
        ${field("pin", "Data pin", cfg.leds.pin, "number")}
        ${field("ledCount", "LED count", cfg.leds.count, "number")}
        ${select("order", "Color order", cfg.leds.order, ["RGB", "GRB", "BRG", "RBG", "GBR", "BGR"].map((o) => [o, o]))}
        ${field("brightness", "Brightness", cfg.leds.brightness, "number", 'min="0" max="255"')}
        ${field("idleBrightness", "Idle brightness", cfg.leds.idleBrightness, "number", 'min="0" max="255"')}
        ${field("locateColor", "Locate color", cfg.leds.locateColor, "color")}
        ${select("idleAnim", "Idle animation", cfg.leds.idleAnim, [["breathe", "Breathe"], ["sparkle", "Sparkle"], ["rainbow", "Rainbow"], ["heatmap", "Heatmap"], ["off", "Off"]])}
        ${select("startupAnim", "Startup animation", cfg.leds.startupAnim, [["cascade", "Cascade"], ["lightning", "Lightning"], ["spiral", "Spiral"], ["none", "None"]])}
      </div>
    </div>
    <div class="card">
      <h3>Wiring</h3>
      <div class="fields">
        ${select("origin", "Origin", cfg.wiring.origin, [["top-left", "Top-left"], ["top-right", "Top-right"], ["bottom-left", "Bottom-left"], ["bottom-right", "Bottom-right"]])}
        ${select("axis", "Direction", cfg.wiring.rowFirst ? "row" : "col", [["row", "Row-first"], ["col", "Column-first"]])}
        ${check("serpentine", "Serpentine", cfg.wiring.serpentine)}
        ${field("offset", "LED offset", cfg.wiring.offset, "number")}
      </div>
      <div class="row-btns" style="margin-top:12px">
        <button class="ghost" id="btnZigzag">Reset to zig-zag</button>
        <button class="ghost" id="btnMap">Tap-to-map</button>
        <button class="ghost" id="btnClearMap">Clear overrides</button>
      </div>
      <p class="help">Default zig-zag: A1 top-left, right along row 1, then left along row 2, and so on. Use Tap-to-map only if a few bins are still wrong.</p>
    </div>
    <div class="card">
      <h3>Lights</h3>
      <div class="row-btns">
        <button class="ghost" id="btnCorners">Show corners</button>
        <button class="ghost" id="btnWalk">Walk strip</button>
        <button class="ghost" id="btnPreview">Preview startup</button>
        <button class="ghost" id="btnIdle2">Idle</button>
        <button class="ghost" id="btnOff">Off</button>
      </div>
    </div>
    <div class="card">
      <h3>Firmware</h3>
      <p class="help" id="fwText">v${esc(state.identity?.fw || "—")} (${esc(state.identity?.git || "dev")})</p>
      <div class="row-btns">
        <button class="ghost" id="btnOtaCheck">Check for update</button>
        <button class="solid" id="btnOtaInstall" hidden>Install update</button>
      </div>
      <div class="bar" id="otaBarWrap" hidden><i id="otaBar"></i></div>
    </div>
  `;

  $("#btnLinkNow")?.addEventListener("click", () => doConnect($("#btnLinkNow")));
  $("#btnCopyKey")?.addEventListener("click", async () => {
    const text = $("#keyOut").value;
    try {
      await navigator.clipboard.writeText(text);
      toast("Access key copied");
    } catch {
      $("#keyOut").select();
      toast("Select-all failed to auto-copy — copy it manually");
    }
  });
  $("#btnForgetDevice")?.addEventListener("click", async () => {
    if (!confirm("Sign out of this device? You'll need the access key or Bluetooth to get back in.")) return;
    if (state.rackId) forget(state.rackId);
    await signOut();
  });

  root.querySelectorAll("[data-k]").forEach((el) => el.addEventListener("change", () => patchSoon()));
  root.querySelectorAll("[data-preset]").forEach((el) => {
    el.addEventListener("click", async () => {
      const [r, c] = el.dataset.preset.split(",").map(Number);
      $("#settings [data-k='rows']").value = String(r);
      $("#settings [data-k='cols']").value = String(c);
      $("#settings [data-k='ledCount']").value = String(r * c);
      await patchFromSettings();
    });
  });
  $("#btnZigzag").onclick = async () => {
    $("#settings [data-k='origin']").value = "top-left";
    $("#settings [data-k='axis']").value = "row";
    $("#settings [data-k='serpentine']").checked = true;
    $("#settings [data-k='offset']").value = "0";
    await patchFromSettings();
    toast("Zig-zag from A1");
  };
  $("#btnCorners").onclick = () => rack.mode("corners").catch((e) => toast(e.message));
  $("#btnWalk").onclick = () => rack.mode("walk").catch((e) => toast(e.message));
  $("#btnMap").onclick = () => startMap();
  $("#btnClearMap").onclick = async () => {
    if (!requireLink("clear the wiring map")) return;
    state.config.overrides = {};
    await api.putConfig(state.config);
    await rack.wiring(state.config.wiring);
    toast("Overrides cleared");
  };
  $("#btnPreview").onclick = () => rack.mode("startup").catch((e) => toast(e.message));
  $("#btnIdle2").onclick = () => rack.mode("idle").catch((e) => toast(e.message));
  $("#btnOff").onclick = () => rack.mode("off").catch((e) => toast(e.message));

  $("#btnOtaCheck").onclick = async () => {
    try {
      const info = await checkUpdate(state.identity?.fw || "0.0.0");
      state.ota = info;
      paintSys();
      if (info.available) {
        $("#fwText").textContent = `v${state.identity?.fw} → v${info.latest} available`;
        $("#btnOtaInstall").hidden = false;
      } else {
        toast("Already on the latest firmware");
      }
    } catch (e) { toast(e.message); }
  };
  $("#btnOtaInstall").onclick = async () => {
    if (!rack.connected) { toast("Connect via Bluetooth to install firmware — this can't be done remotely"); return; }
    const wrap = $("#otaBarWrap");
    const bar = $("#otaBar");
    wrap.hidden = false;
    try {
      await installOta(rack.device, ({ phase, pct }) => {
        bar.style.width = pct + "%";
        $("#fwText").textContent = phase === "downloading" ? "Downloading…" : `Flashing… ${pct}%`;
      });
      toast("Update installed — the rack is rebooting");
    } catch (e) {
      toast("Update failed: " + e.message);
    }
  };
}

// ---------- bind + boot ----------

function bind() {
  $("#q").addEventListener("input", onQuery);
  $("#q").addEventListener("keydown", (e) => { if (e.key === "Escape") { $("#q").value = ""; onQuery(); } });
  $("#clearQ").addEventListener("click", () => { $("#q").value = ""; onQuery(); $("#q").focus(); });
  $("#btnAddCustom").addEventListener("click", () => openCustom(state.q.trim()));
  $$(".tab").forEach((t) => t.addEventListener("click", () => setView(t.dataset.view)));
  $("#btnIdle").addEventListener("click", () => rack.mode("idle").catch((e) => toast(e.message)));
  $("#btnConnect").addEventListener("click", () => doConnect($("#btnConnect")));
  $("#btnHeaderConnect").addEventListener("click", () => doConnect($("#btnHeaderConnect")));
  const doKeySignIn = () => {
    const parsed = decodeKey($("#keyInput").value);
    if (!parsed) { toast("That doesn't look like a valid access key"); return; }
    withPending($("#btnKeySignIn"), () => signInWithKey(parsed.rackId, parsed.secret));
  };
  $("#btnKeySignIn").addEventListener("click", doKeySignIn);
  $("#keyInput").addEventListener("keydown", (e) => { if (e.key === "Enter") doKeySignIn(); });
  document.addEventListener("keydown", (e) => {
    if (e.key === "/" && document.activeElement !== $("#q")) { e.preventDefault(); setView("find"); $("#q").focus(); }
  });
  inflight.listeners.add(() => paintSys());
}

async function boot() {
  bind();
  // A returning device already has a session cookie — no need to show the
  // gate or ask for BLE/key at all. This is what makes remote access actually
  // useful day to day, not just for the first sign-in.
  try {
    await enterApp();
  } catch {
    paintConnectGate();
  }
  state.named = await loadNamedParts().catch(() => []);
  renderChips();
  renderResults();
  renderGrid();

  // ?debug=1 exposes internals for console-driven UI checks without a live BLE
  // device. No effect otherwise — nothing here runs in normal use.
  if (new URLSearchParams(location.search).get("debug") === "1") {
    window.__rack = { state, setView, renderResults, renderGrid, renderSettings, paintConnectGate, paintSys, normalizeConfig };
  }
}

boot();
