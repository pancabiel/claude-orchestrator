// server.mjs — local server for the Claude Agent Orchestrator.
// Run: node server.mjs  →  http://127.0.0.1:4319
// Serves the static UI + a small JSON/WebSocket API that spawns each interactive
// `claude` in a pseudo-terminal (node-pty) and bridges it to xterm.js in the page.
import http from "node:http";
import { createReadStream, existsSync, readFileSync } from "node:fs";
import { writeFile, rename, mkdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { extname, join, basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import ptyLib from "node-pty";
import { WebSocketServer } from "ws";
import { PORT, HOST, PROJECTS, PROJECT_IDS, addProject } from "./config.js";

const ROOT = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(ROOT, "data");
const SETTINGS_PATH = join(DATA_DIR, "settings.json");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

// ---------- helpers ----------
function send(res, status, body, type) {
  if (typeof body === "string") {
    res.writeHead(status, { "Content-Type": type || "text/plain; charset=utf-8", "Cache-Control": "no-store" });
    return res.end(body);
  }
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}
const project = (id) => PROJECTS[id] || null;
const projectsMeta = () => PROJECT_IDS.map((id) => ({ id, name: PROJECTS[id].name, color: PROJECTS[id].color }));

// ---------- settings (data/settings.json) ----------
let settings = { skipPermissions: false };
try { settings = { ...settings, ...JSON.parse(readFileSync(SETTINGS_PATH, "utf8")) }; } catch {}
async function saveSettings(next) {
  settings = { skipPermissions: !!(next && next.skipPermissions) };
  await mkdir(DATA_DIR, { recursive: true }).catch(() => {});
  const tmp = SETTINGS_PATH + ".tmp";
  await writeFile(tmp, JSON.stringify(settings, null, 2));
  await rename(tmp, SETTINGS_PATH);
  return settings;
}

// ---------- live agents (interactive Claude in a PTY) ----------
// Each agent is a `claude` running inside a pseudo-terminal; bytes stream to the
// browser over /api/agents/term and xterm.js renders them. The PTY outlives any
// single socket, so reloading the page reattaches and repaints from a buffer.
const MAX_BUF = 200_000; // chars of scrollback kept per agent for repaint on reattach
const agents = new Map();

const safeSend = (ws, obj) => { try { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); } catch {} };

function createAgent(projId, { resume, cont, cols = 80, rows = 24 } = {}) {
  const p = project(projId);
  if (!p) throw new Error("projeto desconhecido: " + projId);
  if (!p.root) throw new Error("projeto sem diretório raiz");
  // Global setting: when on, every new session skips Claude's permission prompts.
  const skip = settings.skipPermissions ? ["--dangerously-skip-permissions"] : [];
  const claudeArgs = [...skip, ...(resume ? ["--resume", resume] : cont ? ["--continue"] : [])];
  const isWin = process.platform === "win32";
  // On Windows `claude` is a .cmd shim → run it through cmd.exe inside the ConPTY.
  const file = isWin ? "cmd.exe" : "claude";
  const args = isWin ? ["/c", "claude", ...claudeArgs] : claudeArgs;
  const term = ptyLib.spawn(file, args, { name: "xterm-256color", cols, rows, cwd: p.root, env: process.env });
  const id = "a" + randomBytes(5).toString("hex");
  const hhmm = new Date().toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  const agent = {
    id, projId, projName: p.name, title: `${p.name} · ${hhmm}`, name: "", tags: [],
    cmd: ["claude", ...claudeArgs].join(" "), createdAt: Date.now(),
    cols, rows, buffer: "", exited: false, exitCode: null, pty: term, sockets: new Set(),
    // First-prompt auto-naming: accumulate typed keystrokes until Enter, then name the session.
    typed: "", named: false,
  };
  term.onData((d) => {
    agent.buffer += d;
    if (agent.buffer.length > MAX_BUF) agent.buffer = agent.buffer.slice(-MAX_BUF);
    for (const ws of agent.sockets) safeSend(ws, { t: "data", d });
  });
  term.onExit(({ exitCode }) => {
    agent.exited = true; agent.exitCode = exitCode;
    for (const ws of agent.sockets) safeSend(ws, { t: "exit", code: exitCode });
  });
  agents.set(id, agent);
  return agent;
}

function killAgent(id) {
  const a = agents.get(id);
  if (!a) return false;
  try { a.pty.kill(); } catch {}
  agents.delete(id);
  return true;
}

const agentMeta = (a) => ({
  id: a.id, projId: a.projId, projName: a.projName, title: a.title, name: a.name, tags: a.tags, cmd: a.cmd,
  createdAt: a.createdAt, exited: a.exited, exitCode: a.exitCode, attached: a.sockets.size,
});

// Open a page in its own Chrome/Edge window (--app): separate taskbar button, no
// tabs/omnibox. Falls back to the default browser if no Chromium binary is found.
function findBrowser() {
  const c = [
    process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, "Google\\Chrome\\Application\\chrome.exe"),
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  ];
  return c.find((x) => x && existsSync(x));
}
function openAppWindow(path) {
  const url = `http://${HOST}:${PORT}${path}`;
  const exe = findBrowser();
  if (!exe) {
    spawn("cmd.exe", ["/c", "start", "", url], { detached: true, stdio: "ignore", windowsVerbatimArguments: true }).unref();
    return { ok: true, browser: "default" };
  }
  spawn(exe, [`--app=${url}`, "--window-size=1440,900"], { detached: true, stdio: "ignore" }).unref();
  return { ok: true, browser: basename(exe) };
}

// Relaunch the Node server: spawn a detached launcher that waits for this process
// to release the port, starts a fresh server, then we exit. The browser reconnects.
function restartServer() {
  const cmd = `Start-Sleep -Milliseconds 800; Start-Process -FilePath '${process.execPath}' -ArgumentList '"${join(ROOT, "server.mjs")}"' -WorkingDirectory '${ROOT}' -WindowStyle Hidden`;
  spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", cmd], { detached: true, stdio: "ignore" }).unref();
  setTimeout(() => process.exit(0), 250);
}

// Condense a first prompt into a short, label-like name: the first few words rather
// than the whole sentence. No LLM — just a heuristic (keep it offline/dependency-light).
function summarizeLine(line) {
  const MAX_WORDS = 6, MAX_CHARS = 40;
  const words = line.split(" ");
  let name = words.slice(0, MAX_WORDS).join(" ");
  if (name.length > MAX_CHARS) {                  // over the cap: back off to the last whole word
    name = name.slice(0, MAX_CHARS);
    const sp = name.lastIndexOf(" ");
    name = (sp > 0 ? name.slice(0, sp) : name).trim();
  }
  if (name.length < line.length) name += "…";
  return name;
}

// Auto-name a fresh session from its first submitted prompt. We can't read claude's
// input box, so we reconstruct what the user typed from the raw keystroke stream:
// accumulate printable chars, honor backspace, skip escape sequences (arrows, paste
// markers, …), and commit on Enter. Stops after the first non-empty line is captured.
function captureFirstPrompt(agent, d) {
  if (agent.named || agent.name) return;
  let buf = agent.typed;
  for (let i = 0; i < d.length; i++) {
    const ch = d[i], code = d.charCodeAt(i);
    if (ch === "\x1b") {                       // skip an ANSI/escape sequence (incl. bracketed-paste markers)
      let j = i + 1;
      if (d[j] === "[" || d[j] === "O") { j++; while (j < d.length && !/[A-Za-z~]/.test(d[j])) j++; }
      i = j;
      continue;
    }
    if (code === 13 || code === 10) {          // Enter → commit the line if it has content
      const line = buf.replace(/\s+/g, " ").trim();
      if (line) {
        agent.name = summarizeLine(line); agent.named = true; agent.typed = "";
        for (const ws of agent.sockets) safeSend(ws, { t: "meta", id: agent.id, name: agent.name });
        return;
      }
      buf = "";                                // blank Enter: reset and keep waiting
      continue;
    }
    if (code === 127 || code === 8) { buf = buf.slice(0, -1); continue; } // backspace/del
    if (code < 32) continue;                   // other control chars (Ctrl-C, Tab, …) — ignore
    buf += ch;
  }
  agent.typed = buf;
}

// WebSocket: attach to an existing agent (?agent=id) or create a new one
// (?project=id[&cont=1|&resume=sid][&cols=&rows=]). Frames:
//   client → { t:"in", d } | { t:"resize", cols, rows }
//   server → { t:"ready"|"data"|"exit"|"error", … }
function handleTerm(ws, url) {
  let agent;
  try {
    const existing = url.searchParams.get("agent");
    if (existing) {
      agent = agents.get(existing);
      if (!agent) { safeSend(ws, { t: "error", error: "agente não existe mais" }); return ws.close(); }
    } else {
      agent = createAgent(url.searchParams.get("project"), {
        resume: url.searchParams.get("resume"), cont: url.searchParams.get("cont"),
        cols: Number(url.searchParams.get("cols")) || 80, rows: Number(url.searchParams.get("rows")) || 24,
      });
    }
  } catch (e) { safeSend(ws, { t: "error", error: String(e.message || e) }); return ws.close(); }

  agent.sockets.add(ws);
  safeSend(ws, { t: "ready", id: agent.id, title: agent.title, projId: agent.projId, exited: agent.exited });
  if (agent.buffer) safeSend(ws, { t: "data", d: agent.buffer });
  if (agent.exited) safeSend(ws, { t: "exit", code: agent.exitCode });

  ws.on("message", (raw) => {
    let m; try { m = JSON.parse(raw.toString()); } catch { return; }
    if (agent.exited) return;
    if (m.t === "in" && typeof m.d === "string") { try { agent.pty.write(m.d); } catch {} captureFirstPrompt(agent, m.d); }
    else if (m.t === "resize") {
      const c = Math.max(2, m.cols | 0), r = Math.max(1, m.rows | 0);
      agent.cols = c; agent.rows = r; try { agent.pty.resize(c, r); } catch {}
    }
  });
  ws.on("close", () => agent.sockets.delete(ws));
}

// ---------- static ----------
function serveStatic(res, urlPath) {
  const rel = urlPath === "/" ? "/index.html" : urlPath;
  const filePath = join(ROOT, rel.replace(/^\/+/, ""));
  if (!filePath.startsWith(ROOT) || !existsSync(filePath)) return send(res, 404, "Not found");
  res.writeHead(200, { "Content-Type": MIME[extname(filePath)] || "application/octet-stream", "Cache-Control": "no-store" });
  createReadStream(filePath).pipe(res);
}

// ---------- router ----------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;
  try {
    if (p === "/api/projects" && req.method === "GET") return send(res, 200, projectsMeta());
    if (p === "/api/projects" && req.method === "POST") {
      try {
        const b = JSON.parse(await readBody(req));
        const proj = addProject({ name: b.name, root: b.root, color: b.color });
        return send(res, 200, { ok: true, project: { id: proj.id, name: proj.name, color: proj.color } });
      } catch (e) { return send(res, 200, { ok: false, error: String(e.message || e) }); }
    }

    if (p === "/api/agents/live" && req.method === "GET") return send(res, 200, { agents: [...agents.values()].map(agentMeta) });
    if (p === "/api/agents/kill" && req.method === "POST") return send(res, 200, { ok: killAgent(url.searchParams.get("id")) });
    if (p === "/api/agents/meta" && req.method === "PUT") {
      const a = agents.get(url.searchParams.get("id"));
      if (!a) return send(res, 200, { ok: false, error: "agente não existe" });
      try {
        const b = JSON.parse(await readBody(req));
        if (typeof b.name === "string") { a.name = b.name.slice(0, 80); a.named = true; }
        if (Array.isArray(b.tags)) a.tags = b.tags.map((t) => String(t).slice(0, 24)).filter(Boolean).slice(0, 12);
        return send(res, 200, { ok: true, agent: agentMeta(a) });
      } catch (e) { return send(res, 200, { ok: false, error: String(e.message || e) }); }
    }
    if (p === "/api/agents/open-window" && req.method === "POST") {
      try { return send(res, 200, openAppWindow("/")); }
      catch (e) { return send(res, 200, { ok: false, error: String(e.message || e) }); }
    }
    if (p === "/api/restart" && req.method === "POST") {
      send(res, 200, { ok: true });
      console.log("\n  ↻ reiniciando orquestrador…\n");
      return restartServer();
    }

    if (p === "/api/settings" && req.method === "GET") return send(res, 200, settings);
    if (p === "/api/settings" && req.method === "PUT") {
      try { return send(res, 200, { ok: true, settings: await saveSettings(JSON.parse(await readBody(req))) }); }
      catch (e) { return send(res, 400, { error: String(e.message || e) }); }
    }

    if (p.startsWith("/api/")) return send(res, 404, { error: "no such endpoint" });
    return serveStatic(res, p);
  } catch (e) {
    return send(res, 500, { error: String((e && e.message) || e) });
  }
});

// WebSocket endpoint for embedded agent terminals (PTY ⇄ xterm.js).
const wss = new WebSocketServer({ noServer: true });
server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname !== "/api/agents/term") return socket.destroy();
  wss.handleUpgrade(req, socket, head, (ws) => handleTerm(ws, url));
});

server.listen(PORT, HOST, () => {
  console.log(`\n  Claude Orchestrator  →  http://${HOST}:${PORT}\n  projetos: ${PROJECT_IDS.join(", ") || "(nenhum — edite projects.json)"}\n  (Ctrl+C para sair)\n`);
});
