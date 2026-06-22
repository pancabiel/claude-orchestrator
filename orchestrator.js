// hub/orchestrator.js — full-screen Claude agent orchestrator (Conductor-style).
// Opens in its own Chrome --app window. Left: sessions grouped by project, each
// with a project indicator, an editable name and tags. Right: the live terminal
// of the selected agent. Reuses the Hub's PTY/WebSocket backend (/api/agents/*).

const $ = (s, r = document) => r.querySelector(s);
const el = (tag, cls, html) => { const n = document.createElement(tag); if (cls) n.className = cls; if (html != null) n.innerHTML = html; return n; };
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
const showOverlay = (msg) => { const o = el("div", "orch-overlay", `<div class="orch-overlay-box"><span class="orch-spin"></span>${esc(msg)}</div>`); document.body.appendChild(o); return o; };
const api = {
  get: (p) => fetch(p).then((r) => r.json()),
  put: (p, b) => fetch(p, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) }).then((r) => r.json()),
  post: (p, b) => fetch(p, { method: "POST", headers: b ? { "Content-Type": "application/json" } : {}, body: b ? JSON.stringify(b) : undefined }).then((r) => r.json()),
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

// Sidebar layout is user-controlled (drag to reorder / group), not derived from
// the project. Tree of items persisted in localStorage; agent ids are reconciled
// against the live list on every render (new ones land at the root, dead ones drop).
let layout = loadLayout();   // { items: ( {type:"agent",id} | {type:"group",id,name,collapsed,children:[...]} )[] }
let dragData = null;         // { agentId } while dragging a row
function loadLayout() {
  try { const l = JSON.parse(localStorage.getItem("orch-layout") || ""); if (l && Array.isArray(l.items)) return l; } catch {}
  return { items: [] };
}
const saveLayout = () => { try { localStorage.setItem("orch-layout", JSON.stringify(layout)); } catch {} };

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
    else if (m.t === "meta") {                 // server pushed an updated name (e.g. auto-named from first prompt)
      const a = live.find((x) => x.id === m.id);
      if (a && typeof m.name === "string") { a.name = m.name; renderSide(); if (activeId === m.id) renderHead(); }
      else loadLive();                         // snapshot not warm yet — pull fresh state (also re-renders)
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

// ---- layout tree helpers (find / remove / reconcile against live agents) ----
function findAgent(id) {
  for (const it of layout.items) {
    if (it.type === "agent" && it.id === id) return { list: layout.items, index: layout.items.indexOf(it), group: null };
    if (it.type === "group") { const j = it.children.findIndex((c) => c.id === id); if (j >= 0) return { list: it.children, index: j, group: it }; }
  }
  return null;
}
function removeAgent(id) {
  const loc = findAgent(id);
  if (!loc) return null;
  const [item] = loc.list.splice(loc.index, 1);
  if (loc.group && loc.group.children.length === 0) { const gi = layout.items.indexOf(loc.group); if (gi >= 0) layout.items.splice(gi, 1); } // dissolve empty group
  return item;
}
function reconcile(agentList) {
  const ids = new Set(agentList.map((a) => a.id));
  for (const it of layout.items) if (it.type === "group") it.children = it.children.filter((c) => ids.has(c.id));
  layout.items = layout.items.filter((it) => (it.type === "agent" ? ids.has(it.id) : it.children.length > 0));
  const have = new Set();
  for (const it of layout.items) it.type === "agent" ? have.add(it.id) : it.children.forEach((c) => have.add(c.id));
  for (const a of agentList) if (!have.has(a.id)) layout.items.push({ type: "agent", id: a.id });
  saveLayout();
}

function renderSide() {
  if (!sideHost) return;
  const metaList = [...live];
  const pendingRec = activeId && activeId.startsWith && activeId.startsWith("pending:") ? terms.get(activeId.slice(8)) : null;
  if (pendingRec && !pendingRec.serverId)
    metaList.push({ id: activeId, projId: pendingRec.projId, title: "iniciando…", name: "", tags: [], exited: false, pending: true });
  reconcile(metaList);
  const metaById = new Map(metaList.map((a) => [a.id, a]));
  sideHost.innerHTML = "";
  if (!layout.items.length) {
    sideHost.appendChild(el("div", "orch-side-empty muted", 'Nenhuma sessão.<br>Clique <b>＋ Novo</b> para criar.<br><span class="orch-hint">Arraste sessões umas sobre as outras para agrupar.</span>'));
    return;
  }
  for (const it of layout.items) {
    if (it.type === "agent") { const a = metaById.get(it.id); if (a) sideHost.appendChild(agentRow(a)); }
    else sideHost.appendChild(groupEl(it, metaById));
  }
}

function agentRow(a) {
  const active = a.id === activeId;
  const row = el("div", "orch-row" + (active ? " active" : "") + (a.exited ? " exited" : ""));
  row.dataset.agent = a.id;
  row.draggable = !a.pending;
  const label = a.name || a.title || "(sessão)";
  row.innerHTML = `
    <span class="pdot" style="background:${projColor(a.projId)}" title="${esc(projName(a.projId))}"></span>
    <div class="orch-row-main">
      <div class="orch-row-name">${esc(label)}</div>
      ${(a.tags || []).length ? `<div class="orch-row-tags">${a.tags.map((t) => `<span class="orch-tag-sm">${esc(t)}</span>`).join("")}</div>` : ""}
    </div>
    ${a.pending ? "" : `<button class="orch-row-x" title="encerrar">✕</button>`}`;
  row.onclick = (e) => { if (e.target.closest(".orch-row-x")) { killAgent(a.id); return; } if (!a.pending) select(a.id); };
  if (!a.pending) attachRowDnd(row, a.id);
  return row;
}

function groupEl(g, metaById) {
  const wrap = el("div", "orch-group" + (g.collapsed ? " collapsed" : ""));
  wrap.dataset.group = g.id;
  const head = el("div", "orch-group-head");
  head.innerHTML = `
    <span class="orch-group-caret">${g.collapsed ? "▸" : "▾"}</span>
    <b class="orch-group-name">${esc(g.name || "Grupo")}</b>
    <span class="orch-group-n">${g.children.length}</span>`;
  head.onclick = (e) => { if (e.target.closest(".orch-group-name")) return; g.collapsed = !g.collapsed; saveLayout(); renderSide(); };
  $(".orch-group-name", head).ondblclick = (e) => { e.stopPropagation(); renameGroup(g, $(".orch-group-name", head)); };
  attachGroupDrop(head, g);
  wrap.appendChild(head);
  if (!g.collapsed) {
    const body = el("div", "orch-group-body");
    for (const c of g.children) { const a = metaById.get(c.id); if (a) body.appendChild(agentRow(a)); }
    wrap.appendChild(body);
  }
  return wrap;
}

function renameGroup(g, nameEl) {
  const inp = el("input", "orch-group-rename");
  inp.value = g.name || "";
  nameEl.replaceWith(inp);
  inp.focus(); inp.select();
  const commit = () => { g.name = inp.value.trim() || "Grupo"; saveLayout(); renderSide(); };
  inp.onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); commit(); } else if (e.key === "Escape") renderSide(); };
  inp.onblur = commit;
}

// ---- drag & drop: reorder freely, drop onto a row/header to group, drop on empty to ungroup ----
const clearDropMarks = () => sideHost && sideHost.querySelectorAll(".drop-before,.drop-after,.drop-into").forEach((n) => n.classList.remove("drop-before", "drop-after", "drop-into"));

function attachRowDnd(row, id) {
  row.addEventListener("dragstart", (e) => { dragData = { agentId: id }; e.dataTransfer.effectAllowed = "move"; try { e.dataTransfer.setData("text/plain", id); } catch {} setTimeout(() => row.classList.add("dragging"), 0); });
  row.addEventListener("dragend", () => { dragData = null; row.classList.remove("dragging"); clearDropMarks(); });
  row.addEventListener("dragover", (e) => {
    if (!dragData || dragData.agentId === id) return;
    e.preventDefault();
    const r = row.getBoundingClientRect(), rel = (e.clientY - r.top) / r.height;
    clearDropMarks();
    row.classList.add(rel < 0.28 ? "drop-before" : rel > 0.72 ? "drop-after" : "drop-into");
  });
  row.addEventListener("dragleave", () => row.classList.remove("drop-before", "drop-after", "drop-into"));
  row.addEventListener("drop", (e) => {
    if (!dragData || dragData.agentId === id) return;
    e.preventDefault(); e.stopPropagation();
    const r = row.getBoundingClientRect(), rel = (e.clientY - r.top) / r.height, dragged = dragData.agentId;
    if (rel >= 0.28 && rel <= 0.72) groupWith(id, dragged);
    else moveNextTo(dragged, id, rel > 0.72);
    clearDropMarks(); saveLayout(); renderSide();
  });
}

function attachGroupDrop(head, g) {
  head.addEventListener("dragover", (e) => { if (!dragData) return; e.preventDefault(); head.classList.add("drop-into"); });
  head.addEventListener("dragleave", () => head.classList.remove("drop-into"));
  head.addEventListener("drop", (e) => {
    if (!dragData) return;
    e.preventDefault(); e.stopPropagation();
    const item = removeAgent(dragData.agentId);
    if (item) g.children.push(item);
    head.classList.remove("drop-into"); saveLayout(); renderSide();
  });
}

function moveNextTo(draggedId, targetId, after) {
  if (draggedId === targetId) return;
  const item = removeAgent(draggedId);
  if (!item) return;
  const loc = findAgent(targetId);
  if (!loc) { layout.items.push(item); return; }
  loc.list.splice(loc.index + (after ? 1 : 0), 0, item);
}

function groupWith(targetId, draggedId) {
  if (targetId === draggedId) return;
  const item = removeAgent(draggedId);
  if (!item) return;
  const loc = findAgent(targetId);
  if (!loc) { layout.items.push(item); return; }
  if (loc.group) { loc.group.children.splice(loc.index + 1, 0, item); return; }
  const targetItem = loc.list[loc.index];
  const sameProj = metaProj(targetItem.id) && metaProj(targetItem.id) === metaProj(item.id);
  const grp = { type: "group", id: "g" + Math.random().toString(36).slice(2, 8), name: sameProj ? projName(metaProj(targetItem.id)) : "Grupo", collapsed: false, children: [targetItem, item] };
  loc.list.splice(loc.index, 1, grp);
}
const metaProj = (id) => { const a = live.find((x) => x.id === id); return a ? a.projId : null; };

function setupSideDnd() {
  if (!sideHost) return;
  sideHost.addEventListener("dragover", (e) => { if (dragData) e.preventDefault(); });
  sideHost.addEventListener("drop", (e) => {            // dropped on empty area → move to root (ungroup)
    if (!dragData) return;
    e.preventDefault();
    const item = removeAgent(dragData.agentId);
    if (item) layout.items.push(item);
    saveLayout(); renderSide();
  });
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
  root.innerHTML = `
    <aside class="orch-side-col">
      <div class="orch-brand">
        <button class="orch-menu-btn" data-menu-toggle title="Menu" aria-label="Menu">☰</button>
        <img class="orch-logo" src="/icon.png" alt="" /> Orquestrador de Agentes
        <div class="orch-menu" hidden>
          <div class="orch-menu-item" data-restart>↻ Reiniciar orquestrador</div>
        </div>
      </div>
      <div class="orch-new">
        <button class="btn primary orch-new-btn" data-new-toggle title="iniciar uma nova sessão">＋ Novo</button>
        <div class="orch-proj-menu" hidden></div>
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
  setupSideDnd();

  // hamburger menu (top-left): por enquanto só "Reiniciar orquestrador"
  const menuBtn = $("[data-menu-toggle]", root);
  const menu = $(".orch-menu", root);
  const closeAppMenu = () => { menu.hidden = true; menuBtn.classList.remove("open"); };
  menuBtn.onclick = (e) => { e.stopPropagation(); menu.hidden = !menu.hidden; menuBtn.classList.toggle("open", !menu.hidden); };
  $("[data-restart]", menu).onclick = async () => {
    closeAppMenu();
    showOverlay("Reiniciando orquestrador…");
    await api.post("/api/restart").catch(() => {}); // a conexão cai durante o restart
    setTimeout(() => location.reload(), 2500);       // recarrega quando o servidor voltar
  };
  document.addEventListener("click", (e) => { if (!menu.hidden && !e.target.closest(".orch-brand")) closeAppMenu(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeAppMenu(); });

  const newBtn = $(".orch-new-btn", root);
  const projMenu = $(".orch-proj-menu", root);
  const closeMenu = () => { projMenu.hidden = true; newBtn.classList.remove("open"); };
  const openMenu = () => { renderProjMenu(); projMenu.hidden = false; newBtn.classList.add("open"); };
  newBtn.onclick = (e) => { e.stopPropagation(); projMenu.hidden ? openMenu() : closeMenu(); };

  function renderProjMenu(adding = false) {
    const rows = projects.map((p) => `
      <div class="orch-proj-row" data-proj="${esc(p.id)}" title="nova sessão em ${esc(p.name)}">
        <span class="pdot" style="background:${projColor(p.id)}"></span>
        <span class="orch-proj-row-name">${esc(p.name)}</span>
        <button class="orch-proj-cont" data-cont="${esc(p.id)}" title="retomar a última sessão (claude --continue)">↻</button>
      </div>`).join("");
    projMenu.innerHTML = `
      ${rows || `<div class="orch-proj-empty muted">Nenhum projeto ainda.</div>`}
      <div class="orch-proj-divider"></div>
      ${adding ? `
        <form class="orch-proj-form">
          <input class="orch-proj-input" data-add-name placeholder="Nome do projeto" maxlength="40" autocomplete="off" />
          <input class="orch-proj-input" data-add-root placeholder="Diretório (ex.: E:\\repos\\meu-app)" autocomplete="off" />
          <div class="orch-proj-form-err"></div>
          <div class="orch-proj-form-actions">
            <button type="button" class="btn mini" data-add-cancel>Cancelar</button>
            <button type="submit" class="btn mini primary" data-add-save>Adicionar</button>
          </div>
        </form>`
        : `<div class="orch-proj-add" data-add-toggle>＋ Adicionar projeto…</div>`}`;
    if (adding) {
      const form = $(".orch-proj-form", projMenu);
      const nameI = $("[data-add-name]", projMenu);
      const rootI = $("[data-add-root]", projMenu);
      const err = $(".orch-proj-form-err", projMenu);
      nameI.focus();
      form.onsubmit = async (e) => {
        e.preventDefault();
        err.textContent = "";
        const save = $("[data-add-save]", projMenu);
        save.disabled = true; save.textContent = "Adicionando…";
        const r = await api.post("/api/projects", { name: nameI.value, root: rootI.value }).catch((x) => ({ ok: false, error: String(x) }));
        if (!r.ok) { err.textContent = r.error || "falhou"; save.disabled = false; save.textContent = "Adicionar"; return; }
        projects = await api.get("/api/projects").catch(() => projects);
        for (const pr of projects) projById[pr.id] = pr;
        closeMenu();
        newAgent(r.project.id, {}); // já abre uma sessão no projeto recém-criado
      };
      $("[data-add-cancel]", projMenu).onclick = () => renderProjMenu(false);
    }
  }

  projMenu.onclick = (e) => {
    e.stopPropagation(); // cliques dentro do menu nunca fecham via "clique-fora" (re-render destaca o alvo)
    if (e.target.closest(".orch-proj-form")) return; // não fecha enquanto digita
    const cont = e.target.closest("[data-cont]");
    if (cont) { closeMenu(); newAgent(cont.dataset.cont, { cont: 1 }); return; }
    if (e.target.closest("[data-add-toggle]")) { renderProjMenu(true); return; }
    const row = e.target.closest("[data-proj]");
    if (row) { closeMenu(); newAgent(row.dataset.proj, {}); }
  };
  document.addEventListener("click", (e) => { if (!projMenu.hidden && !e.target.closest(".orch-new")) closeMenu(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeMenu(); });
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
