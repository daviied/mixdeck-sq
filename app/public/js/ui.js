// Reusable controls: parameter rows, toggles, selects, fader drag. Bound to a path through a scope.
import { S, set, el, clamp, FADER, f2db, db2f, api, G } from "./core.js";

// Relative drag: a touch never makes the value jump.
export function drag(node, { get, put, axis = "x", span, onStart, onEnd, reset }) {
  node.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || e.target.tagName === "INPUT") return;
    if (document.body.classList.contains("learning")) return;
    e.preventDefault();
    node.setPointerCapture(e.pointerId);
    const st = { x: e.clientX, y: e.clientY, v: get() };
    let moved = false;
    const size = () => (span ? span() : (axis === "x" ? node.clientWidth : node.clientHeight)) || 100;
    const mv = (ev) => {
      if (ev.pointerId !== e.pointerId) return;
      const d = axis === "x" ? ev.clientX - st.x : st.y - ev.clientY;
      if (Math.abs(d) > 1) moved = true;
      const k = ev.shiftKey ? .2 : 1;
      if (moved) put(clamp(st.v + (d / size()) * k));
    };
    const up = (ev) => {
      if (ev.pointerId !== e.pointerId) return;
      node.removeEventListener("pointermove", mv); node.removeEventListener("pointerup", up); node.removeEventListener("pointercancel", up);
      onEnd && onEnd(moved);
    };
    node.addEventListener("pointermove", mv); node.addEventListener("pointerup", up); node.addEventListener("pointercancel", up);
    onStart && onStart();
  });
  node.addEventListener("wheel", (e) => {
    e.preventDefault();
    put(clamp(get() - Math.sign(e.deltaY) * (e.shiftKey ? .002 : .01)));
  }, { passive: false });
  if (reset !== undefined) node.addEventListener("dblclick", () => put(reset));
}

// Label + value + fill. Drag sideways to change, double click to type, wheel to nudge.
export function pr(sc, path, label, scale, opt = {}) {
  const r = el("div", "pr"); if (opt.color) r.style.setProperty("--pc", opt.color);
  const fill = el("div", "fill"), lb = el("span", "lb", label), vl = el("span", "vl");
  r.append(fill, lb, vl);
  const get = () => S.get(path) ?? 0;
  sc.on(path, (v) => { v = v ?? 0; fill.style.width = v * 100 + "%"; vl.textContent = scale.fmt(v); });
  let last = 0;
  drag(r, { get, put: (v) => set(path, v) });
  r.addEventListener("pointerup", () => { // our own double tap: dblclick is unreliable on touch and fights the drag
    const n = performance.now();
    if (n - last < 320) edit();
    last = n;
  });
  function edit() {
    if (r.querySelector("input")) return;
    const i = el("input"); i.value = scale.fmt(get()).replace(/[^\d.\-+kKLRC]/g, "");
    i.inputMode = "decimal"; r.append(i); i.focus(); i.select();
    const done = (ok) => { if (ok && i.value.trim() !== "") { const n = scale.parse(i.value); if (!Number.isNaN(n)) set(path, n); } i.remove(); };
    i.onkeydown = (e) => { if (e.key === "Enter") done(true); if (e.key === "Escape") done(false); e.stopPropagation(); };
    i.onblur = () => done(true);
    i.onpointerdown = (e) => e.stopPropagation();
  }
  return r;
}

export function tog(sc, path, label, cls = "", opt = {}) {
  const b = el("button", "tog " + cls, label);
  const inv = opt.invert;
  sc.on(path, (v) => b.classList.toggle("on", inv ? !v : !!v));
  let armed = 0;
  b.onclick = () => {
    const cur = S.get(path) ? 1 : 0;
    if (opt.confirm && !cur && performance.now() - armed > 2500) { armed = performance.now(); window.toast(opt.confirm); return; }
    set(path, cur ? 0 : 1);
  };
  return b;
}

export function enumSel(sc, path, label, opts) {
  const w = el("label", "es"); w.append(el("span", null, label));
  const s = el("select"); opts.forEach((t, i) => s.append(new Option(t, i)));
  sc.on(path, (v) => { s.value = v ?? 0; });
  s.onchange = () => set(path, +s.value);
  w.append(s); return w;
}

export function bitButtons(sc, path, count, cls, labels) {
  const g = el("div", "bits " + cls);
  for (let i = 0; i < count; i++) {
    const b = el("button", null, labels ? labels[i] : i + 1);
    const bit = 1 << i;
    sc.on(path, (v) => b.classList.toggle("on", !!((v || 0) & bit)));
    b.onclick = () => set(path, (S.get(path) || 0) ^ bit);
    g.append(b);
  }
  return g;
}

export function chead(sc, title, onPath, node) {
  const h = el("div", "chead"); h.append(el("h3", null, title));
  if (onPath) {
    const t = tog(sc, onPath, "ON"); h.append(t);
    sc.on(onPath, (v) => node.classList.toggle("off", !v));
  }
  return h;
}

export { FADER, f2db, db2f, api, G };
