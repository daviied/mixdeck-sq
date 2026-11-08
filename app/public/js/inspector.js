// Channel page: every setting of the selected strip on one screen.
import { S, G, $, el, set, scope, stripDef, stripColor, SCL, RATIOS, FADER, store, events, COLORS, toast } from "./core.js";
import { pr, tog, enumSel, bitButtons, chead } from "./ui.js";
import { eqGraph, EQT, bandColor, dynGraph, bandCount } from "./eq.js";
import { select } from "./mix.js";

let sc = scope(), phoneTab = 0, clip = null;
const pad = (n) => String(n).padStart(2, "0");
// What each strip has on the SQ. FX sends (buses 13-16) have only a fader and a mute.
const fxs = (def) => def.kind === "bus" && def.n > 12;
export const HAS = {
  input: (d) => d.kind === "ch", gate: (d) => d.kind === "ch",
  eq: (d) => ["ch", "bus", "st"].includes(d.kind) && !fxs(d), comp: (d) => ["ch", "bus", "st"].includes(d.kind) && !fxs(d),
  sends: (d) => ["ch", "fxrtn", "bus", "st"].includes(d.kind) && !fxs(d), pan: (d) => ["ch", "fxrtn", "bus", "mtx", "st"].includes(d.kind) && !fxs(d),
};

function chanCard(def) {
  const b = def.base, c = el("div", "card"); c.dataset.t = "Channel";
  c.append(chead(sc, "Channel"));
  if (G.caps.full && def.kind !== "dca") {
    const cols = el("div", "colors");
    COLORS.forEach((col, i) => {
      const x = el("button"); x.style.background = col; x.title = "Color";
      sc.on(b + "/config/color", (v) => x.classList.toggle("on", (v || 0) === i));
      x.onclick = () => set(b + "/config/color", i);
      cols.append(x);
    });
    c.append(cols);
  }
  const fp = def.fader;
  c.append(pr(sc, fp, "Fader", FADER));
  if (HAS.pan(def)) c.append(pr(sc, b + "/mix/pan", "Pan", SCL.pan));
  if (["ch", "fxrtn"].includes(def.kind)) { const r = el("div", "row"); r.append(tog(sc, b + "/mix/st", "LR")); c.append(r); }
  if (G.caps.full && def.kind !== "dca") {
    c.append(el("h3", null, "DCA"), bitButtons(sc, b + "/grp/dca", 8, ""));
    c.append(el("h3", null, "Mute group"), bitButtons(sc, b + "/grp/mute", 6, "mg"));
  }
  const r = el("div", "row");
  const favs = () => store.get("favs-" + G.caps.type, []);
  const star = el("button", "tog", favs().includes(b) ? "★ Favorite" : "☆ Favorite");
  star.onclick = () => {
    const f = favs(), i = f.indexOf(b); i < 0 ? f.push(b) : f.splice(i, 1);
    store.set("favs-" + G.caps.type, f); star.textContent = f.includes(b) ? "★ Favorite" : "☆ Favorite";
  };
  r.append(star);
  if (G.caps.proc && def.kind === "ch") {
    const cp = el("button", "tog", "Copy"), pa = el("button", "tog", "Paste");
    const SECT = /\/(preamp\/(invert|hpon|hpslope|hpf)|gate|dyn|eq)\b/;
    cp.onclick = () => {
      clip = { kind: def.kind, label: def.label, v: [...S].filter(([k]) => k.startsWith(b + "/") && SECT.test(k.slice(b.length))).map(([k, v]) => [k.slice(b.length), v]) };
      toast(`Copied ${def.label}: filter, gate, comp, EQ`);
    };
    pa.onclick = () => {
      if (!clip) return toast("Copy a channel first", true);
      if (clip.kind !== def.kind) return toast(`${clip.label} and ${def.label} are different strip types`, true);
      clip.v.forEach(([k, v]) => set(b + k, v)); toast(`Pasted ${clip.label} to ${def.label}`);
    };
    r.append(cp, pa);
  }
  c.append(r);
  return c;
}

function inputCard(def) {
  const b = def.base, c = el("div", "card"); c.dataset.t = "Input";
  c.append(chead(sc, "Input"));
  const e = G.sources[b] || {};
  if (e.ha != null) {
    const p = `/headamp/${String(e.ha).padStart(3, "0")}/`;
    c.append(pr(sc, p + "gain", "Gain", SCL.ha, { color: "#ffb627" }));
    const r = el("div", "row");
    r.append(tog(sc, p + "phantom", "48V", "red", { confirm: "Tap again to turn on 48 V phantom power" }));
    c.append(r);
  }
  c.append(pr(sc, b + "/preamp/trim", "Trim", SCL.trim));
  const r2 = el("div", "row"); r2.append(tog(sc, b + "/preamp/invert", "Ø Invert", "amber"));
  if (def.kind === "ch") {
    r2.append(tog(sc, b + "/preamp/hpon", "Low cut"));
    c.append(r2, pr(sc, b + "/preamp/hpf", "Low cut", SCL.hpf), enumSel(sc, b + "/preamp/hpslope", "Slope", ["12 dB", "18 dB", "24 dB"]));
    const r3 = el("div", "row"); r3.append(tog(sc, b + "/delay/on", "Delay"));
    c.append(r3, pr(sc, b + "/delay/time", "Delay", SCL.delay));
    const r4 = el("div", "row"); r4.append(tog(sc, b + "/insert/on", "Insert on")); c.append(r4);
  } else c.append(r2);
  return c;
}

function gateCard(def) {
  const P = def.base + "/gate/", c = el("div", "card"); c.dataset.t = "Gate";
  c.append(chead(sc, "Gate", P + "on", c), dynGraph(sc, def.base, "gate", def, true));
  c.append(pr(sc, P + "thr", "Threshold", SCL.gthr, { color: "#ffb627" }), pr(sc, P + "range", "Depth", SCL.grange));
  c.append(pr(sc, P + "attack", "Attack", SCL.att), pr(sc, P + "hold", "Hold", SCL.hold), pr(sc, P + "release", "Release", SCL.rel));
  return c;
}

function compCard(def) {
  const P = def.base + "/dyn/", c = el("div", "card"); c.dataset.t = "Comp";
  c.append(chead(sc, "Compressor", P + "on", c), dynGraph(sc, def.base, "dyn", def, false));
  c.append(pr(sc, P + "thr", "Threshold", SCL.thr, { color: "#ffb627" }));
  c.append(enumSel(sc, P + "ratio", "Ratio", RATIOS.map((r) => r + ":1")));
  c.append(pr(sc, P + "mgain", "Makeup", SCL.mgain));
  return c;
}

function eqCard(def) {
  const b = def.base, n = bandCount(def.kind), c = el("div", "card wide"); c.dataset.t = "EQ";
  c.append(chead(sc, "Equalizer", b + "/eq/on", c));
  c.append(eqGraph(sc, b, n, def.kind === "ch"));
  const row = el("div", "eqb"); row.style.setProperty("--n", n);
  for (let i = 1; i <= n; i++) {
    const P = `${b}/eq/${i}/`, d = el("div"), col = bandColor(i - 1); d.style.setProperty("--bc", col);
    // The SQ has a shape on the low and high bands only: bell, shelf or cut.
    const s = el("select"), opts = i === 1 ? [0, 1, 2] : i === n ? [2, 4, 5] : [2];
    opts.forEach((k) => s.append(new Option(EQT[k], k)));
    s.disabled = opts.length < 2;
    sc.on(P + "type", (v) => (s.value = v ?? 2)); s.onchange = () => set(P + "type", +s.value);
    d.append(s, pr(sc, P + "f", "F", SCL.f, { color: col }), pr(sc, P + "g", "G", SCL.g, { color: col }), pr(sc, P + "q", "Q", SCL.q, { color: col }));
    row.append(d);
  }
  c.append(row);
  return c;
}

function sendsCard(def) {
  const b = def.base, c = el("div", "card wide"); c.dataset.t = "Sends";
  const toMtx = ["bus", "st"].includes(def.kind);
  c.append(chead(sc, toMtx ? "Matrix sends" : "Aux and FX sends"));
  const g = el("div", "sends");
  const count = toMtx ? G.caps.mtx : G.caps.bus;
  for (let i = 1; i <= count; i++) {
    const P = `${b}/mix/${pad(i)}/`, row = el("div", "send");
    const name = toMtx ? `Mtx ${i}` : (S.get(`/bus/${pad(i)}/config/name`) || stripDef(`/bus/${pad(i)}`).label);
    row.append(pr(sc, P + "level", name, FADER), tog(sc, P + "on", "ON"));
    g.append(row);
  }
  c.append(g);
  return c;
}

export function disposeCards() { sc.dispose(); sc = scope(); }

// Follow mode: one console page, full screen.
export function followCards(page, def) {
  disposeCards();
  const w = el("div", `fcards fp-${page}`);
  if (!def) return w;
  const has = Object.fromEntries(Object.entries(HAS).map(([k, f]) => [k, f(def)]));
  const split = (c) => { // graph on one side, controls on the other
    const ctl = el("div", "fctl");
    [...c.children].forEach((x) => { if (!x.matches(".chead,.dynbox")) ctl.append(x); });
    c.append(ctl); c.classList.add("fsplit");
    return c;
  };
  const none = (what) => { const n = el("div", "empty", `${def.label} has no ${what}.`); return n; };
  const cards = {
    home: () => [chanCard(def), has.input && inputCard(def), has.gate && gateCard(def), has.comp && compCard(def), has.eq && eqCard(def)],
    config: () => [has.input ? inputCard(def) : none("input settings")],
    gate: () => [has.gate ? split(gateCard(def)) : none("gate")],
    dyn: () => [has.comp ? split(compCard(def)) : none("compressor")],
    eq: () => [has.eq ? eqCard(def) : none("EQ")],
    sends: () => [has.sends ? sendsCard(def) : none("sends")],
    main: () => [chanCard(def)],
  }[page]();
  cards.filter(Boolean).forEach((c) => { c.classList.add("show"); w.append(c); });
  return w;
}

// One section of this menu, full screen over the Mix page.
const FULL = [["main", "Channel"], ["config", "Input"], ["gate", "Gate"], ["dyn", "Comp"], ["eq", "EQ"], ["sends", "Sends"]];
const CARD_PAGE = { Channel: "main", Input: "config", Gate: "gate", Comp: "dyn", EQ: "eq", Sends: "sends" };
let full = null;
const fullKey = (e) => { if (e.key === "Escape" && e.target.tagName !== "INPUT" && !document.querySelector(".pp")) { e.preventDefault(); e.stopPropagation(); closeFull(); } };
export function pagesFor(def) {
  const proc = G.caps && G.caps.proc;
  return FULL.filter(([p]) => ({
    main: true, config: proc && HAS.input(def), gate: proc && HAS.gate(def), dyn: proc && HAS.comp(def), eq: proc && HAS.eq(def), sends: HAS.sends(def),
  })[p]);
}
const SCROLLERS = ".cards, .fcards, .card, .fctl";
const scrollSave = (root) => [...root.querySelectorAll(SCROLLERS)].map((x) => [x.scrollLeft, x.scrollTop]);
const scrollLoad = (root, keep) => keep && root.querySelectorAll(SCROLLERS).forEach((x, i) => { if (keep[i]) [x.scrollLeft, x.scrollTop] = keep[i]; });

function drawFull() {
  const def = stripDef(G.selected);
  if (!def || !G.caps) return closeFull();
  const pages = pagesFor(def);
  if (!pages.some(([p]) => p === full)) full = "main";
  const o = $("#fullc"), key = def.base + full, keep = o.dataset.key === key ? scrollSave(o) : null;
  o.dataset.key = key; o.innerHTML = "";
  const bar = el("div", "fbar"), seg = el("div", "seg");
  pages.forEach(([p, t]) => {
    const b = el("button", p === full ? "on" : "", t);
    b.onclick = () => { full = p; drawFull(); };
    seg.append(b);
  });
  const list = [...document.querySelectorAll(G.view === "desk" ? "#dstrips .strip, #dmasters .strip" : "#strips .strip, #masters .strip")].map((x) => x.dataset.base);
  const i = list.indexOf(G.selected), box = el("div", "fsel");
  const prev = el("button", null, "‹"), next = el("button", null, "›");
  prev.title = "Previous channel"; next.title = "Next channel";
  prev.disabled = i <= 0; next.disabled = i < 0 || i >= list.length - 1;
  prev.onclick = () => select(list[i - 1]); next.onclick = () => select(list[i + 1]);
  const esc = el("button", "primary", "Esc"); esc.title = "Close (Esc)"; esc.onclick = closeFull; esc.style.fontSize = "1rem";
  const nm = S.get(def.base + "/config/name");
  box.append(prev, el("b", null, def.label + (nm ? ` · ${nm}` : "")), next, esc);
  bar.append(seg, box);
  o.append(bar, followCards(full, def));
  scrollLoad(o, keep);
}
export function openFull(page) {
  closePop();
  if (full) closeFull();
  full = page;
  const o = el("div", "fullc"); o.id = "fullc"; $("#app").append(o);
  document.addEventListener("keydown", fullKey, true);
  drawFull();
}
export function closeFull() {
  if (!full) return;
  full = null; $("#fullc")?.remove();
  document.removeEventListener("keydown", fullKey, true);
  disposeCards();
  buildInspector({});
}

// DiGiCo view: a small window beside the channel strip, not full screen.
const POP = [["gate", "Gate"], ["dyn", "Comp"], ["eq", "EQ"]];
let pop = null;
// The section page open now, in the window or full screen.
export const openPage = () => pop || full;
const popKey = (e) => { if (e.key === "Escape" && e.target.tagName !== "INPUT" && !document.querySelector(".pp")) { e.preventDefault(); e.stopPropagation(); closePop(); } };
export function placePop() {
  const o = $("#dpop"); if (!o) return;
  const strip = document.querySelector(`#dstrips .strip[data-base="${G.selected}"], #dmasters .strip[data-base="${G.selected}"]`);
  if (!strip) return;
  const r = strip.getBoundingClientRect(), w = o.offsetWidth, h = o.offsetHeight;
  let x = r.right + 6; if (x + w > innerWidth - 4) x = r.left - w - 6;
  o.style.left = Math.max(4, x) + "px";
  o.style.top = Math.max(4, Math.min(r.top, innerHeight - h - 4)) + "px";
}
function drawPop() {
  const def = stripDef(G.selected);
  if (!def || !G.caps || !G.caps.proc) return closePop();
  const pages = POP.filter(([p]) => pagesFor(def).some(([q]) => q === p));
  if (!pages.length) return closePop();
  if (!pages.some(([p]) => p === pop)) pop = pages[0][0];
  const o = $("#dpop"); o.innerHTML = ""; o.className = "dpop dpop-" + pop; o.dataset.base = def.base;
  const bar = el("div", "dpopbar"), seg = el("div", "seg");
  pages.forEach(([p, t]) => {
    const b = el("button", p === pop ? "on" : "", t);
    b.onclick = () => { pop = p; drawPop(); };
    seg.append(b);
  });
  const nm = S.get(def.base + "/config/name"), x = el("button", "dpopx", "✕");
  x.title = "Close (Esc)"; x.onclick = closePop;
  const title = el("b", null, def.label + (nm ? ` · ${nm}` : ""));
  bar.append(title, seg, x);
  o.append(bar, followCards(pop, def));
  sc.on(def.base + "/config/name", (v) => (title.textContent = def.label + (v ? ` · ${v}` : "")));
  placePop();
}
export function closePop() {
  if (!pop) return;
  pop = null; $("#dpop")?.remove();
  document.removeEventListener("keydown", popKey, true);
  disposeCards();
}
// was: the channel selected before this tap. A second tap on the same section closes the window.
export function openSection(page, was) {
  if (!store.get("deskWindow", true) || innerWidth <= 760) return openFull(page);
  if (pop === page && was === G.selected) return closePop();
  if (full) closeFull();
  if (!pop) {
    const o = el("div", "dpop"); o.id = "dpop"; $("#app").append(o);
    document.addEventListener("keydown", popKey, true);
  }
  pop = page;
  drawPop();
}
addEventListener("resize", placePop);

export function buildInspector(e) {
  if (pop) return drawPop();
  if (full) return drawFull();
  if (G.view !== "mix") return;
  sc.dispose(); sc = scope();
  const box = $("#insp"), def = stripDef(G.selected);
  const narrow = innerWidth <= 760;
  const open = narrow ? !!(e && e.openSheet) || box.dataset.sheet === "1" : store.get("inspOpen", true);
  box.dataset.sheet = narrow && open ? "1" : "";
  box.hidden = !open || !def || !G.caps; $("#resizer").hidden = box.hidden;
  if (box.hidden) return;
  const keep = box.dataset.base === def.base ? scrollSave(box) : null;
  box.dataset.base = def.base; box.innerHTML = "";
  const h = el("div", "ihead");
  const sw = el("div", "swatch"); sc.on(def.base + "/config/color", (v) => (sw.style.background = stripColor(v)));
  const nm = el("input", "name"); nm.maxLength = G.caps.nameLen || 6; nm.placeholder = def.label;
  sc.on(def.base + "/config/name", (v) => { if (document.activeElement !== nm) nm.value = v || ""; });
  nm.onchange = () => set(def.base + "/config/name", nm.value);
  nm.onkeydown = (ev) => { ev.stopPropagation(); if (ev.key === "Enter") nm.blur(); };
  h.append(sw, nm, el("span", "sub", def.label));
  const sp = el("span", "grow"); h.append(sp);
  const close = el("button", "closeSheet", "Done"); close.style.display = "none";
  close.onclick = () => { box.dataset.sheet = ""; box.hidden = true; };
  h.append(close);
  box.append(h);

  const cards = [];
  cards.push(chanCard(def));
  if (G.caps.proc) {
    if (HAS.input(def)) cards.push(inputCard(def));
    if (HAS.gate(def)) cards.push(gateCard(def));
    if (HAS.eq(def)) cards.push(eqCard(def));
    if (HAS.comp(def)) cards.push(compCard(def));
  }
  if (HAS.sends(def)) cards.push(sendsCard(def));
  if (!G.caps.proc) {
    const n = el("div", "card"); n.dataset.t = "Info"; n.append(chead(sc, "Processing off"));
    n.append(el("p", "note", "Names, gain, HPF, gate, EQ and comp need the native connection. Turn it on in Settings."));
    cards.push(n);
  }
  cards.forEach((c) => {
    const page = CARD_PAGE[c.dataset.t], head = c.querySelector(".chead");
    if (!page || !head) return;
    const b = el("button", "cardfull", "⤢"); b.title = `${c.dataset.t} full screen`;
    b.onclick = () => openFull(page);
    head.append(b);
  });
  if (phoneTab >= cards.length) phoneTab = 0;
  const tabs = el("div", "itabs");
  cards.forEach((c, i) => {
    const t = el("button", i === phoneTab ? "on" : "", c.dataset.t);
    c.classList.toggle("show", i === phoneTab);
    t.onclick = () => { phoneTab = i; tabs.querySelectorAll("button").forEach((x, j) => x.classList.toggle("on", j === i)); cards.forEach((x, j) => x.classList.toggle("show", j === i)); };
    tabs.append(t);
  });
  box.append(tabs);
  const w = el("div", "cards"); w.append(...cards); box.append(w);
  scrollLoad(box, keep);
}

export function initInspector() {
  events.addEventListener("select", (e) => buildInspector(e.detail));
  document.addEventListener("goto", closeFull);
  const rz = $("#resizer");
  const saved = store.get("inspH", 0); if (saved) $("#insp").style.setProperty("--insp-h", saved + "px");
  rz.addEventListener("pointerdown", (e) => {
    e.preventDefault(); rz.setPointerCapture(e.pointerId);
    const y = e.clientY, h = $("#insp").offsetHeight;
    const mv = (ev) => { const n = Math.max(160, Math.min(innerHeight - 260, h + ev.clientY - y)); $("#insp").style.setProperty("--insp-h", n + "px"); store.set("inspH", n); };
    const up = () => { rz.removeEventListener("pointermove", mv); rz.removeEventListener("pointerup", up); };
    rz.addEventListener("pointermove", mv); rz.addEventListener("pointerup", up);
  });
}
