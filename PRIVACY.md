# Privacy Policy — Session Status for Claude Code

_Last updated: 4 November 2026_

Session Status for Claude Code is a Stream Deck plugin. It does not collect, send, sell, or share any personal data. There are no analytics, no telemetry, and no servers run by the author.

## What the plugin reads and writes, all on your Mac

- **Claude Code hook events.** A small hook (`~/.claude/session-status/hook.py`) receives session events from Claude Code. It writes one small status file per session to `~/.claude/session-status/`. These files hold the session state (working, waiting, done, idle), the model name, the effort level, how full the context window is, and which terminal app, tty and process the session runs in (so a key press can jump back to it).
- **Session transcripts.** To find the model, effort level and context usage, the hook reads the end of the local Claude Code transcript for that session. It reads them only on your Mac and never copies them anywhere else.
- **Your terminal.** If you use iTerm2, the plugin uses AppleScript to list its sessions and tab titles. When you press a key, it uses AppleScript (iTerm2, Terminal), `wezterm cli` (WezTerm) or `open` (other apps) to bring that session to the front.
- **Claude Code settings.** Only when you click **Install hook…** or **Remove hook** does the plugin edit `~/.claude/settings.json`. It shows you the change first and saves a backup.
- **Plugin settings.** Your choices (colours, order, and so on) are stored by the Stream Deck app, and also copied to `~/.claude/session-status/config.json` so the hook can read them.

## Optional "Smart status"

This setting is **off by default**. If you turn it on, after each Claude reply the hook runs your own `claude` command-line tool (`claude -p --model haiku`) with the end of that reply, to decide whether the session needs you. That request goes to Anthropic under your own Claude account and is covered by Anthropic's terms and privacy policy. The plugin author never receives it.

## Removing your data

1. Click **Remove hook** in the plugin settings.
2. Uninstall the plugin.
3. Delete the `~/.claude/session-status/` folder.

## Contact

Questions: open an issue at https://github.com/jacopopiogargano/streamdeck-claude-code-status/issues or email jacopoinseattle@gmail.com.

This project is not made by, affiliated with, or endorsed by Anthropic.
