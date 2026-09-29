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
  del: (p) => fetch(p, { method: "DELETE" }).then((r) => r.json()),
};

import { DEPTHS, titleFrom, seedPrompt, makeSeeder } from "./task-depth.js";
import { groupProjects } from "./project-groups.js";
import { speak, stopSpeech, isSpeaking, speechAvailable, unlockSpeech, onSpeechState,
         listVoices, getVoiceId, setVoiceId, onVoicesChanged, voiceIdOf, speakSample,
         getRate, setRate } from "./speech.js";

// ---------------- state ----------------
let projects = [];
const projById = {};
const projColor = (id) => (projById[id] && projById[id].color) || "#64748b";
const projName = (id) => (projById[id] && projById[id].name) || id || "—";

const terms = new Map();   // local key -> { key, serverId, term, fit, wrap, ws, projId, exited }
let live = [];             // last /api/agents/live snapshot (authoritative metadata)
let activeId = null;       // serverId of the agent shown in the terminal
let lastProj = localStorage.getItem("orch-last-proj") || null;
let boardMeta = { ok: false, boardPath: null, columns: [] }; // Hub board (for "✨ Tarefa" cards)
// "Dar play": o hook `Stop` (hooks/orch-say.mjs) entrega a resposta final de cada
// rodada; guardamos em rec.lastSay. Com autoSpeak, só a sessão *ativa* fala sozinha —
// várias sessões falando ao mesmo tempo seria inaudível.
let autoSpeak = localStorage.getItem("orch-speak-auto") === "1";
const unheard = new Set();   // sessões que responderam enquanto você estava em outra

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

let sideHost, headHost, termHost, permSel;

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
  const rec = { key: "t" + Math.random().toString(36).slice(2, 9), serverId: null, term, fit, wrap, ws: null, projId, exited: false, opened: false, lastSay: "" };
  // Clipboard: xterm não cola no Ctrl+V por conta própria (só manda ^V ao PTY), e a
  // colagem nativa não dispara na janela --app. Fiamos copiar/colar à mão via Clipboard API.
  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== "keydown") return true;
    // Ctrl/Shift/Cmd+Enter → quebra de linha no prompt do Claude Code (que a
    // reconhece como ESC+CR, o mesmo que o /terminal-setup mapeia), em vez de
    // submeter. Enter puro segue enviando \r (submete) normalmente.
    if (e.key === "Enter" && (e.ctrlKey || e.shiftKey || e.metaKey)) {
      e.preventDefault();
      if (rec.ws && rec.ws.readyState === 1) rec.ws.send(JSON.stringify({ t: "in", d: "\x1b\r" }));
      return false;
    }
    if (!(e.ctrlKey || e.metaKey)) return true;
    const k = e.key.toLowerCase();
    if (k === "v") {                                   // Ctrl+V / Ctrl+Shift+V → colar
      e.preventDefault();                              // evita a colagem nativa (senão cola duas vezes)
      navigator.clipboard.readText().then((t) => { if (t) term.paste(t); }).catch(() => {});
      return false;
    }
    if (k === "c" && term.hasSelection()) {            // Ctrl+C com seleção → copiar (sem seleção, segue como ^C/interromper)
      e.preventDefault();
      navigator.clipboard.writeText(term.getSelection()).catch(() => {});
      term.clearSelection();
      return false;
    }
    return true;
  });
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
  // "✨ Tarefa": seed a depth-aware opening prompt once the session boots (see task-depth.js).
  const seeder = opts.seedPrompt ? makeSeeder((d) => { if (ws.readyState === 1) ws.send(JSON.stringify({ t: "in", d })); }, opts.seedPrompt) : null;
  ws.onopen = () => sendResize(rec);
  ws.onmessage = (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    if (m.t === "data") { rec.term.write(m.d); seeder && seeder.onData(m.d); }
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
    else if (m.t === "say") {                  // resposta final da rodada (hook Stop)
      rec.lastSay = m.text || "";
      if (rec.serverId === activeId) { if (autoSpeak && !m.replay) speak(rec.lastSay); renderSpeakBtns(); }
      else if (!m.replay) { unheard.add(rec.serverId); renderSide(); }  // 🔊 na linha da sessão que respondeu
    }
    else if (m.t === "exit") { rec.exited = true; rec.term.write(`\r\n\x1b[90m— sessão encerrada (código ${m.code}) —\x1b[0m\r\n`); loadLive(); }
    else if (m.t === "error") { rec.term.write(`\r\n\x1b[31m⚠ ${m.error}\x1b[0m\r\n`); rec.exited = true; rec.gone = true; }
  };
  // O servidor pode ter reiniciado debaixo de nós (menu ↻, crash): a sessão sobrevive
  // no disco, então basta reatar. Só a sessão ativa insiste sozinha; as outras reatam
  // quando você clica nelas (senão um restart acordaria todas de uma vez).
  ws.onclose = () => { if (rec.serverId === activeId) setTimeout(() => ensureConnected(rec), 1500); };
  return rec;
}
// Reata um terminal local ao seu agente. O servidor repinta o scrollback inteiro no
// attach, por isso o reset antes — sem ele o histórico apareceria duplicado.
function ensureConnected(rec) {
  if (!rec || !rec.serverId || rec.gone) return;
  const st = rec.ws && rec.ws.readyState;
  if (st === WebSocket.CONNECTING || st === WebSocket.OPEN) return;
  try { rec.term.reset(); } catch {}
  rec.exited = false;
  connect(rec, { attach: rec.serverId });
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
  unheard.delete(id);
  if (activeId === id) { stopSpeech(); activeId = null; }
  loadLive(); renderHead(); mount();
}

function newAgent(projId, opts = {}) {
  lastProj = projId; localStorage.setItem("orch-last-proj", projId);
  const rec = makeTerm(projId);
  rec.groupId = opts.groupId || null;       // "+" no cabeçalho de um grupo → nasce dentro dele
  connect(rec, opts);
  activeId = "pending:" + rec.key;          // visually select until "ready" gives the real id
  rec._pendingActive = true;
  mount(); renderSide();
}

function select(id) {
  let rec = recByServer(id);
  if (!rec) { const a = live.find((x) => x.id === id); rec = makeTerm(a ? a.projId : lastProj); connect(rec, { attach: id }); rec.serverId = id; }
  else ensureConnected(rec);   // socket caiu (restart do servidor?) → reata, acordando a sessão se preciso
  if (activeId !== id) stopSpeech();   // trocou de sessão: cala a fala da anterior
  unheard.delete(id);
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
    ${m.dormant ? `<span class="muted orch-exited" title="o servidor reiniciou; abrir esta sessão retoma o contexto">💤 dormindo</span>` : ""}
    ${speechAvailable() ? `
      <button class="btn mini" data-say title="ouvir a última resposta">▶ Ouvir</button>
      <button class="btn mini" data-auto title="falar cada resposta desta sessão automaticamente">🔊</button>
      <button class="btn mini" data-voice title="escolher a voz">⚙</button>` : ""}
    <button class="btn mini danger" data-kill title="encerrar agente">✕ Encerrar</button>`;
  const nameInput = $(".orch-name", headHost);
  const save = debounce(() => saveMeta(activeId, { name: nameInput.value }), 400);
  nameInput.oninput = save;
  nameInput.onchange = () => saveMeta(activeId, { name: nameInput.value });
  $("[data-kill]", headHost).onclick = () => killAgent(activeId);
  const sayBtn = $("[data-say]", headHost);
  if (sayBtn) {
    sayBtn.onclick = () => {
      unlockSpeech();
      const rec = recByServer(activeId);
      if (isSpeaking()) stopSpeech();
      else if (rec && rec.lastSay) speak(rec.lastSay);
      renderSpeakBtns();
    };
    $("[data-auto]", headHost).onclick = () => {
      unlockSpeech();
      autoSpeak = !autoSpeak;
      localStorage.setItem("orch-speak-auto", autoSpeak ? "1" : "0");
      if (!autoSpeak) stopSpeech();
      renderSpeakBtns();
    };
    $("[data-voice]", headHost).onclick = () => { unlockSpeech(); openVoiceModal(); };
  }
  renderSpeakBtns();
  renderTags(m);
}

// ▶ vira ⏹ enquanto fala; fica apagado até a primeira resposta chegar do hook.
function renderSpeakBtns() {
  if (!headHost) return;
  const b = $("[data-say]", headHost), a = $("[data-auto]", headHost);
  if (!b) return;
  const rec = activeId && !String(activeId).startsWith("pending:") ? recByServer(activeId) : null;
  const talking = isSpeaking();
  b.textContent = talking ? "⏹ Parar" : "▶ Ouvir";
  b.disabled = !talking && !(rec && rec.lastSay);
  b.classList.toggle("primary", talking);
  if (a) a.classList.toggle("primary", autoSpeak);
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
// Toda sessão nova entra no grupo do seu projeto — se ainda não existe um, ele é
// criado na hora, mesmo que a sessão seja a única. Grupos automáticos carregam
// `projId`; os feitos à mão (arrastando) são adotados quando o nome bate.
function groupOfProject(projId) {
  return layout.items.find((it) => it.type === "group" && (it.projId ? it.projId === projId : it.name === projName(projId))) || null;
}
function ensureProjectGroup(projId) {
  let g = groupOfProject(projId);
  if (g) { if (!g.projId) g.projId = projId; return g; }
  g = { type: "group", id: "gp-" + projId, projId, name: projName(projId), collapsed: false, children: [] };
  layout.items.push(g);
  return g;
}
const recOf = (id) => [...terms.values()].find((r) => r.serverId === id || "pending:" + r.key === id) || null;
function placeNewAgent(a) {
  const item = { type: "agent", id: a.id };
  const rec = recOf(a.id);
  const wanted = rec && rec.groupId ? layout.items.find((it) => it.type === "group" && it.id === rec.groupId) : null;
  const g = wanted || (a.projId ? ensureProjectGroup(a.projId) : null);
  (g ? g.children : layout.items).push(item);
}
function reconcile(agentList) {
  const ids = new Set(agentList.map((a) => a.id));
  for (const it of layout.items) if (it.type === "group") it.children = it.children.filter((c) => ids.has(c.id));
  layout.items = layout.items.filter((it) => (it.type === "agent" ? ids.has(it.id) : it.children.length > 0));
  const have = new Set();
  for (const it of layout.items) it.type === "agent" ? have.add(it.id) : it.children.forEach((c) => have.add(c.id));
  for (const a of agentList) if (!have.has(a.id)) placeNewAgent(a);
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
  // `dormant` = sessão que sobreviveu a um restart do servidor e ainda não foi reaberta:
  // o processo só volta (com --resume) quando você clica nela.
  const row = el("div", "orch-row" + (active ? " active" : "") + (a.exited ? " exited" : "") + (a.dormant ? " dormant" : ""));
  row.dataset.agent = a.id;
  row.draggable = !a.pending;
  const label = a.name || a.title || "(sessão)";
  row.innerHTML = `
    <span class="pdot" style="background:${projColor(a.projId)}" title="${esc(projName(a.projId))}"></span>
    <div class="orch-row-main">
      <div class="orch-row-name">${esc(label)}</div>
      ${(a.tags || []).length ? `<div class="orch-row-tags">${a.tags.map((t) => `<span class="orch-tag-sm">${esc(t)}</span>`).join("")}</div>` : ""}
    </div>
    ${a.dormant ? `<span class="orch-row-sleep" title="dormindo — clique para retomar de onde parou">💤</span>` : ""}
    ${unheard.has(a.id) ? `<span class="orch-row-say" title="respondeu — abra para ouvir">🔊</span>` : ""}
    ${a.pending ? "" : `<button class="orch-row-x" title="encerrar">✕</button>`}`;
  row.onclick = (e) => { if (e.target.closest(".orch-row-x")) { killAgent(a.id); return; } if (!a.pending) select(a.id); };
  if (!a.pending) attachRowDnd(row, a.id);
  return row;
}

// O projeto de um grupo: o dele próprio (grupos automáticos) ou o da primeira sessão dentro.
function groupProjId(g, metaById) {
  if (g.projId) return g.projId;
  for (const c of g.children) { const a = metaById && metaById.get(c.id); if (a && a.projId) return a.projId; }
  return null;
}

function groupEl(g, metaById) {
  const wrap = el("div", "orch-group" + (g.collapsed ? " collapsed" : ""));
  wrap.dataset.group = g.id;
  const pid = groupProjId(g, metaById);
  const head = el("div", "orch-group-head");
  head.innerHTML = `
    <span class="orch-group-caret">${g.collapsed ? "▸" : "▾"}</span>
    <b class="orch-group-name">${esc(g.name || "Grupo")}</b>
    <span class="orch-group-n">${g.children.length}</span>
    ${pid ? `<button class="orch-group-add" title="nova sessão em ${esc(projName(pid))}">＋</button>` : ""}`;
  head.onclick = (e) => {
    if (e.target.closest(".orch-group-add")) { e.stopPropagation(); g.collapsed = false; saveLayout(); newAgent(pid, { groupId: g.id }); return; }
    if (e.target.closest(".orch-group-name")) return;
    g.collapsed = !g.collapsed; saveLayout(); renderSide();
  };
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
  const grp = { type: "group", id: "g" + Math.random().toString(36).slice(2, 8), projId: sameProj ? metaProj(targetItem.id) : null, name: sameProj ? projName(metaProj(targetItem.id)) : "Grupo", collapsed: false, children: [targetItem, item] };
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

// ---------------- seletor de voz ----------------
// As vozes vêm do browser: no Edge existem as neurais da Microsoft ("… Online (Natural)"),
// no Chrome só as SAPI do Windows + a do Google. A escolha fica em localStorage (speech.js).
function openVoiceModal() {
  const back = el("div", "orch-modal-back");
  const edge = /Edg\//.test(navigator.userAgent);
  back.innerHTML = `
    <div class="orch-modal narrow" role="dialog" aria-label="Voz">
      <div class="orch-modal-head"><b>🔊 Voz</b><button class="orch-modal-x" title="fechar">✕</button></div>
      <div class="orch-modal-body">
        <label class="orch-f-label">Voz</label>
        <select class="orch-f-select" data-voices></select>
        <div class="orch-f-hint" data-vhint></div>
        <label class="orch-f-label">Velocidade <span class="muted" data-rateval></span></label>
        <input type="range" class="orch-f-range" data-rate min="0.7" max="1.6" step="0.05" />
      </div>
      <div class="orch-modal-foot">
        <button class="btn" data-test>▶ Testar</button>
        <span style="flex:1"></span>
        <button class="btn primary" data-done>Pronto</button>
      </div>
    </div>`;
  document.body.appendChild(back);

  const sel = $("[data-voices]", back);
  const hint = $("[data-vhint]", back);
  const range = $("[data-rate]", back);
  const rateVal = $("[data-rateval]", back);

  const renderVoices = () => {
    const vs = listVoices();
    const cur = getVoiceId();
    sel.innerHTML = vs.length
      ? vs.map((v) => `<option value="${esc(voiceIdOf(v))}"${voiceIdOf(v) === cur ? " selected" : ""}>${esc(v.name)} · ${esc(v.lang)}</option>`).join("")
      : `<option value="">nenhuma voz em português instalada</option>`;
    sel.disabled = !vs.length;
    const natural = vs.some((v) => /natural|online/i.test(v.name));
    hint.textContent = natural
      ? "As vozes “(Natural)” / “Online” são neurais — bem menos robóticas."
      : edge
        ? "Nenhuma voz neural encontrada. Reabra a janela para o Edge carregar as vozes online."
        : "Vozes neurais só aparecem no Edge. Feche e abra pelo start.vbs (ele agora prefere o Edge).";
  };
  renderVoices();
  const offVoices = onVoicesChanged(renderVoices);

  range.value = String(getRate());
  rateVal.textContent = getRate().toFixed(2) + "×";
  range.oninput = () => { setRate(range.value); rateVal.textContent = getRate().toFixed(2) + "×"; };

  sel.onchange = () => { setVoiceId(sel.value); speakSample(); };
  $("[data-test]", back).onclick = () => speakSample();

  const close = () => { stopSpeech(); offVoices(); back.remove(); document.removeEventListener("keydown", onKey); renderSpeakBtns(); };
  function onKey(e) { if (e.key === "Escape") close(); }
  document.addEventListener("keydown", onKey);
  back.onclick = (e) => { if (e.target === back) close(); };
  $(".orch-modal-x", back).onclick = close;
  $("[data-done]", back).onclick = close;
}

// ---------------- "✨ Tarefa" composer (depth-aware new session) ----------------
// A modal that turns an intent + depth into a seeded session, optionally creating a
// Hub card first. The depth (Rápido / Refinar / Documentar+Fases) is a working style
// encoded in the opening prompt — see task-depth.js. Mirrors the mobile /m flow.
function openComposer() {
  let selP = lastProj || (projects[0] && projects[0].id) || null;
  let selD = localStorage.getItem("orch-depth") || "rapido";
  const hubOff = !boardMeta.ok;
  let mkCard = !hubOff && localStorage.getItem("orch-card") !== "0";

  const back = el("div", "orch-modal-back");
  back.innerHTML = `
    <div class="orch-modal" role="dialog" aria-label="Nova tarefa">
      <div class="orch-modal-head"><b>✨ Nova tarefa</b><button class="orch-modal-x" title="fechar">✕</button></div>
      <div class="orch-modal-body">
        <label class="orch-f-label">Projeto</label>
        <div class="orch-f-projs" data-projs></div>
        <label class="orch-f-label">Profundidade</label>
        <div class="orch-f-depths" data-depths></div>
        <div class="orch-f-hint" data-hint></div>
        <label class="orch-f-card${hubOff ? " disabled" : ""}">
          <input type="checkbox" data-card ${mkCard ? "checked" : ""} ${hubOff ? "disabled" : ""} />
          <span>Criar card no Hub${hubOff ? " <em class='muted'>(board não encontrado)</em>" : ""}</span>
        </label>
        <label class="orch-f-label">O que você quer?</label>
        <textarea class="orch-f-intent" rows="5" placeholder="Ex.: no feed do Nutri, o botão de curtir não atualiza o contador na hora…"></textarea>
        <div class="orch-f-err" data-err></div>
      </div>
      <div class="orch-modal-foot">
        <button class="btn" data-cancel>Cancelar</button>
        <button class="btn primary" data-start>Iniciar →</button>
      </div>
    </div>`;
  document.body.appendChild(back);

  const projsHost = $("[data-projs]", back);
  const depthsHost = $("[data-depths]", back);
  const hint = $("[data-hint]", back);
  const intent = $(".orch-f-intent", back);
  const err = $("[data-err]", back);

  const renderProjs = () => {
    projsHost.innerHTML = "";
    for (const g of groupProjects(projects)) {
      projsHost.appendChild(el("div", "orch-f-group", esc(g.name)));
      const row = el("div", "orch-f-chips");
      for (const p of g.projects) {
        const c = el("button", "orch-f-chip" + (p.id === selP ? " on" : ""), `<span class="pdot" style="background:${p.color}"></span>${esc(p.name)}`);
        c.onclick = () => { selP = p.id; renderProjs(); renderDepths(); };
        row.appendChild(c);
      }
      projsHost.appendChild(row);
    }
  };
  const renderDepths = () => {
    depthsHost.innerHTML = "";
    // "Geral" (afazer) só tem Rápido e Refinar — afazer não vira projeto faseado.
    const assistant = selP === "geral";
    if (assistant && selD === "documentar") { selD = "rapido"; localStorage.setItem("orch-depth", selD); }
    for (const [k, d] of Object.entries(DEPTHS)) {
      if (assistant && k === "documentar") continue;
      const b = el("button", "orch-f-depth" + (k === selD ? " on" : ""), esc(d.label));
      b.onclick = () => { selD = k; localStorage.setItem("orch-depth", k); renderDepths(); };
      depthsHost.appendChild(b);
    }
    hint.textContent = DEPTHS[selD].hint;
  };
  renderProjs(); renderDepths();
  setTimeout(() => intent.focus(), 30);

  const close = () => { back.remove(); document.removeEventListener("keydown", onKey); };
  function onKey(e) { if (e.key === "Escape") close(); }
  document.addEventListener("keydown", onKey);
  back.onclick = (e) => { if (e.target === back) close(); };
  $(".orch-modal-x", back).onclick = close;
  $("[data-cancel]", back).onclick = close;
  $("[data-card]", back).onchange = (e) => { mkCard = e.target.checked; localStorage.setItem("orch-card", mkCard ? "1" : "0"); };

  $("[data-start]", back).onclick = async () => {
    err.textContent = "";
    const text = intent.value.trim();
    if (!selP) { err.textContent = "Escolha um projeto."; return; }
    if (!text) { err.textContent = "Escreva o que você quer."; return; }
    const startBtn = $("[data-start]", back);
    startBtn.disabled = true; startBtn.textContent = "Iniciando…";
    const assistant = selP === "geral"; // pseudo-projeto Geral → modo Assistente (afazer)
    let card = null;
    if (mkCard && boardMeta.ok) {
      const r = await api.post("/api/cards", { project: selP, title: titleFrom(text), desc: text, status: "nao_iniciado", tags: assistant ? ["orquestrador", "afazer"] : ["orquestrador"] }).catch((e) => ({ ok: false, error: String(e) }));
      if (r && r.ok) card = r.card;
      else { err.textContent = "Card não criado: " + ((r && r.error) || "falhou") + " — seguindo sem card."; }
    }
    const prompt = seedPrompt({ intent: text, depth: selD, projectName: projName(selP), card, boardPath: boardMeta.boardPath, assistant });
    close();
    newAgent(selP, { seedPrompt: prompt });
  };
}

// ---------------- shell ----------------
async function boot() {
  if (!window.Terminal) { document.body.innerHTML = `<div style="padding:40px;color:#d6deeb;font:14px system-ui">Não consegui carregar o xterm.js. Rode <code>npm install</code> na pasta do orquestrador.</div>`; return; }
  try { projects = await api.get("/api/projects"); } catch { projects = []; }
  for (const p of projects) projById[p.id] = p;
  if (!lastProj && projects[0]) lastProj = projects[0].id;
  let st = {}; try { st = await api.get("/api/settings"); } catch {}
  try { boardMeta = await api.get("/api/cards/meta"); } catch {}

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
        <div class="orch-new-row">
          <button class="btn primary orch-new-btn" data-new-toggle title="nova sessão em branco">＋ Novo</button>
          <button class="btn orch-task-btn" data-task-toggle title="nova tarefa com profundidade (entrevista / docs / fases)">✨ Tarefa</button>
        </div>
        <div class="orch-proj-menu" hidden></div>
      </div>
      <div class="orch-groups"></div>
      <label class="orch-perm" title="como as novas sessões lidam com permissões">
        <span class="orch-perm-label">Permissões nas novas sessões</span>
        <select class="orch-perm-sel">
          <option value="default">Perguntar (padrão)</option>
          <option value="auto">Auto — decide o que é seguro</option>
          <option value="acceptEdits">Aceitar edições automaticamente</option>
          <option value="bypass">Pular permissões ⚠</option>
        </select>
      </label>
    </aside>
    <main class="orch-main">
      <div class="orch-head"></div>
      <div class="orch-term"></div>
    </main>`;
  sideHost = $(".orch-groups", root);
  headHost = $(".orch-head", root);
  termHost = $(".orch-term", root);
  permSel = $(".orch-perm-sel", root);
  permSel.value = st.permissionMode || (st.skipPermissions ? "bypass" : "default");
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
    // recarrega só quando o servidor novo responder (até ~20s; depois recarrega mesmo assim)
    await new Promise((r) => setTimeout(r, 800));
    for (let i = 0; i < 40; i++) {
      try { if ((await fetch("/api/settings", { cache: "no-store" })).ok) break; } catch {}
      await new Promise((r) => setTimeout(r, 500));
    }
    location.reload();
  };
  document.addEventListener("click", (e) => { if (!menu.hidden && !e.target.closest(".orch-brand")) closeAppMenu(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeAppMenu(); });

  const newBtn = $(".orch-new-btn", root);
  const projMenu = $(".orch-proj-menu", root);
  const closeMenu = () => { projMenu.hidden = true; newBtn.classList.remove("open"); };
  // Abre na hora com a lista em memória e rebusca do servidor (pega projects.json
  // editado à mão); re-renderiza se o menu segue aberto e sem form em uso.
  const openMenu = () => {
    renderProjMenu(); projMenu.hidden = false; newBtn.classList.add("open");
    reloadProjects().then(() => { if (!projMenu.hidden && !projMenu.querySelector("form, .confirm")) renderProjMenu(); });
  };
  newBtn.onclick = (e) => { e.stopPropagation(); projMenu.hidden ? openMenu() : closeMenu(); };
  $("[data-task-toggle]", root).onclick = async (e) => { e.stopPropagation(); closeMenu(); await reloadProjects(); openComposer(); };

  // mode: {} lista | { adding } form de novo projeto | { editing: id } form inline | { confirmDel: id }
  const reloadProjects = async () => {
    projects = await api.get("/api/projects").catch(() => projects);
    for (const pr of projects) projById[pr.id] = pr;
  };
  // Mesmo form pra adicionar e editar. O grupo é um input com datalist dos grupos que
  // já existem: escolher um coloca o projeto nele, digitar um nome novo cria o grupo.
  const projForm = (p) => `
    <form class="orch-proj-form" data-form="${p ? esc(p.id) : ""}">
      <div class="orch-proj-form-line">
        ${p ? `<input type="color" class="orch-proj-color" data-f-color value="${esc(p.color || "#38bdf8")}" title="cor do projeto" />` : ""}
        <input class="orch-proj-input" data-f-name placeholder="Nome do projeto" maxlength="40" autocomplete="off" value="${p ? esc(p.name) : ""}" />
      </div>
      <input class="orch-proj-input" data-f-root placeholder="Diretório (ex.: E:\repos\meu-app)" autocomplete="off" value="${p ? esc(p.root || "") : ""}" />
      <input class="orch-proj-input" data-f-group list="orch-proj-groups" placeholder="Grupo (escolha ou digite um novo; vazio = sem grupo)" maxlength="40" autocomplete="off" value="${p ? esc(p.group || "") : ""}" />
      <div class="orch-proj-form-err"></div>
      <div class="orch-proj-form-actions">
        <button type="button" class="btn mini" data-form-cancel>Cancelar</button>
        <button type="submit" class="btn mini primary" data-form-save>${p ? "Salvar" : "Adicionar"}</button>
      </div>
    </form>`;

  function renderProjMenu(mode = {}) {
    const row = (p) => p.id === mode.editing ? projForm(p) : p.id === mode.confirmDel ? `
      <div class="orch-proj-row confirm" data-proj-confirm="${esc(p.id)}">
        <span class="orch-proj-row-name">Remover <b>${esc(p.name)}</b> da lista?</span>
        <button class="btn mini" data-del-cancel>Não</button>
        <button class="btn mini danger" data-del-yes="${esc(p.id)}">Remover</button>
      </div>` : `
      <div class="orch-proj-row" data-proj="${esc(p.id)}" title="nova sessão em ${esc(p.name)}">
        <span class="pdot" style="background:${projColor(p.id)}"></span>
        <span class="orch-proj-row-name">${esc(p.name)}</span>
        <button class="orch-proj-edit" data-edit="${esc(p.id)}" title="editar projeto (nome, diretório, cor, grupo)">✎</button>
        <button class="orch-proj-del" data-del="${esc(p.id)}" title="remover projeto da lista">✕</button>
      </div>`;
    const rows = groupProjects(projects).map((g) =>
      `<div class="orch-proj-group">${esc(g.name)}</div>` + g.projects.map(row).join("")).join("");
    const groupNames = [...new Set(projects.map((p) => p.group).filter(Boolean))].sort((x, y) => x.localeCompare(y, "pt-BR"));
    projMenu.innerHTML = `
      <datalist id="orch-proj-groups">${groupNames.map((g) => `<option value="${esc(g)}"></option>`).join("")}</datalist>
      <div class="orch-proj-list">${rows || `<div class="orch-proj-empty muted">Nenhum projeto ainda.</div>`}</div>
      <div class="orch-proj-divider"></div>
      ${mode.adding ? projForm(null) : `<div class="orch-proj-add" data-add-toggle>＋ Adicionar projeto…</div>`}`;

    const form = $(".orch-proj-form", projMenu);
    if (!form) return;
    const editId = form.dataset.form;
    const f = (k) => $(`[data-f-${k}]`, form);
    const err = $(".orch-proj-form-err", form);
    f("name").focus();
    if (editId) form.scrollIntoView({ block: "nearest" });
    $("[data-form-cancel]", form).onclick = () => renderProjMenu();
    form.onsubmit = async (e) => {
      e.preventDefault();
      err.textContent = "";
      const save = $("[data-form-save]", form);
      const label = save.textContent;
      save.disabled = true; save.textContent = editId ? "Salvando…" : "Adicionando…";
      const body = { name: f("name").value, root: f("root").value, group: f("group").value };
      if (editId) body.color = f("color").value;
      const oldName = editId ? projName(editId) : null;
      const r = await (editId ? api.put("/api/projects?id=" + encodeURIComponent(editId), body) : api.post("/api/projects", body))
        .catch((x) => ({ ok: false, error: String(x) }));
      if (!r.ok) { err.textContent = r.error || "falhou"; save.disabled = false; save.textContent = label; return; }
      await reloadProjects();
      if (editId) {
        // grupo da sidebar que ainda leva o nome antigo do projeto acompanha a renomeação
        for (const it of layout.items) if (it.type === "group" && it.projId === editId && it.name === oldName) it.name = r.project.name;
        saveLayout(); renderSide(); renderHead();
        renderProjMenu();
        return;
      }
      closeMenu();
      newAgent(r.project.id, {}); // já abre uma sessão no projeto recém-criado
    };
  }

  projMenu.onclick = async (e) => {
    e.stopPropagation(); // cliques dentro do menu nunca fecham via "clique-fora" (re-render destaca o alvo)
    if (e.target.closest(".orch-proj-form")) return; // não fecha enquanto digita
    const edit = e.target.closest("[data-edit]");
    if (edit) { renderProjMenu({ editing: edit.dataset.edit }); return; }
    const del = e.target.closest("[data-del]");
    if (del) { renderProjMenu({ confirmDel: del.dataset.del }); return; }  // pede confirmação inline
    if (e.target.closest("[data-del-cancel]")) { renderProjMenu(); return; }
    const yes = e.target.closest("[data-del-yes]");
    if (yes) {
      const r = await api.del("/api/projects?id=" + encodeURIComponent(yes.dataset.delYes)).catch(() => ({ ok: false }));
      if (r.ok) await reloadProjects();
      renderProjMenu();
      return;
    }
    if (e.target.closest("[data-add-toggle]")) { renderProjMenu({ adding: true }); return; }
    const row = e.target.closest("[data-proj]");
    if (row) { closeMenu(); newAgent(row.dataset.proj, {}); }
  };
  document.addEventListener("click", (e) => { if (!projMenu.hidden && !e.target.closest(".orch-new")) closeMenu(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeMenu(); });
  permSel.onchange = () => api.put("/api/settings", { permissionMode: permSel.value }).catch(() => {});
  permSel.classList.toggle("danger", permSel.value === "bypass");
  permSel.addEventListener("change", () => permSel.classList.toggle("danger", permSel.value === "bypass"));

  renderHead();
  await loadLive();
  mount();

  const refit = debounce(() => {
    let rec = activeId && activeId.startsWith && activeId.startsWith("pending:") ? terms.get(activeId.slice(8)) : (activeId && recByServer(activeId));
    if (rec) { try { rec.fit.fit(); } catch {} sendResize(rec); }
  }, 90);
  const ro = new ResizeObserver(refit);
  ro.observe(termHost);
  // Zoom de página (Ctrl+scroll / Ctrl+±) muda o viewport visual sem sempre disparar
  // o ResizeObserver acima de forma confiável — sem isso o terminal ficava com o
  // nº de colunas de antes do zoom e o texto vazava cortado pela borda direita.
  if (window.visualViewport) window.visualViewport.addEventListener("resize", refit);
  else window.addEventListener("resize", refit);
  setInterval(loadLive, 3000); // mantém a lista lateral viva/atualizada
  onSpeechState(renderSpeakBtns); // ▶/⏹ acompanham o fim da fala
}

boot();
