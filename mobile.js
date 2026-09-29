// mobile.js — phone-first quick-prompt view for the orchestrator.
//
// Flow: pick a project → pick a depth (Rápido / Refinar / Documentar+Fases) → type
// what you want → "Iniciar". It optionally creates a card on the central Hub board
// and starts a `claude` session in the project, seeding a depth-aware opening prompt.
// The terminal is the output; you drive it from a text bar + control keys (the full
// xterm TUI is unusable with a touch keyboard, so input is explicit).
//
// The depth prompts channel two ideas from the Matt Pocock skills:
//   • grill-with-docs — a relentless interview that sharpens scope and emits ADR-style
//     decisions + a glossary as it goes.
//   • to-issues       — break work into thin vertical slices (end-to-end, dependency
//     order), not horizontal layers.

const $ = (s, r = document) => r.querySelector(s);
const el = (tag, cls, html) => { const n = document.createElement(tag); if (cls) n.className = cls; if (html != null) n.innerHTML = html; return n; };
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const api = {
  get: (p) => fetch(p).then((r) => r.json()),
  post: (p, b) => fetch(p, { method: "POST", headers: b ? { "Content-Type": "application/json" } : {}, body: b ? JSON.stringify(b) : undefined }).then((r) => r.json()),
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
let boardMeta = { ok: false, boardPath: null, columns: [] };
let live = [];

let selProj = localStorage.getItem("orch-m-proj") || null;
let selDepth = localStorage.getItem("orch-m-depth") || "rapido";
let makeCard = localStorage.getItem("orch-m-card") !== "0";
// "Dar play": com autoSpeak ligado, cada resposta que o hook `Stop` entrega é falada
// assim que chega (útil de mãos livres). Desligado, sobra o ▶ para ouvir a última.
let autoSpeak = localStorage.getItem("orch-m-speak") === "1";

let app, sessionRec = null;

// ---------------- terminal session ----------------
function wsUrl(params) {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${location.host}/api/agents/term?${params.toString()}`;
}

function makeSession(projId) {
  const term = new window.Terminal({
    fontFamily: '"Cascadia Mono", Consolas, monospace',
    fontSize: 12, cursorBlink: true, scrollback: 8000, convertEol: false,
    theme: { background: "#0b0f14", foreground: "#d6deeb", cursor: "#7dd3fc", selectionBackground: "#1e3a5f" },
  });
  const fit = new window.FitAddon.FitAddon();
  term.loadAddon(fit);
  return { term, fit, ws: null, projId, serverId: null, exited: false, opened: false, seeded: false, gotData: false, lastSay: "" };
}

function sendIn(rec, d) { if (rec.ws && rec.ws.readyState === 1) rec.ws.send(JSON.stringify({ t: "in", d })); }
function sendResize(rec) { if (rec.ws && rec.ws.readyState === 1 && rec.term.cols) rec.ws.send(JSON.stringify({ t: "resize", cols: rec.term.cols, rows: rec.term.rows })); }

function connect(rec, opts = {}) {
  const params = new URLSearchParams();
  if (opts.attach) params.set("agent", opts.attach);
  else params.set("project", rec.projId);
  if (rec.term.cols) { params.set("cols", rec.term.cols); params.set("rows", rec.term.rows); }
  const ws = new WebSocket(wsUrl(params));
  rec.ws = ws;
  ws.onopen = () => sendResize(rec);
  ws.onmessage = (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    if (m.t === "data") { rec.term.write(m.d); rec._onData && rec._onData(m.d); }
    else if (m.t === "ready") { rec.serverId = m.id; rec.exited = !!m.exited; renderSessionHead(); }
    else if (m.t === "meta") { rec.name = m.name; renderSessionHead(); }
    else if (m.t === "say") {                  // resposta final da rodada (hook Stop)
      rec.lastSay = m.text || "";
      if (autoSpeak && !m.replay) speak(rec.lastSay);
      renderSpeakBtns();
    }
    else if (m.t === "exit") { rec.exited = true; rec.term.write(`\r\n\x1b[90m— sessão encerrada (código ${m.code}) —\x1b[0m\r\n`); renderSessionHead(); }
    else if (m.t === "error") { rec.term.write(`\r\n\x1b[31m⚠ ${m.error}\x1b[0m\r\n`); rec.exited = true; rec.gone = true; }
  };
  // Servidor reiniciou (ou a rede oscilou no celular): a sessão continua viva no disco,
  // então reatamos sozinhos enquanto esta for a sessão aberta na tela.
  ws.onclose = () => { if (sessionRec === rec) setTimeout(() => ensureConnected(rec), 1500); };
  if (!rec._wired) { rec._wired = true; rec.term.onData((d) => sendIn(rec, d)); } // teclado físico/soft digitando no xterm
  return rec;
}
// Reata ao agente. O attach repinta todo o scrollback, por isso o reset antes.
function ensureConnected(rec) {
  if (!rec || !rec.serverId || rec.gone) return;
  const st = rec.ws && rec.ws.readyState;
  if (st === WebSocket.CONNECTING || st === WebSocket.OPEN) return;
  try { rec.term.reset(); } catch {}
  rec.exited = false;
  connect(rec, { attach: rec.serverId });
}

// ---------------- screens ----------------
function renderCompose() {
  sessionRec = null;
  document.body.classList.remove("in-session");
  const hubOff = !boardMeta.ok;
  app.innerHTML = `
    <header class="m-top">
      <img class="m-logo" src="/icon.png" alt="" />
      <span class="m-title">Nova tarefa</span>
      <a class="m-desktop" href="/?desktop=1" title="versão completa">desktop ↗</a>
    </header>
    <main class="m-compose">
      <label class="m-label">Projeto</label>
      <div class="m-projs" id="m-projs"></div>

      <label class="m-label">Profundidade</label>
      <div class="m-depths" id="m-depths"></div>
      <div class="m-depth-hint" id="m-depth-hint"></div>

      <label class="m-card-toggle ${hubOff ? "disabled" : ""}">
        <input type="checkbox" id="m-card" ${makeCard && !hubOff ? "checked" : ""} ${hubOff ? "disabled" : ""} />
        <span>Criar card no Hub${hubOff ? " <em>(board não encontrado)</em>" : ""}</span>
      </label>

      <label class="m-label">O que você quer?</label>
      <textarea id="m-intent" class="m-intent" rows="5" placeholder="Ex.: no feed do Nutri, o botão de curtir não atualiza o contador na hora…"></textarea>

      <button class="m-start" id="m-start">Iniciar sessão →</button>
      <button class="m-clean" id="m-clean" title="sessão vazia no projeto, já com o remote control ligado">
        📡 Sessão limpa + remote control
      </button>
      <div class="m-err" id="m-err"></div>

      <div class="m-live" id="m-live"></div>
    </main>`;

  // project chips
  const projs = $("#m-projs");
  if (!selProj && projects[0]) selProj = projects[0].id;
  for (const g of groupProjects(projects)) {
    projs.appendChild(el("div", "m-chip-group", esc(g.name)));
    const row = el("div", "m-chips");
    for (const p of g.projects) {
      const c = el("button", "m-chip" + (p.id === selProj ? " on" : ""), `<span class="dot" style="background:${p.color}"></span>${esc(p.name)}`);
      c.onclick = () => { selProj = p.id; localStorage.setItem("orch-m-proj", p.id); renderCompose(); };
      row.appendChild(c);
    }
    projs.appendChild(row);
  }

  // depth buttons. No pseudo-projeto "Geral" (afazer) só fazem sentido Rápido e Refinar —
  // um afazer não vira projeto faseado. "Documentar + Fases" some e selDepth cai pra rapido.
  const assistant = selProj === "geral";
  const depthEntries = Object.entries(DEPTHS).filter(([k]) => !(assistant && k === "documentar"));
  if (assistant && selDepth === "documentar") { selDepth = "rapido"; localStorage.setItem("orch-m-depth", selDepth); }
  const depths = $("#m-depths");
  for (const [k, d] of depthEntries) {
    const b = el("button", "m-depth" + (k === selDepth ? " on" : ""), esc(d.label));
    b.onclick = () => { selDepth = k; localStorage.setItem("orch-m-depth", k); renderCompose(); };
    depths.appendChild(b);
  }
  $("#m-depth-hint").textContent = DEPTHS[selDepth].hint;

  $("#m-card").onchange = (e) => { makeCard = e.target.checked; localStorage.setItem("orch-m-card", makeCard ? "1" : "0"); };

  // Rede de segurança: guarda o texto enquanto você digita e restaura ao voltar. Se o
  // prompt semeado se perder (ex.: engolido por um diálogo), o texto continua aqui.
  const intentEl = $("#m-intent");
  intentEl.value = localStorage.getItem("orch-m-draft") || "";
  intentEl.oninput = () => localStorage.setItem("orch-m-draft", intentEl.value);

  $("#m-start").onclick = onStart;
  $("#m-clean").onclick = onStartClean;

  renderLiveList();
}

function renderLiveList() {
  const host = $("#m-live");
  if (!host) return;
  const running = live.filter((a) => !a.exited);
  if (!running.length) { host.innerHTML = ""; return; }
  host.innerHTML = `<div class="m-live-h">Sessões em andamento</div>`;
  for (const a of running) {
    // 💤 = sessão que sobreviveu a um restart do servidor: abrir retoma (--resume).
    const row = el("button", "m-live-row" + (a.dormant ? " dormant" : ""), `
      <span class="dot" style="background:${projColor(a.projId)}"></span>
      <span class="m-live-name">${esc(a.name || a.title || "(sessão)")}</span>
      ${a.dormant ? `<span class="m-live-sleep" title="dormindo — toque para retomar">💤</span>` : ""}
      <span class="m-live-proj">${esc(projName(a.projId))}</span>`);
    row.onclick = () => { unlockSpeech(); openSession({ attach: a.id, projId: a.projId }); };
    host.appendChild(row);
  }
}

async function onStart() {
  const err = $("#m-err");
  err.textContent = "";
  const intent = $("#m-intent").value.trim();
  if (!selProj) { err.textContent = "Escolha um projeto."; return; }
  if (!intent) { err.textContent = "Escreva o que você quer."; return; }
  const btn = $("#m-start");
  btn.disabled = true; btn.textContent = "Iniciando…";
  unlockSpeech();   // iOS/Android só liberam áudio dentro de um gesto — este é o toque

  const assistant = selProj === "geral"; // pseudo-projeto Geral → modo Assistente (afazer)
  let card = null;
  if (makeCard && boardMeta.ok) {
    const r = await api.post("/api/cards", {
      project: selProj, title: titleFrom(intent), desc: intent,
      status: "nao_iniciado", tags: assistant ? ["mobile", "afazer"] : ["mobile"],
    }).catch((e) => ({ ok: false, error: String(e) }));
    if (r && r.ok) card = r.card;
    else err.textContent = "Card não criado: " + ((r && r.error) || "falhou") + " — seguindo sem card.";
  }

  const prompt = seedPrompt({ intent, depth: selDepth, projectName: projName(selProj), card, boardPath: boardMeta.boardPath, assistant });
  openSession({ projId: selProj, prompt });
}

// Sessão limpa: sem intent, sem card, sem prompt de profundidade. Só abre o `claude` no
// projeto escolhido e, quando o boot fica quieto, manda `/rc` para ligar o remote control,
// que é o jeito de assumir a sessão pelo celular/claude.ai sem digitar no xterm.
function onStartClean() {
  const err = $("#m-err");
  err.textContent = "";
  if (!selProj) { err.textContent = "Escolha um projeto."; return; }
  const btn = $("#m-clean");
  btn.disabled = true; btn.textContent = "Iniciando…";
  unlockSpeech();
  openSession({ projId: selProj, prompt: "/rc", seedOpts: { paste: false } });
}

function openSession({ projId, prompt, attach, seedOpts }) {
  const rec = makeSession(projId);
  sessionRec = rec;
  if (prompt) { const s = makeSeeder((d) => sendIn(rec, d), prompt, seedOpts); rec._onData = s.onData; }
  renderSessionScreen();
  // open xterm after the container is laid out, then connect
  requestAnimationFrame(() => {
    try { rec.term.open($("#m-term")); rec.opened = true; rec.fit.fit(); } catch {}
    connect(rec, attach ? { attach } : {});
    if (attach) rec.serverId = attach;
  });
}

function renderSessionScreen() {
  const rec = sessionRec;
  document.body.classList.add("in-session");
  app.innerHTML = `
    <header class="m-top">
      <button class="m-back" id="m-back" title="voltar (mantém a sessão rodando)">‹</button>
      <span class="dot" style="background:${projColor(rec.projId)}"></span>
      <span class="m-title" id="m-sess-title">${esc(projName(rec.projId))}</span>
      ${speechAvailable() ? `
        <button class="m-speak" id="m-speak" title="ouvir a última resposta">▶</button>
        <button class="m-speak m-auto" id="m-auto" title="falar cada resposta automaticamente">🔊</button>
        <button class="m-speak" id="m-voice" title="escolher a voz">⚙</button>` : ""}
      <button class="m-kill" id="m-kill" title="encerrar">✕</button>
    </header>
    <div class="m-term" id="m-term"></div>
    <div class="m-keys">
      <button data-k="esc">Esc</button>
      <button data-k="up">▲</button>
      <button data-k="down">▼</button>
      <button data-k="tab">Tab</button>
      <button data-k="rc">/rc</button>
      <button data-k="ctrlc">^C</button>
      <button data-k="enter">↵</button>
    </div>
    <div class="m-input">
      <textarea id="m-send-text" rows="1" placeholder="Mensagem para a sessão…"></textarea>
      <button id="m-send">Enviar</button>
    </div>`;

  const speakBtn = $("#m-speak");
  if (speakBtn) {
    speakBtn.onclick = () => {
      unlockSpeech();
      if (isSpeaking()) stopSpeech();
      else if (rec.lastSay) speak(rec.lastSay);
      renderSpeakBtns();
    };
    $("#m-auto").onclick = () => {
      unlockSpeech();
      autoSpeak = !autoSpeak;
      localStorage.setItem("orch-m-speak", autoSpeak ? "1" : "0");
      if (!autoSpeak) stopSpeech();
      renderSpeakBtns();
    };
    $("#m-voice").onclick = () => { unlockSpeech(); openVoiceSheet(); };
  }

  $("#m-back").onclick = () => { stopSpeech(); loadLive().then(renderCompose); };
  $("#m-kill").onclick = async () => {
    stopSpeech();
    if (rec.serverId) await api.post("/api/agents/kill?id=" + rec.serverId).catch(() => {});
    try { rec.ws && rec.ws.close(); } catch {}
    loadLive().then(renderCompose);
  };

  const KEY = { esc: "\x1b", up: "\x1b[A", down: "\x1b[B", tab: "\t", ctrlc: "\x03", enter: "\r" };
  for (const b of app.querySelectorAll(".m-keys button")) b.onclick = () => {
    if (b.dataset.k === "rc") { sendIn(rec, "/rc"); setTimeout(() => sendIn(rec, "\r"), 60); return; }
    sendIn(rec, KEY[b.dataset.k]);
  };

  const ta = $("#m-send-text");
  const send = () => { const v = ta.value; if (!v) { sendIn(rec, "\r"); return; } sendIn(rec, v); setTimeout(() => sendIn(rec, "\r"), 60); ta.value = ""; ta.style.height = "auto"; };
  $("#m-send").onclick = send;
  ta.oninput = () => { ta.style.height = "auto"; ta.style.height = Math.min(ta.scrollHeight, 120) + "px"; };

  renderSessionHead();
  renderSpeakBtns();
}

// Folha de voz: as vozes são as do browser do celular (no Android o Chrome traz as do
// Google/Speech Services, que já são neurais; no iOS as "Siri/Enhanced" são as boas).
function openVoiceSheet() {
  const back = el("div", "m-sheet-back");
  back.innerHTML = `
    <div class="m-sheet" role="dialog" aria-label="Voz">
      <div class="m-sheet-head"><b>🔊 Voz</b><button class="m-sheet-x">✕</button></div>
      <label class="m-label">Voz</label>
      <select class="m-select" data-voices></select>
      <div class="m-hint" data-vhint></div>
      <label class="m-label">Velocidade <span data-rateval></span></label>
      <input type="range" class="m-range" data-rate min="0.7" max="1.6" step="0.05" />
      <div class="m-sheet-foot">
        <button class="m-chip" data-test>▶ Testar</button>
        <button class="m-chip on" data-done>Pronto</button>
      </div>
    </div>`;
  document.body.appendChild(back);

  const sel = $("[data-voices]", back), hint = $("[data-vhint]", back);
  const range = $("[data-rate]", back), rateVal = $("[data-rateval]", back);

  const renderVoices = () => {
    const vs = listVoices(), cur = getVoiceId();
    sel.innerHTML = vs.length
      ? vs.map((v) => `<option value="${esc(voiceIdOf(v))}"${voiceIdOf(v) === cur ? " selected" : ""}>${esc(v.name)} · ${esc(v.lang)}</option>`).join("")
      : `<option value="">nenhuma voz em português instalada</option>`;
    sel.disabled = !vs.length;
    hint.textContent = vs.length ? "Toque em Testar depois de trocar." : "Instale um pacote de voz pt-BR no sistema.";
  };
  renderVoices();
  const offVoices = onVoicesChanged(renderVoices);

  range.value = String(getRate());
  rateVal.textContent = getRate().toFixed(2) + "×";
  range.oninput = () => { setRate(range.value); rateVal.textContent = getRate().toFixed(2) + "×"; };
  sel.onchange = () => { setVoiceId(sel.value); speakSample(); };
  $("[data-test]", back).onclick = () => speakSample();

  const close = () => { stopSpeech(); offVoices(); back.remove(); renderSpeakBtns(); };
  back.onclick = (e) => { if (e.target === back) close(); };
  $(".m-sheet-x", back).onclick = close;
  $("[data-done]", back).onclick = close;
}

// ▶ vira ⏹ enquanto fala; fica apagado até a primeira resposta chegar do hook.
function renderSpeakBtns() {
  const b = $("#m-speak"), a = $("#m-auto");
  if (!b || !sessionRec) return;
  const talking = isSpeaking();
  b.textContent = talking ? "⏹" : "▶";
  b.disabled = !talking && !sessionRec.lastSay;
  b.classList.toggle("on", talking);
  if (a) a.classList.toggle("on", autoSpeak);
}

function renderSessionHead() {
  const rec = sessionRec;
  if (!rec) return;
  const t = $("#m-sess-title");
  if (t) t.textContent = (rec.name ? rec.name + " · " : "") + projName(rec.projId) + (rec.exited ? " (encerrado)" : "");
}

// ---------------- boot ----------------
async function loadLive() {
  try { const r = await api.get("/api/agents/live"); live = r.agents || []; } catch {}
}

async function boot() {
  app = $("#m-app");
  if (!window.Terminal) { app.innerHTML = `<div class="m-fatal">Não consegui carregar o xterm.js. Rode <code>npm install</code> no servidor.</div>`; return; }
  try { projects = await api.get("/api/projects"); } catch { projects = []; }
  for (const p of projects) projById[p.id] = p;
  try { boardMeta = await api.get("/api/cards/meta"); } catch {}
  await loadLive();
  onSpeechState(renderSpeakBtns);   // ▶/⏹ acompanham o fim da fala
  renderCompose();

  // Refresh the "running sessions" list while composing; keep the terminal fitted to
  // the viewport (the mobile keyboard shrinks it, firing resize).
  setInterval(() => { if (!sessionRec) loadLive().then(renderLiveList); }, 4000);
  const refit = () => { if (sessionRec && sessionRec.opened) { try { sessionRec.fit.fit(); } catch {} sendResize(sessionRec); } };
  window.addEventListener("resize", refit);
  if (window.visualViewport) window.visualViewport.addEventListener("resize", refit);
}

boot();
