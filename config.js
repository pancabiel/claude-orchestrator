// config.js — port + the project registry the orchestrator drives.
//
// Projects live in `projects.json` (gitignored, machine-specific) so you can point
// the tool at your work repos without committing local paths. If it's missing, the
// versioned `projects.example.json` is used as a fallback. Copy the example to
// projects.json and edit it. Shape: array of { id, name, color, root, group? }.
//   - id    : short slug, unique
//   - name  : label shown in the UI
//   - color : any CSS color (the project dot)
//   - root  : absolute path where `claude` should run for this project
//   - group : optional label that clusters projects in the pickers (project-groups.js)
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync, readFileSync, writeFileSync, statSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECTS_PATH = join(__dirname, "projects.json"); // machine-specific, gitignored

export const PORT = Number(process.env.ORCH_PORT) || 4319; // override with ORCH_PORT
export const HOST = "127.0.0.1"; // localhost only — it spawns real terminals on your machine

function loadProjects() {
  const file = existsSync(PROJECTS_PATH) ? "projects.json" : "projects.example.json";
  try {
    const arr = JSON.parse(readFileSync(join(__dirname, file), "utf8"));
    const map = {};
    for (const p of Array.isArray(arr) ? arr : []) if (p && p.id) map[p.id] = p;
    return map;
  } catch (e) {
    console.error(`[config] não consegui ler ${file}: ${e.message}`);
    return {};
  }
}

// `let` (not const) so addProject() can refresh the live binding importers see.
export let PROJECTS = loadProjects();
export let PROJECT_IDS = Object.keys(PROJECTS);

// projects.json editado à mão (ou por outra sessão) com o servidor de pé: relê quando
// o mtime muda. Barato (um stat), chamado a cada GET /api/projects.
const projMtime = () => { try { return statSync(PROJECTS_PATH).mtimeMs; } catch { return 0; } };
let lastMtime = projMtime();
export function refreshProjects() {
  const m = projMtime();
  if (m === lastMtime) return;
  lastMtime = m;
  PROJECTS = loadProjects();
  PROJECT_IDS = Object.keys(PROJECTS);
}

// Path to the central Hub's Kanban board (hub/data/board.json). The orchestrator can
// append cards to it (POST /api/cards). The Hub serves the board statelessly from
// disk, so a card written here shows up in the Hub UI on its next poll. Override with
// ORCH_HUB_BOARD; otherwise derive from a "hub" project in the registry, then fall
// back to E:\repos\hub. Existence is checked at write time, not here.
function resolveHubBoard() {
  if (process.env.ORCH_HUB_BOARD) return process.env.ORCH_HUB_BOARD;
  const hub = PROJECTS["my-hub"] || PROJECTS["hub"] ||
    Object.values(PROJECTS).find((p) => /hub/i.test(p.id) || /hub/i.test(p.name || ""));
  const root = (hub && hub.root) || "E:\\repos\\hub";
  return join(root, "data", "board.json");
}
export const HUB_BOARD = resolveHubBoard();

const PALETTE = ["#34d399", "#f472b6", "#fbbf24", "#a78bfa", "#f97316", "#38bdf8", "#fb7185", "#4ade80", "#60a5fa", "#facc15"];
const slugify = (s) =>
  String(s).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32);

// Add a project from the UI: validate, assign a unique id + color, persist the
// full registry to projects.json, and refresh the in-memory bindings so the new
// project is usable immediately (no restart). Returns the created project.
export function addProject({ name, root, color, group } = {}) {
  name = String(name || "").trim();
  root = String(root || "").trim();
  if (!name) throw new Error("nome é obrigatório");
  if (!root) throw new Error("diretório (root) é obrigatório");
  if (!existsSync(root)) throw new Error("diretório não encontrado: " + root);

  let id = slugify(name) || "proj";
  for (let base = id, n = 2; PROJECTS[id]; ) id = `${base}-${n++}`;
  const used = new Set(Object.values(PROJECTS).map((p) => p.color));
  const col = color || PALETTE.find((c) => !used.has(c)) || PALETTE[PROJECT_IDS.length % PALETTE.length];

  const proj = { id, name, color: col, root };
  group = String(group || "").trim().slice(0, 40);
  if (group) proj.group = group;
  PROJECTS = { ...PROJECTS, [id]: proj };
  PROJECT_IDS = Object.keys(PROJECTS);
  writeFileSync(PROJECTS_PATH, JSON.stringify(PROJECT_IDS.map((k) => PROJECTS[k]), null, 2) + "\n");
  return proj;
}

// Edit a project in place (name / root / color / group). The id never changes, so
// running agents and sidebar groups (keyed by projId) keep pointing at it. An empty
// group removes the project from its group. Returns the updated project.
export function updateProject(id, { name, root, color, group } = {}) {
  id = String(id || "").trim();
  const cur = PROJECTS[id];
  if (!cur) throw new Error("projeto não existe");
  const proj = { ...cur };
  if (name !== undefined) {
    name = String(name).trim();
    if (!name) throw new Error("nome é obrigatório");
    proj.name = name;
  }
  if (root !== undefined) {
    root = String(root).trim();
    if (!root) throw new Error("diretório (root) é obrigatório");
    if (!existsSync(root)) throw new Error("diretório não encontrado: " + root);
    proj.root = root;
  }
  if (color) proj.color = String(color);
  if (group !== undefined) {
    group = String(group || "").trim().slice(0, 40);
    if (group) proj.group = group; else delete proj.group;
  }
  PROJECTS = { ...PROJECTS, [id]: proj };
  writeFileSync(PROJECTS_PATH, JSON.stringify(PROJECT_IDS.map((k) => PROJECTS[k]), null, 2) + "\n");
  return proj;
}

// Remove a project from the registry, persist the rest to projects.json, and refresh
// the live bindings. Running agents are unaffected (they hold their own projName).
// Returns true if a project was removed. Note: if there was no projects.json yet (the
// example fallback was in use), this writes one with the remaining projects.
export function removeProject(id) {
  id = String(id || "").trim();
  if (!PROJECTS[id]) return false;
  const next = { ...PROJECTS };
  delete next[id];
  PROJECTS = next;
  PROJECT_IDS = Object.keys(PROJECTS);
  writeFileSync(PROJECTS_PATH, JSON.stringify(PROJECT_IDS.map((k) => PROJECTS[k]), null, 2) + "\n");
  return true;
}
