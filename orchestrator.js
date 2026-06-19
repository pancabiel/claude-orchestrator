// hub/orchestrator.js — full-screen Claude agent orchestrator (Conductor-style).
// Opens in its own Chrome --app window. Left: sessions grouped by project, each
// with a project indicator, an editable name and tags. Right: the live terminal
// of the selected agent. Reuses the Hub's PTY/WebSocket backend (/api/agents/*).

const $ = (s, r = document) => r.querySelector(s);
const el = (tag, cls, html) => { const n = document.createElement(tag); if (cls) n.className = cls; if (html != null) n.innerHTML = html; return n; };
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
const api = {
  get: (p) => fetch(p).then((r) => r.json()),
  put: (p, b) => fetch(p, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) }).then((r) => r.json()),
  post: (p) => fetch(p, { method: "POST" }).then((r) => r.json()),
};

// ---------------- state ----------------
let projects = [];
const projById = {};
const projColor = (id) => (projById[id] && projById[id].color) || "#64748b";
const projName = (id) => (projById[id] && projById[id].name) || id || "—";

const terms = new Map();   // local key -> { key, serverId, term, fit, wrap, ws, projId, exited }
let live = [];             // last /api/agents/live snapshot (authoritative metadata)
let activeId = null;       // serverId of the agent shown in the terminal
let lastProj = localStorage.getItem("orch-last-proj") || null;

let sideHost, headHost, termHost, skipBox;

// ---------------- terminal core (PTY ⇄ xterm) ----------------
function wsUrl(params) {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${location.host}/api/agents/term?${params.toString()}`;
}
function makeTerm(projId) {
  const wrap = el("div", "term-wrap");
  const term = new window.Terminal({
    fontFamily: '"Cascadia Mono", Consolas, "Courier New", monospace',
    fontSize: 13.5, cursorBlink: true, scrollback: 10000,
    theme: { background: "#0b0f14", foreground: "#d6deeb", cursor: "#7dd3fc", selectionBackground: "#1e3a5f" },
  });
  const fit = new window.FitAddon.FitAddon();
  term.loadAddon(fit);
  // NB: open() is deferred to first mount() — opening on a detached element measures 0×0.
  const rec = { key: "t" + Math.random().toString(36).slice(2, 9), serverId: null, term, fit, wrap, ws: null, projId, exited: false, opened: false };
  term.onData((d) => { if (rec.ws && rec.ws.readyState === 1) rec.ws.send(JSON.stringify({ t: "in", d })); });
  terms.set(rec.key, rec);
  return rec;
}
function connect(rec, opts = {}) {
  const params = new URLSearchParams();
  if (opts.attach) params.set("agent", opts.attach);
  else { params.set("project", rec.projId); if (opts.cont) params.set("cont", "1"); if (opts.resume) params.set("resume", opts.resume); }
  if (rec.term.cols) { params.set("cols", rec.term.cols); params.set("rows", rec.term.rows); }
  const ws = new WebSocket(wsUrl(params));
  rec.ws = ws;
  ws.onopen = () => sendResize(rec);
  ws.onmessage = (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    if (m.t === "data") rec.term.write(m.d);
    else if (m.t === "ready") {
      rec.serverId = m.id; rec.exited = !!m.exited; rec._pendingActive = false;
      if (activeId == null || activeId === "pending:" + rec.key) activeId = m.id;
      loadLive(); renderHead(); mount();
    }
    else if (m.t === "exit") { rec.exited = true; rec.term.write(`\r\n\x1b[90m— sessão encerrada (código ${m.code}) —\x1b[0m\r\n`); loadLive(); }
    else if (m.t === "error") { rec.term.write(`\r\n\x1b[31m⚠ ${m.error}\x1b[0m\r\n`); rec.exited = true; }
  };
  return rec;
}
function sendResize(rec) {
  if (!rec.ws || rec.ws.readyState !== 1) return;
  rec.ws.send(JSON.stringify({ t: "resize", cols: rec.term.cols, rows: rec.term.rows }));
}
const recByServer = (id) => [...terms.values()].find((r) => r.serverId === id) || null;

function killAgent(id) {
  api.post("/api/agents/kill?id=" + id).catch(() => {});
  const rec = recByServer(id);
  if (rec) { try { rec.ws && rec.ws.close(); } catch {} try { rec.term.dispose(); } catch {} terms.delete(rec.key); }
  if (activeId === id) activeId = null;
  loadLive(); renderHead(); mount();
}

function newAgent(projId, opts = {}) {
  lastProj = projId; localStorage.setItem("orch-last-proj", projId);
  const rec = makeTerm(projId);
  connect(rec, opts);
  activeId = "pending:" + rec.key;          // visually select until "ready" gives the real id
  rec._pendingActive = true;
  mount(); renderSide();
}

function select(id) {
  let rec = recByServer(id);
  if (!rec) { const a = live.find((x) => x.id === id); rec = makeTerm(a ? a.projId : lastProj); connect(rec, { attach: id }); rec.serverId = id; }
  activeId = id;
  mount(); renderHead(); renderSide();
}

// ---------------- rendering ----------------
function metaOf(id) {
  const a = live.find((x) => x.id === id);
  return a || { name: "", tags: [], title: "(sessão)", projId: lastProj, exited: false };
}

function mount() {
  if (!termHost) return;
  termHost.innerHTML = "";
  // resolve the active rec (supports the transient "pending:" key)
  let rec = null;
  if (activeId && activeId.startsWith && activeId.startsWith("pending:")) rec = terms.get(activeId.slice(8));
  else if (activeId) rec = recByServer(activeId);
  if (!rec) { termHost.appendChild(el("div", "orch-empty", "Nenhum agente selecionado.<br>Escolha um projeto e clique <b>＋ Novo</b>.")); return; }
  termHost.appendChild(rec.wrap);
  requestAnimationFrame(() => {
    if (!rec.opened) { try { rec.term.open(rec.wrap); rec.opened = true; } catch {} }
    try { rec.fit.fit(); } catch {}
    sendResize(rec);
    if (!rec.exited) rec.term.focus();
  });
}

function renderHead() {
  if (!headHost) return;
  const isPending = activeId && activeId.startsWith && activeId.startsWith("pending:");
  if (!activeId || isPending) {
    headHost.innerHTML = `<div class="orch-head-empty muted">${isPending ? "iniciando sessão…" : "Selecione ou crie um agente."}</div>`;
    return;
  }
  const m = metaOf(activeId);
  headHost.innerHTML = `
    <span class="pdot" style="background:${projColor(m.projId)}" title="${esc(projName(m.projId))}"></span>
    <span class="orch-head-proj">${esc(projName(m.projId))}</span>
    <input class="orch-name" placeholder="${esc(m.title || "sessão")}" value="${esc(m.name || "")}" maxlength="80" />
    <div class="orch-tags"></div>
    <span style="flex:1"></span>
    ${m.exited ? `<span class="muted orch-exited">encerrado</span>` : ""}
    <button class="btn mini danger" data-kill title="encerrar agente">✕ Encerrar</button>`;
  const nameInput = $(".orch-name", headHost);
  const save = debounce(() => saveMeta(activeId, { name: nameInput.value }), 400);
  nameInput.oninput = save;
  nameInput.onchange = () => saveMeta(activeId, { name: nameInput.value });
  $("[data-kill]", headHost).onclick = () => killAgent(activeId);
  renderTags(m);
}

function renderTags(m) {
  const host = $(".orch-tags", headHost);
  if (!host) return;
  host.innerHTML = "";
  for (const t of m.tags || []) {
    const chip = el("span", "orch-tag", `${esc(t)} <span class="orch-tag-x">✕</span>`);
    $(".orch-tag-x", chip).onclick = () => saveMeta(activeId, { tags: (m.tags || []).filter((x) => x !== t) });
    host.appendChild(chip);
  }
  const add = el("input", "orch-tag-add");
  add.placeholder = "+ tag";
  add.onkeydown = (e) => {
    if (e.key !== "Enter") return;
    const v = add.value.trim();
    if (!v) return;
    const tags = [...new Set([...(m.tags || []), v])];
    saveMeta(activeId, { tags });
  };
  host.appendChild(add);
}

async function saveMeta(id, patch) {
  const m = metaOf(id);
  const body = { name: patch.name != null ? patch.name : m.name, tags: patch.tags != null ? patch.tags : m.tags };
  // otimista: reflete já no snapshot local
  const a = live.find((x) => x.id === id);
  if (a) { a.name = body.name; a.tags = body.tags; }
  renderSide();
  if (patch.tags != null) renderTags(metaOf(id)); // re-render só as tags (mantém foco do nome)
  await api.put("/api/agents/meta?id=" + id, body).catch(() => {});
}

function renderSide() {
  if (!sideHost) return;
  sideHost.innerHTML = "";
  // agrupa por projeto, na ordem do registro de projetos
  const groups = new Map();
  for (const a of live) { if (!groups.has(a.projId)) groups.set(a.projId, []); groups.get(a.projId).push(a); }
  // inclui o agente "pending" (ainda sem id no servidor) pra ele aparecer na hora
  const pendingRec = activeId && activeId.startsWith && activeId.startsWith("pending:") ? terms.get(activeId.slice(8)) : null;
  if (pendingRec && !pendingRec.serverId) {
    if (!groups.has(pendingRec.projId)) groups.set(pendingRec.projId, []);
    groups.get(pendingRec.projId).push({ id: activeId, projId: pendingRec.projId, title: "iniciando…", name: "", tags: [], exited: false, pending: true });
  }
  if (!groups.size) { sideHost.appendChild(el("div", "orch-side-empty muted", "Nenhum agente. Crie um acima.")); return; }
  const order = projects.map((p) => p.id).filter((id) => groups.has(id));
  for (const pid of order) {
    const wrap = el("div", "orch-group");
    wrap.appendChild(el("div", "orch-group-head", `<span class="pdot" style="background:${projColor(pid)}"></span><b>${esc(projName(pid))}</b><span class="orch-group-n">${groups.get(pid).length}</span>`));
    for (const a of groups.get(pid)) wrap.appendChild(agentRow(a));
    sideHost.appendChild(wrap);
  }
}

function agentRow(a) {
  const active = a.id === activeId;
  const row = el("div", "orch-row" + (active ? " active" : "") + (a.exited ? " exited" : ""));
  const label = a.name || a.title || "(sessão)";
  row.innerHTML = `
    <span class="orch-row-dot ${a.exited ? "" : "on"}"></span>
    <div class="orch-row-main">
      <div class="orch-row-name">${esc(label)}</div>
      ${(a.tags || []).length ? `<div class="orch-row-tags">${a.tags.map((t) => `<span class="orch-tag-sm">${esc(t)}</span>`).join("")}</div>` : ""}
    </div>
    ${a.pending ? "" : `<button class="orch-row-x" title="encerrar">✕</button>`}`;
  row.onclick = (e) => { if (e.target.closest(".orch-row-x")) { killAgent(a.id); return; } if (!a.pending) select(a.id); };
  return row;
}

async function loadLive() {
  try { const r = await api.get("/api/agents/live"); live = r.agents || []; } catch { /* mantém snapshot */ }
  renderSide();
}

// ---------------- shell ----------------
async function boot() {
  if (!window.Terminal) { document.body.innerHTML = `<div style="padding:40px;color:#d6deeb;font:14px system-ui">Não consegui carregar o xterm.js. Rode <code>npm install</code> em E:\\repos\\hub.</div>`; return; }
  try { projects = await api.get("/api/projects"); } catch { projects = []; }
  for (const p of projects) projById[p.id] = p;
  if (!lastProj && projects[0]) lastProj = projects[0].id;
  let st = {}; try { st = await api.get("/api/settings"); } catch {}

  const root = $("#orch");
  const projOpts = projects.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join("");
  root.innerHTML = `
    <aside class="orch-side-col">
      <div class="orch-brand"><span class="orch-logo">✷</span> Orquestrador de Agentes</div>
      <div class="orch-new">
        <select class="orch-proj-sel" title="projeto do novo agente">${projOpts}</select>
        <button class="btn mini primary" data-new title="claude (sessão nova)">＋ Novo</button>
        <button class="btn mini" data-cont title="claude --continue (retoma a última do projeto)">↻</button>
      </div>
      <div class="orch-groups"></div>
      <label class="orch-skip" title="passa --dangerously-skip-permissions em toda sessão nova">
        <input type="checkbox" class="orch-skip-box" ${st.skipPermissions ? "checked" : ""} />
        <span>Pular permissões nas novas sessões <span class="orch-skip-warn">⚠</span></span>
      </label>
    </aside>
    <main class="orch-main">
      <div class="orch-head"></div>
      <div class="orch-term"></div>
    </main>`;
  sideHost = $(".orch-groups", root);
  headHost = $(".orch-head", root);
  termHost = $(".orch-term", root);
  skipBox = $(".orch-skip-box", root);

  const sel = $(".orch-proj-sel", root);
  sel.value = lastProj;
  sel.onchange = () => { lastProj = sel.value; localStorage.setItem("orch-last-proj", sel.value); };
  $("[data-new]", root).onclick = () => newAgent(sel.value, {});
  $("[data-cont]", root).onclick = () => newAgent(sel.value, { cont: 1 });
  skipBox.onchange = () => api.put("/api/settings", { skipPermissions: skipBox.checked }).catch(() => {});

  renderHead();
  await loadLive();
  mount();

  const ro = new ResizeObserver(debounce(() => {
    let rec = activeId && activeId.startsWith && activeId.startsWith("pending:") ? terms.get(activeId.slice(8)) : (activeId && recByServer(activeId));
    if (rec) { try { rec.fit.fit(); } catch {} sendResize(rec); }
  }, 90));
  ro.observe(termHost);
  setInterval(loadLive, 3000); // mantém a lista lateral viva/atualizada
}

boot();
