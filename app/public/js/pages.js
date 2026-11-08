// Settings page.
import { G, $, el, api, toast, store, openStream } from "./core.js";
import { learnBlock } from "./follow.js";

export async function buildSettings() {
  const v = $("#v-settings"); v.innerHTML = "";
  const w = el("div");
  const { config: c, status } = await api("/api/console");
  const st = status.A;
  const sec = el("div", "sec"); sec.append(el("h2", null, "Console"));
  const card = el("div", "consolecard");
  const fld = (t, n) => { const l = el("label", "field", t); l.append(n); return l; };
  const ip = el("input"); ip.value = c.ip || ""; ip.placeholder = "192.168.1.50"; ip.inputMode = "decimal";
  const nm = el("input"); nm.value = c.name || ""; nm.maxLength = 24;
  const ch = el("select"); for (let i = 1; i <= 16; i++) ch.append(new Option(`MIDI channel ${i}`, i));
  ch.value = c.midiCh || 1;
  const nat = el("label", "chk"), nc = el("input"); nc.type = "checkbox"; nc.checked = c.native !== false;
  nat.append(nc, "Native connection (names, processing, select)");
  for (const i of [ip, nm]) i.onkeydown = (e) => e.stopPropagation();
  const save = el("button", "primary", "Save");
  save.onclick = async () => {
    try { await api("/api/console", { console: { ip: ip.value, name: nm.value, midiCh: +ch.value, native: nc.checked } }); toast("Console saved"); setTimeout(() => { openStream(); buildSettings(); }, 300); }
    catch (e) { toast(e.message, true); }
  };
  const s = el("span", "pill" + (st && st.connected ? " ok" : ""), st ? st.info : "Not set");
  card.append(fld("Name", nm), fld("IP address", ip), fld("SQ MIDI channel", ch), nat);
  const rw = el("div", "field"); rw.append(s, save); card.append(rw);
  sec.append(card);
  sec.append(el("p", "note", "On the SQ: Utility, General, MIDI. Set the MIDI channel to match, and NRPN Fader Law to Linear Taper. Levels, mutes, pan and sends use the SQ MIDI protocol (TCP 51325). Names, preamp, HPF, gate, EQ, comp, delay and the console select use the MixPad protocol (TCP 51326). Allen & Heath does not publish that protocol; turn it off if it causes problems."));
  const rd = el("button", null, "Re-read console");
  rd.onclick = () => api("/api/refresh", {}).then(() => toast("Reading console"));
  const r = el("div", "row"); r.append(rd); sec.append(r);
  w.append(sec);

  const fs = el("div", "sec"); fs.append(el("h2", null, "Console select"), learnBlock()); w.append(fs);
  if (c.native !== false) w.append(await meterBlock());

  const ui = el("div", "sec"); ui.append(el("h2", null, "Display"));
  const row = el("div", "row");
  const size = el("div", "seg");
  for (const [t, px] of [["S", 14], ["M", 16], ["L", 18], ["XL", 21]]) {
    const b = el("button", store.get("size", 16) === px ? "on" : "", t);
    b.onclick = () => { store.set("size", px); applyDisplay(); buildSettings(); }; size.append(b);
  }
  const th = el("div", "seg");
  for (const [k, t] of [["dark", "Dark"], ["light", "Daylight"]]) {
    const b = el("button", store.get("theme", "dark") === k ? "on" : "", t);
    b.onclick = () => { store.set("theme", k); applyDisplay(); buildSettings(); }; th.append(b);
  }
  row.append(el("span", "note", "Size"), size, el("span", "note", "Theme"), th); ui.append(row);
  ui.append(el("p", "note", "Keys: 1-6 layers, ← → channel, M mute, I channel panel, Ctrl+Z undo. Shift while dragging for fine moves. Double click a value to type it. Double click a fader for 0 dB."));
  w.append(ui);
  const out = el("div", "sec"); const lo = el("button", null, "Log out");
  lo.onclick = async () => { await api("/api/logout", {}); location.reload(); };
  out.append(lo);
  if (G.meta && G.meta.mock) out.prepend(el("p", "warn", "Demo mode: this runs on a simulated SQ (SQ_MOCK=1)."));
  w.append(out); v.append(w);
}

// Meters and RTA come over UDP in a layout nobody has published. The default is a guess; edit it here.
async function meterBlock() {
  const sec = el("div", "sec"); sec.append(el("h2", null, "Meters and RTA"));
  const m = await api("/api/meter");
  const s = m.stats, sizes = Object.entries(s.sizes).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, n]) => `${k} B ×${n}`).join(", ");
  sec.append(el("p", "note", `UDP port ${m.port ?? "–"}. Packets: ${s.packets} (${sizes || "none"}). Decoded: ${s.meters} meter, ${s.rta} RTA.` + (s.last ? ` Last starts: ${s.last}` : "")));
  sec.append(el("p", "note", "The SQ meter format is not published. The layout below is a guess. If the meters look wrong, play a tone into one input, record 10 s with a note, and download the file for decoding. Layout: header (auto or bytes to skip), enc (le16db, be16db, u8, f32), minValues (meter packet size), map rows [from, to, count, lvl | gain | gr], rtaMin / rtaMax (RTA packet size). Targets: 0-47 inputs, 48-55 FX returns, 56-71 aux and FX sends, 72-74 matrix, 75-76 LR, 77-124 gate, 125-185 comp."));
  const ta = el("textarea"); ta.rows = 8; ta.style.width = "100%"; ta.style.fontFamily = "monospace"; ta.spellcheck = false;
  ta.value = JSON.stringify(m.cfg, null, 1); ta.onkeydown = (e) => e.stopPropagation();
  const save = el("button", "primary", "Save layout"), def = el("button", null, "Default");
  save.onclick = async () => { try { await api("/api/meter", { cfg: JSON.parse(ta.value) }); toast("Meter layout saved"); } catch (e) { toast(e.message, true); } };
  def.onclick = async () => { try { await api("/api/meter", { cfg: "default" }); toast("Default layout"); buildSettings(); } catch (e) { toast(e.message, true); } };
  const note = el("input"); note.placeholder = "Note, e.g. -18 dB tone on input 1 only"; note.style.flex = "1"; note.onkeydown = (e) => e.stopPropagation();
  const rec = el("button", null, "Record 10 s"), dl = el("a", "pill", "Download recording");
  dl.href = "/api/meter/capture"; dl.hidden = !m.capture;
  rec.onclick = async () => {
    rec.disabled = true; rec.textContent = "Recording…";
    try { const j = await api("/api/meter/record", { secs: 10, note: note.value }); toast(`${j.packets} packets recorded`); dl.hidden = false; }
    catch (e) { toast(e.message, true); }
    rec.disabled = false; rec.textContent = "Record 10 s";
  };
  const r1 = el("div", "row"); r1.append(save, def);
  const r2 = el("div", "row"); r2.append(note, rec, dl);
  sec.append(ta, r1, r2);
  return sec;
}

export function applyDisplay() {
  document.documentElement.style.setProperty("--size", store.get("size", innerWidth <= 760 ? 14 : 16) + "px");
  document.documentElement.dataset.theme = store.get("theme", "dark");
}
