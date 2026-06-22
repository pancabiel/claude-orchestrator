# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A local, dependency-light orchestrator for running **multiple interactive Claude Code sessions** at once. Each `claude` runs inside a real pseudo-terminal (`node-pty`) on a tiny Node server; bytes stream over a WebSocket to `xterm.js` in the browser, so you get the full interactive TUI (permission prompts, slash commands). Sessions are grouped by project in a sidebar. The UI opens in its own Chrome/Edge `--app` window. UI strings are in Brazilian Portuguese.

## Commands

```powershell
npm install            # node-pty (ships prebuilt binaries), ws, @xterm/*
node server.mjs        # start server → http://127.0.0.1:4319 (npm start does the same)
```

- **Launch the app window:** double-click `start.vbs` (runs `start.ps1` hidden). It starts the server if the port is down, then opens the `--app` window. `start.ps1` can be run directly too.
- **Override the port:** set `ORCH_PORT` (read in both `config.js` and `start.ps1`).
- There is **no build step, no test suite, and no linter.** Browser code is plain ES modules; `xterm.js` is served straight from `node_modules/`.
- First-time setup: `cp projects.example.json projects.json`, then edit it — though projects can also be added live from the UI (see below).

## Architecture

Two halves talking over one local HTTP server (`127.0.0.1` only — it spawns real shells, never expose it).

**`server.mjs` — backend.** A hand-rolled `http` router (no framework) plus a `ws` WebSocketServer on `/api/agents/term`. The core abstraction is an **agent**: a `claude` process in a `node-pty` terminal, held in an in-memory `Map` keyed by a random id. Key behaviors:
- On Windows, `claude` is a `.cmd` shim, so agents spawn as `cmd.exe /c claude …` inside ConPTY.
- Each agent keeps a rolling `buffer` (last `MAX_BUF` chars). The PTY **outlives any socket** — reconnecting replays the buffer, so a page reload reattaches and repaints. Multiple sockets can attach to one agent simultaneously (`agent.sockets` Set).
- The global `skipPermissions` setting (persisted to `data/settings.json`) decides whether new agents get `--dangerously-skip-permissions`. `--resume <sid>` / `--continue` are per-spawn options.
- WS protocol: client sends `{t:"in",d}` / `{t:"resize",cols,rows}`; server sends `{t:"ready"|"data"|"exit"|"error"}`.
- REST: `GET/POST /api/projects`, `GET /api/agents/live`, `POST /api/agents/kill`, `PUT /api/agents/meta` (name/tags), `POST /api/agents/open-window`, `GET/PUT /api/settings`.

**`config.js` — project registry.** Loads `projects.json` (gitignored, machine-specific paths) or falls back to `projects.example.json`. `PROJECTS`/`PROJECT_IDS` are exported with `let` so `addProject()` can refresh the live bindings after writing to disk — new projects are usable **without a server restart**.

**`orchestrator.js` — frontend (single file, vanilla).** Manages a `terms` Map of local xterm instances and connects each to a backend agent. Two state sources that must stay reconciled:
- `live` — the authoritative agent metadata snapshot, repolled every 3s via `/api/agents/live`.
- `layout` — the **user-controlled sidebar tree** (drag-to-reorder, drag-onto-row/header to group, drop on empty to ungroup), persisted in `localStorage` under `orch-layout`. It is *not* derived from projects. `reconcile()` runs on every render to add newly-seen agent ids at the root and drop dead ones (dissolving empty groups).
- Terminal gotcha: `term.open()` is **deferred to first mount** — opening on a detached element measures 0×0. A transient `"pending:<key>"` activeId visually selects a session before the server assigns its real id via the `ready` frame.

**`index.html` / `styles.css`** — shell that loads xterm UMD globals (`Terminal`, `FitAddon`) then `orchestrator.js` as a module.

## Conventions

- Keep it dependency-light and build-step-free; that's the point of the project.
- `projects.json`, `data/`, and `node_modules/` are gitignored — don't commit machine-specific paths.
- User-facing strings are pt-BR; match that when editing the UI.
