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
import { existsSync, readFileSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));

export const PORT = Number(process.env.ORCH_PORT) || 4319; // override with ORCH_PORT
export const HOST = "127.0.0.1"; // localhost only — it spawns real terminals on your machine

function loadProjects() {
  const file = existsSync(join(__dirname, "projects.json")) ? "projects.json" : "projects.example.json";
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

export const PROJECTS = loadProjects();
export const PROJECT_IDS = Object.keys(PROJECTS);
