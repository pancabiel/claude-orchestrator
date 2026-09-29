// task-depth.js — shared "task depth" logic for the orchestrator (desktop + mobile).
//
// A *depth* is a working style encoded entirely in the session's opening prompt, so a
// card can be anything from a trivial one-liner to a fully documented, phased piece of
// work — without any of that living in form fields. The prompts channel two of Matt
// Pocock's engineering skills:
//   • grill-with-docs — a relentless interview that sharpens scope and emits ADR-style
//     decisions + a glossary as it goes.
//   • to-issues       — break work into thin vertical slices (end-to-end, dependency
//     order), not horizontal layers.

export const DEPTHS = {
  rapido:     { label: "Rápido",             hint: "Implementa direto, sem cerimônia." },
  refinar:    { label: "Refinar",            hint: "Te entrevista pra afiar o escopo, depois implementa." },
  documentar: { label: "Documentar + Fases", hint: "Entrevista a fundo, doc de decisões e fatias verticais." },
};

// First line / few words of the intent → a short card title.
export function titleFrom(intent) {
  const s = String(intent || "");
  const line = (s.split("\n").find((l) => l.trim()) || s).trim();
  const words = line.split(/\s+/).slice(0, 9).join(" ");
  return (words.length < line.length ? words + "…" : words).slice(0, 120) || "Tarefa";
}

// Compose the opening prompt for a session given the chosen depth. `card` (optional) is
// the Hub card created for this task ({ id, status }); `boardPath` is where it lives.
export function seedPrompt({ intent, depth, projectName, card, boardPath, assistant }) {
  // Assistant mode (pseudo-projeto "Geral"): a sessão NÃO implementa nada — ela só ajuda
  // a transformar um afazer numa entrada de card bem-feita, editando o card direto no board.
  if (assistant) {
    const board = boardPath || "hub/data/board.json";
    let cardCtx = "";
    if (card) {
      cardCtx =
        `\n\nEste afazer já virou o card \`${card.id}\` no board do Hub (${board}, coluna \`${card.status}\`). ` +
        `Seu trabalho é deixar esse card bem-feito: edite-o diretamente no board.json (read-modify-write — ` +
        `preserve os demais cards), melhorando o \`title\` (curto) e o \`desc\`. NÃO altere \`status\`, \`project\` nem \`id\`.`;
    }
    const head =
      `Você é um assistente ajudando a registrar um AFAZER no board do Hub — isto NÃO é uma tarefa de ` +
      `implementação de código. Não escreva nem altere código de projeto nenhum.\n\nAfazer que o usuário quer registrar:\n${String(intent).trim()}`;
    if (depth === "refinar") {
      return head + cardCtx +
        `\n\nModo **Refinar**: me entreviste rápido — uma pergunta por vez, objetiva (prazo? onde/como? qual o objetivo? ` +
        `algo que não pode faltar?) — até o afazer ficar claro. Então escreva um \`title\` e \`desc\` bem-feitos no card ` +
        `e confirme em uma linha. Não implemente nada.`;
    }
    return head + cardCtx + // "rapido" (e qualquer outra profundidade) → redige direto
      `\n\nModo **Rápido**: a partir do que escrevi, redija um \`desc\` limpo e acionável (objetivo claro e, se fizer ` +
      `sentido, um checklist curto de passos ou um prazo). NÃO me entreviste e NÃO implemente nada. Atualize o card ` +
      `e me diga em uma linha o que ficou.`;
  }

  let cardCtx = "";
  if (card) {
    cardCtx =
      `\n\nEsta tarefa virou o card \`${card.id}\` no Hub (board: ${boardPath || "hub/data/board.json"}, ` +
      `coluna \`${card.status}\`). Conforme avançar, mantenha esse card atualizado editando o board.json ` +
      `diretamente (read-modify-write — preserve os demais cards): refine o campo \`desc\` com o escopo acordado ` +
      `e mova \`status\` ao longo do fluxo (nao_iniciado → planejado → implementado → testado → finalizado).`;
  }
  const head = `Você é um agente trabalhando no projeto **${projectName}** (o diretório atual já é a raiz do projeto).\n\nTarefa do usuário:\n${String(intent).trim()}`;

  if (depth === "rapido") {
    return head + cardCtx +
      `\n\nModo **Rápido**: implemente diretamente. Se algo estiver ambíguo, assuma o mais razoável e siga — só pare se for ` +
      `um bloqueio de verdade. Ao terminar, valide o que der e me diga em uma linha o que mudou.`;
  }
  if (depth === "refinar") {
    return head + cardCtx +
      `\n\nModo **Refinar**: ANTES de escrever código, me entreviste como um engenheiro cético — uma pergunta por vez, ` +
      `objetiva — até o escopo ficar afiado: casos de borda, o que está FORA de escopo, formato dos dados, estados de erro, ` +
      `e impacto em quem já usa. Quando estiver claro, escreva um resumo curto do que vamos fazer (atualize o \`desc\` do card) ` +
      `e então implemente. Não pule a entrevista; comece pela primeira pergunta.`;
  }
  return head + cardCtx +
    `\n\nModo **Documentar + Fases**:\n` +
    `1) Me entreviste a fundo (estilo "grilling": uma pergunta por vez, sem piedade) pra afiar o escopo e revelar as decisões.\n` +
    `2) Produza um doc curto de design: as decisões-chave no formato ADR (contexto → decisão → consequência) e um mini-glossário ` +
    `dos termos do domínio.\n` +
    `3) Quebre o trabalho em fatias verticais finas — cada fase entrega algo demonstrável de ponta a ponta (schema → API → UI → teste), ` +
    `não camadas horizontais — em ordem de dependência.\n` +
    `4) Escreva o doc e as fases no \`desc\` do card (e, se fizer sentido, crie um card por fase no board).\n` +
    `5) Só então implemente, fase a fase, validando cada uma.\n` +
    `Comece pela entrevista — primeira pergunta agora.`;
}

// Seed a (possibly multi-line) prompt into a session without the TUI submitting early:
// wait for the boot output to go quiet (the input box finished drawing), then inject it
// wrapped in bracketed-paste markers + a delayed Enter. `sendIn(d)` writes raw bytes to
// the PTY. Returns { onData } — call onData(chunk) on every chunk of terminal output
// (the raw string; it's scanned for the trust dialog). A hard fallback fires even if
// output never quiets, so it can't hang.
//
// Trust-aware: on a brand-new folder, `claude` shows "Do you trust the files in this
// folder?" BEFORE the chat box. Without handling it, the bracketed-paste lands in that
// dialog and the auto-Enter dismisses it — the whole prompt is lost. So we watch the
// boot output: if the trust dialog appears, we accept it (Enter → default "yes") first
// and re-arm the timers, then seed the real prompt once the chat box finally quiets.
// `paste:false` digita o texto cru (sem bracketed paste), que é o que um comando de barra
// curto (`/rc`) precisa: colado, o Claude Code trata o texto como conteúdo e não abre o comando.
export function makeSeeder(sendIn, prompt, { quietMs = 1200, hardMs = 6500, paste = true } = {}) {
  let seeded = false, trustHandled = false, quiet = null, hard = null, tail = "";
  const inject = () => {
    sendIn(paste ? "\x1b[200~" + prompt + "\x1b[201~" : prompt);
    setTimeout(() => sendIn("\r"), 500);
  };
  const fire = () => { if (seeded) return; seeded = true; clearTimeout(quiet); clearTimeout(hard); inject(); };
  const armHard = () => { clearTimeout(hard); hard = setTimeout(fire, hardMs); };
  const armQuiet = () => { clearTimeout(quiet); quiet = setTimeout(fire, quietMs); };
  armHard();
  return {
    onData(chunk) {
      // Look for the folder-trust dialog before seeding; accept it once, then keep waiting
      // for the chat box to draw. `chunk` may be undefined for older callers — then we just
      // fall through to quiet-detection (no trust handling, same as before).
      if (!seeded && !trustHandled && typeof chunk === "string") {
        tail = (tail + chunk).slice(-4000); // small rolling window; the phrase is short
        if (/trust the files in this folder|do you trust the files/i.test(tail)) {
          trustHandled = true; tail = "";
          clearTimeout(quiet); quiet = null;
          setTimeout(() => sendIn("\r"), 250); // accept trust (default option = yes)
          armHard();                           // the chat box still has to render — reset fallback
          return;
        }
      }
      armQuiet();
    },
  };
}
