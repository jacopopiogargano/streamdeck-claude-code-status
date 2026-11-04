// Session Status for Claude Code — Stream Deck plugin.
// One key per iTerm2 session running Claude Code, coloured by what that session needs from you.
// State comes from ~/.claude/session-status/<iTerm session id>.json, written by the bundled hook (src/hook.py, shipped inside bin/hook-src.js).
"use strict";

// Node 20 only exposes WebSocket behind a flag: relaunch ourselves with it.
if (typeof WebSocket === "undefined") {
  const { spawn } = require("child_process");
  const child = spawn(process.execPath, ["--experimental-websocket", "--no-warnings", __filename, ...process.argv.slice(2)],
    { stdio: "inherit" });
  child.on("exit", (code) => process.exit(code ?? 0));
  return;
}

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");
const hooks = require("./hooks.js");

const ACTION = "io.github.jacopopiogargano.ccstatus.session";
const arg = (name) => process.argv[process.argv.indexOf(name) + 1];
const STATUS_DIR = hooks.STATUS_DIR;
const POLL_MS = 2000, FRAME_MS = 250;

// ---------------------------------------------------------------- settings
// Global (all keys): edited in the Property Inspector, stored by Stream Deck as global settings.
const DEFAULTS = {
  // which sessions, in what order
  sort: "start",            // start | newest | tab | urgency | activity | name
  onlyClaude: true,         // hide iTerm sessions that are not running Claude Code
  label: "name",            // name (tab title) | folder
  // more sessions than keys
  maxSessions: 0,           // 0 = one per key
  overflow: "badge",        // badge (+N on last key) | page (last key flips pages) | urgent (keep the most urgent visible)
  // what each key shows
  showModel: true, showEffort: true, showContext: true,
  ctxAmber: 70, ctxPulse: 85,
  breathe: true,            // waiting keys breathe instead of sitting still
  working: "spark",         // spark (animated) | solid
  empty: "walker",          // walker (a little spark wanders empty rows) | blank
  // colours
  cWaiting: "#D93025", cPerm: "#E8710A", cDone: "#0A2C14", cIdle: "#000000", cWorking: "#000000",
  cSpark: "#D97757", cText: "#FFFFFF",
  eLow: "#F5C518", eMedium: "#4EBA65", eHigh: "#B1B9F9", eXhigh: "#AF87FF", eMax: "#FF8A65", maxRainbow: true,
  // smart classification of finished turns (uses the user's own Claude account via `claude -p --model haiku`)
  haiku: false,
};
let cfg = { ...DEFAULTS };

function applyGlobal(g) {
  cfg = { ...DEFAULTS, ...(g || {}) };
  cfg.maxSessions = Math.max(0, parseInt(cfg.maxSessions, 10) || 0);
  cfg.ctxAmber = Number(cfg.ctxAmber) || DEFAULTS.ctxAmber;
  cfg.ctxPulse = Number(cfg.ctxPulse) || DEFAULTS.ctxPulse;
  hooks.writeHookConfig({ haiku: !!cfg.haiku });
  lastImage.clear();
  render();
}

// ---------------------------------------------------------------- Stream Deck socket
const keys = new Map();       // context -> slot (1-based)
let sessions = [];            // sorted, filtered iTerm sessions
const lastImage = new Map();
let frame = 0, page = 0;

const ws = new WebSocket(`ws://127.0.0.1:${arg("-port")}`);
const pluginUUID = arg("-pluginUUID");
const send = (msg) => ws.readyState === 1 && ws.send(JSON.stringify(msg));

ws.onopen = () => {
  send({ event: arg("-registerEvent"), uuid: pluginUUID });
  send({ event: "getGlobalSettings", context: pluginUUID });
};
ws.onclose = () => process.exit(0);
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.event === "didReceiveGlobalSettings") return applyGlobal(m.payload?.settings);
  if (m.action && m.action !== ACTION) return;
  if (m.event === "willAppear" || m.event === "didReceiveSettings") {
    keys.set(m.context, Math.max(1, Number(m.payload?.settings?.slot) || 1));
    lastImage.delete(m.context);
    render();
  } else if (m.event === "willDisappear") {
    keys.delete(m.context);
    lastImage.delete(m.context);
  } else if (m.event === "keyDown") {
    const item = layout().bySlot.get(keys.get(m.context) || 1);
    if (item?.pager) { page++; lastImage.clear(); render(); }
    else if (item?.s) focus(item.s);
    else send({ event: "showAlert", context: m.context });
  } else if (m.event === "sendToPlugin") {
    onInspector(m);
  }
};

// Property Inspector requests: hook status / preview / install / remove, global settings echo
function onInspector(m) {
  const reply = (payload) => send({ event: "sendToPropertyInspector", action: ACTION, context: m.context, payload });
  const p = m.payload || {};
  try {
    if (p.type === "setGlobal") applyGlobal(p.settings);
    else if (p.type === "hookStatus") reply({ type: "hookStatus", ...hooks.status() });
    else if (p.type === "hookPreview") reply({ type: "hookPreview", ...hooks.preview() });
    else if (p.type === "hookInstall") reply({ type: "hookResult", ...hooks.install(), status: hooks.status() });
    else if (p.type === "hookRemove") reply({ type: "hookResult", ...hooks.remove(), status: hooks.status() });
  } catch (err) {
    reply({ type: "hookResult", ok: false, message: String(err.message || err) });
  }
}

// ---------------------------------------------------------------- iTerm2 via JXA (never launches iTerm)
const LIST_JS = `
const app = Application("iTerm2");
if (!app.running()) { "[]" } else {
  const out = [];
  let focused = "";
  try { if (app.frontmost()) focused = app.currentWindow().currentSession().id(); } catch (e) {}
  app.windows().forEach(w => w.tabs().forEach((t, ti) => t.sessions().forEach((s, si) =>
    out.push({ win: w.id(), tab: ti, idx: si, id: s.id(), name: s.name(), focused: false }))));
  out.forEach(o => { o.focused = o.id === focused; });
  JSON.stringify(out);
}`;

function listSessions() {
  return new Promise((resolve) => {
    execFile("/usr/bin/osascript", ["-l", "JavaScript", "-e", LIST_JS], { timeout: 4000 }, (err, stdout) => {
      if (err) return resolve(null);
      try {
        const list = JSON.parse(stdout.trim() || "[]");
        list.sort((a, b) => a.win - b.win || a.tab - b.tab || a.idx - b.idx);   // tab order
        resolve(list);
      } catch { resolve(null); }
    });
  });
}

function focus(s) {
  const js = `
const app = Application("iTerm2");
const w = app.windows().find(w => w.id() === ${Number(s.win)});
if (w) {
  const t = w.tabs()[${Number(s.tab)}];
  w.select(); t.select(); t.sessions()[${Number(s.idx)}].select();
  app.activate();
}`;
  execFile("/usr/bin/osascript", ["-l", "JavaScript", "-e", js], { timeout: 4000 }, () => {});
}

const runsClaude = (s) => /\(claude\)\s*$/i.test(s.name);

function readStatus(s) {
  try {
    const st = JSON.parse(fs.readFileSync(path.join(STATUS_DIR, s.id + ".json"), "utf8"));
    // iTerm titles the tab "<name> (claude)" while Claude runs; without it Claude has exited (e.g. crashed)
    if (st.state === "working" && !runsClaude(s)) st.state = "idle";
    return st;
  } catch { return null; }
}

const labelOf = (s, st) => {
  const name = s.name.replace(/\s*\((claude|node)\)\s*$/i, "").trim();
  const folder = st?.cwd ? path.basename(st.cwd) : "";
  return (cfg.label === "folder" ? folder || name : name || folder) || "session";
};

const URGENCY = { waiting: 0, done: 1, working: 2, idle: 3, none: 4 };
const urgency = (st) => (st?.state === "waiting" && st.kind === "perm" ? -0.5 : URGENCY[st?.state ?? "none"] ?? 4);

function sortSessions(list) {
  const st = new Map(list.map((s) => [s.id, readStatus(s)]));
  let out = list;
  if (cfg.onlyClaude) out = out.filter((s) => runsClaude(s) || ["waiting", "done", "working"].includes(st.get(s.id)?.state));
  const started = (s) => st.get(s.id)?.started ?? Infinity;
  const cmp = {
    tab: () => 0,
    start: (a, b) => started(a) - started(b),
    newest: (a, b) => (st.get(b.id)?.started ?? -Infinity) - (st.get(a.id)?.started ?? -Infinity),
    activity: (a, b) => (st.get(b.id)?.ts ?? 0) - (st.get(a.id)?.ts ?? 0),
    name: (a, b) => labelOf(a, st.get(a.id)).localeCompare(labelOf(b, st.get(b.id))),
    urgency: (a, b) => urgency(st.get(a.id)) - urgency(st.get(b.id)) || started(a) - started(b),
  }[cfg.sort] || (() => 0);
  return [...out].sort((a, b) => cmp(a, b) || 0);   // stable: ties keep tab order
}

// Which session (or pager) goes on which slot, given the keys on the deck and the overflow rule.
function layout() {
  const slots = keys.size ? Math.max(...keys.values()) : 0;
  const cap = cfg.maxSessions > 0 ? Math.min(slots, cfg.maxSessions) : slots;
  const bySlot = new Map();
  let list = sessions, hidden = [];
  if (list.length > cap && cfg.overflow === "page" && cap >= 2) {
    const per = cap - 1, pages = Math.ceil(list.length / per);
    page = ((page % pages) + pages) % pages;
    const shown = list.slice(page * per, page * per + per);
    hidden = list.filter((s) => !shown.includes(s));
    shown.forEach((s, i) => bySlot.set(i + 1, { s }));
    bySlot.set(cap, { pager: true, page, pages, hidden });
    return { bySlot, cap, slots };
  }
  if (list.length > cap && cfg.overflow === "urgent") {
    const ranked = [...list].sort((a, b) => urgency(readStatus(a)) - urgency(readStatus(b)));  // stable within a level
    const keep = new Set(ranked.slice(0, cap));
    hidden = list.filter((s) => !keep.has(s));
    list = list.filter((s) => keep.has(s));
  } else {
    hidden = list.slice(cap);
    list = list.slice(0, cap);
  }
  list.forEach((s, i) => bySlot.set(i + 1, { s }));
  if (hidden.length && cap) bySlot.set(cap, { ...bySlot.get(cap), more: hidden });
  return { bySlot, cap, slots };
}

// ---------------------------------------------------------------- drawing
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
const FONT = `font-family="-apple-system,Helvetica"`;
const dataUrl = (xml) => "data:image/svg+xml;charset=utf8," + encodeURIComponent(xml);

function wrap(title, width = 11, max = 3) {
  const lines = [""];
  for (const word of title.split(/\s+/).filter(Boolean)) {
    const cur = lines[lines.length - 1];
    if (!cur) lines[lines.length - 1] = word;
    else if ((cur + " " + word).length <= width) lines[lines.length - 1] = cur + " " + word;
    else if (lines.length < max) lines.push(word);
    else { lines[max - 1] += " " + word; break; }
  }
  return lines.map((l) => clip(l, width + 1));
}

function mix(a, b, t) {
  const p = (h, i) => parseInt(h.substr(1 + 2 * i, 2), 16);
  return "#" + [0, 1, 2].map((i) => Math.round(p(a, i) + (p(b, i) - p(a, i)) * t).toString(16).padStart(2, "0")).join("");
}

let defaultEffort = null, defaultEffortAt = 0;
function fallbackEffort() {
  if (Date.now() - defaultEffortAt > 60000) {
    defaultEffortAt = Date.now();
    try { defaultEffort = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".claude", "settings.json"), "utf8")).effortLevel || null; } catch {}
  }
  return defaultEffort;
}

const EFFORTS = ["low", "medium", "high", "xhigh", "max"];
const RAINBOW = ["#EB6B6B", "#F0A050", "#F5D255", "#6CCB7A", "#8FA8F5"];
function effortBar(effort) {
  if (!cfg.showEffort) return "";
  const n = EFFORTS.indexOf(effort) + 1;
  if (!n) return "";
  const base = { low: cfg.eLow, medium: cfg.eMedium, high: cfg.eHigh, xhigh: cfg.eXhigh, max: cfg.eMax }[effort];
  const col = (i) => (effort === "max" && cfg.maxRainbow ? RAINBOW[i] : base);
  const x0 = cfg.showModel ? 32 : 16, step = cfg.showModel ? 21 : 23, w = cfg.showModel ? 17 : 19;
  return EFFORTS.map((_, i) => `<rect x="${x0 + i * step}" y="7" width="${w}" height="6" rx="3" fill="${i < n ? col(i) : cfg.cText}" fill-opacity="${i < n ? 1 : 0.25}"/>`).join("");
}

const MODEL_LETTER = { opus: "O", sonnet: "S", haiku: "H", fable: "F" };
function modelTag(model) {
  if (!cfg.showModel || !model) return "";
  const l = MODEL_LETTER[model] || model[0].toUpperCase();
  return `<text x="17" y="16" ${FONT} font-weight="800" font-size="15" fill="${cfg.cText}" fill-opacity="0.8" text-anchor="middle">${esc(l)}</text>`;
}

function ctxBar(pct) {
  if (!cfg.showContext || pct == null) return "";
  const p = Math.max(0, Math.min(100, pct)), w = Math.max(4, 112 * p / 100);
  const col = p >= cfg.ctxAmber ? "#FFD23F" : cfg.cText;
  const op = p >= cfg.ctxPulse ? (0.3 + 0.7 * (0.5 + 0.5 * Math.cos(2 * Math.PI * frame / 6))).toFixed(2) : "0.95";
  return `<rect x="16" y="133" width="112" height="5" rx="2.5" fill="${cfg.cText}" fill-opacity="0.25"/>` +
    `<rect x="16" y="133" width="${w.toFixed(1)}" height="5" rx="2.5" fill="${col}" fill-opacity="${op}"/>`;
}

const chrome = (st) => modelTag(st?.model) + effortBar(st?.effort) + ctxBar(st?.ctx_pct);

function badgeText(badge, x = 134, y = 124) {
  return badge ? `<text x="${x}" y="${y}" ${FONT} font-weight="700" font-size="18" fill="${cfg.cText}" fill-opacity="0.85" text-anchor="end">${esc(badge)}</text>` : "";
}

function plainKey(bg, title, badge, dim, st) {
  const L = wrap(title);
  const size = L.some((l) => l.length > 8) ? 22 : 26;
  const gap = size + 6, y0 = 72 - ((L.length - 1) * gap) / 2 + size / 3;
  const body = L.map((l, i) => `<text x="72" y="${y0 + i * gap}" ${FONT} font-weight="700" font-size="${size}" fill="${cfg.cText}" fill-opacity="${dim ? 0.45 : 1}" text-anchor="middle">${esc(l)}</text>`).join("");
  return dataUrl(`<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144"><rect width="144" height="144" fill="${bg}"/>${dim ? "" : chrome(st)}${body}${badgeText(badge)}</svg>`);
}

// "working": a classic 12-spoke spinner; the bright spoke steps round once every 3 s with a fading tail
const SPOKES = 12, SPIN_CX = 72, SPIN_CY = 50;
const builds = new Map();   // kept for API symmetry (render clears it when a key stops working)
function spinner(head, C) {
  let out = "";
  for (let i = 0; i < SPOKES; i++) {
    const a = (i * 360 / SPOKES - 90) * Math.PI / 180;
    const behind = ((head - i) % SPOKES + SPOKES) % SPOKES;           // 0 = leading spoke
    const op = head < 0 ? 0.35 : Math.max(0.15, 1 - behind * 0.085);
    const x1 = SPIN_CX + Math.cos(a) * 12, y1 = SPIN_CY + Math.sin(a) * 12;
    const x2 = SPIN_CX + Math.cos(a) * 23, y2 = SPIN_CY + Math.sin(a) * 23;
    out += `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="${C}" stroke-width="4.5" stroke-linecap="round" stroke-opacity="${op.toFixed(2)}"/>`;
  }
  return out;
}
function workingKey(context, label, badge, st) {
  const art = spinner(cfg.working === "spark" ? frame % SPOKES : -1, cfg.cSpark);
  const L = wrap(label, 11, 2), size = L.some((l) => l.length > 9) ? 21 : 24;
  const names = L.map((l, i) => `<text x="72" y="${(L.length === 1 ? 108 : 98) + i * (size + 4)}" ${FONT} font-weight="700" font-size="${size}" fill="${cfg.cText}" text-anchor="middle">${esc(l)}</text>`).join("");
  return dataUrl(`<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144"><rect width="144" height="144" fill="${cfg.cWorking}"/>${art}${chrome(st)}${names}${badgeText(badge, 140, 36)}</svg>`);
}

// pager key ("page" overflow): page dots + a red dot when a hidden page has a session waiting on you
function pagerKey(info) {
  const waiting = info.hidden.map(readStatus).filter((st) => st?.state === "waiting");
  const dots = Array.from({ length: Math.min(info.pages, 6) }, (_, i) =>
    `<circle cx="${72 - (Math.min(info.pages, 6) - 1) * 9 + i * 18}" cy="100" r="5" fill="${cfg.cText}" fill-opacity="${i === info.page ? 0.95 : 0.3}"/>`).join("");
  const alert = waiting.length
    ? `<circle cx="118" cy="26" r="11" fill="${waiting.some((s) => s.kind === "perm") && !waiting.some((s) => s.kind !== "perm") ? cfg.cPerm : cfg.cWaiting}"/>` +
      `<text x="118" y="32" ${FONT} font-weight="800" font-size="15" fill="#fff" text-anchor="middle">${waiting.length}</text>` : "";
  return dataUrl(`<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144"><rect width="144" height="144" fill="#000"/>` +
    `<text x="72" y="70" ${FONT} font-weight="700" font-size="24" fill="${cfg.cText}" text-anchor="middle">+${info.hidden.length} ›</text>${dots}${alert}</svg>`);
}

// empty slots; when no session is open at all a little cursor critter wanders across the row
const KEY_PITCH = 160;
const W = { x: 40, dir: 1, mode: "walk", t: 0, step: 0 };
function stepWalker(slots) {
  if (sessions.length || cfg.empty !== "walker") return;
  W.t = Math.max(0, W.t - 1);
  if (W.mode !== "walk" && W.t === 0) W.mode = "walk";
  if (W.mode === "walk") {
    W.x += 9 * W.dir; W.step++;
    if (W.x > (Math.max(1, slots) - 1) * KEY_PITCH + 110) W.dir = -1;
    if (W.x < 34) W.dir = 1;
    const r = Math.random();
    if (r < 0.015) { W.mode = "look"; W.t = 10; }
    else if (r < 0.022) { W.mode = "trip"; W.t = 12; }
  }
}
function sparkWalker(cx) {
  // a block-cursor critter: hops along the ground, looks around, sometimes tips over
  const ground = 104, hop = W.mode === "walk" ? Math.abs(Math.sin(W.step * 0.9)) * 7 : 0, O = cfg.cSpark;
  const bw = 22, bh = 26, x = cx - bw / 2, y = ground - bh - hop;
  let eyes;
  if (W.mode === "trip") {
    eyes = [-5, 5].map((d) => `<path d="M${cx + d - 2.5} ${y + 8} l5 5 M${cx + d + 2.5} ${y + 8} l-5 5" stroke="#000" stroke-width="1.8"/>`).join("");
  } else {
    const px = W.mode === "look" ? 0 : W.dir * 1.4, py = W.mode === "look" ? 1.2 : 0;
    eyes = [-5, 5].map((d) => `<circle cx="${cx + d}" cy="${y + 10}" r="3.6" fill="#fff"/><circle cx="${cx + d + px}" cy="${y + 10 + py}" r="1.8" fill="#1a1a1a"/>`).join("");
  }
  const shadow = `<ellipse cx="${cx}" cy="${ground + 1}" rx="${10 - hop * 0.6}" ry="2" fill="#000" fill-opacity="0.5"/>`;
  const body = `<rect x="${x}" y="${y}" width="${bw}" height="${bh}" rx="4" fill="${O}"/>${eyes}`;
  if (W.mode === "trip") return `<g transform="rotate(${90 * W.dir} ${cx} ${ground - 2})">${body}</g>`;
  return shadow + body;
}
function emptyKey(slot) {
  let art = "";
  if (!sessions.length && cfg.empty === "walker") {
    const local = W.x - (slot - 1) * KEY_PITCH;
    art = `<line x1="0" y1="105" x2="144" y2="105" stroke="#2a2a2a" stroke-width="2"/>` + (local > -30 && local < 174 ? sparkWalker(local) : "");
  }
  return dataUrl(`<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144"><rect width="144" height="144" fill="#000"/>${art}</svg>`);
}

function sessionKey(context, s, more) {
  const st = readStatus(s);
  const state = st ? st.state : "none";
  if (st && !st.effort) st.effort = fallbackEffort();
  const label = labelOf(s, st);
  let badge = "";
  if (more?.length) {
    const waiting = more.map(readStatus).some((x) => x?.state === "waiting");
    badge = `+${more.length}${waiting ? "!" : ""}`;
  }
  if (state === "working") { return workingKey(context, label, badge, st); }
  builds.delete(context);
  let bg = { done: cfg.cDone, idle: cfg.cIdle, none: cfg.cIdle }[state] || cfg.cIdle;
  if (state === "waiting") {
    const col = st.kind === "perm" ? cfg.cPerm : cfg.cWaiting;
    // already looking at that session, or breathing off: solid; else breathe 25%..65%
    bg = s.focused || !cfg.breathe ? mix("#000000", col, 0.6)
      : mix("#000000", col, 0.25 + 0.4 * (0.5 - 0.5 * Math.cos(2 * Math.PI * frame / 12)));
  }
  return plainKey(bg, label, badge, state === "none", st);
}

function render() {
  const { bySlot } = layout();
  for (const [context, slot] of keys) {
    const item = bySlot.get(slot);
    const image = item?.pager ? pagerKey(item) : item?.s ? sessionKey(context, item.s, item.more) : emptyKey(slot);
    if (lastImage.get(context) !== image) {
      lastImage.set(context, image);
      send({ event: "setImage", context, payload: { image, target: 0 } });
    }
  }
}

async function tick() {
  const list = await listSessions();
  if (list) sessions = sortSessions(list);
  render();
  setTimeout(tick, POLL_MS);
}
tick();
setInterval(() => { frame++; stepWalker(keys.size ? Math.max(...keys.values()) : 0); render(); }, FRAME_MS);
hooks.refreshHookCopy();   // keep the installed hook in step with this plugin version
