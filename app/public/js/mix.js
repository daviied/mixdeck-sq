// Mix page: layer bar, strips, master section, meters.
import { S, G, $, el, set, write, scope, stripDef, layerStrips, stripColor, fmtDb, db2f, meters, faderPath, onPath, store, events, emit, clamp } from "./core.js";
import { drag } from "./ui.js";
import { curve, bandCount } from "./eq.js";

let sc = scope();
const LAYERS = [["in", "Inputs"], ["aux", "FX returns"], ["bus", "Aux / FX sends"], ["mtx", "Matrix"], ["dca", "DCA"], ["fav", "★"]];
export const SCALE = [10, 5, 0, -5, -10, -20, -30, -40, -60];
export const visible = () => [...$("#strips").querySelectorAll(".strip")].map((s) => s.dataset.base);

// byte -> fader position, so meter and fader share one scale
const LUT = new Float32Array(256);
for (let i = 0; i < 256; i++) LUT[i] = i === 0 ? 0 : db2f(i / 2.55 - 80);
const mtrList = [];
export const deskMeters = [];

export function makeMeter(idx, list = mtrList) {
  const m = el("div", "mtr" + (idx == null ? " off" : ""));
  if (idx == null) return m;
  const cover = el("div", "cover"), pk = el("div", "pk"); m.append(cover, pk);
  list.push({ idx, cover, pk, v: 0, peak: 0, hold: 0, last: -1, lastP: -1, stale: false });
  return m;
}

function meterLoop() {
  requestAnimationFrame(meterLoop);
  const list = G.view === "mix" ? mtrList : G.view === "desk" ? deskMeters : null;
  if (!list || !G.caps || !G.caps.meters) return;
  const fresh = performance.now() - meters.at < 1000;
  for (const t of list) {
    const target = fresh ? LUT[meters.b[t.idx]] : 0;
    t.v = target > t.v ? target : Math.max(target, t.v - .012);
    if (t.v >= t.peak) { t.peak = t.v; t.hold = 40; } else if (t.hold > 0) t.hold--; else t.peak = Math.max(t.v, t.peak - .006);
    const v = Math.round(t.v * 200), p = Math.round(t.peak * 200);
    if (v !== t.last) { t.last = v; t.cover.style.transform = `scaleY(${1 - v / 200})`; }
    if (p !== t.lastP) { t.lastP = p; t.pk.style.bottom = p / 2 + "%"; }
  }
}
meterLoop();

export function eqThumb(sc, base, def) {
  const n = bandCount(def.kind), hp = def.kind === "ch";
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "thumb"); svg.setAttribute("viewBox", "0 0 60 24"); svg.setAttribute("preserveAspectRatio", "none");
  const zero = document.createElementNS("http://www.w3.org/2000/svg", "line");
  zero.setAttribute("x1", 0); zero.setAttribute("x2", 60); zero.setAttribute("y1", 12); zero.setAttribute("y2", 12);
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path"); svg.append(zero, path);
  let due = 0;
  const redraw = () => { if (due) return; due = setTimeout(() => {
    due = 0; const r = curve(base, n, 30, hp); let d = "";
    for (let i = 0; i < 30; i++) d += (i ? "L" : "M") + ((i / 29) * 60).toFixed(1) + " " + (12 - clamp(r[i], -18, 18) * .62).toFixed(1);
    path.setAttribute("d", d);
  }, 60); };
  for (let i = 1; i <= n; i++) for (const k of ["type", "f", "g", "q"]) sc.on(`${base}/eq/${i}/${k}`, redraw, false);
  sc.on(`${base}/eq/on`, redraw, false);
  if (hp) { sc.on(`${base}/preamp/hpon`, redraw, false); sc.on(`${base}/preamp/hpf`, redraw, false); }
  redraw();
  return svg;
}

export function buildStrip(base, master) {
  const def = stripDef(base), caps = G.caps;
  const s = el("div", "strip" + (master ? " master" : "")); s.dataset.base = base;
  const fp = faderPath(def), op = onPath(def), isSof = fp !== def.fader;
  if (isSof) s.classList.add("sof");

  const head = el("button", "shead");
  const num = el("div", "num"); num.append(el("span", null, def.label));
  const leds = el("span", "leds");
  const nm = el("div", "nm"), src = el("div", "src");
  head.append(num, nm, src);
  num.append(leds);
  if (caps.proc) {
    const led = (t, p, c = "") => { const x = el("span", c, t); sc.on(p, (v) => x.classList.toggle("on", !!v)); leds.append(x); };
    if (def.kind === "ch") led("G", base + "/gate/on");
    if (["ch", "bus", "mtx", "st", "m"].includes(def.kind)) led("C", base + "/dyn/on");
    if (["ch", "bus", "mtx", "st", "m"].includes(def.kind)) led("I", base + "/insert/on", "ins");
  }
  sc.on(base + "/config/name", (v) => (nm.textContent = v || (def.kind === "st" ? "Main" : "")));
  sc.on(base + "/config/color", (v) => s.style.setProperty("--c", stripColor(v)));
  if (def.kind === "st" && !S.get(base + "/config/color")) s.style.setProperty("--c", "#f2f4f6");
  const srcOf = () => { const e = G.sources[base]; src.textContent = isSof ? `→ ${stripDef(`/bus/${String(G.sof).padStart(2, "0")}`).label}` : e ? (e.plug || e.src || "") : ""; };
  srcOf();
  const h = () => srcOf(); events.addEventListener("sources", h); sc.add(() => events.removeEventListener("sources", h));
  head.onclick = () => { if (document.body.classList.contains("learning")) return; select(base, true); };
  s.append(head);

  // EQ thumbnail
  if (caps.proc && ["ch", "bus", "st"].includes(def.kind)) s.append(eqThumb(sc, base, def));

  // Pan
  if (!["dca", "m"].includes(def.kind) && !(def.kind === "bus" && def.n > 12)) {
    const pp = isSof ? null : base + "/mix/pan";
    const pan = el("div", "pan"), bar = el("i"); pan.append(bar);
    if (pp) {
      sc.on(pp, (v) => { v = v ?? .5; bar.style.left = Math.min(v, .5) * 100 + "%"; bar.style.width = Math.abs(v - .5) * 100 + "%"; });
      drag(pan, { get: () => S.get(pp) ?? .5, put: (v) => set(pp, v), span: () => pan.clientWidth * 1.6, reset: .5 });
      pan.dataset.learn = "pan";
    }
    s.append(pan);
  }

  // Mute / solo
  const btns = el("div", "btns");
  const bm = el("button", "bm", "M"); bm.dataset.learn = "mute";
  sc.on(op, (v) => { const m = v === 0; bm.classList.toggle("on", m); s.classList.toggle("muted", m); });
  bm.onclick = () => { if (!document.body.classList.contains("learning")) set(op, S.get(op) === 0 ? 1 : 0); };
  btns.append(bm);
  if (caps.full) {
    const sp = `/-stat/solosw/${String(def.solo).padStart(2, "0")}`;
    const bs = el("button", "bs", "S"); bs.dataset.learn = "solo";
    sc.on(sp, (v) => bs.classList.toggle("on", !!v));
    bs.onclick = () => { if (!document.body.classList.contains("learning")) set(sp, S.get(sp) ? 0 : 1); };
    btns.append(bs);
  }
  s.append(btns);

  // Fader
  const fz = el("div", "fz");
  const scale = el("div", "scale");
  for (const d of SCALE) { const t = el("span", null, d > 0 ? "+" + d : d); t.style.bottom = db2f(d) * 100 + "%"; scale.append(t); }
  const track = el("div", "track"); track.dataset.learn = "fader";
  const zero = el("div", "zero"); zero.style.bottom = db2f(0) * 100 + "%"; track.append(zero);
  const cap = el("div", "cap"); track.append(cap);
  fz.append(scale, track);
  const metersOn = caps.meters && !isSof;
  def.meter.forEach((i) => fz.append(makeMeter(metersOn ? i : null)));
  if (!def.meter.length) fz.append(makeMeter(null));
  s.append(fz);
  const fv = el("div", "fv");
  sc.on(fp, (v) => { v = v ?? 0; cap.style.bottom = v * 100 + "%"; fv.textContent = fmtDb(v); });
  drag(track, { get: () => S.get(fp) ?? 0, put: (v) => set(fp, v), axis: "y", reset: .75 });
  s.append(fv);
  s._def = def;
  return s;
}

export function select(base, openSheet) {
  G.selected = base;
  document.querySelectorAll(".strip.sel").forEach((x) => x.classList.remove("sel"));
  document.querySelectorAll(`.strip[data-base="${base}"]`).forEach((x) => x.classList.add("sel"));
  emit("select", { openSheet });
}

function buildLayerBar() {
  const lb = $("#layerbar"); lb.innerHTML = "";
  const seg = el("div", "seg");
  for (const [k, t] of LAYERS) {
    const b = el("button", k === G.layer ? "on" : "", t);
    b.onclick = () => { G.layer = k; store.set("layer", k); G.bank = 0; buildMix(); };
    seg.append(b);
  }
  lb.append(seg);
  const sf = el("label", "sof" + (G.sof ? " active" : "")); sf.append("Sends on fader");
  const sel = el("select"); sel.append(new Option("Off", 0));
  for (let i = 1; i <= G.caps.bus; i++) { const b = `/bus/${String(i).padStart(2, "0")}`, n = S.get(b + "/config/name"); sel.append(new Option(`${stripDef(b).label}${n ? " " + n : ""}`, i)); }
  sel.value = G.sof;
  sel.onchange = () => { G.sof = +sel.value; buildMix(); };
  sf.append(sel); lb.append(sf);
  const t = el("button", "inspToggle", store.get("inspOpen", true) ? "Hide channel" : "Show channel");
  t.onclick = () => { store.set("inspOpen", !store.get("inspOpen", true)); emit("select", {}); buildLayerBar(); };
  lb.append(t);
}

export function buildMix() {
  sc.dispose(); sc = scope(); mtrList.length = 0;
  if (!G.caps) { $("#strips").innerHTML = ""; $("#masters").innerHTML = ""; $("#layerbar").innerHTML = ""; $("#strips").append(el("div", "empty", "No console set up. Open Settings.")); return; }
  buildLayerBar();
  const box = $("#strips"), left = box.scrollLeft; box.innerHTML = "";
  let list = layerStrips(G.layer);
  if (G.layer === "bus" && innerWidth <= 760) list = [...list, "/main/st", "/main/m"];
  for (const b of list) box.append(buildStrip(b));
  if (!list.length) box.append(el("div", "empty", G.layer === "fav" ? "No favorites yet. Open a channel and tap the star." : "Nothing here."));
  box.scrollLeft = left;
  const m = $("#masters"); m.innerHTML = "";
  m.append(buildStrip("/main/st", true));
  if (G.caps.mono) m.append(buildStrip("/main/m", true));
  document.querySelectorAll(`.strip[data-base="${G.selected}"]`).forEach((x) => x.classList.add("sel"));
}
