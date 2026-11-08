// EQ maths, EQ graph, dynamics graphs.
import { S, set, el, clamp, SCL, RATIOS, on, G, meters, store, rta, api, events, stripDef, emit } from "./core.js";

const FS = 48000;
const BC = ["#ff7a59", "#ffd23f", "#38d67a", "#4e9bff", "#e45bd8", "#3fd9e0"];
export const bandColor = (i) => BC[i % 6];
export const EQT = ["LCut", "LShv", "PEQ", "VEQ", "HShv", "HCut"];

function biquad(type, f, g, q) {
  const w = 2 * Math.PI * Math.min(f, FS * .49) / FS, c = Math.cos(w), s = Math.sin(w), A = 10 ** (g / 40);
  const al = s / (2 * q);
  switch (type) {
    case 0: return [(1 + c) / 2, -(1 + c), (1 + c) / 2, 1 + al, -2 * c, 1 - al];
    case 5: return [(1 - c) / 2, 1 - c, (1 - c) / 2, 1 + al, -2 * c, 1 - al];
    case 1: { const b = 2 * Math.sqrt(A) * al; return [A * (A + 1 - (A - 1) * c + b), 2 * A * (A - 1 - (A + 1) * c), A * (A + 1 - (A - 1) * c - b), A + 1 + (A - 1) * c + b, -2 * (A - 1 + (A + 1) * c), A + 1 + (A - 1) * c - b]; }
    case 4: { const b = 2 * Math.sqrt(A) * al; return [A * (A + 1 + (A - 1) * c + b), -2 * A * (A - 1 + (A + 1) * c), A * (A + 1 + (A - 1) * c - b), A + 1 - (A - 1) * c + b, 2 * (A - 1 - (A + 1) * c), A + 1 - (A - 1) * c - b]; }
    default: return [1 + al * A, -2 * c, 1 - al * A, 1 + al / A, -2 * c, 1 - al / A];
  }
}
function magDb(co, f) {
  const [b0, b1, b2, a0, a1, a2] = co, w = 2 * Math.PI * f / FS, c1 = Math.cos(w), c2 = Math.cos(2 * w);
  const n = b0 * b0 + b1 * b1 + b2 * b2 + 2 * (b0 * b1 + b1 * b2) * c1 + 2 * b0 * b2 * c2;
  const d = a0 * a0 + a1 * a1 + a2 * a2 + 2 * (a0 * a1 + a1 * a2) * c1 + 2 * a0 * a2 * c2;
  return 10 * Math.log10(Math.max(1e-9, n / d));
}
export function bandsOf(base, n) {
  const out = [];
  for (let i = 1; i <= n; i++) {
    const p = `${base}/eq/${i}/`;
    out.push({ i, type: S.get(p + "type") ?? 2, f: SCL.f.val(S.get(p + "f") ?? .5), g: SCL.g.val(S.get(p + "g") ?? .5), q: SCL.q.val(S.get(p + "q") ?? .46) });
  }
  return out;
}
export function curve(base, n, points, hp) {
  const eqOn = S.get(`${base}/eq/on`) ?? 1;
  // Q shapes only the PEQ and VEQ curves. Cuts and shelves draw with a fixed slope.
  const co = eqOn ? bandsOf(base, n).map((b) => biquad(b.type, b.f, b.g, b.type === 2 ? b.q : b.type === 3 ? b.q * 1.4 : .707)) : [];
  if (hp && S.get(`${base}/preamp/hpon`)) co.push(biquad(0, SCL.hpf.val(S.get(`${base}/preamp/hpf`) ?? 0), 0, .707));
  const r = new Float32Array(points);
  for (let i = 0; i < points; i++) {
    const f = 20 * 1000 ** (i / (points - 1));
    let d = 0; for (const c of co) d += magDb(c, f);
    r[i] = d;
  }
  return r;
}
const nf = (f) => Math.log(f / 20) / Math.log(1000);

export function bandCount() { return 4; }  // SQ PEQ: LF, LM, HM, HF

// RTA: 100 bands from 20 Hz to 18.66 kHz, equal steps on a log scale.
const RTA_STEP = Math.pow(18660 / 20, 1 / 99);
const rtaF = (i) => 20 * Math.pow(RTA_STEP, i);
let rtaGraphs = 0, rtaOffTimer = 0;
export const rtaOn = () => !!(G.caps && G.caps.rta) && store.get("eqRta", true);
const rtaSend = (sel) => api("/api/rta", { c: G.slot, sel }, true).catch(() => {});

export function eqGraph(sc, base, n, hasHp, onSel) {
  const box = el("div", "eqbox"), cv = el("canvas"); box.append(cv);
  const def = stripDef(base), rb = el("button", "rtab", "RTA");
  rb.title = "Show the spectrum of this channel behind the EQ curve";
  rb.addEventListener("pointerdown", (e) => e.stopPropagation());
  rb.onclick = () => { store.set("eqRta", !rtaOn()); emit("rtaopt"); };
  if (G.caps && G.caps.rta) box.append(rb);
  let selBand = 0, raf = 0;
  const RANGE = 18, css = getComputedStyle(document.documentElement);
  const redraw = () => { if (!raf) raf = requestAnimationFrame(draw); };
  function draw() {
    raf = 0;
    const W = box.clientWidth, H = box.clientHeight; if (!W || !H) return;
    const dpr = devicePixelRatio || 1; if (cv.width !== W * dpr || cv.height !== H * dpr) { cv.width = W * dpr; cv.height = H * dpr; }
    const c = cv.getContext("2d"); c.setTransform(dpr, 0, 0, dpr, 0, 0); c.clearRect(0, 0, W, H);
    const y = (d) => H / 2 - (d / RANGE) * (H / 2 - 4), x = (f) => nf(f) * W;
    c.font = "10px system-ui"; c.textBaseline = "top";
    for (const f of [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000]) {
      c.strokeStyle = "rgba(255,255,255,.07)"; c.beginPath(); c.moveTo(x(f), 0); c.lineTo(x(f), H); c.stroke();
      if (f > 20 && f < 20000) { c.fillStyle = "rgba(255,255,255,.35)"; c.fillText(f >= 1000 ? f / 1000 + "k" : f, x(f) + 2, H - 13); }
    }
    for (const d of [-12, -6, 0, 6, 12]) {
      c.strokeStyle = d ? "rgba(255,255,255,.07)" : "rgba(255,255,255,.2)"; c.beginPath(); c.moveTo(0, y(d)); c.lineTo(W, y(d)); c.stroke();
      if (d) { c.fillStyle = "rgba(255,255,255,.35)"; c.fillText((d > 0 ? "+" : "") + d, 3, y(d) + 1); }
    }
    if (rtaOn() && performance.now() - rta.at < 1000) {
      c.fillStyle = "rgba(255,210,122,.3)";
      for (let i = 0; i < 100; i++) {
        const X0 = x(rtaF(i)), X1 = x(rtaF(i + 1)), h = (rta.b[i] / 255) * H;
        c.fillRect(X0, H - h, Math.max(1, X1 - X0 - 1), h);
      }
    }
    const pts = Math.min(240, W), r = curve(base, n, pts, hasHp);
    const on = S.get(`${base}/eq/on`) ?? 1;
    const col = on ? "#52b6ff" : "#7f8893";
    c.beginPath(); c.moveTo(0, y(0));
    for (let i = 0; i < pts; i++) c.lineTo((i / (pts - 1)) * W, y(clamp(r[i], -RANGE, RANGE)));
    c.lineTo(W, y(0)); c.closePath(); c.fillStyle = on ? "rgba(82,182,255,.16)" : "rgba(127,136,147,.1)"; c.fill();
    c.beginPath(); for (let i = 0; i < pts; i++) { const X = (i / (pts - 1)) * W, Y = y(clamp(r[i], -RANGE, RANGE)); i ? c.lineTo(X, Y) : c.moveTo(X, Y); }
    c.strokeStyle = col; c.lineWidth = 2; c.stroke(); c.lineWidth = 1;
    bandsOf(base, n).forEach((b, i) => {
      const noG = b.type === 0 || b.type === 5, X = x(b.f), Y = y(noG ? 0 : b.g);
      c.beginPath(); c.arc(X, Y, i === selBand ? 9 : 7, 0, 7); c.fillStyle = bandColor(i) + (i === selBand ? "" : "cc"); c.fill();
      c.strokeStyle = "#0008"; c.stroke();
      c.fillStyle = "#0b0d10"; c.font = "bold 10px system-ui"; c.textAlign = "center"; c.textBaseline = "middle"; c.fillText(i + 1, X, Y + .5); c.textAlign = "left"; c.textBaseline = "top"; c.font = "10px system-ui";
    });
  }
  for (let i = 1; i <= n; i++) for (const k of ["type", "f", "g", "q"]) sc.on(`${base}/eq/${i}/${k}`, redraw, false);
  sc.on(`${base}/eq/on`, redraw, false);
  if (hasHp) { sc.on(`${base}/preamp/hpon`, redraw, false); sc.on(`${base}/preamp/hpf`, redraw, false); }
  const ro = new ResizeObserver(redraw); ro.observe(box); sc.add(() => ro.disconnect());

  // The console sends RTA data only while a visible graph asks for it.
  const ask = () => { if (rtaOn() && box.isConnected && box.clientWidth && def) rtaSend(def.sel); };
  const showRta = () => { rb.classList.toggle("on", rtaOn()); redraw(); };
  const onOpt = () => { showRta(); if (rtaOn()) ask(); else if (def) rtaSend(-1); };
  showRta();
  events.addEventListener("rta", redraw); events.addEventListener("rtaopt", onOpt);
  const timer = setInterval(() => { ask(); redraw(); }, 4000);
  setTimeout(ask, 50);
  clearTimeout(rtaOffTimer); rtaGraphs++;
  sc.add(() => {
    clearInterval(timer); events.removeEventListener("rta", redraw); events.removeEventListener("rtaopt", onOpt);
    rtaGraphs--;
    clearTimeout(rtaOffTimer);
    rtaOffTimer = setTimeout(() => { if (!rtaGraphs && rtaOn()) rtaSend(-1); }, 400);
  });

  // Each finger holds one band node.
  const held = new Map();
  const pos = (e) => { const r = box.getBoundingClientRect(); return { X: e.clientX - r.left, Y: e.clientY - r.top, W: r.width, H: r.height }; };
  box.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    const p = pos(e); let best = -1, bd = 1e9;
    bandsOf(base, n).forEach((b, i) => {
      const noG = b.type === 0 || b.type === 5;
      const X = nf(b.f) * p.W, Y = p.H / 2 - ((noG ? 0 : b.g) / RANGE) * (p.H / 2 - 4), d = Math.hypot(X - p.X, Y - p.Y);
      if (d < bd) { bd = d; best = i; }
    });
    selBand = best; onSel && onSel(best); redraw();
    box.setPointerCapture(e.pointerId);
    const P = `${base}/eq/${best + 1}/`;
    held.set(e.pointerId, { P, x: e.clientX, y: e.clientY, f: S.get(P + "f") ?? .5, g: S.get(P + "g") ?? .5, type: S.get(P + "type") ?? 2 });
  });
  box.addEventListener("pointermove", (e) => {
    const h = held.get(e.pointerId); if (!h) return;
    const r = box.getBoundingClientRect(), k = e.shiftKey ? .2 : 1;
    set(h.P + "f", clamp(h.f + ((e.clientX - h.x) / r.width) * k));
    if (h.type !== 0 && h.type !== 5) {
      const pxPerDb = (r.height / 2 - 4) / RANGE;
      set(h.P + "g", clamp(h.g - (((e.clientY - h.y) / pxPerDb) / 30) * k));
    }
  });
  const end = (e) => held.delete(e.pointerId);
  box.addEventListener("pointerup", end); box.addEventListener("pointercancel", end);
  box.addEventListener("wheel", (e) => {
    e.preventDefault();
    const P = `${base}/eq/${selBand + 1}/q`;
    set(P, clamp((S.get(P) ?? .46) + Math.sign(e.deltaY) * -.02));
  }, { passive: false });
  draw();
  return box;
}

// Dynamics: transfer curve with a live level dot. Drag up and down for threshold.
export function dynGraph(sc, base, sect, def, isGate) {
  const box = el("div", "dynbox"), cv = el("canvas"); box.append(cv);
  const P = `${base}/${sect}/`;
  const lo = isGate ? -72 : -46;
  let raf = 0, alive = true;
  const metering = store.get("dynMeters", true);
  sc.add(() => { alive = false; cancelAnimationFrame(raf); });
  const scale = isGate ? SCL.gthr : SCL.thr;
  function loop() {
    if (!alive) return;
    raf = requestAnimationFrame(loop);
    const W = box.clientWidth, H = box.clientHeight; if (!W || !H) return;
    const dpr = devicePixelRatio || 1; if (cv.width !== W * dpr || cv.height !== H * dpr) { cv.width = W * dpr; cv.height = H * dpr; }
    const c = cv.getContext("2d"); c.setTransform(dpr, 0, 0, dpr, 0, 0); c.clearRect(0, 0, W, H);
    const X = (d) => ((d - lo) / -lo) * W, Y = (d) => H - ((d - lo) / -lo) * H;
    c.strokeStyle = "rgba(255,255,255,.08)"; c.beginPath();
    for (let d = lo; d <= 0; d += 20) { c.moveTo(X(d), 0); c.lineTo(X(d), H); c.moveTo(0, Y(d)); c.lineTo(W, Y(d)); } c.stroke();
    const on = S.get(P + "on");
    const thr = scale.val(S.get(P + "thr") ?? 1);
    const ratioI = S.get(P + "ratio") ?? 3, ratio = parseFloat(RATIOS[ratioI] || "3");
    const range = isGate ? SCL.grange.val(S.get(P + "range") ?? 1) : 0;
    const out = (d) => { if (isGate) return d < thr ? Math.max(d - range, lo) : d; return d > thr ? thr + (d - thr) / ratio : d; };
    c.beginPath(); for (let i = 0; i <= 80; i++) { const d = lo + (-lo * i) / 80; i ? c.lineTo(X(d), Y(out(d))) : c.moveTo(X(d), Y(out(d))); }
    c.strokeStyle = on ? "#52b6ff" : "#7f8893"; c.lineWidth = 2; c.stroke(); c.lineWidth = 1;
    c.strokeStyle = "rgba(255,182,39,.8)"; c.setLineDash([3, 3]); c.beginPath(); c.moveTo(X(thr), 0); c.lineTo(X(thr), H); c.stroke(); c.setLineDash([]);
    // live level and gain reduction
    const mi = def.meter[0];
    if (metering && mi != null && G.caps && G.caps.meters) {
      const lv = meters.b[mi] / 2.55 - 80;
      if (lv > lo) { c.beginPath(); c.arc(X(lv), Y(out(lv)), 4, 0, 7); c.fillStyle = "#fff"; c.fill(); }
      const gi = isGate ? def.gate : def.gr;
      if (gi != null && meters.b[gi] > 0) {  // 0 = no data; a real console sends 1.0 for no reduction
        const gr = clamp((80 - (meters.b[gi] / 2.55)) / 30);
        c.fillStyle = "rgba(255,77,85,.9)"; c.fillRect(W - 6, 0, 6, gr * H);
      }
    }
  }
  loop();
  let st = null;
  box.addEventListener("pointerdown", (e) => { e.preventDefault(); box.setPointerCapture(e.pointerId); st = { y: e.clientY, v: S.get(P + "thr") ?? 1 }; });
  box.addEventListener("pointermove", (e) => { if (st) set(P + "thr", clamp(st.v + ((st.y - e.clientY) / box.clientHeight) * (e.shiftKey ? .2 : 1))); });
  box.addEventListener("pointerup", () => (st = null)); box.addEventListener("pointercancel", () => (st = null));
  return box;
}
export { on };
