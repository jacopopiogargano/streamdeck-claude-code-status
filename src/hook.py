#!/usr/bin/python3
"""Session Status for Claude Code: hook that records this terminal session's Claude state for the Stream Deck plugin.

Installed by the plugin to ~/.claude/session-status/hook.py. Writes ~/.claude/session-status/<iTerm session id or "cc-"+Claude session id>.json. Never blocks or fails the hook.
On Stop, decides whether Claude's last message needs a reply ("waiting") or not ("done"):
a quick heuristic first; if enabled in the plugin settings, a background Haiku classification refines it.
"""
import json, os, re, shutil, subprocess, sys, time

FOLDER = os.path.expanduser("~/.claude/session-status")
# only real asks count: a question mark, or phrasing that hands the turn to the user
ASKY = re.compile(r"\?|\b(want me to|should i|shall i|which (one|option)|let me know|your call|"
                  r"tell me (which|what|if)|pick (one|\d)|say \"?go\"?)\b", re.I)
LOG = os.path.join(FOLDER, "classify.log")


def hook_config():
    """Settings the plugin writes for the hook: {"haiku": bool, "claude": optional path}."""
    try:
        with open(os.path.join(FOLDER, "config.json")) as f:
            return json.load(f)
    except Exception:
        return {}


def claude_bin(cfg):
    for c in (cfg.get("claude"), shutil.which("claude"), os.path.expanduser("~/.local/bin/claude"),
              "/opt/homebrew/bin/claude", "/usr/local/bin/claude"):
        if c and os.path.isfile(c) and os.access(c, os.X_OK):
            return c
    return None


def write(path, **fields):
    if "started" not in fields:
        try:
            with open(path) as f:
                old = json.load(f).get("started")
            if old:
                fields["started"] = old
        except Exception:
            pass
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(fields, f)
    os.replace(tmp, path)


def last_assistant_text(data):
    if data.get("last_assistant_message"):
        return data["last_assistant_message"]
    try:
        with open(data["transcript_path"]) as f:
            lines = f.readlines()[-200:]
    except Exception:
        return ""
    for line in reversed(lines):
        try:
            e = json.loads(line)
        except Exception:
            continue
        if e.get("type") != "assistant":
            continue
        content = (e.get("message") or {}).get("content") or []
        text = "".join(c.get("text", "") for c in content if isinstance(c, dict) and c.get("type") == "text")
        if text.strip():
            return text
    return ""


EFFORT = re.compile(rb'"output_config":\{[^}]*?"effort":"(\w+)"')
MODEL = re.compile(rb'"model":"claude-([a-z]+)')
STAMP = re.compile(rb'"timestamp":"(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)')
USAGE = re.compile(rb'"usage":\{"input_tokens":(\d+),"cache_creation_input_tokens":(\d+),"cache_read_input_tokens":(\d+)')


def settings():
    try:
        with open(os.path.expanduser("~/.claude/settings.json")) as f:
            return json.load(f)
    except Exception:
        return {}


def session_info(data):
    """(effort, context tokens, context % of the auto-compact window) from the session transcript tail."""
    effort, ctx, model, started = None, None, None, None
    try:
        with open(data["transcript_path"], "rb") as f:
            m = STAMP.search(f.read(65536))
        if m:
            import calendar
            started = calendar.timegm(time.strptime(m.group(1).decode(), "%Y-%m-%dT%H:%M:%S"))
    except Exception:
        pass
    try:
        with open(data["transcript_path"], "rb") as f:
            f.seek(0, 2); f.seek(max(0, f.tell() - 600_000))
            tail = f.read()
        hits = EFFORT.findall(tail)
        effort = hits[-1].decode() if hits else None
        u = USAGE.findall(tail)
        ctx = sum(int(x) for x in u[-1]) if u else None
        mm = MODEL.findall(tail)
        model = mm[-1].decode() if mm else None
    except Exception:
        pass
    if isinstance(data.get("model"), dict):
        model = (data["model"].get("id") or "").replace("claude-", "").split("-")[0] or model
    if isinstance(data.get("effort"), dict):
        effort = data["effort"].get("level") or effort
    elif data.get("effort"):
        effort = data["effort"]
    cfg = settings()
    effort = effort or cfg.get("effortLevel")  # fresh session, no request yet: configured default
    window = cfg.get("autoCompactWindow") or 200_000
    pct = round(100 * ctx / window) if ctx is not None else None
    info = {"effort": effort, "ctx": ctx, "ctx_pct": pct, "model": model}
    if started:
        info["started"] = started
    return info


FOLLOW = re.compile(r"\b(installed|deployed|pushed|fixed|added|updated|built|changed|now (shows|has|uses)|next step|you('ll| will) need to|please (check|test|try|run|restart|review|look)|"
                    r"tell me (if|whether)|let me know (if|whether)|try it|check (it|that|on)|restart)\b", re.I)


def heuristic(text):
    """Quick first guess; Haiku refines it. waiting = needs an answer, done = follow-up for the user, idle = nothing."""
    tail = text.strip()[-300:]
    return "waiting" if ASKY.search(tail) else "done" if FOLLOW.search(text.strip()[-800:]) else "idle"


def classify_later(path, text, stamp):
    """Detach and ask Haiku whether the message needs a reply; update only if nothing newer happened."""
    if os.fork():
        return
    os.setsid()
    if os.fork():
        os._exit(0)
    try:
        prompt = ("Classify the final message an AI coding assistant sent to its user.\n"
                  "WAITING = the message explicitly asks the user something: a direct question, a request to pick "
                  "or choose between options, to confirm/approve, to provide information, or to say 'go'.\n"
                  "FOLLOWUP = no question, but there is something for the user to look at: the assistant built, "
                  "changed, fixed, installed, deployed or pushed something the user would want to check out or try, "
                  "or it left a step for the user (a test, restart, setting, merge, something unverified).\n"
                  "DONE = nothing new to look at: an answer, an explanation, an investigation that changed nothing, "
                  "a plain acknowledgement, or a report that nothing needed changing.\n"
                  "Examples:\n"
                  "'Which option do you prefer, A or B?' -> WAITING\n"
                  "'Pick 3 and I will build them.' -> WAITING\n"
                  "'Fixed and installed. Restart the app and check the key turns dark.' -> FOLLOWUP\n"
                  "'Pushed to dev. The release still needs dev merged into main.' -> FOLLOWUP\n"
                  "'Tests pass and the fix is deployed.' -> FOLLOWUP (a finished change worth trying)\n"
                  "'Added the dark mode toggle to the settings page.' -> FOLLOWUP\n"
                  "'Done. Say if you want the old layout back.' (after making a change) -> FOLLOWUP\n"
                  "'The bug was caused by X; here is how it works.' -> DONE\n"
                  "'The file already has that setting, nothing to change.' -> DONE\n"
                  "'Ciao! Everything is saved.' -> DONE\n"
                  "'Red now means the session is asking you something; green means a next step.' -> DONE "
                  "(it describes questions, it does not ask one)\n"
                  "Only an actual request addressed to the user counts as WAITING, not text that talks about questions.\n"
                  "When the assistant delivered or changed something, prefer FOLLOWUP over DONE.\n"
                  "Judge the message as a whole, mainly its ending. "
                  "Reply with exactly one word: WAITING, FOLLOWUP or DONE.\n\n<message>\n" + text[-4000:] + "\n</message>")
        env = {k: v for k, v in os.environ.items() if k not in ("ITERM_SESSION_ID", "CLAUDECODE")}
        out = subprocess.run(
            [CLAUDE, "-p", "--model", "haiku", "--no-session-persistence",
             "--settings", '{"disableAllHooks": true}', prompt],
            capture_output=True, text=True, timeout=60, env=env, stdin=subprocess.DEVNULL).stdout.upper()
        # deck states: waiting = red, done = green (follow-up for the user), idle = nothing to do
        verdict = "waiting" if "WAITING" in out else "done" if "FOLLOWUP" in out else "idle" if "DONE" in out else None
        if verdict == "waiting" and not ASKY.search(text.strip()[-600:]):
            verdict = "done"  # no question or hand-over phrase near the end: at most a follow-up
        applied = False
        if verdict:
            with open(path) as f:
                cur = json.load(f)
            if cur.get("ts") == stamp:  # no newer hook event since this Stop
                cur.update(state=verdict, judged="haiku")
                write(path, **cur)
                applied = True
        with open(LOG, "a") as f:
            f.write(json.dumps({"ts": stamp, "took": round(time.time() - stamp, 1), "sid": os.path.basename(path)[:8],
                                "heuristic": heuristic(text), "haiku": verdict, "raw": out[:40], "applied": applied,
                                "tail": text.strip()[-120:]}) + "\n")
    except Exception as e:
        try:
            with open(LOG, "a") as f:
                f.write(json.dumps({"ts": stamp, "error": repr(e)[:300]}) + "\n")
        except Exception:
            pass
    os._exit(0)


def claude_process():
    """(pid, tty, headless) of the claude process that fired this hook, or (None, "", False).
    headless = a non-interactive `claude -p` run (e.g. one an app spawned from a terminal tab)."""
    pid = os.getppid()
    for _ in range(4):
        try:
            out = subprocess.run(["/bin/ps", "-o", "ppid=,tty=,command=", "-p", str(pid)], capture_output=True, text=True, timeout=2).stdout.strip()
        except Exception:
            break
        if not out:
            break
        parts = out.split(None, 2)
        if len(parts) < 3:
            break
        ppid, tty, cmd = parts
        args = cmd.split()
        exe = os.path.basename(args[0])
        if exe == "claude" or (exe == "node" and len(args) > 1 and "claude" in args[1]):
            return pid, ("" if tty in ("??", "-") else "/dev/" + tty), ("-p" in args or "--print" in args)
        pid = int(ppid)
    return None, "", False


def terminal_info():
    """Which terminal app this session runs in, so the plugin can jump back to it."""
    env = os.environ
    term = env.get("TERM_PROGRAM", "")
    if env.get("ITERM_SESSION_ID"):
        term = "iTerm.app"
    elif env.get("KITTY_WINDOW_ID"):
        term = "kitty"
    info = {"term": term, "app": env.get("__CFBundleIdentifier", "")}
    if env.get("WEZTERM_PANE"):
        info["pane"] = env["WEZTERM_PANE"]
    if env.get("TMUX"):
        info["tmux"] = True
    return info


try:
    data = json.load(sys.stdin)
    cpid, tty, headless = claude_process()
    if headless:
        sys.exit(0)
    # one file per terminal session: iTerm2 has a stable session id; elsewhere use Claude's own session id
    iterm = os.environ.get("ITERM_SESSION_ID", "")  # e.g. "w0t1p0:6A1B2C3D-..."
    if iterm:
        sid = iterm.split(":")[-1]
    elif data.get("session_id"):
        sid = "cc-" + data["session_id"]
    else:
        sys.exit(0)
    where = dict(terminal_info(), pid=cpid, tty=tty)
    os.makedirs(FOLDER, exist_ok=True)
    path = os.path.join(FOLDER, sid + ".json")
    event = data.get("hook_event_name", "")
    cwd = data.get("cwd") or os.getcwd()

    if event == "SessionEnd":
        if os.path.exists(path):
            os.remove(path)
        sys.exit(0)

    if event == "Stop":
        text = last_assistant_text(data)
        stamp = time.time()
        write(path, state=heuristic(text), cwd=cwd, event=event, ts=stamp, judged="heuristic", **session_info(data), **where,
              session=(data.get("session_id") or "")[:8])
        hc = hook_config()
        CLAUDE = claude_bin(hc) if hc.get("haiku") else None
        if text.strip() and CLAUDE:
            classify_later(path, text, stamp)
        sys.exit(0)

    state = {"SessionStart": "idle", "UserPromptSubmit": "working", "PreToolUse": "working",
             "PostToolUse": "working"}.get(event)
    # Claude is blocked on the user: question box, plan approval, permission dialog
    if event == "PermissionRequest" or (event == "PreToolUse" and data.get("tool_name") in ("AskUserQuestion", "ExitPlanMode")):
        state = "waiting"
    if event == "Notification":
        kind = data.get("notification_type", "")
        msg = (data.get("message") or "").lower()
        if kind == "idle_prompt" or "waiting for your input" in msg:
            sys.exit(0)  # idle reminder: keep whatever Stop decided
        state = "waiting"  # permission prompt etc.
    if not state:
        sys.exit(0)
    # waiting kind: "perm" = permission dialog (quick approve), "ask" = question/plan for the user
    kind = None
    if state == "waiting":
        if data.get("tool_name") in ("AskUserQuestion", "ExitPlanMode"):
            kind = "ask"
        elif event == "PermissionRequest" or data.get("notification_type") == "permission_prompt":
            kind = "perm"
        else:  # other notification: keep what the earlier event decided
            try:
                with open(path) as f:
                    kind = json.load(f).get("kind") or "perm"
            except Exception:
                kind = "perm"
    write(path, state=state, kind=kind, cwd=cwd, event=event, ts=time.time(), tool=data.get("tool_name"),
          agent=data.get("agent_id") or data.get("agent_type"), session=(data.get("session_id") or "")[:8],
          **session_info(data), **where)
except Exception:
    pass
sys.exit(0)
