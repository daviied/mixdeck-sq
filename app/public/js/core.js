// State store, transport, scales. Everything else builds on this.
export const S = new Map();
export const G = { slot: "A", caps: null, status: {}, sources: {}, link: null, meta: null, selected: "/ch/01", layer: "in", sof: 0, view: "mix", bank: 0 };
const subs = new Map();
const anySubs = new Set();
export const events = new EventTarget();
export const emit = (n, d) => events.dispatchEvent(new CustomEvent(n, { detail: d }));

export const $ = (s, r = document) => r.querySelector(s);
export function el(tag, cls, txt) { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; }
export const store = {
  get(k, d) { try { const v = localStorage.getItem("md-" + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem("md-" + k, JSON.stringify(v)); } catch { /* private window */ } },
};

export function toast(msg, bad) {
  const t = $("#toast"); t.textContent = msg; t.className = "show" + (bad ? " bad" : "");
  clearTimeout(t._h); t._h = setTimeout(() => (t.className = ""), bad ? 4500 : 2200);
}
window.toast = toast;

// ---- subscriptions: a scope groups them, so a rebuilt view drops the old ones ----
export function on(path, fn) {
  let s = subs.get(path); if (!s) subs.set(path, (s = new Set()));
  s.add(fn); return () => s.delete(fn);
}
export function scope() {
  const off = [];
  return {
    on(path, fn, now = true) { off.push(on(path, fn)); if (now) fn(S.get(path)); },
    add(f) { off.push(f); },
    dispose() { off.splice(0).forEach((f) => f()); },
  };
}
export const onAny = (fn) => { anySubs.add(fn); return () => anySubs.delete(fn); };
function notify(p, v) { const s = subs.get(p); if (s) for (const f of s) f(v); for (const f of anySubs) f(p, v); }

// ---- writes: one POST at a time; all pending values go in the next one ----
const queue = new Map(), touched = new Map();
let inflight = false;
async function flush() {
  if (inflight || !queue.size) return;
  inflight = true;
  const sets = [...queue]; queue.clear();
  try { await api("/api/set", { c: G.slot, sets }, true); } catch (e) { toast(e.message, true); }
  inflight = false;
  if (queue.size) flush();
}
export function write(path, v) {
  touched.set(path, performance.now());
  S.set(path, v); notify(path, v);
  queue.set(path, v); flush();
}

// ---- undo: moves on one path within 800 ms count as one step ----
const undoStack = [];
let lastUndo = null;
export function set(path, v) {
  const now = performance.now();
  if (!(lastUndo && lastUndo.path === path && now - lastUndo.t < 800)) {
    lastUndo = { path, old: S.get(path), t: now, slot: G.slot };
    undoStack.push(lastUndo); if (undoStack.length > 200) undoStack.shift();
    emit("undo");
  }
  lastUndo.t = now;
  write(path, v);
}
export function undo() {
  const u = undoStack.pop(); lastUndo = null; emit("undo");
  if (u && u.slot === G.slot && u.old !== undefined) { write(u.path, u.old); toast(`Undo ${u.path}`); }
}
export const canUndo = () => undoStack.length > 0;
export function clearSolos() {
  write("/-action/clearsolo", 1);
  for (let i = 1; i <= 80; i++) {  // not every console acts on the command
    const p = `/-stat/solosw/${String(i).padStart(2, "0")}`;
    if (S.get(p)) write(p, 0);
  }
}

export const ownRecent = (path) => { const t = touched.get(path); return !!t && performance.now() - t < 1500; };

function applyIn(path, v) {
  const t = touched.get(path);
  if (t && performance.now() - t < 500) return;  // our own recent move wins
  if (S.get(path) === v) return;
  S.set(path, v); notify(path, v);
}

export async function api(path, body, quiet) {
  const opt = body === undefined ? {} : { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json", "X-Requested-With": "x32r" } };
  const r = await fetch(path, opt);
  const j = await r.json().catch(() => ({}));
  if (r.status === 401 && path !== "/api/login") { location.reload(); throw new Error("Login required"); }
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
}

// ---- stream ----
export const meters = { b: new Uint8Array(167), at: 0 };
export const rta = { b: new Uint8Array(100), at: 0 };
let es = null;
export function openStream() {
  if (es) es.close();
  es = new EventSource("/api/events?c=" + G.slot);
  const J = (f) => (e) => f(JSON.parse(e.data));
  es.addEventListener("full", J((d) => {
    S.clear(); for (const k in d.values) S.set(k, d.values[k]);
    G.status = d.status; G.sources = d.sources; G.link = d.link;
    G.caps = (d.status[G.slot] || {}).caps || null;
    emit("full");
  }));
  es.addEventListener("d", J((d) => { for (const k in d) applyIn(k, d[k]); }));
  es.addEventListener("status", J((d) => { G.status = d.status; G.link = d.link; G.caps = (d.status[G.slot] || {}).caps || G.caps; emit("status"); }));
  es.addEventListener("sources", J((d) => { const old = G.sources; G.sources = d; emit("sources", old); }));
  es.addEventListener("routing", (e) => window.Router && Router.setState(e.data));
  es.addEventListener("reload", () => { setTimeout(openStream, 150); });
  es.addEventListener("r", (e) => {
    const s = atob(e.data);
    for (let i = 0; i < s.length && i < 100; i++) rta.b[i] = s.charCodeAt(i);
    rta.at = performance.now(); emit("rta");
  });
  es.addEventListener("m", (e) => {
    const s = atob(e.data);
    if (meters.b.length !== s.length) meters.b = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) meters.b[i] = s.charCodeAt(i);
    meters.at = performance.now();
  });
}

// ---- value scales: console value <-> what the user reads ----
export const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
export function f2db(f) { if (f <= 0) return -Infinity; if (f >= .5) return f * 40 - 30; if (f >= .25) return f * 80 - 50; if (f >= .0625) return f * 160 - 70; return f * 480 - 90; }
export function db2f(d) { if (d <= -90) return 0; let f; if (d >= -10) f = (d + 30) / 40; else if (d >= -30) f = (d + 50) / 80; else if (d >= -60) f = (d + 70) / 160; else f = (d + 90) / 480; return clamp(f); }
export const fmtDb = (f) => { const d = f2db(f); return d === -Infinity || d < -89.5 ? "−∞" : (d > 0 ? "+" : "") + d.toFixed(Math.abs(d) < 10 ? 1 : 0); };
const hz = (v) => (v >= 1000 ? (v / 1000).toFixed(v >= 10000 ? 1 : 2) + "k" : v.toFixed(v < 100 ? 1 : 0));
export const lin = (a, b, unit = "", dec = 1) => ({ fmt: (n) => { const v = a + (b - a) * n; return (a < 0 && v > 0 ? "+" : "") + v.toFixed(dec) + unit; }, val: (n) => a + (b - a) * n, norm: (v) => clamp((v - a) / (b - a)), parse: (t) => clamp((parseFloat(t) - a) / (b - a)) });
export const log = (a, b, unit = "", dec = 1) => {
  const r = Math.log(b / a);
  const mult = (t) => parseFloat(t) * (/k/i.test(t) ? 1000 : 1);
  return { fmt: (n) => { const v = a * Math.exp(r * n); return (unit === "Hz" ? hz(v) : v.toFixed(dec)) + (unit && unit !== "Hz" ? unit : ""); }, val: (n) => a * Math.exp(r * n), norm: (v) => clamp(Math.log(v / a) / r), parse: (t) => clamp(Math.log(mult(t) / a) / r) };
};
export const FADER = { fmt: fmtDb, parse: (t) => (/inf|∞/i.test(t) ? 0 : db2f(parseFloat(t))) };
// SQ ranges. They must match SC in app/sq.py.
export const SCL = {
  trim: lin(-24, 24, " dB"), ha: lin(0, 60, " dB"), hpf: log(20, 2000, "Hz"), delay: lin(0, 341, " ms"),
  gthr: lin(-72, 18, " dB"), grange: lin(0, 60, " dB"), att: log(.05, 300, " ms", 2), hold: log(10, 5000, " ms", 0), rel: log(10, 1000, " ms", 0),
  thr: lin(-46, 18, " dB"), mgain: lin(0, 18, " dB"),
  f: log(20, 20000, "Hz"), g: lin(-15, 15, " dB"), q: log(14.4, .67, "", 2),
  pan: { fmt: (n) => { const v = Math.round((n - .5) * 200); return v === 0 ? "C" : v < 0 ? "L" + -v : "R" + v; }, parse: (t) => { const m = /([LR]?)\s*(\d+)/i.exec(t); if (!m) return .5; return clamp(.5 + (m[1].toUpperCase() === "L" ? -1 : 1) * m[2] / 200); } },
};
export const RATIOS = ["1.5", "1.6", "1.7", "1.8", "2.3", "2.5", "2.7", "3.0", "3.5", "4.0", "4.5", "4.7", "5.3", "5.5", "6.0", "7.0", "10", "12", "20", "40"];
export const COLORS = ["#59616b", "#ff4d55", "#38d67a", "#ffd23f", "#4e9bff", "#e45bd8", "#3fd9e0", "#f2f4f6"];
export const stripColor = (i) => COLORS[(i || 0) & 7];

// ---- strips ----
export function stripDef(base) {
  const m = /^\/(ch|auxin|fxrtn|bus|mtx)\/(\d\d)$/.exec(base);
  if (m) {
    const n = +m[2], k = m[1];
    // Meter byte layout from app/sq.py (METER_LEN)
    const off = { ch: [0, 0, "Ch"], auxin: [0, 32, "Aux"], fxrtn: [48, 40, "FX"], bus: [56, 48, "Bus"], mtx: [72, 64, "Mtx"] }[k];
    const label = k === "bus" ? (n > 12 ? `FX ${n - 12}` : `Aux ${n}`) : k === "fxrtn" ? `FXR ${n}` : `${off[2]} ${n}`;
    return { base, kind: k, n, label, fader: base + "/mix/fader", on: base + "/mix/on", meter: [off[0] + n - 1], solo: off[1] + n,
      sel: { ch: n - 1, auxin: 31 + n, fxrtn: 39 + n, bus: 47 + n, mtx: 63 + n }[k], gr: k === "ch" ? 124 + n : k === "bus" && n <= 12 ? 172 + n : null, gate: k === "ch" ? 76 + n : null };
  }
  if (base === "/main/st") return { base, kind: "st", n: 1, label: "LR", fader: base + "/mix/fader", on: base + "/mix/on", meter: [75, 76], solo: 71, sel: 70, gr: 185 };
  if (base === "/main/m") return { base, kind: "m", n: 1, label: "M/C", fader: base + "/mix/fader", on: base + "/mix/on", meter: [120], solo: 72, sel: 71, gr: 144 };
  const d = /^\/dca\/(\d)$/.exec(base);
  if (d) return { base, kind: "dca", n: +d[1], label: `DCA ${d[1]}`, fader: base + "/fader", on: base + "/on", meter: [], solo: 72 + +d[1], sel: 71 + +d[1] };
  return null;
}
const range = (n, f) => Array.from({ length: n }, (_, i) => f(i + 1));
const pad = (i) => String(i).padStart(2, "0");
export function layerStrips(layer, caps = G.caps) {
  if (!caps) return [];
  if (layer === "in") return range(caps.ch, (i) => `/ch/${pad(i)}`);
  if (layer === "aux") return [...range(caps.aux, (i) => `/auxin/${pad(i)}`), ...range(caps.fx, (i) => `/fxrtn/${pad(i)}`)];
  if (layer === "bus") return range(caps.bus, (i) => `/bus/${pad(i)}`);
  if (layer === "mtx") return range(caps.mtx, (i) => `/mtx/${pad(i)}`);
  if (layer === "dca") return range(caps.dca, (i) => `/dca/${i}`);
  if (layer === "fav") return (store.get("favs-" + caps.type, [])).filter((b) => stripDef(b));
  return [];
}
export const stripName = (base) => S.get(base + "/config/name") || "";
export const faderPath = (def) => (G.sof && ["ch", "auxin", "fxrtn"].includes(def.kind) ? `${def.base}/mix/${pad(G.sof)}/level` : def.fader);
export const onPath = (def) => (G.sof && ["ch", "auxin", "fxrtn"].includes(def.kind) ? `${def.base}/mix/${pad(G.sof)}/on` : def.on);
