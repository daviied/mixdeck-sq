// DiGiCo-style desk: fader banks, one touch column per channel, a rotary per fader.
import { S, G, $, el, set, scope, stripDef, layerStrips, stripColor, fmtDb, db2f, meters, faderPath, onPath, store, clamp, SCL, FADER, events, onAny, ownRecent } from "./core.js";
import { drag, tog } from "./ui.js";
import { eqThumb, makeMeter, deskMeters, select, SCALE } from "./mix.js";
import { openFull, openSection, closePop, HAS } from "./inspector.js";

const LAYERS = [["in", "Inputs"], ["aux", "FX returns"], ["bus", "Aux / FX sends"], ["mtx", "Matrix"], ["dca", "DCA"], ["fav", "★"]];
const pad = (n, w = 2) => String(n).padStart(w, "0");
let sc = scope(), layer = store.get("deskLayer", "in"), page = store.get("deskPage", 0), lastN = 0;
let grs = [];

const isPhone = () => innerWidth <= 760;
const screenOnly = () => store.get("deskScreen", false);
const SEL = "/-stat/sel";
const selSync = () => store.get("deskSelSync", true);
function bankSize() {
  const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
  const side = isPhone() ? 0 : (7.5 + (G.caps && G.caps.mono ? 2 : 1) * 5.6) * rem;
  return clamp(Math.floor((innerWidth - side) / (4.4 * rem)), isPhone() ? 3 : 4, 12);
}
const listOf = (k) => { const l = layerStrips(k); return k === "bus" && isPhone() ? [...l, "/main/st"] : l; };

// What the rotary above each fader controls.
function rotFn() { const f = store.get("deskRot", "gain"); return !G.caps.proc && (f === "gain" || f === "hpf") ? "pan" : f; }
function rotaryFor(def) {
  const f = rotFn(), b = def.base, k = def.kind;
  if (f === "gain") {
    const ha = (G.sources[b] || {}).ha;
    if (ha != null) return { path: `/headamp/${pad(ha, 3)}/gain`, scale: SCL.ha };
    return k === "ch" ? { path: b + "/preamp/trim", scale: SCL.trim, reset: .5, bi: true } : null;
  }
  if (f === "pan") return HAS.pan(def) ? { path: b + "/mix/pan", scale: SCL.pan, reset: .5, bi: true } : null;
  if (f === "hpf") return k === "ch" ? { path: b + "/preamp/hpf", scale: SCL.hpf } : null;
  if (f.startsWith("send:")) return ["ch", "fxrtn"].includes(k) ? { path: `${b}/mix/${pad(+f.slice(5))}/level`, scale: FADER, reset: db2f(0) } : null;
  return null;
}

function knobParts() {
  const NS = "http://www.w3.org/2000/svg", svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 40 40");
  const ring = (cls) => {
    const c = document.createElementNS(NS, "circle");
    c.setAttribute("cx", 20); c.setAttribute("cy", 20); c.setAttribute("r", 17); c.setAttribute("pathLength", 100);
    c.setAttribute("transform", "rotate(135 20 20)"); c.setAttribute("class", cls); return c;
  };
  const back = ring("rb"), val = ring("rv");
  const knob = document.createElementNS(NS, "circle");
  knob.setAttribute("cx", 20); knob.setAttribute("cy", 20); knob.setAttribute("r", 12); knob.setAttribute("class", "rk");
  const tick = document.createElementNS(NS, "line");
  tick.setAttribute("x1", 20); tick.setAttribute("x2", 20); tick.setAttribute("y1", 9); tick.setAttribute("y2", 15); tick.setAttribute("class", "rt");
  svg.append(back, val, knob, tick);
  return { svg, val, tick };
}

// One send as a knob: drag sets the level, a tap turns the send on or off.
function sendKnob(P, i, hi, title) {
  const w = el("div", "dsk" + (hi ? " hi" : "")), { svg, val, tick } = knobParts();
  w.title = title;
  w.append(svg, el("span", null, i));
  sc.on(P + "level", (v) => {
    v = v ?? 0;
    val.setAttribute("stroke-dasharray", `${Math.max(v * 75, .6)} 100`);
    tick.setAttribute("transform", `rotate(${v * 270 - 135} 20 20)`);
  });
  sc.on(P + "on", (x) => w.classList.toggle("off", x === 0));
  let moved = false;
  drag(w, { get: () => S.get(P + "level") ?? 0, put: (v) => { moved = true; set(P + "level", v); }, axis: "y", span: () => 220 });
  w.addEventListener("click", (e) => {
    if (document.body.classList.contains("learning")) return;
    e.stopPropagation();
    if (moved) { moved = false; return; }
    set(P + "on", S.get(P + "on") === 0 ? 1 : 0);
  });
  return w;
}
const sendStyle = () => store.get("deskSendStyle", "bars");

function rotary(def) {
  const w = el("div", "drot"), r = rotaryFor(def);
  const { svg, val, tick } = knobParts();
  const txt = el("span", "rval", "–");
  w.append(svg, txt);
  if (!r) { w.classList.add("off"); return w; }
  sc.on(r.path, (v) => {
    v = v ?? 0; txt.textContent = r.scale.fmt(v);
    const a = r.bi ? Math.min(v, .5) : 0, len = r.bi ? Math.abs(v - .5) : v;
    val.setAttribute("stroke-dasharray", `${Math.max(len * 75, .6)} 100`);
    val.setAttribute("stroke-dashoffset", -a * 75);
    tick.setAttribute("transform", `rotate(${v * 270 - 135} 20 20)`);
  });
  drag(w, { get: () => S.get(r.path) ?? 0, put: (v) => set(r.path, v), axis: "y", span: () => 220, reset: r.reset });
  return w;
}

// One touch section. A tap selects the channel and runs the action.
function section(name, base, act) {
  const d = el("div", "ds ds-" + name);
  if (act) { d.classList.add("tap"); d.onclick = () => { if (document.body.classList.contains("learning")) return; const was = G.selected; select(base); act(was); }; }
  return d;
}
const none = (name) => el("div", `ds ds-${name} none`);
function tag(path, label, cls) {
  const t = tog(sc, path, label, "dt " + cls);
  t.addEventListener("click", (e) => e.stopPropagation());
  return t;
}
function dynRow(name, def, path, label, scale, gi, pageName) {
  const d = section(name, def.base, (was) => openSection(pageName, was));
  const v = el("span", "dv");
  sc.on(path + "/thr", (x) => (v.textContent = scale.fmt(x ?? 0).replace(" dB", "")));
  sc.on(path + "/on", (x) => d.classList.toggle("off", !x));
  d.append(tag(path + "/on", label, name), v);
  // As on a DiGiCo: the gate has three lights (open, reducing, closed), the comp a gain reduction meter.
  if (gi == null || !G.caps.meters) return d;
  if (name === "gate" && store.get("deskGateLeds", true)) {
    const w = el("div", "dgl"), red = el("i", "r"), amb = el("i", "a"), grn = el("i", "g");
    w.title = "Gate: green open, amber reducing, red closed";
    w.append(red, amb, grn); d.append(w); d.classList.add("lt");
    grs.push({ i: gi, gate: { red, amb, grn }, on: path + "/on", range: path + "/range", last: "" });
  } else if (name === "comp" && store.get("deskCompMeter", true)) {
    const w = el("div", "dcm"), bar = el("i");
    w.title = "Compressor gain reduction, 0 to 24 dB";
    w.append(bar); d.append(w); d.classList.add("lt");
    grs.push({ i: gi, bar, last: -1 });
  }
  return d;
}

// The SQ has one insert per channel. A tap turns it on or off.
function insRow(base) {
  const d = section("ins", base, null), p = base + "/insert/on";
  d.append(tag(p, "INS", "ins"), el("span", "dv"));
  sc.on(p, (x) => d.classList.toggle("off", !x));
  return d;
}
function rename(host, def) {
  if ($("#dname")) return;
  const path = def.base + "/config/name", i = el("input"), r = host.getBoundingClientRect();
  i.id = "dname"; i.maxLength = G.caps.nameLen || 6;
  i.value = S.get(path) || ""; i.placeholder = def.label; i.setAttribute("aria-label", `Name of ${def.label}`);
  document.body.append(i);
  i.style.left = Math.max(4, Math.min(r.left, innerWidth - i.offsetWidth - 4)) + "px";
  i.style.top = r.top + (r.height - i.offsetHeight) / 2 + "px";
  let done = false;
  const end = (save) => {
    if (done) return;
    done = true;
    if (save && i.value !== (S.get(path) || "")) set(path, i.value);
    i.remove();
  };
  i.onblur = () => end(true);
  i.onkeydown = (e) => {
    e.stopPropagation();
    if (e.key === "Enter") end(true);
    if (e.key === "Escape") end(false);
  };
  i.focus(); i.select();
}

function buildStrip(base, master) {
  const def = stripDef(base), k = def.kind, full = false, proc = G.caps.proc, s = el("div", "strip dstrip" + (master ? " master" : ""));
  s.dataset.base = base;
  const fp = faderPath(def), op = onPath(def), isSof = fp !== def.fader;
  if (isSof) s.classList.add("sof");
  if (k !== "dca") sc.on(base + "/config/color", (v) => s.style.setProperty("--c", stripColor(v)));
  if (k === "st" && !S.get(base + "/config/color")) s.style.setProperty("--c", "#f2f4f6");
  const has = {
    input: proc && HAS.input(def), hpf: proc && k === "ch", gate: proc && HAS.gate(def), eq: proc && HAS.eq(def), comp: proc && HAS.comp(def),
    ins: proc && k === "ch", sends: HAS.sends(def), pan: HAS.pan(def),
  };
  const e = G.sources[base] || {}, scr = el("div", "dscreen");

  // Meters first. Without faders, this row also shows level, mute and solo.
  const lvl = el("div", "ds ds-lvl"), showM = G.caps.meters && store.get("deskMeters", true);
  if (showM) {
    const mw = el("div", "dlm");
    def.meter.forEach((i) => mw.append(makeMeter(G.caps.meters && !isSof ? i : null, deskMeters)));
    if (!def.meter.length) mw.append(makeMeter(null, deskMeters));
    lvl.append(mw);
  } else lvl.classList.add("nom");
  if (screenOnly()) {
    const info = el("div", "dli"), fv = el("b", "dlv"), m = el("span", "dbadge bm", "M");
    sc.on(fp, (v) => (fv.textContent = fmtDb(v ?? 0)));
    sc.on(op, (v) => { const x = v === 0; m.classList.toggle("on", x); s.classList.toggle("muted", x); });
    info.append(fv, m);
    if (full) {
      const sp = `/-stat/solosw/${pad(def.solo)}`, so = el("span", "dbadge bs", "S");
      sc.on(sp, (v) => so.classList.toggle("on", !!v));
      info.append(so);
    }
    lvl.append(info);
  }
  if (showM || screenOnly()) scr.append(lvl);

  // Source: the tap patches this input, as on the desk.
  if (k === "ch") {
    const d = section("src", base, null);
    d.append(el("span", "dl", "IN"), el("b", null, `Ip ${def.n}`));
    scr.append(d);
  } else scr.append(none("src"));

  // Gain, with 48 V and phase state. A tap opens the input menu.
  if (has.input) {
    const d = section("gain", base, () => openFull("config")), v = el("div", "dgv");
    const gp = e.ha != null ? `/headamp/${pad(e.ha, 3)}/` : null;
    const path = gp ? gp + "gain" : base + "/preamp/trim", scale = gp ? SCL.ha : SCL.trim;
    sc.on(path, (x) => (v.textContent = scale.fmt(x ?? 0).replace(" dB", "")));
    let moved = false;
    drag(v, { get: () => S.get(path) ?? 0, put: (x) => { moved = true; set(path, x); }, axis: "y", span: () => 220 });
    v.addEventListener("click", (ev) => { if (moved) { ev.stopPropagation(); moved = false; } });
    // 48 V and phase are set in the menu. Here they only show state.
    const r = el("div", "dgb"), ind = (p, t, c) => { const i = el("span", "dgi " + c, t); sc.on(p, (x) => i.classList.toggle("on", !!x)); r.append(i); };
    if (gp) ind(gp + "phantom", "48V", "p48");
    ind(base + "/preamp/invert", "Ø", "inv");
    d.append(v, r); scr.append(d);
  } else scr.append(none("gain"));

  if (has.hpf) {
    const d = section("hpf", base, () => openFull("config")), v = el("span", "dv");
    sc.on(base + "/preamp/hpf", (x) => (v.textContent = SCL.hpf.fmt(x ?? 0)));
    d.append(tag(base + "/preamp/hpon", "HPF", "hpf"), v); scr.append(d);
  } else scr.append(none("hpf"));

  scr.append(has.ins ? insRow(base) : none("ins"));

  if (has.eq) {
    const d = section("eq", base, (was) => openSection("eq", was));
    sc.on(base + "/eq/on", (x) => d.classList.toggle("off", !x));
    d.append(tag(base + "/eq/on", "EQ", "eq"), eqThumb(sc, base, def)); scr.append(d);
  } else scr.append(none("eq"));

  scr.append(has.gate ? dynRow("gate", def, base + "/gate", "GATE", SCL.gthr, def.gate, "gate") : none("gate"));
  scr.append(has.comp ? dynRow("comp", def, base + "/dyn", "COMP", SCL.thr, def.gr, "dyn") : none("comp"));

  const showSends = store.get("deskSends", true);
  if (has.sends && showSends) {
    const toMtx = ["bus", "st"].includes(k), n = toMtx ? G.caps.mtx : G.caps.bus, d = section("send", base, () => openFull("sends"));
    const hi = rotFn().startsWith("send:") && !toMtx ? +rotFn().slice(5) : 0;
    if (sendStyle() === "bars") {
      const g = el("div", "dsg"); g.style.setProperty("--n", n > 8 ? 8 : n);
      for (let i = 1; i <= n; i++) {
        const P = `${base}/mix/${pad(i)}/`, c = el("span", i === hi ? "hi" : ""), f = el("i"); c.append(f);
        sc.on(P + "level", (x) => (f.style.height = (x ?? 0) * 100 + "%"));
        sc.on(P + "on", (x) => c.classList.toggle("off", x === 0));
        g.append(c);
      }
      d.append(g);
    } else {
      // A tap on the header opens the sends page.
      const from = sendStyle() === "k2" && !toMtx && n > 8 ? 9 : 1, to = Math.min(n, from + 7), kg = el("div", "dskg");
      for (let i = from; i <= to; i++) kg.append(sendKnob(`${base}/mix/${pad(i)}/`, i, i === hi, toMtx ? `Matrix ${i}` : S.get(`/bus/${pad(i)}/config/name`) || stripDef(`/bus/${pad(i)}`).label));
      d.classList.add("knobs");
      d.append(el("div", "dskh", `${toMtx ? "MTX" : "AUX"} ${from}-${to}`), kg);
    }
    scr.append(d);
  } else if (showSends) scr.append(none("send"));

  if (has.pan && !isSof) {
    const pp = base + "/mix/pan", d = el("div", "ds ds-pan"), bar = el("i"), v = el("span", "dpv");
    sc.on(pp, (x) => { x = x ?? .5; bar.style.left = Math.min(x, .5) * 100 + "%"; bar.style.width = Math.abs(x - .5) * 100 + "%"; v.textContent = SCL.pan.fmt(x); });
    drag(d, { get: () => S.get(pp) ?? .5, put: (x) => set(pp, x), span: () => d.clientWidth * 1.6, reset: .5 });
    d.append(bar, v); scr.append(d);
  } else scr.append(none("pan"));

  // Name: the first tap selects, the next one renames.
  const nm = section("name", base, null);
  nm.classList.add("tap");
  nm.onclick = () => {
    if (G.selected !== base) return select(base);
    if (!document.body.classList.contains("learning")) rename(nm, def);
  };
  const nmt = el("b");
  sc.on(base + "/config/name", (v) => (nmt.textContent = v || (k === "st" ? "Main" : def.label)));
  if (isSof) nm.append(el("span", "dn", `→ ${stripDef(`/bus/${pad(G.sof)}`).label}`));
  nm.append(nmt);
  scr.append(nm);
  s.append(scr);
  if (screenOnly()) return s;

  // Worksurface: rotary, buttons, fader
  const pn = el("div", "dpanel");
  pn.append(rotary(def));
  const btns = el("div", "dbtn");
  const sel = el("button", "bsel", "SEL");
  sel.onclick = () => select(base);
  btns.append(sel);
  if (full) {
    const sp = `/-stat/solosw/${pad(def.solo)}`, bs = el("button", "bs", "SOLO");
    sc.on(sp, (v) => bs.classList.toggle("on", !!v));
    bs.onclick = () => set(sp, S.get(sp) ? 0 : 1);
    btns.append(bs);
  }
  const bm = el("button", "bm", "MUTE");
  sc.on(op, (v) => { const m = v === 0; bm.classList.toggle("on", m); s.classList.toggle("muted", m); });
  bm.onclick = () => set(op, S.get(op) === 0 ? 1 : 0);
  btns.append(bm);
  pn.append(btns);

  const fz = el("div", "fz"), scale = el("div", "scale");
  for (const d of SCALE) { const t = el("span", null, d > 0 ? "+" + d : d); t.style.bottom = db2f(d) * 100 + "%"; scale.append(t); }
  const track = el("div", "track"), zero = el("div", "zero"), cap = el("div", "cap");
  zero.style.bottom = db2f(0) * 100 + "%"; track.append(zero, cap);
  fz.append(scale, track);
  pn.append(fz);
  const fv = el("div", "fv");
  sc.on(fp, (v) => { v = v ?? 0; cap.style.bottom = v * 100 + "%"; fv.textContent = fmtDb(v); });
  drag(track, { get: () => S.get(fp) ?? 0, put: (v) => set(fp, v), axis: "y", reset: db2f(0) });
  pn.append(fv);
  s.append(pn);
  return s;
}

function check(label, key, val, fn) {
  const w = el("label", "dchk"), c = el("input");
  c.type = "checkbox"; c.checked = !!val;
  c.onchange = () => { store.set(key, c.checked); if (fn) fn(c.checked); buildDesk(); };
  w.append(c, label);
  return w;
}

function buildRail(n) {
  const rail = el("div", "drail"), banks = el("div", "dbanks");
  for (const [k, t] of LAYERS) {
    const list = listOf(k);
    if (!list.length) continue;
    const g = el("div", "dgroup"); g.append(el("h3", null, t));
    for (let i = 0; i * n < list.length; i++) {
      const part = list.slice(i * n, (i + 1) * n), a = stripDef(part[0]), z = stripDef(part[part.length - 1]);
      const label = part.length === 1 ? a.label : a.kind === z.kind && a.label.replace(/\d+$/, "") === z.label.replace(/\d+$/, "") ? `${a.label}-${z.label.match(/\d+$/)[0]}` : `${a.label}…${z.label}`;
      const b = el("button", k === layer && i === page ? "on" : "", k === "fav" ? `${i + 1}` : label);
      b.onclick = () => { layer = k; page = i; store.set("deskLayer", k); store.set("deskPage", i); buildDesk(); };
      g.append(b);
    }
    banks.append(g);
  }
  const fn = el("div", "dfn");
  fn.append(check("Hide faders", "deskScreen", screenOnly(), (on) => { if (on) G.sof = 0; }));
  const sync = check("Sync select with console", "deskSelSync", selSync(), (on) => { if (on) selectFromConsole(); });
  if (!G.caps.selLearned) sync.title = "Learn the console select message in Settings first";
  fn.append(sync);
  if (G.caps.meters) {
    fn.append(check("Meters", "deskMeters", store.get("deskMeters", true)));
    fn.append(check("Gate lights", "deskGateLeds", store.get("deskGateLeds", true)));
    fn.append(check("Comp meter", "deskCompMeter", store.get("deskCompMeter", true)));
    fn.append(check("Gate / comp graph metering", "dynMeters", store.get("dynMeters", true)));
  }
  if (G.caps.rta) fn.append(check("EQ RTA", "eqRta", store.get("eqRta", true), () => events.dispatchEvent(new CustomEvent("rtaopt"))));
  fn.append(check("Aux sends", "deskSends", store.get("deskSends", true)));
  if (store.get("deskSends", true)) {
    const st = el("select");
    st.title = "How the strip shows aux sends";
    st.append(new Option("Aux: bars", "bars"), new Option("Aux: knobs 1-8", "k1"), new Option("Aux: knobs 9-16", "k2"));
    st.value = sendStyle();
    if (st.value !== sendStyle()) st.value = "k1";
    st.onchange = () => { store.set("deskSendStyle", st.value); buildDesk(); };
    fn.append(st);
  }
  if (G.caps.proc) fn.append(check("EQ, gate, comp in a window", "deskWindow", store.get("deskWindow", true)));
  if (screenOnly()) {
    const hide = el("button", null, "Hide this panel");
    hide.onclick = () => { store.set("deskRailOff", true); buildDesk(); };
    fn.append(hide);
  } else {
    fn.append(el("h3", null, "Rotary"));
    const rs = el("select");
    rs.title = "What the rotaries control";
    if (G.caps.proc) rs.append(new Option("Gain", "gain"), new Option("HPF", "hpf"));
    rs.append(new Option("Pan", "pan"));
    for (let i = 1; i <= G.caps.bus; i++) { const b = `/bus/${pad(i)}`, nm = S.get(b + "/config/name"); rs.append(new Option(`Send ${stripDef(b).label}${nm ? " " + nm : ""}`, "send:" + i)); }
    rs.value = rotFn();
    rs.onchange = () => { store.set("deskRot", rs.value); buildDesk(); };
    fn.append(rs);
    const f = rotFn(), n2 = f.startsWith("send:") ? +f.slice(5) : 0;
    const flip = el("button", "dflip" + (G.sof ? " on" : ""), G.sof ? `Flip off (${stripDef(`/bus/${pad(G.sof)}`).label})` : "Flip to faders");
    flip.title = "Set Rotary to a send, then show that send on the faders";
    flip.disabled = !G.sof && !n2;
    flip.onclick = () => { G.sof = G.sof ? 0 : n2; buildDesk(); };
    fn.append(flip);
  }
  rail.append(banks, fn);
  return rail;
}

export function buildDesk() {
  sc.dispose(); sc = scope(); deskMeters.length = 0; grs = [];
  const root = $("#v-desk"); root.innerHTML = "";
  if (!G.caps) { root.append(el("div", "empty", "No console set up. Open Settings.")); return; }
  const n = bankSize(); lastN = n;
  const screen = screenOnly();
  root.classList.toggle("screen", screen);
  if (screen && store.get("deskRailOff", false)) {
    const tab = el("button", "drailtab", "⚙"); tab.title = "Show the panel";
    tab.onclick = () => { store.set("deskRailOff", false); buildDesk(); };
    root.append(tab);
  } else root.append(buildRail(n));
  const box = el("div", "dstrips"); box.id = "dstrips";
  {
    let list = listOf(layer);
    if (!list.length) { layer = "in"; list = listOf("in"); }
    const pages = Math.max(1, Math.ceil(list.length / n));
    if (page >= pages) page = pages - 1;
    const part = list.slice(page * n, (page + 1) * n);
    for (const b of part) box.append(buildStrip(b));
    for (let i = part.length; i < n; i++) box.append(el("div", "dstrip blank"));
  }
  root.append(box);
  if (!isPhone()) {
    const m = el("div", "dmasters"); m.id = "dmasters";
    m.append(buildStrip("/main/st", true));
    root.append(m);
  }
  root.querySelectorAll(`.strip[data-base="${G.selected}"]`).forEach((x) => x.classList.add("sel"));
}

// Select the channel the console has selected. With manual banks, also go to the bank that holds it.
export function selectFromConsole() {
  const b = S.get(SEL);
  if (!selSync() || !G.caps || !G.caps.selLearned || !stripDef(b)) return;
  if (b !== G.selected) select(b);
  if (G.view !== "desk") return;
  for (const [k] of LAYERS) {
    const at = k === "fav" ? -1 : listOf(k).indexOf(b);
    if (at < 0) continue;
    const pg = Math.floor(at / (lastN || bankSize()));
    if (k !== layer || pg !== page) { layer = k; page = pg; store.set("deskLayer", k); store.set("deskPage", pg); buildDesk(); }
    return;
  }
}

function grLoop() {
  requestAnimationFrame(grLoop);
  if (G.view !== "desk" || !G.caps || !G.caps.meters) return;
  const fresh = performance.now() - meters.at < 1000;
  for (const g of grs) {
    const b = fresh ? meters.b[g.i] : 0, gr = b > 0 ? Math.max(0, 80 - b / 2.55) : 0; // dB of gain reduction
    if (g.gate) {
      // Closed: at the gate range (less 1.5 dB). Reducing: 1 dB or more. Off or no data: no light.
      const range = Math.max(3, SCL.grange.val(S.get(g.range) ?? 1));
      const st = !fresh || !S.get(g.on) ? "" : gr >= range - 1.5 ? "r" : gr >= 1 ? "a" : "g";
      if (st !== g.last) {
        g.last = st;
        g.gate.red.classList.toggle("on", st === "r"); g.gate.amb.classList.toggle("on", st === "a"); g.gate.grn.classList.toggle("on", st === "g");
      }
      continue;
    }
    const v = Math.round(clamp(gr / 24) * 100);
    if (v !== g.last) { g.last = v; g.bar.style.height = v + "%"; }
  }
}
grLoop();

addEventListener("resize", () => {
  if (G.view !== "desk" || !G.caps) return;
  const n = bankSize();
  if (n !== lastN) { page = Math.floor((page * lastN) / n); buildDesk(); }
});
onAny((p) => {
  if (G.view === "desk" && p === SEL) queueMicrotask(selectFromConsole);
});
events.addEventListener("sources", (e) => {
  if (G.view === "desk" && JSON.stringify(e.detail) !== JSON.stringify(G.sources)) buildDesk();
});
