// Installs / removes the Claude Code hook that feeds the plugin.
// The hook script is copied to ~/.claude/session-status/hook.py (outside the plugin folder), so uninstalling
// the plugin never leaves Claude Code pointing at a missing file; the command also ends in `|| true`.
// Usable from the command line for testing:  node hooks.js status|preview|install|remove [--settings <file>]
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");

const HOME = os.homedir();
const STATUS_DIR = path.join(HOME, ".claude", "session-status");
const HOOK_DEST = path.join(STATUS_DIR, "hook.py");
const HOOK_SRC = path.join(__dirname, "hook.py");
let SETTINGS = path.join(HOME, ".claude", "settings.json");
const MARK = "session-status/hook.py";           // identifies our entries
const EVENTS = ["SessionStart", "SessionEnd", "UserPromptSubmit", "PreToolUse", "PostToolUse",
  "PermissionRequest", "Notification", "Stop"];
const PYTHON = "/usr/bin/python3";
const COMMAND = `${PYTHON} "${HOOK_DEST}" || true`;

const isOurs = (h) => typeof h?.command === "string" && h.command.includes(MARK);

function readSettings() {
  if (!fs.existsSync(SETTINGS)) return {};
  const text = fs.readFileSync(SETTINGS, "utf8");
  try { return JSON.parse(text || "{}"); }
  catch { throw new Error(`${SETTINGS} is not valid JSON; fix it before installing.`); }
}

function installedEvents(s) {
  return EVENTS.filter((ev) => (s.hooks?.[ev] || []).some((g) => (g.hooks || []).some(isOurs)));
}

function status() {
  let installed = [], error = null;
  try { installed = installedEvents(readSettings()); } catch (e) { error = e.message; }
  return {
    installed: installed.length === EVENTS.length, partial: installed.length > 0 && installed.length < EVENTS.length,
    events: installed, python: fs.existsSync(PYTHON), hookCopied: fs.existsSync(HOOK_DEST),
    settingsPath: SETTINGS, error,
  };
}

// what install would change, for the user to read before confirming
function preview() {
  const s = readSettings();
  const have = installedEvents(s);
  const add = EVENTS.filter((ev) => !have.includes(ev));
  return {
    settingsPath: SETTINGS, command: COMMAND, hookPath: HOOK_DEST, add, already: have,
    snippet: JSON.stringify(Object.fromEntries(add.map((ev) => [ev, [{ hooks: [{ type: "command", command: COMMAND, timeout: 5 }] }]])), null, 2),
  };
}

function backup() {
  if (!fs.existsSync(SETTINGS)) return null;
  const dest = `${SETTINGS}.session-status-backup-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  fs.copyFileSync(SETTINGS, dest);
  return dest;
}

function writeSettings(s) {
  fs.mkdirSync(path.dirname(SETTINGS), { recursive: true });
  const tmp = SETTINGS + ".tmp-session-status";
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2) + "\n");
  fs.renameSync(tmp, SETTINGS);
}

function copyHook() {
  fs.mkdirSync(STATUS_DIR, { recursive: true });
  fs.copyFileSync(HOOK_SRC, HOOK_DEST);
  fs.chmodSync(HOOK_DEST, 0o755);
}

function install() {
  if (!fs.existsSync(PYTHON)) return { ok: false, message: "python3 not found at /usr/bin/python3. Run `xcode-select --install`, then try again." };
  const s = readSettings();
  copyHook();
  const have = installedEvents(s);
  const add = EVENTS.filter((ev) => !have.includes(ev));
  if (!add.length) return { ok: true, message: "Already installed. Hook script refreshed." };
  const saved = backup();
  s.hooks = s.hooks || {};
  for (const ev of add) (s.hooks[ev] = s.hooks[ev] || []).push({ hooks: [{ type: "command", command: COMMAND, timeout: 5 }] });
  writeSettings(s);
  return { ok: true, message: `Added hooks for ${add.length} events.${saved ? ` Backup: ${saved}` : ""} New Claude Code sessions pick them up; restart running ones.` };
}

function remove() {
  const s = readSettings();
  if (!installedEvents(s).length) return { ok: true, message: "Nothing to remove." };
  const saved = backup();
  for (const ev of Object.keys(s.hooks || {})) {
    s.hooks[ev] = s.hooks[ev]
      .map((g) => ({ ...g, hooks: (g.hooks || []).filter((h) => !isOurs(h)) }))
      .filter((g) => g.hooks.length);
    if (!s.hooks[ev].length) delete s.hooks[ev];
  }
  if (s.hooks && !Object.keys(s.hooks).length) delete s.hooks;
  writeSettings(s);
  return { ok: true, message: `Removed.${saved ? ` Backup: ${saved}` : ""}` };
}

// called at plugin start: update the copied hook if it is installed and the plugin shipped a newer one
function refreshHookCopy() {
  try {
    if (fs.existsSync(HOOK_DEST) && fs.readFileSync(HOOK_DEST, "utf8") !== fs.readFileSync(HOOK_SRC, "utf8")) copyHook();
  } catch {}
}

function writeHookConfig(c) {
  try {
    fs.mkdirSync(STATUS_DIR, { recursive: true });
    fs.writeFileSync(path.join(STATUS_DIR, "config.json"), JSON.stringify(c));
  } catch {}
}

module.exports = { STATUS_DIR, EVENTS, status, preview, install, remove, refreshHookCopy, writeHookConfig,
  _setSettingsPath: (p) => { SETTINGS = p; } };

if (require.main === module) {
  const i = process.argv.indexOf("--settings");
  if (i > 0) SETTINGS = path.resolve(process.argv[i + 1]);
  const cmd = process.argv[2] || "status";
  const fn = { status, preview, install, remove }[cmd];
  if (!fn) { console.error("usage: node hooks.js status|preview|install|remove [--settings <file>]"); process.exit(1); }
  console.log(JSON.stringify(fn(), null, 2));
}
