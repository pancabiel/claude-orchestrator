// project-groups.js — agrupa a lista de projetos pelo campo opcional `group` de
// projects.json (desktop + mobile). Grupos em ordem alfabética, projetos dentro de
// cada grupo também; os sem grupo vão num bloco final "Outros".
const cmp = (a, b) => a.localeCompare(b, "pt-BR", { sensitivity: "base" });

export const OTHER_GROUP = "Outros";

export function groupProjects(projects) {
  const byGroup = new Map();
  for (const p of projects) {
    const g = (p.group || "").trim() || OTHER_GROUP;
    if (!byGroup.has(g)) byGroup.set(g, []);
    byGroup.get(g).push(p);
  }
  const names = [...byGroup.keys()].filter((g) => g !== OTHER_GROUP).sort(cmp);
  if (byGroup.has(OTHER_GROUP)) names.push(OTHER_GROUP);
  return names.map((name) => ({ name, projects: byGroup.get(name).sort((a, b) => cmp(a.name, b.name)) }));
}
