// Follow mode: this screen shows the channel selected on the SQ, full screen.
// The SQ select message is not published. The app learns it once (Settings, Console select).
// Until then, or as an option, the app follows the last control moved on the console.
import { S, G, $, el, set, store, onAny, events, toast, stripDef, stripColor, ownRecent, api } from "./core.js";
import { followCards, disposeCards, pagesFor } from "./inspector.js";

const SEL = "/-stat/sel";
const PAGES = { main: "Channel", config: "Input", gate: "Gate", dyn: "Comp", eq: "EQ", sends: "Sends" };
let active = false, goView = null, dirty = false, shown = "", wake = null, page = store.get("followPage", "main");

export const isFollow = () => active;
const learned = () => !!(G.status.A && G.status.A.caps && G.status.A.caps.selLearned);
const byTouch = () => store.get("followTouch", true);
const byPage = () => store.get("followTouchPage", true);

function schedule() {
  if (dirty) return;
  dirty = true;
  queueMicrotask(() => { dirty = false; if (active) render(); });
}

// The strip and page a parameter path belongs to.
function placeOf(p) {
  const h = /^\/headamp\/(\d{3})\//.exec(p);
  if (h) return { base: `/ch/${String(+h[1] + 1).padStart(2, "0")}`, page: "config" };
  const m = /^(\/(?:ch|fxrtn|bus|mtx)\/\d\d|\/main\/st|\/dca\/\d)(\/.*)$/.exec(p);
  if (!m) return null;
  const r = m[2];
  const pg = /^\/(preamp|delay|insert)\//.test(r) ? "config" : /^\/gate\//.test(r) ? "gate" : /^\/dyn\//.test(r) ? "dyn"
    : /^\/eq\//.test(r) ? "eq" : /^\/mix\/\d\d\//.test(r) ? "sends" : null;
  return { base: m[1], page: pg };
}

let burst = 0, burstAt = 0;
onAny((p, v) => {
  if (!active) return;
  if (p === SEL) {
    if (learned() && stripDef(v)) { G.selected = v; schedule(); }
    return;
  }
  if (!byTouch() || ownRecent(p) || p.endsWith("/config/name")) return;
  const now = performance.now();
  if (now - burstAt > 300) { burst = 0; burstAt = now; }
  if (++burst > 6) return;  // many values at once: a scene recall or a read, not a hand on the console
  const at = placeOf(p);
  if (!at || !stripDef(at.base)) return;
  G.selected = at.base;
  if (byPage() && at.page) page = at.page;
  schedule();
});

function pages() {
  const def = stripDef(G.selected);
  return def ? pagesFor(def) : [["main", "Channel"]];
}

export function followTabs() {
  const n = $("#views"); n.innerHTML = "";
  for (const [p, t] of pages()) {
    const b = el("button", p === page ? "on" : "", t);
    b.onclick = () => { page = p; store.set("followPage", p); schedule(); };
    n.append(b);
  }
}

function step(d) {
  const list = [...Array.from({ length: G.caps.ch }, (_, i) => `/ch/${String(i + 1).padStart(2, "0")}`),
    ...Array.from({ length: G.caps.fx }, (_, i) => `/fxrtn/${String(i + 1).padStart(2, "0")}`),
    ...Array.from({ length: G.caps.bus }, (_, i) => `/bus/${String(i + 1).padStart(2, "0")}`), "/main/st"];
  const i = list.indexOf(G.selected), n = list[i + d];
  if (n) { G.selected = n; schedule(); }
}

let barOff = [];
function drawBar() {
  barOff.splice(0).forEach((f) => f());
  const bar = $("#fbar"); bar.innerHTML = "";
  const def = stripDef(G.selected); if (!def) return;
  const box = el("div", "fsel");
  const prev = el("button", null, "‹"), next = el("button", null, "›");
  prev.title = "Previous channel"; next.title = "Next channel";
  prev.onclick = () => step(-1); next.onclick = () => step(1);
  const sw = el("div", "swatch"); sw.style.background = stripColor(S.get(def.base + "/config/color"));
  const nm = el("input", "name"); nm.maxLength = G.caps.nameLen || 6; nm.placeholder = def.label;
  nm.value = S.get(def.base + "/config/name") || "";
  nm.onchange = () => set(def.base + "/config/name", nm.value);
  nm.onkeydown = (e) => { e.stopPropagation(); if (e.key === "Enter") nm.blur(); };
  box.append(prev, sw, el("b", null, def.label), nm, next);
  const how = el("span", "note", learned() ? "Follows console Sel" + (byTouch() ? " and moves" : "") : byTouch() ? "Follows console moves" : "Not following");
  how.title = learned() ? "" : "Learn the select message in Settings to follow the Sel keys";
  bar.append(box, how);
}

export function buildFollowPage() {
  disposeCards();
  const v = $("#v-follow"); v.innerHTML = "";
  if (!pages().some(([p]) => p === page)) page = "main";
  v.append(followCards(page, stripDef(G.selected)));
}

function render(force) {
  const key = `${page}/${G.selected}`;
  followTabs(); drawBar();
  if (!force && key === shown) return;
  shown = key;
  if (G.view === "follow") buildFollowPage(); else goView("follow");
  followTabs();
}

async function keepAwake() {
  try { if (active && navigator.wakeLock && !wake) { wake = await navigator.wakeLock.request("screen"); wake.addEventListener("release", () => (wake = null)); } } catch { /* needs HTTPS */ }
}
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") keepAwake(); });

export function enterFollow(fromTap) {
  if (!G.caps) return toast("No console", true);
  active = true; shown = ""; store.set("follow", true);
  document.body.classList.add("follow");
  $("#fbar").hidden = false; $("#follow").classList.add("on");
  if (learned() && stripDef(S.get(SEL))) G.selected = S.get(SEL);
  render(true); keepAwake();
  if (fromTap) {
    const d = document.documentElement, f = d.requestFullscreen || d.webkitRequestFullscreen;
    if (f) { const r = f.call(d); r && r.catch && r.catch(() => {}); }
  }
}
export function exitFollow() {
  active = false; store.set("follow", false);
  disposeCards();
  document.body.classList.remove("follow");
  $("#fbar").hidden = true; $("#follow").classList.remove("on");
  if (wake) { wake.release().catch(() => {}); wake = null; }
  const x = document.exitFullscreen || document.webkitExitFullscreen;
  if ((document.fullscreenElement || document.webkitFullscreenElement) && x) { const r = x.call(document); r && r.catch && r.catch(() => {}); }
  goView(store.get("view", "mix"));
}
export function initFollow(go) { goView = go; }

events.addEventListener("full", () => {
  if (!active) { if (store.get("follow", false) && G.caps && goView) enterFollow(false); return; }
  render(true);
});

// ---- Settings: learn the select message, and follow options ----
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
export function learnBlock() {
  const w = el("div");
  const st = el("p", "note", learned() ? "Learned. The app follows the Sel keys." : "Not learned yet.");
  const chk = (key, label, def) => {
    const l = el("label", "chk"), c = el("input"); c.type = "checkbox"; c.checked = store.get(key, def);
    c.onchange = () => store.set(key, c.checked); l.append(c, label); return l;
  };
  const go = el("button", "primary", "Learn Sel"), clr = el("button", null, "Clear"), msg = el("b");
  go.onclick = async () => {
    go.disabled = clr.disabled = true;
    try {
      for (const n of [1, 2, 3]) {
        msg.textContent = `Press SEL on input ${n} now (once)…`;
        const r = api("/api/learn", { step: n, secs: 3 });
        if (G.meta && G.meta.mock) { await wait(1000); api("/api/sim/desk", { sel: n - 1 }).catch(() => {}); }
        const j = await r;
        if (n < 3) { msg.textContent = `Got ${j.frames} messages.`; await wait(600); } else { msg.textContent = j.msg; toast(j.msg); }
      }
      st.textContent = "Learned. The app follows the Sel keys.";
    } catch (e) { msg.textContent = e.message; toast(e.message, true); }
    go.disabled = clr.disabled = false;
  };
  clr.onclick = async () => { try { const j = await api("/api/learn", { step: "clear" }); toast(j.msg); st.textContent = "Not learned yet."; } catch (e) { toast(e.message, true); } };
  const r = el("div", "row"); r.append(go, clr, msg);
  w.append(st, el("p", "note", "Learn: tap Learn Sel, then press SEL on input 1, 2 and 3 on the console when asked. Do not touch anything else for those 10 seconds. Needs the native connection."), r,
    chk("followTouch", "Follow mode: also follow the last control moved on the console", true),
    chk("followTouchPage", "Follow mode: open the page of that control (gate, EQ, comp…)", true),
    chk("deskSelSync", "DiGiCo view: select the channel the console selects", true));
  return w;
}
