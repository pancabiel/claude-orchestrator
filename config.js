// config.js — port + the project registry the orchestrator drives.
//
// Projects live in `projects.json` (gitignored, machine-specific) so you can point
// the tool at your work repos without committing local paths. If it's missing, the
// versioned `projects.example.json` is used as a fallback. Copy the example to
// projects.json and edit it. Shape: array of { id, name, color, root }.
//   - id    : short slug, unique
//   - name  : label shown in the UI
//   - color : any CSS color (the project dot)
//   - root  : absolute path where `claude` should run for this project
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

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

const PALETTE = ["#34d399", "#f472b6", "#fbbf24", "#a78bfa", "#f97316", "#38bdf8", "#fb7185", "#4ade80", "#60a5fa", "#facc15"];
const slugify = (s) =>
  String(s).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32);

// Add a project from the UI: validate, assign a unique id + color, persist the
// full registry to projects.json, and refresh the in-memory bindings so the new
// project is usable immediately (no restart). Returns the created project.
export function addProject({ name, root, color } = {}) {
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
  PROJECTS = { ...PROJECTS, [id]: proj };
  PROJECT_IDS = Object.keys(PROJECTS);
  writeFileSync(PROJECTS_PATH, JSON.stringify(PROJECT_IDS.map((k) => PROJECTS[k]), null, 2) + "\n");
  return proj;
}
