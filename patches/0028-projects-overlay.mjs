// Patch 0028 — show projects when they exist, keep the cwd grouping otherwise.
//
// E70 claimed grouping by cwd was a "detour"; E80 revised that: `project` is a
// user-defined collection, and with zero projects (the current state) switching
// wholesale would leave the sidebar empty. So this overlays rather than replaces:
//   projects exist -> group by project
//   none           -> group by cwd (the previous behaviour)
//
// Usage: node patches/0028-projects-overlay.mjs [appDir]
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const appDir = resolve(process.argv[2] ?? new URL("../app", import.meta.url).pathname);

function patchFile(file, rules, appendText, appendMarker) {
  let source = readFileSync(file, "utf8");
  let changed = 0;
  for (const rule of rules) {
    if (rule.skipIf && source.includes(rule.skipIf)) { console.log(`skip  ${rule.name} (marker present)`); continue; }
    const hits = source.split(rule.from).length - 1;
    if (hits === 0) throw new Error(`cannot apply "${rule.name}" in ${file}: anchor not found`);
    if (hits > 1) throw new Error(`cannot apply "${rule.name}" in ${file}: anchor matched ${hits} times`);
    source = source.replace(rule.from, rule.to);
    changed += 1;
    console.log(`apply ${rule.name}`);
  }
  if (appendText && !source.includes(appendMarker)) {
    source += appendText;
    changed += 1;
    console.log(`apply append to ${file}`);
  }
  if (changed > 0) writeFileSync(file, source);
  return changed;
}

patchFile(resolve(appDir, "public/app.js"), [
  {
    // Threads carry a projectId; without projects we keep grouping by cwd.
    name: "group key prefers the project when one exists",
    from: "if(state.pinnedSectionId&&thread.section?.id===state.pinnedSectionId){pinnedThreads.push(thread);continue}const key=sidebarProjectKey(thread),",
    to: "if(state.pinnedSectionId&&thread.section?.id===state.pinnedSectionId){pinnedThreads.push(thread);continue}const key=(state.projects&&state.projects.length)?('project:'+(thread.projectId||'__none__')):sidebarProjectKey(thread),",
    skipIf: "const key=(state.projects&&state.projects.length)",
  },
  {
    name: "sidebarProjectName resolves project ids",
    from: "function sidebarProjectName(key){if(key==='__tasks__')return'Tasks';if(key==='__pinned__')return'Pinned';",
    to: "function sidebarProjectName(key){if(key==='__tasks__')return'Tasks';if(key==='__pinned__')return'Pinned';if(String(key).startsWith('project:')){const id=String(key).slice(8);return projectName(id)}",
    skipIf: "if(String(key).startsWith('project:'))",
  },
  {
    name: "load projects together with the other startup data",
    from: "void loadThreadSections();void loadCollaborationModes();if(shouldLoad)",
    to: "void loadThreadSections();void loadCollaborationModes();void loadProjects();if(shouldLoad)",
    skipIf: "void loadProjects();",
  },
], `

// Projects are user-defined collections (E80). They are optional: with none
// defined the sidebar keeps grouping by cwd, which is the sensible default.
async function loadProjects(){
  try{
    const result=await rpc('project/list',{});
    state.projects=(result?.data||[]).filter(item=>item&&item.id);
  }catch(error){console.error('Could not load projects',error)}
}

function projectName(projectId){
  const found=(state.projects||[]).find(item=>String(item.id)===String(projectId));
  return found?.name||t('Somewhere else');
}
`, "async function loadProjects(");

console.log("\nrebuild the bundle:  bun build public/app.js --target=browser --outfile=public/app.bundle.js");
