# Claude Agent Orchestrator

A local, full-screen orchestrator for running **multiple interactive Claude Code sessions** at once —
Conductor-style, but Claude-only and dependency-light. Sessions are grouped by project in a left
sidebar (each with a project color, an editable **name** and **tags**); the selected session is a
**real terminal** on the right. It opens in its **own window** (Chrome/Edge `--app`), separate from
your normal browser, with its own taskbar button.

It works by running each `claude` inside a pseudo-terminal (`node-pty`) on a tiny local server and
streaming the bytes to the browser over a WebSocket, where [`xterm.js`](https://xtermjs.org) renders a
fully interactive terminal. The terminal stays in the page; nothing is headless — you get the normal
Claude Code TUI (permission prompts, slash commands, everything).

## Requirements

- **Node.js** 18+ (works on 24).
- **Claude Code** installed and on your `PATH` (the `claude` command).
- Windows (uses ConPTY via `node-pty`; `cmd.exe /c claude …`). macOS/Linux should work too but are untested here.

## Setup

```bash
npm install                 # installs node-pty, ws, xterm (node-pty ships prebuilt binaries)
cp projects.example.json projects.json   # then edit projects.json with YOUR repos
```

`projects.json` (gitignored) is an array of projects:

```jsonc
[
  { "id": "api", "name": "API", "color": "#34d399", "root": "C:\\work\\api" }
]
```

- `id` — short unique slug · `name` — label · `color` — the project dot · `root` — absolute path where `claude` runs.

## Run

```powershell
node server.mjs             # → http://127.0.0.1:4319
```

Then open the orchestrator in its own window with **`start.vbs`** (double-click, or make a shortcut and
pin it to the taskbar). `start.vbs` starts the server if it isn't running and launches the `--app` window.
Override the port with the `ORCH_PORT` env var.

## Using it

- **＋ Novo** — start a fresh `claude` in the selected project. **↻** — `claude --continue` (resume the project's last session).
- Click a session in the sidebar to focus its terminal. Hover a row → **✕** to end it.
- In the header: rename the session and add **tags** (type + Enter; ✕ to remove).
- Footer selector **"Permissões nas novas sessões"** → how every **new** session starts:
  *Perguntar* (default, asks normally), *Auto* (`--permission-mode auto`), *Aceitar edições*
  (`--permission-mode acceptEdits`), or *Pular permissões ⚠* (`--dangerously-skip-permissions`).
  The choice is saved to `data/settings.json`.
- Sessions survive a page reload (the server keeps the terminal alive and repaints recent output on reattach).
- **▶ Ouvir / 🔊** — read Claude's last answer out loud (browser speech synthesis, pt-BR).
  🔊 speaks every answer of the focused session as it lands. Needs the hook below.

## Hearing the answers (▶)

The terminal is a TUI, so the spoken text does **not** come from the screen — a `Stop`
hook reads the session transcript and posts the final answer to the orchestrator.
Add this to `~/.claude/settings.json` (or a project's `.claude/settings.json`):

```json
{
  "hooks": {
    "Stop": [{ "hooks": [{ "type": "command",
      "command": "node \"E:\\repos\\claude-orchestrator\\hooks\\orch-say.mjs\"" }] }]
  }
}
```

Troubleshooting: run with `ORCH_SAY_LOG=<file>` in the environment and the hook records
every firing (it is silent by design).

The hook exits immediately when `ORCH_AGENT_ID` is not set, so sessions started outside
the orchestrator are unaffected. Without it everything else still works — only ▶ stays
greyed out. Voice quality is whatever pt-BR voice the OS ships; `speech.js` keeps the
engine behind `speak()`/`setEngine()` so an HTTP TTS can replace it later.

## API (local only, `127.0.0.1`)

| Method + path | What |
|---|---|
| `GET·POST·DELETE /api/projects` | List `[{id,name,color}]`; add `{name,root}`; remove `?id=` (registry only — live agents untouched). |
| `GET /api/agents/live` | List live agents (`{id,projId,name,tags,cmd,exited,…}`). |
| `POST /api/agents/kill?id=` | End an agent. |
| `PUT /api/agents/meta?id=` | Body `{name,tags[]}` — rename / tag a session. |
| `GET·POST /api/agents/say?id=` | Last answer of an agent (`{text,at}`); POST `{text}` comes from the `Stop` hook and is pushed to attached clients. |
| `POST /api/agents/open-window` | Open another orchestrator `--app` window. |
| `GET·PUT /api/settings` | `{ permissionMode: "default"\|"auto"\|"acceptEdits"\|"bypass" }` (legacy `skipPermissions` still accepted/mirrored). |
| **WS** `/api/agents/term?project=…` *or* `?agent=id` | Spawn/attach a PTY and bridge it to xterm.js. |

## Notes

- **Local only.** The server binds to `127.0.0.1` and spawns real terminals on your machine — don't expose it.
- **Zero build step.** Plain Node `http` + vanilla ES-module browser code; `xterm.js` is served straight from `node_modules/`.
- `--dangerously-skip-permissions` lets Claude act without asking. Turn it on only where you trust the workspace.
