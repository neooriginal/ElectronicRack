import {
  COMMON_STARTERS,
  colorFor,
  loadNamedParts,
  makeCustom,
  searchInventory,
  searchLocal,
} from "./catalog.js";

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];

const state = {
  view: "find",
  q: "",
  named: [],
  inventory: [],
  config: null,
  status: {},
  selected: null,
  placeCell: null,
  cursor: 0,
  remote: [],
  remoteQ: "",
  remoteBusy: false,
  mapping: false,
  mapLed: 0,
  lastUndo: null,
  ota: null,
  ignoreDirtyUntil: 0,
};

const api = {
  async get(path) {
    const r = await fetch(path, { cache: "no-store" });
    if (!r.ok) throw new Error(await r.text());
    return r.json();
  },
  async send(path, method, body) {
    const r = await fetch(path, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body == null ? undefined : JSON.stringify(body),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || r.statusText);
    return data;
  },
};

function toast(msg) {
  const el = $("#toast");
  el.hidden = false;
  el.textContent = msg;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.hidden = true; }, 2400);
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

function occupiedMap() {
  const m = new Map();
  for (const item of state.inventory) {
    for (const loc of item.locs || []) {
      m.set(`${loc.row},${loc.col}`, { item, loc });
    }
  }
  return m;
}

function firstEmpty() {
  if (!state.config) return null;
  const occ = occupiedMap();
  for (let r = 0; r < state.config.rows; r++) {
    for (let c = 0; c < state.config.cols; c++) {
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

function touchDirty() {
  state.ignoreDirtyUntil = Date.now() + 1000;
}

function locCell(loc) {
  return loc.cell || cellLabel(loc.row, loc.col);
}

function applyLocalQty(cell, qty) {
  for (const item of state.inventory) {
    for (const loc of item.locs || []) {
      if (locCell(loc) !== cell) continue;
      loc.qty = qty;
      loc.cell = cell;
    }
    item.locs = (item.locs || []).filter((l) => l.qty > 0);
    item.qty = (item.locs || []).reduce((a, l) => a + l.qty, 0);
  }
  state.inventory = state.inventory.filter((i) => (i.locs || []).length);
  if (state.selected) state.selected.stock = findStockMatch(state.selected);
  const input = $("#qty");
  if (input && state.placeCell && state.placeCell.cell === cell) input.value = String(Math.max(0, qty));
  if (state.view === "find") renderResults();
  if (state.view === "rack") renderGrid();
}

async function refreshAll() {
  let boot;
  try {
    boot = await api.get("/api/bootstrap");
  } catch {
    const [cfg, inv, st] = await Promise.all([
      api.get("/api/config"),
      api.get("/api/inventory"),
      api.get("/api/status"),
    ]);
    boot = { ...st, config: cfg, inventory: inv };
  }
  state.config = boot.config;
  state.inventory = (boot.inventory && boot.inventory.items) || [];
  state.status = boot;
  $("#rackName").textContent = (boot.config && boot.config.rackName) || "Bench Rack";
  paintSys();
  if (state.view === "find") renderResults();
  if (state.view === "rack") renderGrid();
  if (state.view === "settings") renderSettings();
}

async function refreshInventory() {
  const inv = await api.get("/api/inventory");
  state.inventory = inv.items || [];
  if (state.selected) state.selected.stock = findStockMatch(state.selected);
  if (state.view === "find") renderResults();
  if (state.view === "rack") renderGrid();
}

function paintSys() {
  const pip = $("#linkPip");
  const text = $("#sysText");
  const s = state.status || {};
  pip.className = "pip " + (s.ip ? "ok" : "warn");
  text.textContent = s.ip ? `${s.ip} · ${s.heap || 0}B` : "offline";
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
    b.addEventListener("click", () => {
      $("#q").value = c;
      state.q = c;
      onQuery();
      $("#q").focus();
    });
    box.appendChild(b);
  }
}

function collectResults() {
  const q = state.q.trim();
  const stock = searchInventory(q, state.inventory);
  const local = q ? searchLocal(q, state.named) : [];
  const remote = (state.remoteQ === q ? state.remote : []).map((p) => ({ ...p, score: 30 }));
  const custom = q ? makeCustom(q) : null;
  const stockKeys = new Set(stock.map((s) => (s.mpn || s.name).toLowerCase()));
  const localF = local.filter((p) => !stockKeys.has((p.mpn || p.name).toLowerCase()));
  const remoteF = remote.filter((p) => !stockKeys.has((p.mpn || p.name).toLowerCase())
    && !localF.some((l) => (l.mpn && l.mpn === p.mpn) || l.name === p.name));
  return { stock, local: localF, remote: remoteF, custom };
}

function renderResults() {
  const root = $("#results");
  const q = state.q.trim();
  const { stock, local, remote, custom } = collectResults();
  const blocks = [];

  const addGroup = (title, items, extra = "") => {
    if (!items.length) return;
    blocks.push(`<div><div class="group-h"><span>${title}</span><span>${extra}</span></div><div class="list"></div></div>`);
  };

  if (!q && !stock.length) {
    root.innerHTML = `<div class="empty"><strong>Rack is empty.</strong>Search a value or name, tap it, then + to drop it in the first empty bin. Stocked parts always rise to the top.</div>`;
    return;
  }

  root.innerHTML = "";
  const groups = [];
  if (stock.length) groups.push(["In the rack", stock, `${stock.length}`]);
  if (local.length) groups.push(["Catalog", local, "generated + named"]);
  if (remote.length) groups.push(["JLCPCB / LCSC", remote, state.remoteBusy ? "updating…" : "live"]);
  if (q && custom) groups.push(["Create", [custom], "custom"]);

  if (!groups.length) {
    root.innerHTML = `<div class="empty">Nothing matched. Press Enter to create “${q}”.</div>`;
    return;
  }

  const flat = [];
  for (const [title, items, extra] of groups) {
    const wrap = document.createElement("div");
    wrap.innerHTML = `<div class="group-h"><span>${esc(title)}</span><span>${esc(extra)}</span></div>`;
    const list = document.createElement("div");
    list.className = "list";
    for (const item of items) {
      const idx = flat.length;
      flat.push(item);
      list.appendChild(resultRow(item, idx === state.cursor));
    }
    wrap.appendChild(list);
    root.appendChild(wrap);
  }
  state._flat = flat;
  if (state.cursor >= flat.length) state.cursor = 0;
}

function resultRow(item, active) {
  const wrap = document.createElement("div");
  wrap.className = "row" + (active ? " active" : "");
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
    <div class="meta">${esc([item.mpn, item.package, item.brand, item.category].filter(Boolean).join(" · "))}</div>
    <span class="badges">
      ${loc ? `<span class="badge stock">${esc(locCell(loc))}</span>` : ""}
      ${low ? `<span class="badge low">low</span>` : ""}
      ${item.source && item.source !== "stock" ? `<span class="badge">${esc(item.source)}</span>` : ""}
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

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

async function selectPart(item) {
  state.selected = item;
  const stock = item.stock || findStockMatch(item);
  if (stock) {
    state.selected.stock = stock;
    const loc = primaryLoc(stock);
    if (loc && (state.config?.ui?.locateOnSelect !== false)) {
      locate(loc.row, loc.col);
    }
    state.placeCell = loc ? { row: loc.row, col: loc.col, cell: loc.cell || cellLabel(loc.row, loc.col) } : firstEmpty();
  } else {
    state.placeCell = firstEmpty();
  }
  openSheet();
}

function findStockMatch(item) {
  return state.inventory.find((it) =>
    (item.id && it.id === item.id) ||
    (item.mpn && it.mpn && it.mpn === item.mpn) ||
    (it.name === item.name && (it.package || "") === (item.package || ""))
  ) || null;
}

function openSheet() {
  const item = state.selected;
  if (!item) return;
  const sheet = $("#sheet");
  const card = $("#sheetCard");
  const stock = item.stock;
  const loc = stock ? primaryLoc(stock) : null;
  const qty = loc ? loc.qty : 0;
  const cell = state.placeCell;
  card.innerHTML = `
    <div class="sheet-top">
      <div>
        <div class="cat">${esc(item.category || "part")}</div>
        <h2>${esc(item.name)}</h2>
        <div class="meta" style="color:var(--muted);margin-top:4px;font-size:13px">
          ${esc([item.mpn, item.package, item.brand, item.sku].filter(Boolean).join(" · "))}
        </div>
      </div>
      <button class="close" id="sheetClose" aria-label="Close">✕</button>
    </div>
    <div class="stepper">
      <button id="dec">−</button>
      <div class="num"><input id="qty" type="number" min="0" inputmode="numeric" value="${qty}" /></div>
      <button id="inc">+</button>
    </div>
    <div class="nudge-row">
      <button type="button" data-d="-5">−5</button>
      <button type="button" data-d="-1">−1</button>
      <button type="button" data-d="1">+1</button>
      <button type="button" data-d="5">+5</button>
    </div>
    <div class="actions">
      <button class="solid" id="btnLocate">${cell ? "Light " + cell.cell : "No empty bin"}</button>
      <button class="ghost" id="btnPut">${stock ? "Done" : "Put in " + (cell ? cell.cell : "…")}</button>
      ${stock ? `<button class="danger" id="btnEmpty">Empty</button>` : ""}
    </div>
    <div class="mini-grid" id="mini"></div>
    <div class="help">${stock ? "Hold +/− to count faster. Type a number to jump." : "Pick a bin, set how many you put in, done."}</div>
  `;
  sheet.hidden = false;
  sheet.classList.add("is-open");
  $(".app")?.setAttribute("inert", "");
  $("#sheetClose").onclick = (e) => { e.stopPropagation(); closeSheet(); };
  sheet.onclick = (e) => {
    if (e.target === sheet) {
      e.preventDefault();
      e.stopPropagation();
      closeSheet();
    }
  };
  $("#sheetCard").onclick = (e) => e.stopPropagation();
  $("#inc").onclick = () => nudge(1);
  $("#dec").onclick = () => nudge(-1);
  holdRepeat($("#inc"), () => nudge(1));
  holdRepeat($("#dec"), () => nudge(-1));
  card.querySelectorAll(".nudge-row [data-d]").forEach((b) => {
    b.onclick = () => nudge(Number(b.dataset.d));
  });
  $("#btnLocate").onclick = () => cell && locate(cell.row, cell.col);
  $("#btnPut").onclick = () => { if (stock) closeSheet(); else commitQty(); };
  const empty = $("#btnEmpty");
  if (empty) empty.onclick = () => clearCell();
  $("#qty").addEventListener("change", () => commitQty(true));
  paintMini();
  try { navigator.vibrate?.(8); } catch {}
}

function paintMini() {
  const mini = $("#mini");
  if (!mini || !state.config) return;
  const { rows, cols } = state.config;
  mini.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
  mini.innerHTML = "";
  const occ = occupiedMap();
  const sel = state.placeCell;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const key = `${r},${c}`;
      const hit = occ.get(key);
      const b = document.createElement("button");
      b.textContent = cellLabel(r, c);
      if (hit) b.classList.add("full");
      else b.classList.add("empty");
      if (sel && sel.row === r && sel.col === c) b.classList.add("pick");
      b.title = hit ? `${hit.item.name} × ${hit.loc.qty}` : "empty";
      b.onclick = async () => {
        const stock = state.selected?.stock;
        if (stock && primaryLoc(stock) && (primaryLoc(stock).row !== r || primaryLoc(stock).col !== c)) {
          try {
            await api.send("/api/stock/move", "POST", {
              from: cellLabel(primaryLoc(stock).row, primaryLoc(stock).col),
              to: cellLabel(r, c),
            });
            touchDirty();
            await refreshInventory();
            state.selected.stock = findStockMatch(state.selected);
          } catch (e) { toast(e.message); }
        }
        state.placeCell = { row: r, col: c, cell: cellLabel(r, c) };
        locate(r, c);
        paintMini();
        const put = $("#btnPut");
        if (put && !state.selected?.stock) put.textContent = "Put in " + state.placeCell.cell;
      };
      mini.appendChild(b);
    }
  }
}

function holdRepeat(el, fn) {
  let t, i;
  const start = (ev) => {
    ev.preventDefault();
    fn();
    t = setTimeout(() => { i = setInterval(fn, 70); }, 320);
  };
  const stop = () => { clearTimeout(t); clearInterval(i); };
  el.addEventListener("pointerdown", start);
  el.addEventListener("pointerup", stop);
  el.addEventListener("pointerleave", stop);
}

async function quickAdjust(item, delta) {
  const loc = primaryLoc(item.stock || item);
  if (!loc) {
    selectPart(item);
    return;
  }
  const cell = locCell(loc);
  const next = Math.max(0, (loc.qty || 0) + delta);
  applyLocalQty(cell, next);
  state.lastUndo = { cell, delta: -delta };
  locate(loc.row, loc.col);
  touchDirty();
  try {
    const res = await api.send("/api/stock/adjust", "POST", { cell, delta });
    applyLocalQty(cell, res.qty);
  } catch (e) {
    toast(e.message);
    refreshInventory().catch(() => {});
  }
}

async function nudge(delta) {
  const input = $("#qty");
  if (!input) return;
  const next = Math.max(0, (parseInt(input.value, 10) || 0) + delta);
  input.value = String(next);
  const stock = state.selected?.stock;
  const cell = state.placeCell;
  if (stock && cell) {
    applyLocalQty(cell.cell, next);
    state.lastUndo = { cell: cell.cell, delta: -delta };
    touchDirty();
    try {
      const res = await api.send("/api/stock/adjust", "POST", { cell: cell.cell, delta });
      applyLocalQty(cell.cell, res.qty);
    } catch (e) {
      toast(e.message);
      refreshInventory().catch(() => {});
    }
  } else if (!stock && cell && next > 0) {
    await commitQty(true);
  }
}

async function commitQty(fromInput) {
  const cell = state.placeCell;
  if (!cell) { toast("No bin selected"); return; }
  const qty = Math.max(0, parseInt($("#qty").value, 10) || 0);
  const item = state.selected;
  try {
    if (item.stock && findStockMatch(item)) {
      await api.send("/api/stock/set", "POST", { cell: cell.cell, qty });
    } else {
      await api.send("/api/stock/place", "POST", {
        name: item.name,
        mpn: item.mpn || "",
        sku: item.sku || "",
        category: item.category || "other",
        package: item.package || "",
        brand: item.brand || "",
        source: item.source || "custom",
        color: item.color || colorFor(item.category),
        cell: cell.cell,
        qty,
      });
    }
    touchDirty();
    await refreshInventory();
    state.selected.stock = findStockMatch(item);
    if (fromInput) {
      const input = $("#qty");
      if (input) input.value = String(qty);
      paintMini();
      return;
    }
    toast(`${item.name} → ${cell.cell}`);
    openSheet();
  } catch (e) { toast(e.message); }
}

async function clearCell() {
  const cell = state.placeCell;
  if (!cell) return;
  try {
    await api.send("/api/stock/clear", "POST", { cell: cell.cell });
    touchDirty();
    await refreshInventory();
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

function locate(row, col) {
  const cell = cellLabel(row, col);
  fetch("/api/locate?cell=" + encodeURIComponent(cell), { cache: "no-store" }).catch(() => {});
  if (state.view === "rack") renderGrid(cell);
}

function renderGrid(lit) {
  const g = $("#grid");
  const cfg = state.config;
  if (!cfg) return;
  $("#rackTitle").textContent = `${cfg.cols} × ${cfg.rows}`;
  g.style.gridTemplateColumns = `repeat(${cfg.cols}, minmax(72px, 1fr))`;
  g.innerHTML = "";
  const occ = occupiedMap();
  const walk = state._walkCell;
  for (let r = 0; r < cfg.rows; r++) {
    for (let c = 0; c < cfg.cols; c++) {
      const lab = cellLabel(r, c);
      const hit = occ.get(`${r},${c}`);
      const b = document.createElement("button");
      b.className = "cell" + (hit ? "" : " empty") + ((lit === lab || walk === lab) ? " on" : "");
      b.innerHTML = `
        <div class="lab">${lab}</div>
        <div>
          <div class="cn">${hit ? esc(hit.item.name) : ""}</div>
          <div class="cq">${hit ? hit.loc.qty : ""}</div>
        </div>
        <span class="wash" style="background:${hit ? (hit.item.color || colorFor(hit.item.category)) : "transparent"}"></span>`;
      b.onclick = () => {
        if (hit) selectPart({ ...hit.item, stock: hit.item, color: hit.item.color });
        else {
          state.placeCell = { row: r, col: c, cell: lab };
          locate(r, c);
          setView("find");
          $("#q").focus();
          toast("Assign a part to " + lab);
        }
      };
      g.appendChild(b);
    }
  }
}

function renderSettings() {
  const cfg = state.config;
  if (!cfg) return;
  const root = $("#settings");
  root.innerHTML = `
    <div class="card">
      <h3>Rack</h3>
      <div class="fields">
        ${field("rackName", "Name", cfg.rackName, "text")}
        ${field("rows", "Rows", cfg.rows, "number")}
        ${field("cols", "Columns", cfg.cols, "number")}
      </div>
      <div class="row-btns" style="margin-top:12px">
        <button class="ghost" data-preset="6,6">6×6 · 36 bins</button>
        <button class="ghost" data-preset="5,6">6×5 · 30 bins</button>
        <button class="ghost" data-preset="8,8">8×8 · 64 bins</button>
      </div>
      <p class="help">Labels are A1 at the top-left as you look at the rack. Grow the grid anytime — extra bins appear empty. LED count follows the bin count unless you override it.</p>
    </div>
    <div class="card">
      <h3>LED wiring</h3>
      <div class="fields">
        ${select("origin", "LED 0 corner", cfg.wiring.origin, [
          ["top-left","Top left"],["top-right","Top right"],["bottom-left","Bottom left"],["bottom-right","Bottom right"]])}
        ${select("axis", "Then run", cfg.wiring.rowFirst ? "row" : "col", [["row","Along the row"],["col","Along the column"]])}
        ${check("serpentine", "Serpentine (snake)", cfg.wiring.serpentine)}
        ${field("offset", "LED index offset", cfg.wiring.offset, "number")}
        ${field("ledCount", "LED count", cfg.leds.count, "number")}
        ${field("pin", "Data pin (GPIO)", cfg.leds.pin, "number")}
        ${select("order", "Color order", cfg.leds.order, ["GRB","RGB","BRG","RBG","GBR","BGR"].map((x)=>[x,x]))}
      </div>
      <div class="row-btns" style="margin-top:12px">
        <button class="solid" id="btnCorners">Light corners</button>
        <button class="ghost" id="btnWalk">Walk bins</button>
        <button class="ghost" id="btnMap">Tap-to-map LED ${state.mapLed}</button>
        <button class="ghost" id="btnClearMap">Clear overrides</button>
      </div>
      <p class="help">Corners: A1 red, last column green, last row blue, opposite white. If that matches the physical rack, you’re calibrated. Tap-to-map lights one LED at a time — tap the bin that actually lit.</p>
    </div>
    <div class="card">
      <h3>Look</h3>
      <div class="fields">
        ${field("brightness", "Brightness", cfg.leds.brightness, "number")}
        ${field("idleBrightness", "Idle brightness", cfg.leds.idleBrightness, "number")}
        ${field("locateColor", "Locate color", cfg.leds.locateColor, "color")}
        ${select("idleAnim", "Idle animation", cfg.leds.idleAnim, [
          ["off","Off"],["dim-stock","Dim stock"],["breathe","Breathe"],["sparkle","Sparkle"],["heatmap","Heatmap"],["rainbow","Rainbow"]])}
        ${select("startupAnim", "Startup", cfg.leds.startupAnim, [
          ["none","None"],["cascade","Cascade"],["spiral","Spiral"],["lightning","Lightning"]])}
        ${check("locateOnSelect", "Light bin on select", cfg.ui.locateOnSelect)}
        ${check("remoteSearch", "Live JLCPCB / LCSC search", cfg.ui.remoteSearch)}
        ${field("lowStockQty", "Low-stock at", cfg.ui.lowStockQty, "number")}
      </div>
      <div class="row-btns" style="margin-top:12px">
        <button class="ghost" id="btnPreview">Replay startup</button>
        <button class="ghost" id="btnIdle2">Idle</button>
        <button class="ghost" id="btnOff">Lights off</button>
      </div>
    </div>
    <div class="card">
      <h3>Firmware</h3>
      <p class="help" id="otaSummary"></p>
      <div class="bar" id="otaMiniBarWrap" hidden><i id="otaMiniBar"></i></div>
      <div class="row-btns" style="margin-top:12px">
        <button class="ghost" id="btnOtaCheck">Check GitHub</button>
        <button class="solid" id="btnOtaInstall" hidden>Install update</button>
      </div>
    </div>
    <div class="card">
      <h3>Data</h3>
      <div class="row-btns">
        <a class="ghost" href="/api.md" style="text-decoration:none">API docs</a>
        <a class="ghost" href="/api" style="text-decoration:none">API index</a>
        <a class="ghost" href="/api/backup" style="text-decoration:none">Download backup</a>
        <label class="ghost">Restore<input id="restore" type="file" accept="application/json" hidden /></label>
        <button class="danger" id="btnReset">Factory reset</button>
      </div>
      <p class="help">Firmware ${esc(state.status.fw || "—")} (${esc(state.status.git || "dev")}) · heap ${state.status.heap || "—"} · ${esc(state.status.ssid || "")}</p>
    </div>
  `;
  root.querySelectorAll("[data-k]").forEach((el) => {
    el.addEventListener("change", () => patchFromSettings());
  });
  root.querySelectorAll("[data-preset]").forEach((el) => {
    el.addEventListener("click", async () => {
      const [rows, cols] = el.dataset.preset.split(",").map(Number);
      $("#settings [data-k='rows']").value = String(rows);
      $("#settings [data-k='cols']").value = String(cols);
      $("#settings [data-k='ledCount']").value = String(rows * cols);
      await patchFromSettings();
    });
  });
  $("#btnCorners").onclick = () => api.send("/api/leds", "POST", { mode: "corners" });
  $("#btnWalk").onclick = () => api.send("/api/leds", "POST", { mode: "walk" });
  $("#btnMap").onclick = () => startMap();
  $("#btnClearMap").onclick = async () => {
    await api.send("/api/config", "PUT", { overrides: {} });
    await refreshAll();
    toast("Overrides cleared");
  };
  $("#btnPreview").onclick = () => api.send("/api/leds", "POST", { mode: "startup" });
  $("#btnIdle2").onclick = () => api.send("/api/leds", "POST", { mode: "idle" });
  $("#btnOff").onclick = () => api.send("/api/leds", "POST", { mode: "off" });
  $("#btnReset").onclick = async () => {
    if (!confirm("Erase inventory and settings?")) return;
    await api.send("/api/factory-reset", "POST", {});
    await refreshAll();
  };
  $("#btnOtaCheck").onclick = () => checkOta(true);
  $("#btnOtaInstall").onclick = () => installOta();
  paintOta();
  if (!state.ota) checkOta(false);

  $("#restore").onchange = async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    const data = JSON.parse(await f.text());
    await api.send("/api/restore", "POST", data);
    await refreshAll();
    toast("Restored");
  };
}

function field(key, label, value, type) {
  return `<div class="field"><label>${label}</label><input data-k="${key}" type="${type}" value="${esc(value)}" ${type === "number" ? "step=1" : ""} /></div>`;
}
function select(key, label, value, opts) {
  return `<div class="field"><label>${label}</label><select data-k="${key}">${
    opts.map(([v, l]) => `<option value="${v}" ${String(v)===String(value)?"selected":""}>${l}</option>`).join("")
  }</select></div>`;
}
function check(key, label, value) {
  return `<div class="field"><label>${label}</label><label class="check"><input data-k="${key}" type="checkbox" ${value ? "checked" : ""} /> enabled</label></div>`;
}

async function patchFromSettings() {
  const g = (k) => $("#settings [data-k='" + k + "']");
  const num = (k) => Number(g(k).value);
  const oldCells = (state.config?.rows || 0) * (state.config?.cols || 0);
  if (g("ledCount") && num("ledCount") === oldCells) {
    g("ledCount").value = String(num("rows") * num("cols"));
  }
  const payload = {
    rackName: g("rackName").value,
    rows: num("rows"),
    cols: num("cols"),
    leds: {
      pin: num("pin"),
      count: num("ledCount"),
      order: g("order").value,
      brightness: num("brightness"),
      idleBrightness: num("idleBrightness"),
      locateColor: g("locateColor").value,
      idleAnim: g("idleAnim").value,
      startupAnim: g("startupAnim").value,
    },
    wiring: {
      origin: g("origin").value,
      rowFirst: g("axis").value === "row",
      serpentine: g("serpentine").checked,
      offset: num("offset"),
    },
    ui: {
      locateOnSelect: g("locateOnSelect").checked,
      remoteSearch: g("remoteSearch").checked,
      lowStockQty: num("lowStockQty"),
    },
  };
  state.config = await api.send("/api/config", "PUT", payload);
  $("#rackName").textContent = state.config.rackName;
  api.send("/api/leds", "POST", { mode: "corners" }).catch(() => {});
}

async function startMap() {
  state.mapping = true;
  state.mapLed = 0;
  await api.send("/api/leds", "POST", { mode: "identify", index: 0 });
  toast("LED 0 is on — tap the bin that lit, in Grid");
  setView("rack");
  const handler = async (e) => {
    const cell = e.target.closest(".cell");
    if (!cell) return;
    const lab = cell.querySelector(".lab")?.textContent;
    if (!lab) return;
    e.stopPropagation();
    e.preventDefault();
    const cfg = state.config;
    let row = 0, col = 0;
    // parse label
    const m = lab.match(/^([A-Z]+)(\d+)$/);
    if (!m) return;
    col = m[1].split("").reduce((a, ch) => a * 26 + (ch.charCodeAt(0) - 64), 0) - 1;
    row = Number(m[2]) - 1;
    const idx = row * cfg.cols + col;
    const overrides = { ...(cfg.overrides || {}) };
    overrides[String(idx)] = state.mapLed;
    state.config = await api.send("/api/config", "PUT", { overrides });
    state.mapLed += 1;
    if (state.mapLed >= cfg.leds.count) {
      state.mapping = false;
      toast("Mapping complete");
      api.send("/api/leds", "POST", { mode: "idle" });
      $("#grid").removeEventListener("click", handler, true);
      return;
    }
    await api.send("/api/leds", "POST", { mode: "identify", index: state.mapLed });
    toast("LED " + state.mapLed + " — tap the bin that lit");
  };
  $("#grid").addEventListener("click", handler, true);
}

let remoteTimer = 0;
function onQuery() {
  state.q = $("#q").value;
  state.cursor = 0;
  const clear = $("#clearQ");
  if (clear) clear.hidden = !state.q;
  renderResults();
  clearTimeout(remoteTimer);
  const q = state.q.trim();
  if (q.length < 2 || state.config?.ui?.remoteSearch === false) return;
  remoteTimer = setTimeout(() => fetchRemote(q), 220);
}

async function fetchRemote(q) {
  state.remoteBusy = true;
  renderResults();
  try {
    const data = await api.get("/api/catalog/remote?q=" + encodeURIComponent(q));
    if (state.q.trim() !== q) return;
    state.remote = data.items || [];
    state.remoteQ = q;
  } catch {
    if (state.q.trim() === q) state.remote = [];
  } finally {
    state.remoteBusy = false;
    renderResults();
  }
}

function paintOta() {
  const ota = state.ota;
  const summary = $("#otaSummary");
  const install = $("#btnOtaInstall");
  const miniWrap = $("#otaMiniBarWrap");
  const mini = $("#otaMiniBar");
  const veil = $("#otaVeil");
  const cur = `${state.status.fw || "—"} · ${state.status.git || "dev"}`;
  const repo = (ota && ota.repo) || state.status.repo || "neooriginal/ElectronicRack";
  if (summary) {
    if (!ota) {
      summary.textContent = `Running ${cur}. Source ${repo}.`;
    } else if (ota.available) {
      summary.textContent = `Running ${cur}. ${ota.latest?.version || ""} (${ota.latest?.git || ""}) is on GitHub.`;
    } else if (ota.state === "error") {
      summary.textContent = `Running ${cur}. ${ota.message || "check failed"}`;
    } else {
      summary.textContent = `Running ${cur}. ${ota.message || "up to date"} · ${repo}`;
    }
  }
  if (install) install.hidden = !(ota && ota.available) || ota.state === "updating";
  const updating = ota && (ota.state === "updating" || ota.state === "success");
  if (miniWrap) miniWrap.hidden = !updating;
  if (mini && ota) mini.style.width = `${ota.progress || 0}%`;
  paintSys();
  if (veil) {
    veil.hidden = !updating;
    if (updating) {
      $("#otaTitle").textContent = ota.state === "success" ? "Rebooting" : "Updating";
      $("#otaMsg").textContent = (ota.phase ? ota.phase + " · " : "") + (ota.message || "pulling from GitHub");
      $("#otaBar").style.width = `${ota.progress || 0}%`;
      $("#otaPct").textContent = `${ota.progress || 0}%`;
    }
  }
}

async function checkOta(toastOn) {
  try {
    if (toastOn) await api.send("/api/update/check", "POST", {});
    const start = Date.now();
    while (Date.now() - start < 15000) {
      state.ota = await api.get("/api/update");
      paintOta();
      if (!toastOn) break;
      if (state.ota.state === "checking" || (state.ota.state === "idle" && Date.now() - start < 1200)) {
        await new Promise((r) => setTimeout(r, 350));
        continue;
      }
      break;
    }
    if (toastOn && state.ota?.available) toast("Update " + (state.ota.latest?.git || "") + " ready");
    else if (toastOn && state.ota?.state === "error") toast(state.ota.message || "check failed");
    else if (toastOn) toast(state.ota?.message || "up to date");
  } catch (e) {
    if (toastOn) toast(e.message);
  }
  paintOta();
}

async function installOta() {
  if (!confirm("Install the GitHub build? The rack will reboot.")) return;
  try {
    await api.send("/api/update/install", "POST", {});
    const started = Date.now();
    while (Date.now() - started < 180000) {
      try {
        state.ota = await api.get("/api/update");
      } catch {
        toast("Device rebooting…");
        break;
      }
      paintOta();
      if (state.ota.state === "error") {
        toast(state.ota.message || "update failed");
        break;
      }
      if (state.ota.state === "success") break;
      await new Promise((r) => setTimeout(r, 800));
    }
  } catch (e) {
    toast(e.message);
  }
}

function connectWs() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  let ws;
  const open = () => {
    ws = new WebSocket(proto + "://" + location.host + "/ws");
    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.t === "status") {
        state.status = msg;
        paintSys();
      } else if (msg.t === "dirty") {
        if (Date.now() < state.ignoreDirtyUntil) return;
        if (msg.what === "inventory") refreshInventory().catch(() => {});
        else refreshAll().catch(() => {});
      } else if (msg.t === "walk") {
        state._walkCell = msg.cell;
        if (state.view === "rack") renderGrid(msg.cell);
      } else if (msg.t === "ota") {
        state.ota = msg;
        paintOta();
      }
    };
    ws.onclose = () => setTimeout(open, 1500);
  };
  open();
}

function bind() {
  $$(".tab").forEach((t) => t.addEventListener("click", () => setView(t.dataset.view)));
  $("#q").addEventListener("input", onQuery);
  $("#q").addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") { e.preventDefault(); state.cursor++; renderResults(); }
    if (e.key === "ArrowUp") { e.preventDefault(); state.cursor = Math.max(0, state.cursor - 1); renderResults(); }
    if (e.key === "Enter") {
      e.preventDefault();
      const item = (state._flat || [])[state.cursor] || makeCustom(state.q);
      if (item) selectPart(item);
    }
  });
  $("#clearQ")?.addEventListener("click", () => {
    $("#q").value = "";
    onQuery();
    $("#q").focus();
  });
  $("#btnIdle")?.addEventListener("click", () => api.send("/api/leds", "POST", { mode: "idle" }));
  document.addEventListener("keydown", (e) => {
    const typing = ["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement?.tagName);
    if (e.key === "/" && !typing) { e.preventDefault(); setView("find"); $("#q").focus(); $("#q").select(); }
    if (e.key === "Escape") closeSheet();
    if (!typing && (e.key === "+" || e.key === "=")) nudge(1);
    if (!typing && e.key === "-") nudge(-1);
    if (!typing && e.key === "z" && (e.metaKey || e.ctrlKey) && state.lastUndo) {
      api.send("/api/stock/adjust", "POST", state.lastUndo).then(refreshAll);
      state.lastUndo = null;
    }
  });
}

async function boot() {
  bind();
  renderChips();
  try {
    state.named = await loadNamedParts();
  } catch { state.named = []; }
  try {
    await refreshAll();
  } catch (e) {
    $("#sysText").textContent = "API offline";
    toast("Firmware API not reachable — start the device or ./scripts/dev_server.py");
  }
  renderChips();
  renderResults();
  connectWs();
  $("#q").focus();
}

boot();
