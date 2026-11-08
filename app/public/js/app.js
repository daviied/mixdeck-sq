// Shell: login, navigation, keys.
import { S, G, $, el, api, set, store, openStream, events, undo, canUndo, stripDef, layerStrips, toast } from "./core.js";
import { buildMix, select } from "./mix.js";
import { buildInspector, initInspector, closePop } from "./inspector.js";
import { buildSettings, applyDisplay } from "./pages.js";
import { buildDesk, selectFromConsole } from "./desk.js";
import { isFollow, followTabs, enterFollow, exitFollow, initFollow, buildFollowPage } from "./follow.js";

const ICON = {
  desk: "M4 3h16v8H4zM7 14v7M12 14v7M17 14v7M5 17h4M10 15h4M15 19h4",
  mix: "M6 3v8m0 4v6M12 3v2m0 4v12M18 3v10m0 4v4M4 11h4v4H4zM10 5h4v4h-4zM16 13h4v4h-4z",
  settings: "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1",
};
const VIEWS = [["mix", "Mix"], ["desk", "DiGiCo"], ["settings", "Settings"]];

function drawNav() {
  if (isFollow()) return followTabs();
  const n = $("#views"); n.innerHTML = "";
  for (const [k, t] of VIEWS) {
    const b = el("button", k === G.view ? "on" : "");
    b.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="${ICON[k]}"/></svg>`;
    b.append(t); b.onclick = () => go(k); n.append(b);
  }
}
const BUILD = { mix: () => { buildMix(); buildInspector({}); }, desk: () => { buildMix(); selectFromConsole(); buildDesk(); }, settings: buildSettings, follow: buildFollowPage };
function go(v) {
  if (!BUILD[v]) v = "mix";
  if (v !== "desk") closePop();
  G.view = v; if (!isFollow()) store.set("view", v);
  drawNav();
  document.querySelectorAll(".view").forEach((s) => s.classList.toggle("on", s.id === "v-" + v));
  BUILD[v]();
}
document.addEventListener("goto", (e) => go(e.detail));

function drawConsoles() {
  const box = $("#consoles"); box.innerHTML = "";
  const st = G.status.A;
  if (st) {
    const b = el("button", "on"), d = el("span", "dot " + (st.connected ? "ok" : "bad"));
    b.append(d, el("b", null, st.name || "SQ"));
    b.title = st.info;
    b.onclick = () => go("settings");
    box.append(b);
  }
  const rb = $("#readBar");
  rb.hidden = !st || !st.connected || st.progress >= .995;
  if (st) rb.firstChild.style.width = st.progress * 100 + "%";
}

events.addEventListener("full", () => {
  if (G.caps && !stripDef(G.selected)) G.selected = "/ch/01";
  drawConsoles();
  $("#follow").hidden = !G.caps; $("#clearSolo").hidden = true; $("#mon").innerHTML = "";
  if (isFollow()) return;  // follow.js handles its own rebuild
  BUILD[G.view]();
});
events.addEventListener("status", drawConsoles);
events.addEventListener("undo", () => ($("#undo").disabled = !canUndo()));

$("#undo").onclick = undo;
// Full screen. iPhone Safari has no full screen for pages: there the button stays hidden.
{
  const root = document.documentElement, btn = $("#fullscreen");
  const enter = root.requestFullscreen || root.webkitRequestFullscreen;
  const leave = document.exitFullscreen || document.webkitExitFullscreen;
  const now = () => document.fullscreenElement || document.webkitFullscreenElement;
  btn.hidden = !enter;
  btn.onclick = () => { try { Promise.resolve(now() ? leave.call(document) : enter.call(root)).catch((e) => toast(e.message, true)); } catch (e) { toast(e.message, true); } };
  const draw = () => { const on = !!now(); btn.classList.toggle("on", on); btn.title = on ? "Exit full screen" : "Full screen"; btn.setAttribute("aria-label", btn.title); };
  document.addEventListener("fullscreenchange", draw); document.addEventListener("webkitfullscreenchange", draw);
}
$("#follow").title = "Show the channel selected on the console";
$("#follow").onclick = () => (isFollow() ? exitFollow() : enterFollow(true));

document.addEventListener("keydown", (e) => {
  if (/INPUT|SELECT|TEXTAREA/.test(e.target.tagName)) return;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") { e.preventDefault(); undo(); return; }
  const desk = G.view === "desk";
  if (e.ctrlKey || e.metaKey || e.altKey || (G.view !== "mix" && !desk) || !G.caps) return;
  const list = [...document.querySelectorAll(desk ? "#dstrips .strip" : "#strips .strip")].map((x) => x.dataset.base);
  const d = stripDef(G.selected), key = e.key.toLowerCase();
  if (!desk && key >= "1" && key <= "6") { G.layer = ["in", "aux", "bus", "mtx", "dca", "fav"][+key - 1]; buildMix(); }
  else if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
    e.preventDefault();
    const n = list[list.indexOf(G.selected) + (e.key === "ArrowRight" ? 1 : -1)];
    if (n) { select(n); document.querySelector(`#strips .strip[data-base="${n}"]`)?.scrollIntoView({ inline: "nearest", block: "nearest" }); }
  } else if (key === "m" && d) set(d.on, S.get(d.on) === 0 ? 1 : 0);
  else if (!desk && key === "i") { store.set("inspOpen", !store.get("inspOpen", true)); buildInspector({}); buildMix(); }
});
let lastW = innerWidth <= 760;
addEventListener("resize", () => { const n = innerWidth <= 760; if (n !== lastW) { lastW = n; if (G.view === "mix") BUILD.mix(); } });

async function start() {
  $("#login").hidden = true; $("#app").hidden = false;
  G.meta = await api("/api/meta");
  G.slot = "A"; G.layer = store.get("layer", "in"); G.view = store.get("view", "mix");
  initInspector(); initFollow(go);
  openStream(); go(G.view);
}
$("#loginForm").onsubmit = async (e) => {
  e.preventDefault();
  try { await api("/api/login", { password: $("#pw").value }); location.reload(); }
  catch (err) { $("#loginErr").textContent = err.message; }
};
applyDisplay();
if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
fetch("/api/auth").then((r) => r.json()).then((j) => { if (j.authed) start(); else $("#login").hidden = false; }).catch(() => ($("#login").hidden = false));
export { toast, layerStrips };
