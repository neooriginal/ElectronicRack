// Local catalog: electronics-aware parser + generated passives + named parts.
// Remote JLCPCB/LCSC results are merged by the app after this returns.

export const CATEGORIES = [
  "resistor", "capacitor", "inductor", "diode", "led", "transistor",
  "ic", "mcu", "board", "sensor", "connector", "module", "display",
  "power", "tool", "chemical", "wire", "mechanical", "other",
];

export const CATEGORY_COLOR = {
  resistor: "#E6A15C",
  capacitor: "#5B9DFF",
  inductor: "#7C6BFF",
  diode: "#F0C14B",
  led: "#FF6B8A",
  transistor: "#4FD1A5",
  ic: "#C084FC",
  mcu: "#A78BFA",
  board: "#22D3EE",
  sensor: "#34D399",
  connector: "#FB7185",
  module: "#67E8F9",
  display: "#93C5FD",
  power: "#F87171",
  tool: "#F5D0A9",
  chemical: "#FDE68A",
  wire: "#FBBF24",
  mechanical: "#A8A29E",
  other: "#E6A15C",
};

const E12 = [10, 12, 15, 18, 22, 27, 33, 39, 47, 56, 68, 82];
const E24 = [10, 11, 12, 13, 15, 16, 18, 20, 22, 24, 27, 30, 33, 36, 39, 43, 47, 51, 56, 62, 68, 75, 82, 91];
const E96 = [100, 102, 105, 107, 110, 113, 115, 118, 121, 124, 127, 130, 133, 137, 140, 143, 147, 150, 154, 158, 162, 165, 169, 174, 178, 182, 187, 191, 196, 200, 205, 210, 215, 221, 226, 232, 237, 243, 249, 255, 261, 267, 274, 280, 287, 294, 301, 309, 316, 324, 332, 340, 348, 357, 365, 374, 383, 392, 402, 412, 422, 432, 442, 453, 464, 475, 487, 499, 511, 523, 536, 549, 562, 576, 590, 604, 619, 634, 649, 665, 681, 698, 715, 732, 750, 768, 787, 806, 825, 845, 866, 887, 909, 931, 953, 976];

const R_PACKAGES = ["THT 1/4W", "THT 1/8W", "THT 1/2W", "0402", "0603", "0805", "1206", "1210"];
const C_PACKAGES = ["0402", "0603", "0805", "1206", "THT", "electrolytic", "tantalum"];
const L_PACKAGES = ["0603", "0805", "1206", "THT"];

const PACK_RE = /\b(0201|0402|0603|0805|1206|1210|2010|2512|sot-?23(?:-6)?|soic-?8|soic-?14|ssop|tssop|qfn|lqfp-?\d*|dip-?\d*|to-?220|to-?92|tht|axial|radial|electrolytic|tantalum|smd)\b/i;
const TOL_RE = /\b(0\.1|0\.5|1|2|5|10)\s*%/;
const PWR_RE = /\b(1\/8|1\/4|1\/2|1|2)\s*w\b/i;

let namedCache = null;

export async function loadNamedParts() {
  if (namedCache) return namedCache;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch("/named-parts.json", { cache: "force-cache", signal: ctrl.signal });
    namedCache = res.ok ? await res.json() : [];
  } catch {
    namedCache = [];
  } finally {
    clearTimeout(timer);
  }
  return namedCache;
}

export function colorFor(category) {
  return CATEGORY_COLOR[category] || CATEGORY_COLOR.other;
}

export function formatOhm(v) {
  if (v >= 1e6) return trimNum(v / 1e6) + "MΩ";
  if (v >= 1e3) return trimNum(v / 1e3) + "kΩ";
  if (v >= 1) return trimNum(v) + "Ω";
  return trimNum(v * 1e3) + "mΩ";
}

export function formatFarad(v) {
  if (v >= 1e-3) return trimNum(v * 1e3) + "mF";
  if (v >= 1e-6) return trimNum(v * 1e6) + "µF";
  if (v >= 1e-9) return trimNum(v * 1e9) + "nF";
  return trimNum(v * 1e12) + "pF";
}

export function formatHenry(v) {
  if (v >= 1) return trimNum(v) + "H";
  if (v >= 1e-3) return trimNum(v * 1e3) + "mH";
  if (v >= 1e-6) return trimNum(v * 1e6) + "µH";
  return trimNum(v * 1e9) + "nH";
}

function trimNum(n) {
  const s = n.toPrecision(4);
  return String(Number(s));
}

function norm(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[µμ]/g, "u")
    .replace(/Ω/g, "ohm")
    .replace(/[^a-z0-9.%+/]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** 4k7 / 4K7 / 4.7k / 10R / 100n / 4.7u / 10uf */
export function parseEngineering(raw) {
  const s = String(raw).trim().replace(/,/g, "");
  const compact = s.replace(/\s+/g, "");
  const infix = compact.match(/^(\d+)([kKmMuUnNpP])(\d+)([ΩohmrfFhH]*)$/i);
  if (infix) {
    const a = Number(infix[1]);
    const b = infix[3];
    const mul = prefixMul(infix[2]);
    const unit = (infix[4] || infix[2]).toLowerCase();
    return { value: (a + Number("0." + b)) * mul, unit: unitKind(unit, infix[2]) };
  }
  const m = compact.match(/^(\d*\.?\d+)\s*([kKmMuUnNpP])?\s*(ohm|ohms|Ω|r|f|farad|h|henry)?$/i);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  const mul = prefixMul(m[2] || "");
  const unit = (m[3] || m[2] || "").toLowerCase();
  return { value: n * mul, unit: unitKind(unit, m[2]) };
}

function prefixMul(p) {
  switch (String(p).toLowerCase()) {
    case "p": return 1e-12;
    case "n": return 1e-9;
    case "u": return 1e-6;
    case "m": return 1e-3;
    case "k": return 1e3;
    default: return 1;
  }
}

function unitKind(unit, prefix) {
  const u = String(unit || "").toLowerCase();
  if (u.includes("ohm") || u === "r" || u === "ω") return "R";
  if (u.includes("farad") || u === "f") return "C";
  if (u.includes("henry") || u === "h") return "L";
  const p = String(prefix || "").toLowerCase();
  if (p === "k") return "R";
  return "";
}

function parseSmdCode(token) {
  const t = token.trim();
  if (/^\d{3}$/.test(t)) {
    const sig = Number(t.slice(0, 2));
    const exp = Number(t[2]);
    return { kind: "maybe", r: sig * Math.pow(10, exp), c: sig * Math.pow(10, exp) * 1e-12 };
  }
  if (/^\d{4}$/.test(t)) {
    const sig = Number(t.slice(0, 3));
    const exp = Number(t[3]);
    return { kind: "R", r: sig * Math.pow(10, exp) };
  }
  return null;
}

export function parseQuery(q) {
  const raw = String(q || "").trim();
  const n = norm(raw);
  const tokens = n.split(" ").filter(Boolean);
  const out = {
    raw, norm: n, tokens,
    category: "",
    pkg: "",
    tol: "",
    power: "",
    value: null,
    unit: "",
  };

  for (const cat of CATEGORIES) {
    if (tokens.includes(cat) || tokens.includes(cat + "s")) {
      out.category = cat;
      break;
    }
  }
  const aliases = {
    res: "resistor", cap: "capacitor", caps: "capacitor", mcu: "mcu",
    uc: "mcu", solder: "chemical", sodder: "chemical", flux: "chemical",
    pi: "board", raspberry: "board", arduino: "board", esp: "mcu",
    header: "connector", jumper: "wire",
  };
  if (!out.category) {
    for (const t of tokens) {
      if (aliases[t]) { out.category = aliases[t]; break; }
    }
  }

  const pack = raw.match(PACK_RE);
  if (pack) out.pkg = pack[1].toUpperCase().replace("THT", "THT").replace("ELECTROLYTIC", "electrolytic");
  const tol = raw.match(TOL_RE);
  if (tol) out.tol = tol[1] + "%";
  const pwr = raw.match(PWR_RE);
  if (pwr) out.power = pwr[1].replace("1/4", "1/4").replace("1/8", "1/8") + "W";

  for (const t of tokens) {
    const eng = parseEngineering(t);
    if (eng && eng.value > 0) {
      out.value = eng.value;
      out.unit = eng.unit;
      break;
    }
    const smd = parseSmdCode(t);
    if (smd && !out.value) {
      if (out.category === "capacitor") { out.value = smd.c; out.unit = "C"; }
      else if (out.category === "resistor" || smd.kind === "R") { out.value = smd.r; out.unit = "R"; }
      else { out.value = smd.r; out.unit = "R"; out._smdAmbiguous = smd; }
    }
  }
  return out;
}

function part(p) {
  return {
    id: p.id || "",
    name: p.name,
    mpn: p.mpn || "",
    sku: p.sku || "",
    category: p.category || "other",
    package: p.package || p.pkg || "",
    brand: p.brand || "",
    notes: p.notes || "",
    source: p.source || "local",
    color: p.color || colorFor(p.category || "other"),
    stock: p.stock || null,
    score: p.score || 0,
  };
}

function resistorName(ohms, tol, pkg) {
  return `${formatOhm(ohms)} ${tol} ${pkg}`.replace(/\s+/g, " ").trim();
}

function synthesizePassives(parsed, limit = 24) {
  const out = [];
  const wantR = !parsed.unit || parsed.unit === "R" || parsed.category === "resistor";
  const wantC = parsed.unit === "C" || parsed.category === "capacitor";
  const wantL = parsed.unit === "L" || parsed.category === "inductor";

  if (parsed.value && wantR && parsed.unit !== "C" && parsed.unit !== "L") {
    const tols = parsed.tol ? [parsed.tol] : ["1%", "5%"];
    let pkgs = R_PACKAGES;
    if (parsed.pkg) pkgs = [normalizePkg(parsed.pkg, parsed.power)];
    else if (parsed.power) pkgs = R_PACKAGES.filter((p) => p.includes(parsed.power) || p.includes("THT"));
    for (const pkg of pkgs) {
      for (const tol of tols) {
        out.push(part({
          name: resistorName(parsed.value, tol, pkg),
          category: "resistor",
          package: pkg,
          sku: `R-${formatOhm(parsed.value).replace("Ω", "")}-${tol}-${pkg}`.replace(/\s+/g, ""),
          source: "generated",
        }));
      }
    }
  }

  if (parsed.value && wantC) {
    const pkgs = parsed.pkg ? [parsed.pkg] : ["0603", "0805", "THT", "electrolytic"];
    const volts = parsed.value >= 1e-6 ? ["16V", "25V", "50V"] : ["50V", "100V"];
    for (const pkg of pkgs.slice(0, 3)) {
      for (const v of volts.slice(0, pkg === "electrolytic" ? 3 : 1)) {
        out.push(part({
          name: `${formatFarad(parsed.value)} ${v} ${pkg}`,
          category: "capacitor",
          package: pkg,
          sku: `C-${formatFarad(parsed.value)}-${v}-${pkg}`.replace(/\s+/g, ""),
          source: "generated",
        }));
      }
    }
  }

  if (parsed.value && wantL) {
    const pkgs = parsed.pkg ? [parsed.pkg] : L_PACKAGES;
    for (const pkg of pkgs.slice(0, 3)) {
      out.push(part({
        name: `${formatHenry(parsed.value)} ${pkg}`,
        category: "inductor",
        package: pkg,
        source: "generated",
      }));
    }
  }

  if (!parsed.value && parsed.category === "resistor") {
    const commons = [10, 22, 47, 100, 220, 330, 470, 1e3, 2.2e3, 4.7e3, 10e3, 22e3, 47e3, 100e3, 1e6];
    for (const v of commons) {
      out.push(part({
        name: resistorName(v, "1%", parsed.pkg || "THT 1/4W"),
        category: "resistor",
        package: parsed.pkg || "THT 1/4W",
        source: "generated",
      }));
    }
  }
  if (!parsed.value && parsed.category === "capacitor") {
    const commons = [1e-12, 10e-12, 22e-12, 100e-12, 1e-9, 10e-9, 100e-9, 1e-6, 10e-6, 100e-6];
    for (const v of commons) {
      out.push(part({
        name: `${formatFarad(v)} ${parsed.pkg || "0603"}`,
        category: "capacitor",
        package: parsed.pkg || "0603",
        source: "generated",
      }));
    }
  }

  return out.slice(0, limit);
}

function normalizePkg(pkg, power) {
  const p = String(pkg).toUpperCase();
  if (p === "THT" || p === "AXIAL") return power ? `THT ${power}` : "THT 1/4W";
  return pkg;
}

function scoreText(item, parsed) {
  const hay = norm([item.name, item.mpn, item.sku, item.package, item.brand, item.category, item.notes].join(" "));
  if (!parsed.norm) return 1;
  if (hay === parsed.norm) return 200;
  if (hay.startsWith(parsed.norm)) return 140;
  let s = 0;
  if (hay.includes(parsed.norm)) s += 80;
  for (const t of parsed.tokens) {
    if (t.length < 2) continue;
    if (hay.includes(t)) s += 18;
    else if (t.length > 3 && hay.split(" ").some((w) => w.startsWith(t))) s += 8;
  }
  if (parsed.category && item.category === parsed.category) s += 20;
  if (parsed.pkg && norm(item.package).includes(norm(parsed.pkg))) s += 16;
  return s;
}

export function searchInventory(query, items) {
  const parsed = parseQuery(query);
  const out = [];
  for (const item of items) {
    const total = (item.locs || []).reduce((a, l) => a + (l.qty || 0), 0);
    if (total <= 0 && !(item.locs || []).length) continue;
    const sc = parsed.norm ? scoreText(item, parsed) : 50;
    if (parsed.norm && sc < 18) continue;
    out.push({
      ...part({ ...item, source: "stock", stock: item, color: item.color || colorFor(item.category) }),
      score: sc + 400 + Math.min(40, total),
    });
  }
  out.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  return out;
}

export function searchLocal(query, namedParts) {
  const parsed = parseQuery(query);
  const out = [];
  if (parsed.norm.length >= 1) {
    out.push(...synthesizePassives(parsed));
  }
  for (const n of namedParts || []) {
    const sc = parsed.norm ? scoreText(n, parsed) : (n.popular ? 30 : 0);
    if (parsed.norm && sc < 16) continue;
    if (!parsed.norm && !n.popular) continue;
    out.push(part({ ...n, source: n.source || "named", score: sc + (n.popular ? 10 : 0) }));
  }
  out.sort((a, b) => (b.score || 0) - (a.score || 0) || a.name.localeCompare(b.name));
  const seen = new Set();
  return out.filter((p) => {
    const k = (p.name + "|" + p.package).toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  }).slice(0, 60);
}

export function makeCustom(query) {
  const parsed = parseQuery(query || "");
  return part({
    name: String(query || "").trim(),
    category: parsed.category || "other",
    package: parsed.pkg || "",
    source: "custom",
  });
}

export function nearestE24(ohms) {
  if (!ohms) return null;
  let decade = 1;
  let x = ohms;
  while (x >= 100) { x /= 10; decade *= 10; }
  while (x < 10) { x *= 10; decade /= 10; }
  let best = E24[0], d = Infinity;
  for (const e of E24) {
    const dd = Math.abs(e - x);
    if (dd < d) { d = dd; best = e; }
  }
  return best * decade;
}

export const COMMON_STARTERS = [
  "10k resistor", "100n capacitor", "4.7k", "220Ω", "solder", "flux",
  "ESP32", "Raspberry Pi Pico", "header 2.54", "jumper wire",
];
