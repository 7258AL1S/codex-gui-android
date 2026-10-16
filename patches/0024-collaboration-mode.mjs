// Patch 0024 — Default/Plan switcher in the composer.
//
// E66 established the protocol: `collaborationMode/list` enumerates the modes and
// `turn/start` accepts a `collaborationMode` field (neither appears in the
// generated types, so they had to be discovered from the binary + errors).
//
// Only sent when the mode is NOT the default, so the ordinary path is unchanged.
//
// Usage: node patches/0024-collaboration-mode.mjs [appDir]
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

// #modeButton is already the permissions control, so this is a separate id.
patchFile(resolve(appDir, "public/index.html"), [
  {
    name: "composer gets a mode chip",
    from: '<div class="model-picker composer-model-control" id="modelPicker" data-composer-control="model">',
    to: '<button type="button" class="composer-text-button collab-mode-control" id="collabModeButton" data-composer-control="mode" aria-pressed="false" hidden><span id="collabModeLabel">Default</span></button>\n            <div class="model-picker composer-model-control" id="modelPicker" data-composer-control="model">',
    skipIf: 'id="collabModeButton"',
  },
]);

patchFile(resolve(appDir, "public/app.js"), [
  {
    name: "load modes at startup",
    from: "$('#archivedButton')?.addEventListener('click',()=>toggleArchivedView());void loadThreadSections();",
    to: "$('#archivedButton')?.addEventListener('click',()=>toggleArchivedView());void loadThreadSections();void loadCollaborationModes();",
    skipIf: "void loadCollaborationModes();",
  },
  {
    name: "send the mode with turn/start",
    from: "await rpc('turn/start',{threadId:state.active.id,input:[{type:'text',text}],model:state.selectedModel,effort:$('#effortSelect').value,cwd:state.active.cwd,...permissionTurnPolicy(state.active.cwd)});",
    to: "await rpc('turn/start',{threadId:state.active.id,input:[{type:'text',text}],model:state.selectedModel,effort:$('#effortSelect').value,cwd:state.active.cwd,...permissionTurnPolicy(state.active.cwd),...collaborationModeParam()});",
    skipIf: "...collaborationModeParam()});",
  },
  {
    name: "send the mode with thread/start",
    from: "const res=await rpc('thread/start',{cwd,model:state.selectedModel,...permissionThreadPolicy(),sessionStartSource:'startup'});",
    to: "const res=await rpc('thread/start',{cwd,model:state.selectedModel,...permissionThreadPolicy(),sessionStartSource:'startup',...collaborationModeParam()});",
    skipIf: "sessionStartSource:'startup',...collaborationModeParam()",
  },
], `

// Default/Plan switching (E66). The list comes from the server, so a future mode
// shows up without a code change; the chip hides itself if the server offers
// nothing but the default.
async function loadCollaborationModes(){
  try{
    const result=await rpc('collaborationMode/list',{});
    const modes=(result?.data||[]).filter(item=>item&&item.mode);
    state.collaborationModes=modes;
    const current=modes.find(item=>item.mode===state.collaborationMode);
    state.collaborationMode=current?current.mode:(modes[0]?.mode||'default');
    renderCollaborationMode();
  }catch(error){console.error('Could not load collaboration modes',error)}
}

function collaborationModeParam(){
  const mode=state.collaborationMode;
  if(!mode||mode==='default')return{};
  return{collaborationMode:{mode,settings:{model:state.selectedModel||null,reasoning_effort:null,developer_instructions:null}}};
}

function renderCollaborationMode(){
  const button=$('#collabModeButton'),label=$('#collabModeLabel');
  if(!button||!label)return;
  const modes=state.collaborationModes||[];
  if(modes.length<2){button.hidden=true;return}
  button.hidden=false;
  const current=modes.find(item=>item.mode===state.collaborationMode)||modes[0];
  label.textContent=current.name||current.mode;
  button.setAttribute('aria-pressed',String(current.mode!=='default'));
  button.classList.toggle('active',current.mode!=='default');
  button.title=t('Conversation mode');
  button.setAttribute('aria-label',t('Conversation mode'));
}

function toggleCollaborationMode(){
  const modes=state.collaborationModes||[];
  if(modes.length<2)return;
  const index=modes.findIndex(item=>item.mode===state.collaborationMode);
  const next=modes[(index+1)%modes.length];
  state.collaborationMode=next.mode;
  renderCollaborationMode();
  toast(next.mode==='plan'?t('Plan mode: Codex will plan before acting'):t('Default mode'));
}
`, "async function loadCollaborationModes(");

patchFile(resolve(appDir, "public/app.js"), [
  {
    name: "bind the mode chip",
    from: "$('#archivedButton')?.addEventListener('click',()=>toggleArchivedView());",
    to: "$('#archivedButton')?.addEventListener('click',()=>toggleArchivedView());$('#collabModeButton')?.addEventListener('click',()=>toggleCollaborationMode());",
    skipIf: "toggleCollaborationMode());",
  },
]);

patchFile(resolve(appDir, "public/i18n.js"), [], `
Object.assign(ZH_CN, {
  "Conversation mode": "对话模式",
  "Plan mode: Codex will plan before acting": "已切到 Plan 模式：Codex 会先规划再动手",
  "Default mode": "已切回 Default 模式",
});
`, '"Conversation mode": "对话模式"');

patchFile(resolve(appDir, "public/style.css"), [], `

/* Collaboration mode chip (patch 0024). */
.collab-mode-control[hidden]{display:none}
.collab-mode-control.active{color:var(--text-strong);background:var(--surface-hover)}
`, "/* Collaboration mode chip (patch 0024). */");

console.log("\nrebuild the bundle:  bun build public/app.js --target=browser --outfile=public/app.bundle.js");
