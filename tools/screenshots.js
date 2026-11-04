// Renders Marketplace screenshots (1920x960 PNG) of the plugin's keys with sample sessions, plus the settings screen.
// node tools/screenshots.js  -> screenshots/*.png   (uses headless Google Chrome)
"use strict";
const fs = require("fs"), os = require("os"), path = require("path");
const { execFileSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const PLUGIN = path.join(ROOT, "io.github.jacopopiogargano.ccstatus.sdPlugin");
const OUT = path.join(ROOT, "screenshots");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "ccstatus-shots-"));
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
fs.mkdirSync(OUT, { recursive: true });

// Load the plugin's drawing code without starting it: drop the startup tail, stub the socket and status reads.
const src = fs.readFileSync(path.join(PLUGIN, "bin/plugin.js"), "utf8")
  .replace(`require("./hooks.js")`, `require(${JSON.stringify(path.join(PLUGIN, "bin/hooks.js"))})`)
  .replace(/\ntick\(\);[\s\S]*$/, "\n")
  + `\nfunction readStatus(s) { return s.st ? { ...s.st } : null; }
module.exports = { sessionKey, pagerKey, emptyKey, setCfg: (c) => { cfg = { ...DEFAULTS, ...c }; },
  setFrame: (f) => { frame = f; }, builds, W };`;
global.WebSocket = class { constructor() { this.readyState = 0; } send() {} };
const mod = new module.constructor(path.join(TMP, "p.js"));
mod.filename = path.join(TMP, "p.js");
mod.paths = module.paths;
mod._compile(src, mod.filename);
const P = mod.exports;

const svgOf = (url) => decodeURIComponent(url.slice(url.indexOf(",") + 1));
const S = (name, state, extra = {}) => ({ name: name + " (claude)", focused: false, st: state && { state, ...extra } });
let ctx = 0;
const key = (s, more) => svgOf(P.sessionKey("c" + ctx++, s, more));
function working(s, f) { P.setFrame(f); P.builds.delete("w"); P.setFrame(0); P.sessionKey("w", s); P.setFrame(f); return svgOf(P.sessionKey("w", s)); }

const sample = {
  ask: S("api-refactor", "waiting", { kind: "ask", effort: "high", ctx_pct: 42, model: "opus" }),
  perm: S("landing-page", "waiting", { kind: "perm", effort: "medium", ctx_pct: 18, model: "sonnet" }),
  done: S("billing-fix", "done", { effort: "xhigh", ctx_pct: 63, model: "opus" }),
  work: S("ios-app", "working", { effort: "max", ctx_pct: 88, model: "opus" }),
  idle: S("docs", "idle", { effort: "low", ctx_pct: 9, model: "haiku" }),
};

const CSS = `
  * { box-sizing: border-box; margin: 0; }
  body { width: 1920px; height: 960px; background: radial-gradient(ellipse at 30% 20%, #23262e, #0e0f12 70%);
         font-family: -apple-system, "Helvetica Neue", sans-serif; color: #e8eaed; display: flex; align-items: center;
         justify-content: center; gap: 110px; padding: 0 120px; }
  .copy { width: 560px; }
  .copy h1 { font-size: 58px; line-height: 1.08; font-weight: 750; letter-spacing: -0.02em; }
  .copy p { font-size: 25px; line-height: 1.45; color: #a7abb3; margin-top: 26px; }
  .deck { background: linear-gradient(#1b1c1f, #121315); border-radius: 46px; padding: 46px;
          box-shadow: 0 40px 90px rgba(0,0,0,.6), inset 0 1px 0 rgba(255,255,255,.06); }
  .grid { display: grid; gap: 22px; }
  .k { width: 158px; height: 158px; border-radius: 22px; overflow: hidden; background: #000;
       box-shadow: inset 0 0 0 2px rgba(255,255,255,.04), 0 3px 0 #000; }
  .k svg { width: 158px; height: 158px; display: block; }
  .cap { text-align: center; font-size: 19px; color: #a7abb3; margin-top: 14px; width: 158px; }
  .row { display: flex; gap: 22px; }
  .legend .k + .cap { margin-bottom: 0; }
`;
const keyDiv = (svg, cap) => `<div><div class="k">${svg.replace("<svg ", '<svg viewBox="0 0 144 144" ')}</div>${cap ? `<div class="cap">${cap}</div>` : ""}</div>`;
const deck = (cols, svgs) => `<div class="deck"><div class="grid" style="grid-template-columns:repeat(${cols},158px)">${svgs.map((s) => keyDiv(s)).join("")}</div></div>`;
const page = (name, body) => fs.writeFileSync(path.join(TMP, name + ".html"), `<!doctype html><meta charset="utf-8"><style>${CSS}</style><body>${body}</body>`);
const blank = () => `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144"><rect width="144" height="144" fill="#000"/></svg>`;

// 1. hero: a full deck with sessions in every state
P.setCfg({});
page("1-overview", `
  <div class="copy"><h1>See every Claude Code session at a glance.</h1>
  <p>One key per session, in any terminal. Red asks you something, orange wants a permission, green has finished work to check.
  Press a key to jump straight to that terminal.</p></div>
  ${deck(5, [key(sample.ask), key(sample.perm), key(sample.done), working(sample.work, 9), key(sample.idle),
    blank(), blank(), blank(), blank(), blank(), blank(), blank(), blank(), blank(), blank()].map((s, i) => s))}`);

// 2. legend: what each state looks like
page("2-states", `
  <div class="copy"><h1>Know what each session needs.</h1>
  <p>Every key shows the model, the effort level and how full the context is. The context bar turns amber, then pulses when it is time to /compact.</p></div>
  <div class="deck"><div class="row legend">
    ${keyDiv(key(sample.ask), "Asks you")}${keyDiv(key(sample.perm), "Permission")}${keyDiv(key(sample.done), "Done, check it")}
    ${keyDiv(working(sample.work, 6), "Working")}${keyDiv(key(sample.idle), "Idle")}</div></div>`);

// 3. more sessions than keys
P.setCfg({ overflow: "page" });
const hidden = [S("a", "waiting", { kind: "ask" }), S("b", "idle"), S("c", "done"), S("d", "idle")];
const pager = svgOf(P.pagerKey({ pager: true, page: 0, pages: 3, hidden }));
P.setCfg({});
page("3-overflow", `
  <div class="copy"><h1>More sessions than keys? Your call.</h1>
  <p>Show a “+N” badge, flip pages with the last key, or keep the sessions that need you on screen.
  A red count tells you a hidden session is waiting.</p></div>
  <div class="deck"><div class="row legend">
    ${keyDiv(key(sample.done), "")}${keyDiv(working(sample.work, 12), "")}${keyDiv(key(sample.idle), "")}${keyDiv(pager, "Page key")}</div>
    <div class="row legend" style="margin-top:30px">
    ${keyDiv(key(sample.ask), "")}${keyDiv(key(sample.perm), "")}${keyDiv(key(sample.done), "")}${keyDiv(key(sample.idle, hidden), "“+N” badge")}</div></div>`);

// 4. personalisation: same sessions, custom colours
P.setCfg({ cWaiting: "#C2185B", cPerm: "#F9A825", cDone: "#1A3A5C", cIdle: "#1C1C1E", cWorking: "#141A22", cSpark: "#7C9CFF",
  eLow: "#9E9E9E", eMedium: "#80CBC4", eHigh: "#4FC3F7", eXhigh: "#7C9CFF", maxRainbow: false, eMax: "#E040FB", label: "folder" });
const custom = [key(sample.ask), key(sample.perm), key(sample.done), working(sample.work, 15), key(sample.idle)];
P.setCfg({ showModel: false, showEffort: false, breathe: false });
const minimal = [key(sample.ask), key(sample.perm), key(sample.done), working(sample.work, 15), key(sample.idle)];
P.setCfg({});
page("4-personalise", `
  <div class="copy"><h1>Make it yours.</h1>
  <p>Pick every colour, the order (oldest first, needs-you first, by name…), how many sessions to show,
  and which details appear on each key.</p></div>
  <div class="deck"><div class="row">${custom.map((s) => keyDiv(s)).join("")}</div>
  <div class="row" style="margin-top:22px">${minimal.map((s) => keyDiv(s)).join("")}</div></div>`);

// 5. the settings screen itself (Property Inspector), shown as it appears in the Stream Deck app
const pi = fs.readFileSync(path.join(PLUGIN, "ui/pi.html"), "utf8").replace("</body>",
  `<script>fill(); document.getElementById("hookState").className="ok"; document.getElementById("hookState").textContent="Installed ✓";</script></body>`);
fs.writeFileSync(path.join(TMP, "pi.html"), pi);
page("5-settings", `
  <div class="copy"><h1>Set up in one click.</h1>
  <p>The plugin installs its Claude Code hook for you, shows exactly what it adds to your settings first, and keeps a backup.
  Removing it is one click too.</p></div>
  <div class="deck" style="padding:22px"><iframe src="pi.html" style="width:520px;height:820px;border:0;border-radius:18px;background:#2d2d2d"></iframe></div>`);

// Marketplace icon (288x288): a 2x2 mini deck with real keys. Rendered at 2x, then scaled down for crisp text.
P.setCfg({});
const iconKeys = [
  key(S("api", "waiting", { kind: "ask", effort: "high", ctx_pct: 42, model: "opus" })),
  key(S("web", "waiting", { kind: "perm", effort: "medium", ctx_pct: 18, model: "sonnet" })),
  key(S("billing", "done", { effort: "xhigh", ctx_pct: 63, model: "opus" })),
  working(S("ios", "working", { effort: "max", ctx_pct: 88, model: "opus" }), 9),
];
fs.writeFileSync(path.join(TMP, "icon.html"), `<!doctype html><meta charset="utf-8"><style>
  * { margin: 0; box-sizing: border-box; } html, body { width: 288px; height: 288px; background: transparent; }
  .deck { width: 288px; height: 288px; border-radius: 52px; background: linear-gradient(#26272b, #141517);
          padding: 16px; display: grid; grid-template-columns: 122px 122px; gap: 12px; }
  .k { width: 122px; height: 122px; border-radius: 20px; overflow: hidden; background: #000; }
  .k svg { width: 122px; height: 122px; display: block; }
</style><body><div class="deck">${iconKeys.map((x) => `<div class="k">${x.replace("<svg ", '<svg viewBox="0 0 144 144" ')}</div>`).join("")}</div></body>`);
const MKT = path.join(ROOT, "marketplace");
fs.mkdirSync(MKT, { recursive: true });
const icon2x = path.join(TMP, "icon@2x.png");
execFileSync(CHROME, ["--headless=new", `--user-data-dir=${path.join(TMP, "chrome")}`, "--no-first-run", "--disable-gpu", "--hide-scrollbars",
  "--force-device-scale-factor=2", "--default-background-color=00000000", "--window-size=288,288", `--screenshot=${icon2x}`, "file://" + path.join(TMP, "icon.html")],
  { stdio: "ignore", timeout: 60000 });
execFileSync("/usr/bin/sips", ["-z", "288", "288", icon2x, "--out", path.join(MKT, "icon-288.png")], { stdio: "ignore" });
console.log("wrote marketplace/icon-288.png");

for (const f of fs.readdirSync(TMP).filter((f) => /^\d.*\.html$/.test(f))) {
  const png = path.join(OUT, f.replace(".html", ".png"));
  execFileSync(CHROME, ["--headless=new", `--user-data-dir=${path.join(TMP, "chrome")}`, "--no-first-run", "--disable-gpu", "--hide-scrollbars", "--force-device-scale-factor=1",
    "--window-size=1920,960", `--screenshot=${png}`, "file://" + path.join(TMP, f)], { stdio: "ignore", timeout: 60000 });
  console.log("wrote", path.relative(ROOT, png));
}
fs.rmSync(TMP, { recursive: true, force: true });
process.exit(0);
