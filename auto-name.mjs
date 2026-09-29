// auto-name.mjs — nomeia cada sessão pelo *assunto* dela, não pelo texto cru.
//
// A sessão é um TUI que se redesenha: não dá pra ler a caixa de input. Então o nome sai
// de duas fontes que o servidor já tem na mão:
//   1) o primeiro prompt enviado (reconstruído do fluxo de teclas / do bloco colado);
//   2) a primeira resposta do Claude (entregue pelo hook `Stop`, ver /api/agents/say).
//
// Com esse material chamamos o próprio `claude` em modo headless (`claude -p`, modelo
// barato) e pedimos um título curto — ou seja, alguém *entende* o que está sendo tratado
// ali antes de rotular. Se o headless falhar, demorar ou vier vazio, cai numa heurística
// offline (primeiras palavras). O nome heurístico é aplicado na hora, e o do modelo
// substitui quando chega — a sidebar nunca fica esperando.

import { spawn } from "node:child_process";

const ENABLED = process.env.ORCH_AUTONAME !== "0";
const MODEL = process.env.ORCH_NAME_MODEL || "haiku";
const LLM_TIMEOUT = 25_000;
const MAX_NAME = 44;

// ---------- heurística offline (fallback) ----------
export function fallbackName(text) {
  const line = (String(text || "").split("\n").find((l) => l.trim()) || "").replace(/\s+/g, " ").trim();
  if (!line) return "";
  const MAX_WORDS = 6;
  let name = line.split(" ").slice(0, MAX_WORDS).join(" ");
  if (name.length > MAX_NAME) {
    name = name.slice(0, MAX_NAME);
    const sp = name.lastIndexOf(" ");
    name = (sp > 0 ? name.slice(0, sp) : name).trim();
  }
  if (name.length < line.length) name += "…";
  return name;
}

// Prompts semeados pelo compositor/mobile (task-depth.js) vêm embrulhados em boilerplate
// ("Você é um agente…", contexto do card, "Modo **Rápido**: …"). O que interessa pro nome
// é só o pedido do usuário — extraímos ele quando reconhecemos o formato.
export function coreIntent(text) {
  const s = String(text || "");
  const m = s.match(/(?:Tarefa do usuário|Afazer que o usuário quer registrar):\s*\n?([\s\S]*)/);
  if (!m) return s.trim();
  return m[1]
    .split(/\n\n(?:Esta tarefa virou o card|Este afazer já virou o card|Modo \*\*)/)[0]
    .trim() || s.trim();
}

// ---------- nome via modelo ----------
function clean(out) {
  let s = String(out || "").trim().split("\n").map((l) => l.trim()).filter(Boolean).pop() || "";
  s = s.replace(/^["'“”«»\s]+|["'“”«»\s]+$/g, "").replace(/^(?:título|titulo|nome)\s*:\s*/i, "").replace(/[.;]+$/, "");
  if (s.length > MAX_NAME) {
    s = s.slice(0, MAX_NAME);
    const sp = s.lastIndexOf(" ");
    s = (sp > 8 ? s.slice(0, sp) : s).trim() + "…";
  }
  return s.trim();
}

const INSTRUCTIONS =
  `Você nomeia sessões de trabalho de um agente de código. Abaixo vem o que está sendo tratado ` +
  `na sessão: a primeira mensagem do usuário e, quando existe, a resposta do agente.\n\n` +
  `Entenda o objetivo e responda APENAS com um título curto em português do Brasil (2 a 5 palavras, ` +
  `no máximo 40 caracteres) que descreva o ASSUNTO do trabalho — não repita as palavras da pessoa, ` +
  `resuma o que ela quer. Ignore boilerplate (instruções de papel, modo Rápido/Refinar/Documentar, ` +
  `cards do Hub) e resuma só a tarefa real. Sem aspas, sem ponto final, sem prefixo "Título:", ` +
  `sem explicação — só o título.\n`;

// Chama `claude -p` (headless) pelo stdin: nada de aspas em argv, então acento e quebra de
// linha passam intactos no Windows. Resolve com "" em qualquer falha — quem chama decide.
function askModel(payload) {
  return new Promise((resolve) => {
    if (!ENABLED) return resolve("");
    const isWin = process.platform === "win32";
    const args = ["-p", "--model", MODEL, "--max-turns", "1"];
    let proc;
    try {
      proc = spawn(isWin ? "cmd.exe" : "claude", isWin ? ["/c", "claude", ...args] : args, {
        stdio: ["pipe", "pipe", "ignore"], windowsHide: true,
      });
    } catch { return resolve(""); }
    let out = "", done = false;
    const finish = (v) => { if (done) return; done = true; clearTimeout(timer); resolve(v); };
    const timer = setTimeout(() => { try { proc.kill(); } catch {} finish(""); }, LLM_TIMEOUT);
    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", (d) => { out += d; if (out.length > 4000) out = out.slice(0, 4000); });
    proc.on("error", () => finish(""));
    proc.on("close", () => finish(clean(out)));
    try { proc.stdin.end(payload, "utf8"); } catch { finish(""); }
  });
}

const clip = (s, n) => (s.length > n ? s.slice(0, n) + "\n[…]" : s);

async function nameFor({ prompt, answer }) {
  const body =
    INSTRUCTIONS +
    `\n<mensagem-do-usuario>\n${clip(String(prompt || "").trim(), 3000)}\n</mensagem-do-usuario>\n` +
    (answer ? `\n<resposta-do-agente>\n${clip(String(answer).trim(), 1500)}\n</resposta-do-agente>\n` : "");
  return await askModel(body);
}

// ---------- captura do primeiro prompt ----------
// Reconstrói o que foi enviado a partir do fluxo bruto de teclas: caracteres imprimíveis,
// backspace, sequências ANSI ignoradas. Dentro de um bloco colado (bracketed paste, que é
// como o compositor semeia o prompt) as quebras de linha fazem parte do texto — só o Enter
// de fora do bloco confirma. Chama `emit(agent)` sempre que o nome muda.
export function feedInput(agent, d, emit) {
  if (agent.userNamed || agent.named) return;
  let buf = agent.typed || "";
  for (let i = 0; i < d.length; i++) {
    const ch = d[i], code = d.charCodeAt(i);
    if (ch === "\x1b") {
      if (d.startsWith("\x1b[200~", i)) { agent.pasting = true; i += 5; continue; }
      if (d.startsWith("\x1b[201~", i)) { agent.pasting = false; i += 5; continue; }
      let j = i + 1;                            // demais sequências ANSI (setas, etc.) — pula
      if (d[j] === "[" || d[j] === "O") { j++; while (j < d.length && !/[A-Za-z~]/.test(d[j])) j++; }
      i = j;
      continue;
    }
    if (code === 13 || code === 10) {
      if (agent.pasting) { buf += "\n"; continue; }   // quebra dentro do bloco colado: é conteúdo
      const text = buf.replace(/[ \t]+/g, " ").trim();
      if (text) { agent.typed = ""; commitFirstPrompt(agent, text, emit); return; }
      buf = "";                                       // Enter em branco: segue esperando
      continue;
    }
    if (code === 127 || code === 8) { buf = buf.slice(0, -1); continue; }
    if (code < 32) continue;
    buf += ch;
    if (buf.length > 8000) buf = buf.slice(-8000);
  }
  agent.typed = buf;
}

function setName(agent, name, emit) {
  if (!name || agent.userNamed || name === agent.name) return;
  agent.name = name;
  agent.named = true;
  emit && emit(agent);
}

function commitFirstPrompt(agent, text, emit) {
  agent.firstPrompt = text;
  const intent = coreIntent(text);
  setName(agent, fallbackName(intent), emit);          // algo legível já, sem esperar o modelo
  nameFor({ prompt: intent }).then((n) => setName(agent, n, emit)).catch(() => {});
}

// Primeira resposta do Claude: já dá pra entender o assunto de verdade (útil quando o
// prompt era vago — "continua", "arruma isso"). Refina o nome uma única vez.
export function refineWithAnswer(agent, answer, emit) {
  if (!ENABLED || agent.userNamed || agent.refined) return;
  agent.refined = true;
  if (!agent.firstPrompt && !answer) return;
  nameFor({ prompt: coreIntent(agent.firstPrompt || ""), answer })
    .then((n) => setName(agent, n, emit))
    .catch(() => {});
}
