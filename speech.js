// speech.js — "dar play" na última resposta do Claude (desktop + mobile).
//
// Duas metades independentes:
//   • cleanForSpeech() — vira o markdown do Claude em algo audível: blocos de código,
//     caminhos e ruído de markup não são lidos caractere a caractere.
//   • um *engine* de voz trocável. Hoje só existe o `browserEngine`
//     (speechSynthesis: grátis, offline, sem dependência nova). Um TTS por API entra
//     aqui via setEngine() — o resto da UI chama speak()/stopSpeech() e não muda.

// ---------------- text → fala ----------------

const BASENAME = /[A-Za-z]:[\\/][^\s`"']+|(?:\.{0,2}[\\/])?(?:[\w.-]+[\\/]){1,}[\w.-]+\.\w+/g;

// Markdown → texto corrido. A regra é: se não dá pra ouvir, não fala.
export function cleanForSpeech(raw) {
  let t = String(raw ?? "");
  t = t.replace(/```[\s\S]*?```/g, " (bloco de código) ");   // code fences
  t = t.replace(/^\s{4,}\S.*$/gm, " ");                       // blocos indentados
  t = t.replace(/`([^`]+)`/g, "$1");                          // inline code: mantém o conteúdo
  t = t.replace(/!\[[^\]]*\]\([^)]*\)/g, " ");                // imagens
  t = t.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");              // links → só o texto
  t = t.replace(/^\s{0,3}#{1,6}\s*/gm, "");                   // headings
  t = t.replace(/^\s*[-*+]\s+/gm, "");                        // bullets
  t = t.replace(/^\s*\d+\.\s+/gm, "");                        // listas numeradas
  t = t.replace(/^\s*>\s?/gm, "");                            // citações
  t = t.replace(/^\s*[-=_]{3,}\s*$/gm, " ");                  // réguas
  t = t.replace(/\*\*|__|~~|\*|_/g, "");                      // ênfase
  // Caminhos viram só o nome do arquivo: "E:\repos\x\server.mjs" → "server.mjs".
  t = t.replace(BASENAME, (m) => " " + m.split(/[\\/]/).pop() + " ");
  t = t.replace(/⏺|✓|✔|✕|✗|→|←|·|•|─|━|│|≥|≤/g, " ");         // glifos do TUI
  t = t.replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, " "); // emoji
  t = t.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  // Sem corte: a resposta é falada inteira. Quem segura texto longo é o engine —
  // ver browserEngine.speak(), que enfileira um pedaço por vez.
  return t;
}

// Frases de tamanho seguro: o speechSynthesis do Chrome engasga/para sozinho em
// enunciados longos, então enfileiramos pedaços curtos.
function chunk(text, max = 220) {
  const out = [];
  for (const part of text.split(/(?<=[.!?:;\n])\s+/)) {
    let s = part.trim();
    if (!s) continue;
    while (s.length > max) {
      const sp = s.lastIndexOf(" ", max);
      out.push(s.slice(0, sp > max * 0.5 ? sp : max));
      s = s.slice(sp > max * 0.5 ? sp + 1 : max);
    }
    if (s) out.push(s);
  }
  return out;
}

// ---------------- engine: browser (speechSynthesis) ----------------

const synth = typeof window !== "undefined" ? window.speechSynthesis : null;
let voice = null;
// Ordem de preferência quando o usuário ainda não escolheu. As "(Natural)"/"Online"
// da Microsoft só existem no Edge — são neurais e de longe as menos robóticas; o
// Chrome enxerga só as SAPI do Windows (Maria/Daniel) + a "Google português do Brasil".
const PREF = [/natural/i, /online/i, /google.*portugu/i, /francisca/i, /thalita/i, /antonio/i, /daniel/i];
const VOICE_KEY = "orch-speak-voice";
let wantedVoice = (typeof localStorage !== "undefined" && localStorage.getItem(VOICE_KEY)) || "";

const voiceId = (v) => v.voiceURI || v.name;

/** Vozes pt-BR/pt disponíveis, melhores primeiro. */
export function listVoices() {
  if (!synth) return [];
  const all = synth.getVoices().filter((v) => /^pt(-|_)?/i.test(v.lang));
  const score = (v) => {
    let s = /pt[-_]?BR/i.test(v.lang) ? 0 : 50;         // pt-BR antes de pt-PT
    const i = PREF.findIndex((re) => re.test(v.name));
    return s + (i < 0 ? PREF.length : i);
  };
  return all.sort((a, b) => score(a) - score(b) || a.name.localeCompare(b.name));
}

function pickVoice() {
  const all = listVoices();
  if (!all.length) return null;
  if (wantedVoice) { const v = all.find((x) => voiceId(x) === wantedVoice); if (v) return v; }
  return all[0];
}
if (synth) {
  voice = pickVoice();
  synth.onvoiceschanged = () => { voice = pickVoice(); for (const fn of voiceListeners) { try { fn(); } catch {} } };
}

// getVoices() vem vazio no primeiro tick em alguns browsers; quem desenha o seletor
// se inscreve aqui para redesenhar quando a lista chegar.
const voiceListeners = new Set();
export function onVoicesChanged(fn) { voiceListeners.add(fn); return () => voiceListeners.delete(fn); }

export function getVoiceId() { return voice ? voiceId(voice) : ""; }
export function setVoiceId(id) {
  wantedVoice = id || "";
  try { localStorage.setItem(VOICE_KEY, wantedVoice); } catch {}
  voice = pickVoice();
}
export const voiceIdOf = voiceId;

let keepAlive = 0;
let rate = Number(localStorage.getItem("orch-speak-rate")) || 1.05;
let gen = 0;        // geração da fala atual: invalida a fila de uma fala anterior
let busy = false;   // fala em andamento, inclusive no vão entre dois pedaços

const browserEngine = {
  available: () => !!synth,
  speak(text, { onEnd } = {}) {
    synth.cancel();
    const parts = chunk(text);
    if (!parts.length) { onEnd && onEnd(); return; }
    // Um pedaço por vez, encadeado no onend: despejar dezenas de utterances de
    // uma vez faz o Chrome engasgar e perder o fim de respostas longas.
    const mine = ++gen;
    busy = true;
    let i = 0;
    const done = () => { if (mine !== gen) return; busy = false; clearInterval(keepAlive); onEnd && onEnd(); };
    const next = () => {
      if (mine !== gen) return;                 // outra fala (ou stop) assumiu
      if (i >= parts.length) return done();
      const u = new SpeechSynthesisUtterance(parts[i++]);
      if (voice) u.voice = voice;
      u.lang = (voice && voice.lang) || "pt-BR";
      u.rate = rate; u.pitch = 1;
      u.onend = next; u.onerror = next;
      synth.speak(u);
    };
    next();
    // Chrome pausa a fila sozinho depois de ~15s; um resume periódico segura a barra.
    clearInterval(keepAlive);
    keepAlive = setInterval(() => {
      if (mine !== gen) { clearInterval(keepAlive); return; }
      if (synth.speaking) synth.resume();
    }, 8000);
  },
  stop() { gen++; busy = false; clearInterval(keepAlive); try { synth.cancel(); } catch {} },
  speaking: () => !!(synth && (busy || synth.speaking || synth.pending)),
};

let engine = browserEngine;

/** Troque por um TTS de API depois: setEngine({ available, speak, stop, speaking }). */
export function setEngine(e) { engine = e; }
export function setRate(r) { rate = Math.min(2, Math.max(0.5, Number(r) || 1)); localStorage.setItem("orch-speak-rate", String(rate)); }
export function getRate() { return rate; }
export const speechAvailable = () => engine.available();
export const isSpeaking = () => engine.speaking();

const listeners = new Set();
export function onSpeechState(fn) { listeners.add(fn); return () => listeners.delete(fn); }
const emit = () => { for (const fn of listeners) { try { fn(isSpeaking()); } catch {} } };

/** Fala `raw` (markdown cru). Devolve o texto limpo, ou "" se não havia nada audível. */
export function speak(raw) {
  if (!engine.available()) return "";
  const text = cleanForSpeech(raw);
  if (!text) return "";
  engine.speak(text, { onEnd: emit });
  emit();
  return text;
}

export function stopSpeech() { engine.stop(); emit(); }

/** Frase curta para testar voz/velocidade no seletor. */
export function speakSample(text = "Pronto. Ajustei o servidor e os testes passaram.") {
  if (!engine.available()) return;
  engine.stop();
  engine.speak(text, { onEnd: emit });
  emit();
}
export function toggleSpeak(raw) { if (isSpeaking()) { stopSpeech(); return ""; } return speak(raw); }

// iOS/Android só liberam áudio dentro de um gesto do usuário: uma fala vazia no
// primeiro toque destrava a fila para as falas automáticas seguintes.
let unlocked = false;
export function unlockSpeech() {
  if (unlocked || !synth) return;
  unlocked = true;
  try { const u = new SpeechSynthesisUtterance(" "); u.volume = 0; synth.speak(u); } catch {}
}
