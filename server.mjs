// server.mjs — local server for the Claude Agent Orchestrator.
// Run: node server.mjs  →  http://127.0.0.1:4319
// Serves the static UI + a small JSON/WebSocket API that spawns each interactive
// `claude` in a pseudo-terminal (node-pty) and bridges it to xterm.js in the page.
import http from "node:http";
import { createReadStream, existsSync, readFileSync, readdirSync, statSync, mkdirSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { writeFile, readFile, rename, mkdir } from "node:fs/promises";
import childProcess, { spawn } from "node:child_process";
import { extname, join, basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";
import ptyLib from "node-pty";
import { WebSocketServer } from "ws";
import { PORT, HOST, HUB_BOARD, PROJECTS, PROJECT_IDS, addProject, updateProject, removeProject, refreshProjects } from "./config.js";
import { feedInput, refineWithAnswer } from "./auto-name.mjs";

// O pty.kill() do node-pty no Windows faz fork() de um helper node
// (conpty_console_list_agent) sem windowsHide; como o servidor não tem console,
// cada sessão fechada piscava uma janela de CMD. Força windowsHide em todo fork.
if (process.platform === "win32") {
  const fork = childProcess.fork;
  childProcess.fork = function (mod, args, opts) {
    if (args != null && !Array.isArray(args)) { opts = args; args = []; }
    return fork.call(this, mod, args ?? [], { windowsHide: true, ...opts });
  };
}

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
const projectsMeta = () => PROJECT_IDS.map((id) => ({ id, name: PROJECTS[id].name, color: PROJECTS[id].color, group: PROJECTS[id].group || null, root: PROJECTS[id].root }));

// ---------- settings (data/settings.json) ----------
// `permissionMode` is the source of truth for how new sessions start. It maps to
// claude's --permission-mode (see `claude --help`), except "bypass" which uses the
// --dangerously-skip-permissions flag so old skipPermissions configs keep working:
//   "default"     → asks for permissions normally (no flag)
//   "auto"        → --permission-mode auto        (auto-runs what it deems safe)
//   "acceptEdits" → --permission-mode acceptEdits (auto-accepts file edits)
//   "bypass"      → --dangerously-skip-permissions (asks for nothing) ⚠
// `skipPermissions` is kept in sync (= mode "bypass") for backward compatibility.
const PERM_MODES = ["default", "auto", "acceptEdits", "bypass"];
const normalizeMode = (m, skip) => (PERM_MODES.includes(m) ? m : skip ? "bypass" : "default");
let settings = { permissionMode: "default", skipPermissions: false };
try { settings = { ...settings, ...JSON.parse(readFileSync(SETTINGS_PATH, "utf8")) }; } catch {}
settings.permissionMode = normalizeMode(settings.permissionMode, settings.skipPermissions);
settings.skipPermissions = settings.permissionMode === "bypass";
async function saveSettings(next) {
  const mode = normalizeMode(next && next.permissionMode, next && next.skipPermissions);
  settings = { permissionMode: mode, skipPermissions: mode === "bypass" };
  await mkdir(DATA_DIR, { recursive: true }).catch(() => {});
  const tmp = SETTINGS_PATH + ".tmp";
  await writeFile(tmp, JSON.stringify(settings, null, 2));
  await rename(tmp, SETTINGS_PATH);
  return settings;
}

// ---------- Hub Kanban cards ----------
// Append a card to the central Hub board (config HUB_BOARD). The Hub reads the board
// from disk on every request, so we just do an atomic read-modify-write here and the
// card surfaces in the Hub UI on its next poll. Single-user/local: the only race is
// dragging a card in the Hub at the same instant, which is acceptable. Card shape
// mirrors hub/server.mjs (id, project, status, title, desc, area, tags, updated).
let _cardSeq = 0;
const cardUid = () => `c${Date.now().toString(36)}${(_cardSeq++).toString(36)}`;

async function readBoardMeta() {
  if (!HUB_BOARD || !existsSync(HUB_BOARD)) return { ok: false, boardPath: HUB_BOARD || null, columns: [] };
  try {
    const b = JSON.parse(await readFile(HUB_BOARD, "utf8"));
    return { ok: true, boardPath: HUB_BOARD, columns: Array.isArray(b.columns) ? b.columns : [] };
  } catch (e) { return { ok: false, boardPath: HUB_BOARD, columns: [], error: String(e.message || e) }; }
}

async function addCard({ project, title, desc, status, tags } = {}) {
  if (!HUB_BOARD || !existsSync(HUB_BOARD)) throw new Error("board do Hub não encontrado (defina ORCH_HUB_BOARD)");
  const board = JSON.parse(await readFile(HUB_BOARD, "utf8"));
  if (!board || !Array.isArray(board.cards)) throw new Error("board.json inválido (cards não é uma lista)");
  const cols = (board.columns || []).map((c) => c.id);
  const col = cols.includes(status) ? status : cols.includes("nao_iniciado") ? "nao_iniciado" : cols[0] || "nao_iniciado";
  const card = {
    id: cardUid(),
    project: String(project || "").trim(),
    status: col,
    title: (String(title || "").trim().slice(0, 200)) || "(sem título)",
    desc: String(desc || ""),
    area: "",
    tags: Array.isArray(tags) ? tags.map((t) => String(t).slice(0, 24)).filter(Boolean).slice(0, 12) : [],
    updated: new Date().toISOString(),
  };
  board.cards.push(card);
  const tmp = HUB_BOARD + ".tmp";
  await writeFile(tmp, JSON.stringify(board, null, 2), "utf8");
  await rename(tmp, HUB_BOARD); // atomic
  return { card, boardPath: HUB_BOARD };
}

// ---------- live agents (interactive Claude in a PTY) ----------
// Each agent is a `claude` running inside a pseudo-terminal; bytes stream to the
// browser over /api/agents/term and xterm.js renders them. The PTY outlives any
// single socket, so reloading the page reattaches and repaints from a buffer.
const MAX_BUF = 200_000; // chars of scrollback kept per agent for repaint on reattach
const agents = new Map();

// ---------- persistência das sessões (sobreviver a um restart) ----------
// O PTY morre com o processo, mas a *sessão* não precisa morrer junto: cada agente é
// snapshotado em data/sessions/<id>.json (metadados + scrollback + id da sessão do
// Claude). No boot esses arquivos viram agentes **dormentes** — aparecem na sidebar
// como sempre, só sem processo. Ao abrir um deles, wakeAgent() respawna o `claude`
// com --resume <sessionId> e o contexto volta. Nada é respawnado sozinho: reiniciar
// o servidor não deve disparar dez `claude` de uma vez.
const SESSIONS_DIR = join(DATA_DIR, "sessions");
const SAVE_DEBOUNCE = 1500;                 // agrupa as rajadas de output do PTY em uma escrita
const SESSION_TTL = 7 * 24 * 3600 * 1000;   // dormentes mais velhas que isso somem no boot
try { mkdirSync(SESSIONS_DIR, { recursive: true }); } catch {}

const sessFile = (id) => join(SESSIONS_DIR, id + ".json");
const snapshotOf = (a) => ({
  v: 1, id: a.id, projId: a.projId, projName: a.projName, title: a.title, name: a.name, tags: a.tags,
  named: a.named, userNamed: a.userNamed, refined: a.refined, firstPrompt: a.firstPrompt,
  cmd: a.cmd, createdAt: a.createdAt, cols: a.cols, rows: a.rows, sessionId: a.sessionId || null,
  lastSay: a.lastSay, lastSayAt: a.lastSayAt, savedAt: Date.now(), buffer: a.buffer,
});

const saveTimers = new Map();
function scheduleSave(a) {
  if (saveTimers.has(a.id)) return;
  saveTimers.set(a.id, setTimeout(() => { saveTimers.delete(a.id); saveAgent(a); }, SAVE_DEBOUNCE));
}
function saveAgent(a) {
  const t = saveTimers.get(a.id);
  if (t) { clearTimeout(t); saveTimers.delete(a.id); }
  if (!agents.has(a.id)) return;            // encerrado no meio do caminho: não ressuscita
  try {
    const tmp = sessFile(a.id) + ".tmp";
    writeFileSync(tmp, JSON.stringify(snapshotOf(a)));
    renameSync(tmp, sessFile(a.id));        // atômico: nunca deixa um snapshot pela metade
  } catch {}
}
function saveAllSync() { for (const a of agents.values()) saveAgent(a); }
function forgetAgent(id) {
  const t = saveTimers.get(id);
  if (t) { clearTimeout(t); saveTimers.delete(id); }
  try { unlinkSync(sessFile(id)); } catch {}
}

// Onde o Claude Code guarda os transcripts do projeto: ~/.claude/projects/<root com
// tudo que não é alfanumérico virando "-">/<sessionId>.jsonl.
const transcriptDir = (projId) => {
  const p = project(projId);
  return p && p.root ? join(homedir(), ".claude", "projects", p.root.replace(/[^a-zA-Z0-9]/g, "-")) : null;
};
const hasTranscript = (projId, sid) => {
  const d = transcriptDir(projId);
  return !!(d && sid && existsSync(join(d, sid + ".jsonl")));
};

// Qual sessão dá para retomar. O caminho normal é o sessionId que o hook `Stop`
// mandou. Sem o hook instalado, tentamos adivinhar pelo transcript: entre os .jsonl do
// projeto, o primeiro que nasceu *durante a vida deste agente* (entre o spawn e o
// último snapshot) e que nenhum outro agente já reivindicou. É palpite — a janela
// apertada é justamente para não retomar a sessão de outra janela do mesmo projeto.
function resumableSessionId(a) {
  if (a.sessionId && hasTranscript(a.projId, a.sessionId)) return a.sessionId;
  const dir = transcriptDir(a.projId);
  if (!dir || !existsSync(dir)) return null;
  const taken = new Set([...agents.values()].filter((x) => x !== a && x.sessionId).map((x) => x.sessionId));
  const from = a.createdAt - 30_000, to = (a.savedAt || Date.now()) + 30_000;
  let best = null;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".jsonl")) continue;
    const sid = f.slice(0, -6);
    if (taken.has(sid)) continue;
    let born;
    try { const st = statSync(join(dir, f)); born = st.birthtimeMs || st.ctimeMs; } catch { continue; }
    if (born < from || born > to) continue;                  // fora da vida deste agente: não é dele
    if (!best || born < best.born) best = { sid, born };     // o primeiro criado depois do spawn
  }
  return best ? best.sid : null;
}

// Cada snapshot em disco vira um agente dormente. Um agente dormente é "não está
// rodando" — inclusive os que já tinham encerrado antes do restart: abrir qualquer um
// deles é retomar. O que não dá mais para retomar some daqui (TTL / JSON corrompido).
function restoreAgents() {
  let files = [];
  try { files = readdirSync(SESSIONS_DIR).filter((f) => f.endsWith(".json")); } catch { return 0; }
  let n = 0;
  for (const f of files) {
    const path = join(SESSIONS_DIR, f);
    let s = null;
    try { s = JSON.parse(readFileSync(path, "utf8")); } catch {}
    if (!s || !s.id || Date.now() - (s.savedAt || 0) > SESSION_TTL) { try { unlinkSync(path); } catch {} continue; }
    agents.set(s.id, {
      ...s,
      tags: Array.isArray(s.tags) ? s.tags : [],
      buffer: s.buffer || "", cols: s.cols || 80, rows: s.rows || 24,
      pty: null, sockets: new Set(), dormant: true, exited: false, exitCode: null,
      typed: "", pasting: false,
      firstPrompt: s.firstPrompt || "", named: !!s.named, userNamed: !!s.userNamed, refined: !!s.refined,
      lastSay: s.lastSay || null, lastSayAt: s.lastSayAt || 0,
    });
    n++;
  }
  return n;
}

// Sair sem perder nada: grava todos os snapshots e derruba os PTYs (senão sobram
// `claude` órfãos segurando a mesma sessão que o servidor novo vai tentar retomar).
let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  saveAllSync();
  for (const a of agents.values()) { try { a.pty && a.pty.kill(); } catch {} }
}
process.on("exit", shutdown);
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"]) {
  process.on(sig, () => { shutdown(); process.exit(0); });
}

const safeSend = (ws, obj) => { try { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); } catch {} };

// Start (or restart) an agent's `claude` inside a fresh PTY. Split out of createAgent
// so a *dormant* agent — one restored from disk after the server restarted — can be
// brought back with --resume keeping its id, name, tags, scrollback and sidebar spot.
// Everything that is per-process (pty, exit state, cmd) is (re)set here.
function spawnFor(agent, { resume, cont } = {}) {
  const p = project(agent.projId);
  if (!p) throw new Error("projeto desconhecido: " + agent.projId);
  if (!p.root) throw new Error("projeto sem diretório raiz");
  // Global setting: how new sessions handle permissions (see PERM_MODES above).
  const mode = settings.permissionMode;
  const permArgs = mode === "bypass" ? ["--dangerously-skip-permissions"]
    : mode === "default" ? []
    : ["--permission-mode", mode];
  const claudeArgs = [...permArgs, ...(resume ? ["--resume", resume] : cont ? ["--continue"] : [])];
  const isWin = process.platform === "win32";
  // On Windows `claude` is a .cmd shim → run it through cmd.exe inside the ConPTY.
  const file = isWin ? "cmd.exe" : "claude";
  const args = isWin ? ["/c", "claude", ...claudeArgs] : claudeArgs;
  // ORCH_AGENT_ID/ORCH_PORT são herdados pelos hooks do Claude Code: é assim que o
  // hook `Stop` (hooks/orch-say.mjs) sabe para qual agente mandar a resposta falada.
  const env = { ...process.env, ORCH_AGENT_ID: agent.id, ORCH_PORT: String(PORT) };
  const term = ptyLib.spawn(file, args, { name: "xterm-256color", cols: agent.cols, rows: agent.rows, cwd: p.root, env });
  agent.pty = term;
  agent.cmd = ["claude", ...claudeArgs].join(" ");
  agent.exited = false; agent.exitCode = null; agent.dormant = false;
  term.onData((d) => {
    agent.buffer += d;
    if (agent.buffer.length > MAX_BUF) agent.buffer = agent.buffer.slice(-MAX_BUF);
    for (const ws of agent.sockets) safeSend(ws, { t: "data", d });
    scheduleSave(agent);
  });
  term.onExit(({ exitCode }) => {
    agent.exited = true; agent.exitCode = exitCode;
    for (const ws of agent.sockets) safeSend(ws, { t: "exit", code: exitCode });
    saveAgent(agent);
  });
  return term;
}

function createAgent(projId, { resume, cont, cols = 80, rows = 24 } = {}) {
  const p = project(projId);
  if (!p) throw new Error("projeto desconhecido: " + projId);
  const id = "a" + randomBytes(5).toString("hex");
  const hhmm = new Date().toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  const agent = {
    id, projId, projName: p.name, title: `${p.name} · ${hhmm}`, name: "", tags: [],
    cmd: "", createdAt: Date.now(),
    cols, rows, buffer: "", exited: false, exitCode: null, pty: null, sockets: new Set(),
    // Auto-nomeação (auto-name.mjs): junta o primeiro prompt enviado e, depois, a primeira
    // resposta, e pede um título curto ao `claude` headless. `userNamed` = renomeado à mão.
    typed: "", pasting: false, named: false, userNamed: false, refined: false, firstPrompt: "",
    // Sessão do Claude Code (id vindo do hook `Stop`): é a chave do --resume depois de
    // um restart. `dormant` = agente conhecido, sem processo rodando (ver wakeAgent).
    sessionId: resume || null, dormant: false,
    // Última resposta do Claude, entregue pelo hook `Stop` (ver POST /api/agents/say).
    lastSay: null, lastSayAt: 0,
  };
  spawnFor(agent, { resume, cont });
  agents.set(id, agent);
  saveAgent(agent);
  return agent;
}

// Acorda um agente dormente: respawna o `claude` na mesma sessão de antes do restart.
// Sem sessionId utilizável, começa uma sessão nova no mesmo projeto — a linha, o nome,
// as tags e o scrollback antigo continuam ali; só o contexto do Claude é que recomeça.
function wakeAgent(agent, { cols, rows } = {}) {
  if (cols) agent.cols = cols;
  if (rows) agent.rows = rows;
  const sid = resumableSessionId(agent);
  if (sid) agent.sessionId = sid;
  spawnFor(agent, { resume: sid });
  const note = sid
    ? "— retomando a sessão anterior (claude --resume) —"
    : "— a sessão anterior não pôde ser retomada; começando uma nova neste projeto —";
  const line = `\r\n\x1b[90m${note}\x1b[0m\r\n`;
  agent.buffer += line;
  for (const ws of agent.sockets) safeSend(ws, { t: "data", d: line });
  saveAgent(agent);
  return agent;
}

function killAgent(id) {
  const a = agents.get(id);
  if (!a) return false;
  try { a.pty && a.pty.kill(); } catch {}
  agents.delete(id);
  forgetAgent(id);
  return true;
}

const agentMeta = (a) => ({
  id: a.id, projId: a.projId, projName: a.projName, title: a.title, name: a.name, tags: a.tags, cmd: a.cmd,
  createdAt: a.createdAt, exited: a.exited, exitCode: a.exitCode, attached: a.sockets.size,
  lastSayAt: a.lastSayAt || 0, dormant: !!a.dormant, resumable: !!a.sessionId,
});

// "Dar play": o hook `Stop` (hooks/orch-say.mjs) manda aqui a resposta final da
// rodada — texto limpo do transcript, não a tela do TUI. Guardamos a última (para
// quem chegar depois) e empurramos no WS, onde a UI decide falar ou só oferecer ▶.
const MAX_SAY = 200_000; // só um teto de sanidade: a resposta é falada inteira (speech.js)
// `sessionId` vem no mesmo POST do hook: é a chave que permite retomar esta sessão
// com --resume depois de um restart do orquestrador (ver wakeAgent).
function setSay(agent, text, sessionId) {
  agent.lastSay = String(text || "").slice(0, MAX_SAY);
  agent.lastSayAt = Date.now();
  if (sessionId) agent.sessionId = String(sessionId);
  for (const ws of agent.sockets) safeSend(ws, { t: "say", id: agent.id, text: agent.lastSay, at: agent.lastSayAt });
  saveAgent(agent);
  // A primeira resposta revela o assunto melhor que o prompt: refina o nome uma vez.
  refineWithAnswer(agent, agent.lastSay, emitName);
  return agent.lastSay;
}

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

// Relaunch the Node server: spawn a fresh, detached node and exit. The new process
// retries listen() until this one releases the port (see listenWithRetry). Não usar
// powershell como intermediário: detached no Windows = sem console, e o powershell.exe
// morre na hora sem console — o servidor novo nunca subia.
// As sessões não morrem junto: shutdown() grava o snapshot de cada agente e o
// servidor novo as recarrega dormentes, prontas para retomar (ver restoreAgents).
function restartServer() {
  spawn(process.execPath, [join(ROOT, "server.mjs")], { cwd: ROOT, detached: true, stdio: "ignore", windowsHide: true }).unref();
  shutdown();
  setTimeout(() => process.exit(0), 250);
}

// Empurra o nome recém-calculado (auto-name.mjs é assíncrono: o modelo responde depois).
const emitName = (a) => { for (const ws of a.sockets) safeSend(ws, { t: "meta", id: a.id, name: a.name }); saveAgent(a); };

// WebSocket: attach to an existing agent (?agent=id) or create a new one
// (?project=id[&cont=1|&resume=sid][&cols=&rows=]). Frames:
//   client → { t:"in", d } | { t:"resize", cols, rows }
//   server → { t:"ready"|"data"|"meta"|"say"|"exit"|"error", … }
function handleTerm(ws, url) {
  let agent;
  try {
    const existing = url.searchParams.get("agent");
    if (existing) {
      agent = agents.get(existing);
      if (!agent) { safeSend(ws, { t: "error", error: "agente não existe mais" }); return ws.close(); }
      // Sessão restaurada de um restart: só agora, ao ser aberta, o `claude` volta.
      if (agent.dormant) wakeAgent(agent, { cols: Number(url.searchParams.get("cols")) || agent.cols, rows: Number(url.searchParams.get("rows")) || agent.rows });
    } else {
      agent = createAgent(url.searchParams.get("project"), {
        resume: url.searchParams.get("resume"), cont: url.searchParams.get("cont"),
        cols: Number(url.searchParams.get("cols")) || 80, rows: Number(url.searchParams.get("rows")) || 24,
      });
    }
  } catch (e) { safeSend(ws, { t: "error", error: String(e.message || e) }); return ws.close(); }

  agent.sockets.add(ws);
  safeSend(ws, { t: "ready", id: agent.id, title: agent.title, projId: agent.projId, exited: agent.exited, dormant: agent.dormant });
  if (agent.buffer) safeSend(ws, { t: "data", d: agent.buffer });
  // `replay` = resposta antiga, do histórico: habilita o ▶ sem disparar a fala automática.
  if (agent.lastSay) safeSend(ws, { t: "say", id: agent.id, text: agent.lastSay, at: agent.lastSayAt, replay: true });
  if (agent.exited) safeSend(ws, { t: "exit", code: agent.exitCode });

  ws.on("message", (raw) => {
    let m; try { m = JSON.parse(raw.toString()); } catch { return; }
    if (agent.exited) return;
    if (m.t === "in" && typeof m.d === "string") { try { agent.pty.write(m.d); } catch {} feedInput(agent, m.d, emitName); }
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
    if (p === "/api/projects" && req.method === "GET") { refreshProjects(); return send(res, 200, projectsMeta()); }
    if (p === "/api/projects" && req.method === "POST") {
      try {
        const b = JSON.parse(await readBody(req));
        const proj = addProject({ name: b.name, root: b.root, color: b.color, group: b.group });
        return send(res, 200, { ok: true, project: { id: proj.id, name: proj.name, color: proj.color } });
      } catch (e) { return send(res, 200, { ok: false, error: String(e.message || e) }); }
    }
    if (p === "/api/projects" && req.method === "PUT") {
      // Edits name/root/color/group; the id stays, so running agents are untouched.
      try {
        const b = JSON.parse(await readBody(req));
        const proj = updateProject(url.searchParams.get("id"), { name: b.name, root: b.root, color: b.color, group: b.group });
        return send(res, 200, { ok: true, project: { id: proj.id, name: proj.name, color: proj.color, group: proj.group || null } });
      } catch (e) { return send(res, 200, { ok: false, error: String(e.message || e) }); }
    }
    if (p === "/api/projects" && req.method === "DELETE") {
      // Removes the project from the registry only — running agents are untouched.
      try { return send(res, 200, { ok: removeProject(url.searchParams.get("id")) }); }
      catch (e) { return send(res, 200, { ok: false, error: String(e.message || e) }); }
    }

    if (p === "/api/agents/live" && req.method === "GET") return send(res, 200, { agents: [...agents.values()].map(agentMeta) });
    if (p === "/api/agents/kill" && req.method === "POST") return send(res, 200, { ok: killAgent(url.searchParams.get("id")) });
    if (p === "/api/agents/meta" && req.method === "PUT") {
      const a = agents.get(url.searchParams.get("id"));
      if (!a) return send(res, 200, { ok: false, error: "agente não existe" });
      try {
        const b = JSON.parse(await readBody(req));
        if (typeof b.name === "string") { a.name = b.name.slice(0, 80); a.named = true; a.userNamed = true; }
        if (Array.isArray(b.tags)) a.tags = b.tags.map((t) => String(t).slice(0, 24)).filter(Boolean).slice(0, 12);
        saveAgent(a);
        return send(res, 200, { ok: true, agent: agentMeta(a) });
      } catch (e) { return send(res, 200, { ok: false, error: String(e.message || e) }); }
    }
    // Resposta falada: POST vem do hook `Stop`; GET serve quem reabriu a página.
    if (p === "/api/agents/say" && req.method === "POST") {
      const a = agents.get(url.searchParams.get("id"));
      if (!a) return send(res, 200, { ok: false, error: "agente não existe" });
      try {
        const b = JSON.parse(await readBody(req));
        if (typeof b.text !== "string" || !b.text.trim()) return send(res, 200, { ok: false, error: "sem texto" });
        return send(res, 200, { ok: true, at: (setSay(a, b.text, b.sessionId), a.lastSayAt) });
      } catch (e) { return send(res, 200, { ok: false, error: String(e.message || e) }); }
    }
    if (p === "/api/agents/say" && req.method === "GET") {
      const a = agents.get(url.searchParams.get("id"));
      if (!a) return send(res, 200, { ok: false, error: "agente não existe" });
      return send(res, 200, { ok: true, text: a.lastSay || "", at: a.lastSayAt || 0 });
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

    // Hub Kanban: meta (columns + whether the board is reachable) and card creation.
    if (p === "/api/cards/meta" && req.method === "GET") return send(res, 200, await readBoardMeta());
    if (p === "/api/cards" && req.method === "POST") {
      try { const b = JSON.parse(await readBody(req)); return send(res, 200, { ok: true, ...(await addCard(b)) }); }
      catch (e) { return send(res, 200, { ok: false, error: String(e.message || e) }); }
    }

    if (p.startsWith("/api/")) return send(res, 404, { error: "no such endpoint" });
    if (p === "/m" || p === "/m/") return serveStatic(res, "/mobile.html"); // phone-first quick-prompt view
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

// Sessões do processo anterior voltam como dormentes (o `claude` só é respawnado
// quando você abre uma delas — ver wakeAgent). Antes do listen: assim já aparecem no
// primeiro /api/agents/live que a página pedir.
const restored = restoreAgents();

// Num restart o processo antigo ainda segura a porta por alguns ms: tenta de novo
// por até ~10s em vez de morrer com EADDRINUSE.
let listenTries = 0;
server.on("error", (e) => {
  if (e.code === "EADDRINUSE" && ++listenTries < 40) return setTimeout(() => server.listen(PORT, HOST), 250);
  console.error(e); process.exit(1);
});
server.listen(PORT, HOST, () => {
  const sess = restored ? `\n  sessões restauradas: ${restored} (dormindo — abra para retomar)` : "";
  console.log(`\n  Claude Orchestrator  →  http://${HOST}:${PORT}\n  projetos: ${PROJECT_IDS.join(", ") || "(nenhum — edite projects.json)"}${sess}\n  (Ctrl+C para sair)\n`);
});
