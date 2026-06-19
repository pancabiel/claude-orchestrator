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
- Footer toggle **"Pular permissões nas novas sessões ⚠"** → starts every **new** session with
  `--dangerously-skip-permissions`. Off by default; the choice is saved to `data/settings.json`.
- Sessions survive a page reload (the server keeps the terminal alive and repaints recent output on reattach).

## API (local only, `127.0.0.1`)

| Method + path | What |
|---|---|
| `GET /api/projects` | `[{id,name,color}]` for the UI. |
| `GET /api/agents/live` | List live agents (`{id,projId,name,tags,cmd,exited,…}`). |
| `POST /api/agents/kill?id=` | End an agent. |
| `PUT /api/agents/meta?id=` | Body `{name,tags[]}` — rename / tag a session. |
| `POST /api/agents/open-window` | Open another orchestrator `--app` window. |
| `GET·PUT /api/settings` | `{ skipPermissions }`. |
| **WS** `/api/agents/term?project=…` *or* `?agent=id` | Spawn/attach a PTY and bridge it to xterm.js. |

## Notes

- **Local only.** The server binds to `127.0.0.1` and spawns real terminals on your machine — don't expose it.
- **Zero build step.** Plain Node `http` + vanilla ES-module browser code; `xterm.js` is served straight from `node_modules/`.
- `--dangerously-skip-permissions` lets Claude act without asking. Turn it on only where you trust the workspace.
