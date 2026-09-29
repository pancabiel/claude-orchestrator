#!/usr/bin/env node
// hooks/orch-say.mjs — hook `Stop` do Claude Code que entrega a resposta final ao
// orquestrador, para o botão ▶ (falar) do desktop e do /m.
//
// Instale em ~/.claude/settings.json (ou .claude/settings.json de um projeto):
//   {
//     "hooks": {
//       "Stop": [{ "hooks": [{ "type": "command",
//         "command": "node \"E:\\repos\\claude-orchestrator\\hooks\\orch-say.mjs\"" }] }]
//     }
//   }
//
// Fora do orquestrador ele não faz nada: sem ORCH_AGENT_ID no ambiente, sai na hora.
// O orquestrador injeta essa variável ao criar cada agente (server.mjs → createAgent).
//
// Entrada (stdin, JSON do hook): { session_id, transcript_path, stop_hook_active, … }
// Saída: POST /api/agents/say?id=<agente>  { text }

import { readFileSync, appendFileSync } from "node:fs";

// Diagnóstico: ORCH_SAY_LOG=<arquivo> registra cada disparo (o hook é silencioso por design).
const log = (m) => { if (process.env.ORCH_SAY_LOG) { try { appendFileSync(process.env.ORCH_SAY_LOG, new Date().toISOString() + " " + m + "\n"); } catch {} } };
log("hook chamado; ORCH_AGENT_ID=" + (process.env.ORCH_AGENT_ID || "(vazio)"));

const AGENT = process.env.ORCH_AGENT_ID;
if (!AGENT) process.exit(0);
const PORT = process.env.ORCH_PORT || 4319;

const read = (stream) => new Promise((r) => { let s = ""; stream.on("data", (c) => (s += c)); stream.on("end", () => r(s)); });

// A resposta *final*: varre o transcript de trás pra frente juntando o texto do
// assistant até esbarrar em uma tool call (fim do trecho falado) ou no turno do
// usuário. Sem isso viria a narração da rodada inteira — "vou conferir X", "agora Y" —
// e o resumo do fim, que é o que interessa ouvir, ficaria enterrado.
function lastAnswer(path) {
  const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
  const parts = [];
  for (let i = lines.length - 1; i >= 0; i--) {
    let e; try { e = JSON.parse(lines[i]); } catch { continue; }
    const msg = e.message || {};
    const role = msg.role || e.type;
    const content = msg.content;
    if (role === "assistant") {
      const blocks = Array.isArray(content) ? content : typeof content === "string" ? [{ type: "text", text: content }] : [];
      if (blocks.some((b) => b && b.type === "tool_use") && parts.length) break;  // trabalho anterior: para aqui
      const texts = blocks.filter((b) => b && b.type === "text" && b.text.trim()).map((b) => b.text);
      if (texts.length) parts.unshift(texts.join("\n"));
      continue;
    }
    if (role === "user") {
      const isToolResult = Array.isArray(content) && content.every((b) => b && b.type === "tool_result");
      if (isToolResult) { if (parts.length) break; continue; }  // resultado de tool antes do texto final
      if (parts.length) break;                                  // chegamos ao prompt que gerou a resposta
    }
  }
  return parts.join("\n\n").trim();
}

try {
  const raw = (await read(process.stdin)) || "{}";
  log("stdin: " + raw.slice(0, 300));
  const input = JSON.parse(raw);
  if (!input.transcript_path) process.exit(0);
  // O hook chega a rodar antes de a última mensagem ser gravada no transcript —
  // sem esta espera curta o texto sai vazio em respostas rápidas.
  let text = "";
  for (let i = 0; i < 12 && !text; i++) {
    if (i) await new Promise((r) => setTimeout(r, 250));
    try { text = lastAnswer(input.transcript_path); } catch {}
  }
  log("texto extraído: " + text.length + " chars");
  if (!text) process.exit(0);
  const r = await fetch(`http://127.0.0.1:${PORT}/api/agents/say?id=${encodeURIComponent(AGENT)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, sessionId: input.session_id || null }),
  });
  log("POST → " + r.status);
} catch (e) {
  // O hook nunca deve atrapalhar a sessão: qualquer falha é silenciosa.
  log("erro: " + (e && e.message));
}
process.exit(0);
