import { DEFAULT_TURN_PAGE_SIZE, applyComposerSuggestion, createLatestRequestGate, createTurnWindow, createOverlayBackGuard, createSubmitGate, filterAppModels, getComposerAutocomplete, resolveComposerPlaceholder, selectModelState } from './ui-core.js';
import { agentMessageText, isImageReference, renderAssistantMarkdown, renderImagePreview, renderItemImages } from './rendering.js';
import { codexIcon, hydrateCodexIcons } from './codex-icons.js';
import { codexInterfaceMark } from './codex-brand.js';
import { createDomI18n, createI18n } from './i18n.js';
import { buildApprovalModel, buildLegacyApprovalModel, buildElicitationModel, buildElicitationResponse, buildUserInputModel, buildUserInputResponse, createReviewPreferences, missingElicitationFields, parseUnifiedDiff, permissionRows, splitDiffHunk, summarizeActivity, unifiedDiffFromFileChanges } from './codex-surfaces.js';
import { browserSandboxFor, normalizeBrowserUrl } from './browser-panel.js';
import { THREAD_NOT_FOUND, bridgeErrorCode, createBridgeError, threadInputErrorMessage } from './bridge-errors.js';
import lottie from 'lottie-web/build/player/lottie_light.js';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
globalThis.__renderAssistantMarkdown = renderAssistantMarkdown;
const $ = (s) => document.querySelector(s);
const i18n=globalThis.__codexWebuiI18n||createI18n();
globalThis.__codexWebuiI18n=i18n;
globalThis.__codexWebuiDomI18n=globalThis.__codexWebuiDomI18n||createDomI18n(i18n);
const t=(message,values)=>i18n.t(message,values);
const state = { ws:null, events:null, transport:'connecting', wsFallbackTimer:null, rpcId:1, pending:new Map(), threads:[], active:null, models:[], selectedModel:'', workspaceContext:null, projectless:false, composerMode:'local', planMode:false, permissionMode:localStorage.getItem('codex-webui-permission-mode')||'default', permissionProfiles:[], permissionVisibility:{autoReview:true,fullAccess:localStorage.getItem('codex-webui-permission-full-access')!=='false'}, goalMode:false, backgroundAgentsVisible:false, cloudStartingState:null, placeholderText:null, composerMentions:[],composerAttachments:[], turnWindow:null, tokenUsage:new Map(), items:new Map(), turns:new Map(), activities:new Map(), activityItems:new Map(), sideTasks:new Map(), dividers:new Map(), changes:new Map(), requestCards:new Map(), motion:new Map(), turnDiffs:new Map(), activeReview:null, account:null, connected:false, config:{home:'',defaultCwd:'',projectless:false} };
let folderBrowse={path:'~',parent:null,selected:null};
const reviewPreferences=createReviewPreferences(JSON.parse(localStorage.getItem('codex-webui-review-preferences')||'{}'));
let reviewPatchState='undo';
let sidePanelReturnFocus=null,summaryPanelReturnFocus=null,imageViewerReturnFocus=null;
let bottomPanelLastView=null;
let sidebarLayoutMobile=null;
let pendingFullAccessAction='select';
let settingsMobileLayout=matchMedia('(max-width:480px)').matches;
const createTerminalState=(hostId,panelId)=>({hostId,panelId,term:null,fit:null,ws:null,resizeObserver:null,reconnectTimer:null});
const terminalStates={bottom:createTerminalState('terminalHost','bottomPanel'),side:createTerminalState('sideTerminalHost','sidePanel')};
const browserState={history:[],index:-1,loadTimer:null,loadRequest:0};
const accountRequestGate=createLatestRequestGate();
const workspaceContextRequestGate=createLatestRequestGate();
const permissionProfileRequestGate=createLatestRequestGate();
const autocompleteState={match:null,items:[],selected:0,requestId:0,message:''};
const ACTIVE_THREAD_STORAGE_KEY='codex-webui-active-thread';
const SIDEBAR_PROJECT_EXPANSION_KEY='codex-webui-sidebar-project-expansion';
const sidebarProjectExpansion=(()=>{try{return JSON.parse(localStorage.getItem(SIDEBAR_PROJECT_EXPANSION_KEY)||'{}')}catch{return{}}})();
const ACTIVE_THREAD_SYNC_ACTIVE_MS=800,ACTIVE_THREAD_SYNC_IDLE_MS=2400,THREAD_LIST_POLL_MS=3000;
let activeThreadSyncTimer=null,activeThreadSyncGeneration=0,activeThreadSyncInFlight=false,activeThreadSyncSignature='',threadListTimer=null,threadListInFlight=false,threadListSignature='';

const icons = {
  chevron:codexIcon('chevronRight','activity-chevron'),
  terminal:codexIcon('terminal'),
  file:codexIcon('file'),
  search:codexIcon('search'),
  tool:codexIcon('wrench'),
  check:codexIcon('check'),
};
hydrateCodexIcons();
// 芯片是 innerHTML 生成的，展开/收起用事件委托，重渲染不必重新绑定。
document.addEventListener('click',event=>{
  const chip=event.target?.closest?.('.user-attachment');
  if(!chip)return;
  const open=chip.classList.toggle('open');
  chip.setAttribute('aria-expanded',open?'true':'false');
  const hint=chip.querySelector('.user-attachment-hint');
  if(hint)hint.textContent=open?t('Collapse path'):t('Path');
});
$('#windowCodexMark').innerHTML=codexInterfaceMark('window-codex-mark');
$('#emptyCodexMark').innerHTML=codexInterfaceMark('empty-codex-mark');

const WS_CONNECT_TIMEOUT_MS=5000;
function transportSwitchError(){const error=new Error('Bridge transport changed');error.silentTransportSwitch=true;return error}
function clearWsFallbackTimer(){clearTimeout(state.wsFallbackTimer);state.wsFallbackTimer=null}
function rejectWebSocketPending(){for(const pending of state.pending.values())pending.reject(transportSwitchError());state.pending.clear()}
async function postBridge(path,payload){const response=await fetch(path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload),cache:'no-store'}),data=await response.json().catch(()=>({}));if(!response.ok)throw createBridgeError(data.error||'Codex bridge request failed',data.code);return data}
function connectSse(){
  if(state.events)return;
  state.transport='sse';state.connected=false;setStatus('connecting','Connecting to Codex');
  const events=new EventSource('/api/events');state.events=events;
  events.onmessage=event=>{try{handle(JSON.parse(event.data))}catch{}};
  events.onerror=()=>{if(state.events===events&&!state.connected)setStatus('connecting','Connecting to Codex')};
}
function fallbackToSse(ws){
  if(state.transport==='sse'||(ws&&state.ws!==ws))return;
  clearWsFallbackTimer();rejectWebSocketPending();state.connected=false;
  if(ws){ws.onopen=ws.onmessage=ws.onerror=ws.onclose=null;try{ws.close()}catch{}}
  state.ws=null;connectSse();
}
function connect(){
  if(state.transport==='sse'||state.ws)return;
  const proto=location.protocol==='https:'?'wss:':'ws:';
  let ws;
  try{ws=new WebSocket(`${proto}//${location.host}/ws`)}catch{fallbackToSse();return}
  state.transport='ws';state.ws=ws;
  const fallback=()=>fallbackToSse(ws);
  state.wsFallbackTimer=setTimeout(fallback,WS_CONNECT_TIMEOUT_MS);
  ws.onopen=()=>{if(state.ws===ws)setStatus('connecting','Connecting to Codex')};
  ws.onmessage=(event)=>{if(state.ws!==ws)return;try{const message=JSON.parse(event.data);clearWsFallbackTimer();handle(message)}catch{fallback()}};
  ws.onerror=fallback;ws.onclose=fallback;
}
function rpc(method,params={}){
  const id=state.rpcId++;
  if(state.transport==='sse')return postBridge('/api/rpc',{id,method,params}).then(message=>{if(message.type!=='rpc/result')throw createBridgeError(message.error||'Codex bridge request failed',message.code);return message.result});
  if(state.ws?.readyState===WebSocket.OPEN){try{state.ws.send(JSON.stringify({type:'rpc',id,method,params}));return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{if(!state.pending.delete(id))return;clientLog('rpc TIMEOUT after 20000ms: '+method);reject(new Error('Bridge request timed out: '+method));fallbackToSse(state.ws)},20000);state.pending.set(id,{resolve:(value)=>{clearTimeout(timer);resolve(value)},reject:(error)=>{clearTimeout(timer);reject(error)}})})}catch{fallbackToSse(state.ws);return Promise.reject(transportSwitchError())}}
  return Promise.reject(transportSwitchError());
}
function respondToCodex(requestId,result,error){
  if(state.transport==='sse')return postBridge('/api/codex/respond',{requestId,result,error});
  if(state.ws?.readyState===WebSocket.OPEN){try{state.ws.send(JSON.stringify(error?{type:'codex/error',requestId,error}:{type:'codex/response',requestId,result}));return Promise.resolve()}catch{fallbackToSse(state.ws);return Promise.reject(transportSwitchError())}}
  return Promise.reject(transportSwitchError());
}
function handle(message){
  if(message.type==='bridge/status'){
    if(message.status==='connected'){const shouldLoad=!state.connected;state.connected=true;setStatus('connected','Codex connected');registerNativeNotifier();void restorePendingRequests();void loadThreadSections();void loadCollaborationModes();void loadProjects();if(!state.models.length){clientLog('model catalog empty on connect — reloading');void loadInitial()}if(shouldLoad){const _t0=performance.now();Promise.resolve(loadInitial()).then(()=>clientLog('timing: loadInitial '+(performance.now()-_t0).toFixed(0)+'ms'));requestTaskNotifyPermission()}}
    else{state.connected=false;setStatus('connecting','Connecting to Codex')}
    return;
  }
  if(message.type==='rpc/result'||message.type==='rpc/error'){
    const p=state.pending.get(message.id);if(!p)return;state.pending.delete(message.id);
    message.type==='rpc/result'?p.resolve(message.result):p.reject(createBridgeError(message.error,message.code));return;
  }
  if(message.type==='codex/notification') onNotification(message.payload.method,message.payload.params||{});
  if(message.type==='codex/request') onServerRequest(message.payload);
}
function setStatus(kind,text){
  $('#statusDot').className='status-dot'+(kind==='connected'?' connected':kind==='error'?' error':'');
  $('#statusText').textContent=t(text||kind);
}
async function loadInitial(refreshAccount=false){
  loadAccount(refreshAccount);
  try{const [models,threads,profiles]=await Promise.all([rpc('model/list',{limit:50}),rpc('thread/list',{limit:50,sortKey:'recency_at',sortDirection:'desc'}),rpc('permissionProfile/list',{cwd:permissionProfileCwd(),limit:100}).catch(()=>({data:[]}))]);
    state.models=filterAppModels(models.data||[]);renderModels();applyThreadSummaries(threads.data||[]);setPermissionProfiles(profiles.data||[]);scheduleThreadListRefresh();const rememberedThread=localStorage.getItem(ACTIVE_THREAD_STORAGE_KEY);if(!state.active&&rememberedThread){clientLog('restoring remembered thread (deferred)');setTimeout(()=>{void openThread(rememberedThread)},0);}
  }catch(e){if(!e?.silentTransportSwitch)toast(e.message);}
}
async function loadAccount(refresh=false){
  const requestId=accountRequestGate.next();
  try{const response=await fetch(`/api/account${refresh?'?refresh=1':''}`,{cache:'no-store'}),account=await response.json();if(!response.ok)throw new Error(account.error||'Cannot load account');if(!accountRequestGate.isCurrent(requestId))return;state.account=account;renderAccount(account)}catch{if(accountRequestGate.isCurrent(requestId))renderAccount({displayName:null,avatarUrl:null,planType:null,initials:'?'})}
}
function renderAccount(account){
  state.account=account;
  const displayName=account?.displayName?.trim()||t('Settings'),initials=account?.initials?.trim()||'?',type=account?.type||'unknown',plan=account?.planType?`${account.planType.charAt(0).toUpperCase()}${account.planType.slice(1)} plan`:type==='apiKey'?t('API key mode'):type==='amazonBedrock'?'Amazon Bedrock':'';
  const profileMenuAvailable=type==='chatgpt';
  $('#accountName').textContent=displayName;$('#accountMenuName').textContent=displayName;$('#settingsAccountName').textContent=displayName;$('#accountFooterMeta').textContent='';$('#accountMenuSubtitle').textContent=plan;$('#settingsAccountMeta').textContent=plan||t('Codex account');
  $('#accountButton').setAttribute('aria-label',profileMenuAvailable?'Open profile menu':'Open settings');
  const avatarUrl=profileMenuAvailable&&typeof account?.avatarUrl==='string'&&account.avatarUrl.startsWith('/api/account/avatar')?account.avatarUrl:'',profileAvatars=[$('#accountMenuAvatar'),$('#settingsAccountAvatar')],footerAvatar=$('#accountAvatar'),profileAvatarClass=avatar=>`account-avatar${avatar.id==='accountMenuAvatar'?' account-menu-avatar':''}`;for(const avatar of profileAvatars){avatar.dataset.imageUrl=avatarUrl;avatar.className=`${profileAvatarClass(avatar)} account-initials`;avatar.textContent=initials}
  if(profileMenuAvailable){footerAvatar.dataset.imageUrl=avatarUrl;footerAvatar.className='account-avatar account-initials';footerAvatar.textContent=initials;profileAvatars.unshift(footerAvatar)}else{footerAvatar.dataset.imageUrl='';footerAvatar.className='account-avatar account-settings-icon';footerAvatar.innerHTML=codexIcon('wrench')}
  if(avatarUrl){const image=new Image;image.alt='';image.src=`${avatarUrl}?v=${Date.now()}`;image.onload=()=>{for(const avatar of profileAvatars){if(avatar.dataset.imageUrl!==avatarUrl)continue;avatar.className=profileAvatarClass(avatar);avatar.replaceChildren(image.cloneNode())}};image.onerror=()=>{for(const avatar of profileAvatars){if(avatar.dataset.imageUrl!==avatarUrl)continue;avatar.className=`${profileAvatarClass(avatar)} account-initials`;avatar.textContent=initials}}}
  if(!profileMenuAvailable)toggleAccountMenu(false);
  const apiMode=!profileMenuAvailable;$('#accountProfile').hidden=apiMode;$('#accountUsage').hidden=apiMode;$('#accountLogout').hidden=apiMode;
  const accountSettingsPage=$('[data-settings-page="profile"]');if(accountSettingsPage){accountSettingsPage.dataset.settingsAvailable=String(!apiMode);if(apiMode&&accountSettingsPage.classList.contains('active'))setSettingsPage('general-settings');filterSettingsNavigation($('#settingsSearch')?.value||'')}
  syncPermissionSettings();syncPermissionControl();
}
function toggleAccountMenu(force){const menu=$('#accountMenu'),open=force??menu.hidden;menu.hidden=!open;$('#accountButton').setAttribute('aria-expanded',String(open))}
const settingsPageAliases={general:'general-settings',account:'profile',keyboard:'keyboard-shortcuts'};
const settingsPages={
  'general-settings':{title:'General'},appearance:{title:'Appearance',rows:[['Theme','System'],['Language','System default'],['Interface scale','Default']]},agent:{title:'Configuration'},profile:{title:'Profile'},'keyboard-shortcuts':{title:'Keyboard shortcuts'},
  'plugins-settings':{title:'Plugins',rows:[['Installed plugins','None'],['Plugin sources','Not configured']]},'skills-settings':{title:'Skills',rows:[['Installed skills','Not configured']]},'browser-use':{title:'Browser',rows:[['Browser access','Not configured'],['Network access','Inherited from permissions']]},'computer-use':{title:'Computer use',rows:[['Computer use','Not configured']]},
  connections:{title:'Connections',rows:[['Connected services','None']]},'cloud-settings':{title:'Cloud preferences',rows:[['Diff view','Unified'],['Branch format','Default']]},'cloud-environments':{title:'Cloud environments',rows:[['Environments','None']]},'code-review':{title:'Code review',rows:[['Review instructions','Not configured']]},'git-settings':{title:'Git',rows:[['Git integration','System default']]},'experimental-settings':{title:'Experimental',rows:[['Features','Loads from experimentalFeature/list']]},'experimental-settings':{title:'Experimental',rows:[['Features','Loads from experimentalFeature/list']]},'experimental-settings':{title:'Experimental',rows:[['Features','Loads from experimentalFeature/list']]},'hooks-settings':{title:'Hooks',rows:[['Configured hooks','None']]},'automation-settings':{title:'Automation'},worktrees:{title:'Worktrees',rows:[['Worktree behavior','Default']]},'data-controls':{title:'Archived chats',rows:[['Archived chats','None']]},
};
function normalizeSettingsPage(page='general-settings'){const candidate=settingsPageAliases[page]||page;return settingsPages[candidate]?candidate:'general-settings'}
function settingsRoutePage(pathname=location.pathname){const match=pathname.match(/^\/settings(?:\/([^/]+))?\/?$/);return match?normalizeSettingsPage(match[1]||'general-settings'):null}
function settingsPlaceholderRows(page){if(page==='agent')return[['Model',modelDisplay(selectedModel())],['Reasoning effort',reasoningLabel($('#effortSelect')?.value)],['Approval',selectedPermission().label],['Web search','Automatic']];return settingsPages[page]?.rows||[]}
function renderSettingsPlaceholder(page){if(renderSettingsLive(page))return;const definition=settingsPages[page],title=$('#settingsPlaceholderTitle'),description=$('#settingsPlaceholderDescription'),rows=$('#settingsPlaceholderRows');title.textContent=t(definition.title);description.hidden=true;description.textContent='';rows.replaceChildren();for(const [label,value] of settingsPlaceholderRows(page)){const row=document.createElement('div');row.className='settings-row settings-readonly-row';const copy=document.createElement('span'),strong=document.createElement('strong'),status=document.createElement('span');strong.textContent=t(label);copy.append(strong);status.textContent=t(value);row.append(copy,status);rows.append(row)}}
function setSettingsPage(page='general-settings',{updateRoute=true}={}){const selected=normalizeSettingsPage(page),contentPage=['general-settings','profile','keyboard-shortcuts'].includes(selected)?selected:'placeholder';for(const button of document.querySelectorAll('[data-settings-page]'))button.classList.toggle('active',button.dataset.settingsPage===selected);for(const content of document.querySelectorAll('[data-settings-content]'))content.hidden=content.dataset.settingsContent!==contentPage;if(contentPage==='placeholder')renderSettingsPlaceholder(selected);$('#settingsPageTitle').textContent=t(settingsPages[selected].title);$('#settingsContent')?.scrollTo({top:0});
  // settings-page-switch：手机上点了条目要真的切到内容视图（上游只设 active，不切视图）。
  const settingsDialog=$('#settingsDialog');
  if(settingsDialog?.open&&settingsDialog.dataset.mobilePage==='false'&&matchMedia('(max-width:480px)').matches)settingsDialog.dataset.mobilePage='true';
  if(updateRoute&&settingsRoutePage())history.replaceState({...history.state,codexWebuiSettings:true},'',`/settings/${selected}`)}
function filterSettingsNavigation(query=''){const normalized=query.trim().toLocaleLowerCase(),clear=$('#clearSettingsSearch');let visible=0;if(clear)clear.hidden=!normalized;for(const group of document.querySelectorAll('[data-settings-group]')){let groupVisible=0;for(const button of group.querySelectorAll('[data-settings-page]')){const available=button.dataset.settingsAvailable!=='false',matches=!normalized||button.textContent.toLocaleLowerCase().includes(normalized);button.hidden=!available||!matches;if(!button.hidden){groupVisible++;visible++}}group.hidden=groupVisible===0}$('#settingsNavEmpty').hidden=visible!==0}
function clearSettingsSearch(){const input=$('#settingsSearch');input.value='';filterSettingsNavigation();input.focus()}
function showSettingsMobileNavigation(){const dialog=$('#settingsDialog');dialog.dataset.mobilePage='false';requestAnimationFrame(()=>$('#settingsSearch').focus())}
function syncSettingsResponsiveLayout(){const mobile=matchMedia('(max-width:480px)').matches;if(mobile===settingsMobileLayout)return;settingsMobileLayout=mobile;const dialog=$('#settingsDialog');if(dialog.open)dialog.dataset.mobilePage=String(mobile)}
function hideSettings(){const dialog=$('#settingsDialog');if(dialog.open)dialog.close();document.body.classList.remove('settings-open')}
function closeSettings(){if(settingsRoutePage()){if(typeof history.state?.codexSettingsReturnPath==='string'){history.back();return}history.replaceState({},'','/');hideSettings();return}hideSettings()}
$('#closeSettingsNav').onclick=closeSettings;$('#settingsMobileBack').onclick=showSettingsMobileNavigation;for(const button of document.querySelectorAll('.settings-page .settings-mobile-back'))button.onclick=showSettingsMobileNavigation;$('#settingsSearch').oninput=event=>filterSettingsNavigation(event.currentTarget.value);$('#clearSettingsSearch').onclick=clearSettingsSearch;$('#settingsSearch').onkeydown=event=>{if(event.key==='Escape'&&event.currentTarget.value){event.preventDefault();clearSettingsSearch()}};addEventListener('resize',syncSettingsResponsiveLayout);const overlayBack=createOverlayBackGuard({history:globalThis.history,onClose:()=>setSidebarOpen(false)});
addEventListener('popstate',()=>{if(overlayBack.handlePop())return;const page=settingsRoutePage();if(page){showSettings(page,{updateRoute:false});return}hideSettings()});
function showSettings(page='general-settings',{updateRoute=true}={}){toggleAccountMenu(false);syncPermissionSettings();$('#settingsPermissionValue').textContent=t(selectedPermission().label);$('#settingsProjectValue').textContent=state.projectless?t('No project'):shortPath(state.active?.cwd||$('#projectPath').textContent);$('#settingsSearch').value='';filterSettingsNavigation();setSettingsPage(page,{updateRoute});const dialog=$('#settingsDialog'),mobile=matchMedia('(max-width:480px)').matches;settingsMobileLayout=mobile;dialog.dataset.mobilePage=String(mobile);if(!dialog.open)dialog.show();document.body.classList.add('settings-open');requestAnimationFrame(()=>{const target=mobile?$('#settingsSearch'):document.querySelector('.settings-nav-back');target?.focus()})}
function openSettings(page='general-settings'){const selected=normalizeSettingsPage(page),current=settingsRoutePage();if(!current){history.pushState({codexWebuiSettings:true,codexSettingsReturnPath:location.pathname+location.search+location.hash},'',`/settings/${selected}`)}else if(current!==selected){history.replaceState({...history.state,codexWebuiSettings:true},'',`/settings/${selected}`)}showSettings(selected,{updateRoute:false})}
const reasoningLabels={none:'None',minimal:'Minimal',low:'Low',medium:'Medium',high:'High',xhigh:'Extra High',max:'Max',ultra:'Ultra'};
function reasoningLabel(value){return t(reasoningLabels[value]||String(value||'Medium'))}
function modelDisplay(model,stripPrefix=false){const value=String(model?.displayName||model?.model||state.selectedModel||'Select model').trim();if(!stripPrefix)return value;const stripped=value.replace(/^[^-_/\s]+[-_\s]/,'').trim();return stripped.length>=2?stripped:value}
function selectedModel(){return state.models.find(x=>x.model===state.selectedModel)}
function renderModels(){
  const saved=localStorage.getItem('codex-webui-model'),selection=selectModelState(state.models,saved);state.selectedModel=selection.model;
  updateEfforts(selection.effort);syncModelLabel();renderModelMenuMain();
}
function chooseModel(model,keepOpen=false){const previous=$('#effortSelect').value;state.selectedModel=model;localStorage.setItem('codex-webui-model',model);updateEfforts(previous);syncModelLabel();if(keepOpen)renderModelMenuMain();else closeModelMenu();toast(`Model: ${modelDisplay(selectedModel())}`)}
function syncModelLabel(){const model=selectedModel(),hasCatalog=Array.isArray(state.models)&&state.models.length>0;$('#modelLabel').textContent=model?modelDisplay(model,true):(hasCatalog?modelDisplay(null,true):t('No models are available'));$('#effortLabel').textContent=reasoningLabel($('#effortSelect')?.value)}
function updateEfforts(preferred){
  const model=selectedModel(),effort=$('#effortSelect');effort.innerHTML='';
  const supported=model?.supportedReasoningEfforts||[{reasoningEffort:'medium'}],values=supported.map(item=>item.reasoningEffort).filter(Boolean),saved=localStorage.getItem(`codex-webui-effort:${state.selectedModel}`),selected=[saved,preferred,model?.defaultReasoningEffort,values[0],'medium'].find(value=>values.includes(value))||'medium';
  for(const value of values.length?values:['medium']){const option=document.createElement('option');option.value=value;option.textContent=value;option.selected=value===selected;effort.append(option)}
  $('#effortLabel').textContent=reasoningLabel(effort.value);
}
function contextUsageValue(tokenUsage){const contextWindow=Number(tokenUsage?.modelContextWindow),totalTokens=Number(tokenUsage?.last?.totalTokens);if(!Number.isFinite(contextWindow)||contextWindow<=0||!Number.isFinite(totalTokens)||totalTokens<0)return null;const usedTokens=Math.min(totalTokens,contextWindow),percent=usedTokens/contextWindow*100;return Number.isFinite(percent)?{percent,usedTokens,contextWindow,remainingTokens:Math.max(contextWindow-usedTokens,0)}:null}
function renderContextUsage(){const indicator=$('#contextUsage'),usage=state.active?.id?contextUsageValue(state.tokenUsage.get(state.active.id)):null;if(!indicator)return;if(!usage){indicator.hidden=true;indicator.removeAttribute('data-tooltip');return}const percent=Math.max(0,Math.min(usage.percent,100)),rounded=Math.round(percent),remaining=Math.max(0,100-rounded),usedThousands=Math.round(usage.usedTokens/1000),windowThousands=Math.round(usage.contextWindow/1000),status=rounded>=50?`${rounded}% full`:`${rounded}% used (${remaining}% left)`;indicator.hidden=false;indicator.style.setProperty('--context-percent',String(percent));indicator.setAttribute('aria-label',`Context usage: ${rounded}%`);indicator.dataset.tooltip=`Context window:\n${status}\n${usedThousands}k / ${windowThousands}k tokens used`}
function menuTitle(text,back=false){return `<div class="model-menu-title-row">${back?`<button type="button" class="model-menu-back" id="modelMenuBack" aria-label="Back">${codexIcon('chevronLeft')}</button>`:''}<div class="model-menu-title">${escapeHtml(text)}</div></div>`}
function renderModelMenuMain(){const menu=$('#modelMenu'),model=selectedModel(),effort=$('#effortSelect');menu.innerHTML=`<div class="model-menu-view model-menu-view-main">${menuTitle('Reasoning')}<div class="model-menu-list" data-model-menu-efforts></div><div class="model-menu-separator"></div><button type="button" class="model-submenu-button" id="modelSubmenuButton"><span>Model</span><span class="model-submenu-value">${escapeHtml(modelDisplay(model))}</span>${codexIcon('chevronRight')}</button></div>`;const list=menu.querySelector('[data-model-menu-efforts]');for(const option of effort.options){const button=document.createElement('button');button.type='button';button.className='model-effort-row';button.dataset.value=option.value;button.setAttribute('aria-checked',String(option.selected));button.innerHTML=`<span>${escapeHtml(reasoningLabel(option.value))}</span><span class="model-check">${option.selected?codexIcon('check'):''}</span>`;button.onclick=()=>chooseEffort(option.value);list.append(button)}menu.querySelector('#modelSubmenuButton').onclick=renderModelSubmenu}
function renderModelSubmenu(){const menu=$('#modelMenu');menu.innerHTML=`<div class="model-menu-view model-menu-view-models">${menuTitle('Model',true)}<div class="model-menu-list model-list"></div></div>`;menu.querySelector('#modelMenuBack').onclick=renderModelMenuMain;const list=menu.querySelector('.model-list');for(const model of state.models){const button=document.createElement('button');button.type='button';button.className='model-option';button.role='menuitemradio';button.dataset.model=model.model;button.setAttribute('aria-checked',String(model.model===state.selectedModel));button.innerHTML=`<span class="model-option-copy"><strong>${escapeHtml(modelDisplay(model))}</strong>${model.description?`<small>${escapeHtml(model.description)}</small>`:''}</span><span class="model-check">${model.model===state.selectedModel?codexIcon('check'):''}</span>`;button.onclick=()=>chooseModel(model.model);list.append(button)}}
function chooseEffort(value){const effort=$('#effortSelect');if(![...effort.options].some(option=>option.value===value))return;effort.value=value;$('#effortLabel').textContent=reasoningLabel(value);localStorage.setItem(`codex-webui-effort:${state.selectedModel}`,value);closeModelMenu();toast(`Reasoning: ${reasoningLabel(value)}`)}
function openModelMenu(view='main'){if(view==='models')renderModelSubmenu();else renderModelMenuMain();$('#modelMenu').hidden=false;$('#modelButton').setAttribute('aria-expanded','true')}
function toggleModelMenu(){const menu=$('#modelMenu');if(menu.hidden)openModelMenu();else closeModelMenu()}
function closeModelMenu(){const menu=$('#modelMenu');menu.hidden=true;$('#modelButton').setAttribute('aria-expanded','false')}
const permissionModes={
  default:{kind:'legacy',label:'Ask for approval',description:'Always ask for permission before editing external files or using the internet',icon:'shield',approvalPolicy:'on-request',approvalsReviewer:'user',sandbox:'workspace-write'},
  'guardian-approvals':{kind:'legacy',label:'Approve for me',description:'Only ask for actions detected as potentially unsafe',icon:'shield',approvalPolicy:'on-request',approvalsReviewer:'auto_review',sandbox:'workspace-write'},
  'full-access':{kind:'legacy',label:'Full access',description:'Unrestricted access to the internet and any file on your computer',icon:'terminal',approvalPolicy:'never',approvalsReviewer:'user',sandbox:'danger-full-access'},
};
const PERMISSION_PROFILE_PREFIX='profile:';
const RESERVED_PERMISSION_PROFILE_IDS=new Set(['default','guardian-approvals','full-access','custom']);
function permissionProfileCwd(){if(state.projectless)return null;const path=state.active?.cwd||state.workspaceContext?.cwd||localStorage.getItem('codex-webui-project')||state.config.defaultCwd||null;return typeof path==='string'&&path.startsWith('~')?state.config.home+path.slice(1):path}
function permissionProfileId(mode=state.permissionMode){return String(mode||'').startsWith(PERMISSION_PROFILE_PREFIX)?String(mode).slice(PERMISSION_PROFILE_PREFIX.length):null}
function autoReviewSupported(){return state.account?.type==='chatgpt'}
function permissionModeDefinition(mode=state.permissionMode){if(permissionModes[mode])return{mode,...permissionModes[mode]};const profileId=permissionProfileId(mode),profile=profileId&&state.permissionProfiles.find(item=>item.id===profileId);return profile?{kind:'profile',mode,profileId,label:profile.id,description:profile.description||'Custom permission profile',icon:'file',allowed:profile.allowed!==false}:null}
function permissionModeAvailable(mode=state.permissionMode){const selected=permissionModeDefinition(mode);if(!selected||selected.allowed===false)return false;if(mode==='guardian-approvals')return autoReviewSupported();if(mode==='full-access')return state.permissionVisibility.fullAccess;return true}
function normalizePermissionMode(){if(permissionModeAvailable())return;state.permissionMode='default';localStorage.setItem('codex-webui-permission-mode','default')}
function selectedPermission(){normalizePermissionMode();return permissionModeDefinition()||{mode:'default',...permissionModes.default}}
function setPermissionProfiles(profiles=[]){const seen=new Set;state.permissionProfiles=(Array.isArray(profiles)?profiles:[]).flatMap(profile=>{if(!profile||typeof profile.id!=='string')return[];const id=profile.id.trim(),key=id.toLocaleLowerCase();if(!id||id.startsWith(':')||RESERVED_PERMISSION_PROFILE_IDS.has(key)||seen.has(key))return[];seen.add(key);return[{id,description:typeof profile.description==='string'?profile.description:'',allowed:profile.allowed!==false}]});normalizePermissionMode();syncPermissionControl()}
async function loadPermissionProfiles(){if(!state.connected)return;const requestId=permissionProfileRequestGate.next();try{const result=await rpc('permissionProfile/list',{cwd:permissionProfileCwd(),limit:100});if(permissionProfileRequestGate.isCurrent(requestId))setPermissionProfiles(result.data||[])}catch{if(permissionProfileRequestGate.isCurrent(requestId))setPermissionProfiles([])}}
function permissionThreadPolicy(){const selected=selectedPermission();if(selected.kind==='profile')return{permissions:selected.profileId};return{approvalPolicy:selected.approvalPolicy,approvalsReviewer:selected.approvalsReviewer,sandbox:selected.sandbox}}
function permissionTurnPolicy(cwd){const selected=selectedPermission();if(selected.kind==='profile')return{permissions:selected.profileId,approvalPolicy:null,approvalsReviewer:null};const sandboxPolicy=selected.sandbox==='danger-full-access'?{type:'dangerFullAccess'}:{type:'workspaceWrite',writableRoots:cwd?[cwd]:[],networkAccess:false,excludeTmpdirEnvVar:false,excludeSlashTmp:false};return{permissions:null,approvalPolicy:selected.approvalPolicy,approvalsReviewer:selected.approvalsReviewer,sandboxPolicy}}
function renderPermissionMenu(){const list=$('#permissionOptions');if(!list)return;list.innerHTML='';const modes=['default'];if(autoReviewSupported())modes.push('guardian-approvals');if(state.permissionVisibility.fullAccess)modes.push('full-access');for(const profile of state.permissionProfiles)modes.push(`${PERMISSION_PROFILE_PREFIX}${profile.id}`);for(const mode of modes){const option=permissionModeDefinition(mode);if(!option)continue;const checked=mode===state.permissionMode,button=document.createElement('button');button.type='button';button.className='permission-option';button.dataset.permissionMode=mode;button.role='menuitemradio';button.disabled=option.allowed===false;button.setAttribute('aria-checked',String(checked));const description=option.allowed===false?'Not allowed by managed settings':option.description;button.innerHTML=`<span class="permission-option-icon">${codexIcon(option.icon)}</span><span class="permission-option-copy"><strong>${escapeHtml(option.optionLabel||option.label)}</strong><small>${escapeHtml(description)}</small></span><span class="permission-option-check">${checked?codexIcon('check'):''}</span>`;button.onclick=()=>choosePermissionMode(mode);list.append(button)}}
function syncPermissionSettings(){const autoRow=$('#settingsAutoReviewRow'),autoToggle=$('#settingsAutoReviewToggle'),fullToggle=$('#settingsFullAccessToggle');if(autoRow)autoRow.hidden=true;if(autoToggle)autoToggle.checked=autoReviewSupported();if(fullToggle)fullToggle.checked=state.permissionVisibility.fullAccess;syncTaskNotifySettings()}
const TASK_NOTIFY_STORAGE_KEY='codex-webui-task-notify';
function taskNotifyEnabled(){return localStorage.getItem(TASK_NOTIFY_STORAGE_KEY)!=='false'}
// 注意顺序：只有在 Notification 真的存在时才碰它。放在 `&&` 的左边会让 truthy 的
// task-notify 设置直接把它求值，于是在没有 Notification 的环境（Android WebView）里
// 整块 bundle 求值失败——界面只剩静态标记（E102）。
function notificationSupported(){return typeof Notification!=='undefined'}
function syncTaskNotifySettings(){const toggle=$('#settingsTaskNotifyToggle');if(toggle)toggle.checked=taskNotifyEnabled()&&notificationSupported()&&Notification.permission!=='denied'}
async function setTaskNotifyEnabled(enabled){const on=Boolean(enabled);localStorage.setItem(TASK_NOTIFY_STORAGE_KEY,String(on));if(on&&notificationSupported()&&Notification.permission==='default'){try{await Notification.requestPermission()}catch{}}syncTaskNotifySettings();if(on&&Notification.permission==='denied')toast(t('Browser notifications are blocked'))}
function maybeNotifyTaskCompleted(p){if(!taskNotifyEnabled())return;if(document.hasFocus()&&!document.hidden)return;const thread=state.threads.find(x=>x.id===p.threadId),title=thread?.name||t('Task completed'),tag='codex-turn-'+(p.turn?.id||Date.now());if(nativeNotify(t('Task completed'),title,tag))return;if(!(notificationSupported())||Notification.permission!=='granted')return;try{new Notification(t('Task completed'),{body:title,tag})}catch{}}
function requestTaskNotifyPermission(){if(taskNotifyEnabled()&&notificationSupported()&&Notification.permission==='default')Notification.requestPermission().catch(()=>{})}
function syncPermissionControl(){normalizePermissionMode();const selected=selectedPermission();$('#modeButton .control-label').textContent=t(state.planMode?'Plan mode':selected.label);$('#modeButton').classList.toggle('active',state.planMode||state.permissionMode!=='default');if($('#settingsPermissionValue'))$('#settingsPermissionValue').textContent=t(selected.label);syncPermissionSettings();renderPermissionMenu()}
function setPermissionMode(mode){if(!permissionModeAvailable(mode))return;const selected=permissionModeDefinition(mode);state.permissionMode=mode;localStorage.setItem('codex-webui-permission-mode',mode);syncPermissionControl();closePermissionMenu();toast(selected.label)}
function setPermissionVisibility(kind,enabled){state.permissionVisibility[kind]=Boolean(enabled);localStorage.setItem(kind==='autoReview'?'codex-webui-permission-auto-review':'codex-webui-permission-full-access',String(Boolean(enabled)));normalizePermissionMode();syncPermissionControl()}
function openPermissionMenu(){closeModelMenu();syncPermissionControl();$('#permissionMenu').hidden=false;$('#modeButton').setAttribute('aria-expanded','true')}
function closePermissionMenu(){const menu=$('#permissionMenu');menu.hidden=true;$('#modeButton').setAttribute('aria-expanded','false')}
function togglePermissionMenu(){if($('#permissionMenu').hidden)openPermissionMenu();else closePermissionMenu()}
function choosePermissionMode(mode){closePermissionMenu();if(mode==='full-access'&&state.permissionMode!=='full-access'){pendingFullAccessAction='select';const dialog=$('#fullAccessDialog');if(!dialog.open)dialog.showModal();return}setPermissionMode(mode)}
async function loadFolders(path=folderBrowse.path){const list=$('#folderList');list.innerHTML='<div class="list-state">Loading folders…</div>';try{const response=await fetch(`/api/folders?path=${encodeURIComponent(path)}`),data=await response.json();if(!response.ok)throw new Error(data.error||'Cannot browse folder');folderBrowse={path:data.path,parent:data.parent,selected:data.path};$('#folderPathInput').value=data.path;$('#folderSelection').textContent=data.path;$('#folderConfirm').disabled=false;$('#folderUp').disabled=!data.parent;list.innerHTML='';for(const folder of data.folders){const b=document.createElement('button');b.type='button';b.className='folder-item';b.innerHTML=`${icons.file}<span>${escapeHtml(folder.name)}</span>`;b.ondblclick=()=>loadFolders(folder.path);b.onclick=()=>{folderBrowse.selected=folder.path;$('#folderSelection').textContent=folder.path;$('#folderConfirm').disabled=false;list.querySelectorAll('.folder-item').forEach(x=>x.classList.remove('selected'));b.classList.add('selected')};list.append(b)}if(!data.folders.length)list.innerHTML='<div class="list-state">No subfolders</div>'}catch(e){list.innerHTML=`<div class="list-state">${escapeHtml(e.message)}</div>`}}
function openFolderPicker(){const dialog=$('#folderDialog');folderBrowse.selected=null;dialog.showModal();loadFolders(state.projectless?(state.config.defaultCwd||'~/projects'):($('#projectPath').textContent||'~/projects'));$('#projectlessOption').classList.toggle('selected',state.projectless)}
async function syncWorkspaceContext(path){const requestId=workspaceContextRequestGate.next();try{const response=await fetch(`/api/workspace/context?cwd=${encodeURIComponent(path)}`,{cache:'no-store'}),context=await response.json();if(!response.ok)throw new Error(context.error||'Workspace context unavailable');if(!workspaceContextRequestGate.isCurrent(requestId)||state.projectless)return;state.workspaceContext=context;if(!state.active)showEmpty()}catch{if(workspaceContextRequestGate.isCurrent(requestId)&&!state.projectless){state.workspaceContext={cwd:path,project:path.split('/').filter(Boolean).at(-1)||path,environment:'Local',branch:'No branch'};if(!state.active)showEmpty()}}}
function syncProjectControl(){const button=$('#composerProjectButton'),label=$('#composerProjectLabel');button.hidden=Boolean(state.active);label.textContent=state.projectless?'Tasks':($('#projectName').textContent||'Project')}
function refreshComposerPlaceholder(){const followUpType=state.active?(state.active.source==='cloud'?'cloud':'local'):undefined;$('#prompt').placeholder=resolveComposerPlaceholder({followUpType,composerMode:state.composerMode,cloudStartingState:state.cloudStartingState,isBackgroundSubagentsPanelVisible:state.backgroundAgentsVisible,isGoalModeActive:state.goalMode,isPlanModeActive:state.planMode,placeholderText:state.placeholderText,isHome:!state.active})}
function setWorkspace(path){const name=path.split('/').filter(Boolean).at(-1)||path,resolved=path.replace(/^~/,state.config.home);workspaceContextRequestGate.next();state.projectless=false;state.workspaceContext={cwd:resolved,project:name,environment:'Local',branch:null};$('#projectPath').textContent=shortPath(path);$('#projectName').textContent=name;localStorage.setItem('codex-webui-project',path);syncProjectControl();if(!state.active)showEmpty();if(!$('#summaryPanel').hidden)syncSummaryPanel();syncWorkspaceContext(resolved);if(state.connected)loadPermissionProfiles()}
function setProjectless(){workspaceContextRequestGate.next();state.projectless=true;state.workspaceContext=null;$('#projectPath').textContent='~';$('#projectName').textContent=t('Tasks');localStorage.setItem('codex-webui-project','~');syncProjectControl();if(!state.active){$('#threadPath').textContent='';showEmpty()}if(!$('#summaryPanel').hidden)syncSummaryPanel();if(state.connected)loadPermissionProfiles()}
function resetReviewState(){state.turnDiffs.clear();state.activeReview=null;reviewPatchState='undo';$('#reviewTab').hidden=true;if(!$('#reviewPanelContent').hidden)setSidePanelView('launcher','New tab');renderChanges()}
function clearConversationRuntime(){for(const animation of state.motion.values())animation?.destroy?.();state.items.clear();state.turns.clear();state.activities.clear();state.activityItems.clear();state.sideTasks.clear();state.dividers.clear();state.motion.clear();renderSideTasks()}
function rememberActiveThread(id){if(id)localStorage.setItem(ACTIVE_THREAD_STORAGE_KEY,String(id));else localStorage.removeItem(ACTIVE_THREAD_STORAGE_KEY)}
function startNewTask(){resetActiveThreadSync();setActiveTurnId('');rememberActiveThread(null);state.active=null;state.composerMentions=[];state.turnWindow=null;clearConversationRuntime();state.changes.clear();resetReviewState();closeComposerAutocomplete();$('#threadTitle').textContent=t('New task');$('#threadPath').textContent=state.projectless?'':$('#projectPath').textContent;$('#prompt').value='';setPlanMode(false);syncProjectControl();renderContextTray();renderContextUsage();resizePrompt();if(!$('#summaryPanel').hidden)syncSummaryPanel();showEmpty();renderThreads();$('#prompt').focus()}
function useSelectedFolder(){if(!folderBrowse.selected)return;setWorkspace(folderBrowse.selected);$('#folderDialog').close();startNewTask()}
function useProjectless(){setProjectless();$('#folderDialog').close();startNewTask()}
function titleOf(t){return (t.name||t.preview||'Untitled task').replace(/\s+/g,' ').trim().slice(0,110)}
function shortPath(path=''){const home=state.config.home;return home&&path.startsWith(home)?'~'+path.slice(home.length):path}
function sidebarProjectKey(thread={}){return thread.projectless||!thread.cwd?'__tasks__':String(thread.cwd).replace(/\/+$/,'')}
function sidebarProjectName(key){if(key==='__tasks__')return'Tasks';if(key==='__pinned__')return'Pinned';if(String(key).startsWith('project:')){const id=String(key).slice(8);return projectName(id)}if(key===state.config.home)return'Home';return key.split('/').filter(Boolean).at(-1)||key}
function currentSidebarProjectKey(){if(state.projectless)return'__tasks__';return String(state.active?.cwd||state.workspaceContext?.cwd||$('#projectPath').textContent||'').replace(/^~/,state.config.home).replace(/\/+$/,'')}
function saveSidebarProjectExpansion(){localStorage.setItem(SIDEBAR_PROJECT_EXPANSION_KEY,JSON.stringify(sidebarProjectExpansion))}
// Thread actions the upstream UI never wired up (audit in E56). All three RPCs
// are verified working in probe/p3-thread-ops.mjs.
async function renameThread(thread){
  if(!thread?.id)return;
  const next=prompt(t('Rename thread'),titleOf(thread));
  if(next===null)return;
  const name=String(next).trim();
  if(!name)return;
  try{
    await rpc('thread/name/set',{threadId:thread.id,name});
    await refreshThreadList();renderThreads();
    toast(t('Thread renamed'));
  }catch(error){console.error('Could not rename thread',error);toast(t('Could not rename thread'))}
}

async function forkThread(thread){
  if(!thread?.id)return;
  try{
    const result=await rpc('thread/fork',{threadId:thread.id});
    const forkedId=result?.thread?.id??result?.id;
    await refreshThreadList();renderThreads();
    if(forkedId)await openThread(forkedId);
    toast(t('Thread forked'));
  }catch(error){console.error('Could not fork thread',error);toast(t('Could not fork thread'))}
}

async function archiveThread(thread){
  if(!thread?.id)return;
  try{
    await rpc('thread/archive',{threadId:thread.id});
    const wasActive=state.active?.id===thread.id;
    state.threads=state.threads.filter(item=>item.id!==thread.id);
    await refreshThreadList();
    if(wasActive)startNewTask();else renderThreads();
    toast(t('Thread archived'));
  }catch(error){console.error('Could not archive thread',error);toast(t('Could not archive thread'))}
}

async function unarchiveThread(thread){
  if(!thread?.id)return;
  try{
    await rpc('thread/unarchive',{threadId:thread.id});
    state.threads=state.threads.filter(item=>item.id!==thread.id);
    renderThreads();
    toast(t('Thread restored'));
  }catch(error){console.error('Could not restore thread',error);toast(t('Could not restore thread'))}
}

// A "⋯" button that opens a small popover. Closed on outside click / Escape so it
// behaves on a phone.
function threadActionsButton(thread){
  const wrap=document.createElement('span');
  wrap.className='thread-actions';
  const trigger=document.createElement('button');
  trigger.type='button';
  trigger.className='icon-button small thread-actions-trigger';
  trigger.title=t('Thread actions');
  trigger.setAttribute('aria-label',t('Thread actions'));
  trigger.setAttribute('aria-expanded','false');
  trigger.innerHTML=codexIcon('ellipsis');
  const menu=document.createElement('div');
  menu.className='thread-actions-menu';
  menu.hidden=true;
  const add=(label,handler)=>{const button=document.createElement('button');button.type='button';button.className='thread-actions-item';button.textContent=label;button.onclick=(event)=>{event.stopPropagation();close();handler()};menu.append(button)};
  add(t('Rename'),()=>renameThread(thread));
  add(t('Fork'),()=>forkThread(thread));
  const isPinned=Boolean(state.pinnedSectionId&&thread.section?.id===state.pinnedSectionId);
  add(isPinned?t('Unpin'):t('Pin'),()=>togglePinThread(thread));
  add(t('Compact'),()=>compactThread(thread));
  if(thread.archived)add(t('Restore'),()=>unarchiveThread(thread));else add(t('Archive'),()=>archiveThread(thread));
  const close=()=>{menu.hidden=true;trigger.setAttribute('aria-expanded','false');if(menu.parentNode)menu.parentNode.removeChild(menu);document.removeEventListener('click',onOutside,true);document.removeEventListener('keydown',onKey,true)};
  const onOutside=(event)=>{if(!wrap.contains(event.target)&&!menu.contains(event.target))close()};
  const onKey=(event)=>{if(event.key==='Escape')close()};
  const position=()=>{
    const rect=trigger.getBoundingClientRect();
    const maxTop=window.innerHeight-menu.offsetHeight-8;
    menu.style.top=Math.max(8,Math.min(rect.bottom+4,maxTop))+'px';
    menu.style.left=Math.max(8,rect.right-menu.offsetWidth)+'px';
  };
  trigger.onclick=(event)=>{
    event.stopPropagation();
    const open=menu.hidden;
    if(open){
      document.body.append(menu);
      menu.hidden=false;
      position();
      document.addEventListener('click',onOutside,true);
      document.addEventListener('keydown',onKey,true);
    }else close();
    trigger.setAttribute('aria-expanded',String(open));
  };
  wrap.append(trigger);
  return wrap;
}

async function deleteThread(thread){
  if(!thread?.id)return;
  const title=titleOf(thread);
  if(!confirm(t('Delete “{title}”? This permanently deletes the thread and its descendants.',{title})))return;
  try{
    await rpc('thread/delete',{threadId:thread.id});
    const wasActive=state.active?.id===thread.id;
    state.threads=state.threads.filter(item=>item.id!==thread.id);
    await refreshThreadList();
    if(wasActive)startNewTask();else renderThreads();
    toast(t('Thread deleted'));
  }catch(error){console.error('Could not delete thread',error);toast(t('Could not delete thread'))}
}
// 会话是不是卡在"等用户"上：`thread/list` 的 status.activeFlags（ThreadStatus.ts）。
// 审批优先于提问（同一回合里先碰上审批的概率更高，且它更需要马上处理）。
function threadWaitingFlag(thread){
  const flags=thread?.status?.type==='active'?thread.status.activeFlags:null;
  if(!Array.isArray(flags)||!flags.length)return null;
  if(flags.includes('waitingOnApproval'))return 'approval';
  if(flags.includes('waitingOnUserInput'))return 'input';
  return null;
}
function renderThreads(){
  const list=$('#threadList'),q=$('#threadSearch').value.trim().toLowerCase(),groups=new Map;list.innerHTML='';
  const pinnedThreads=[];for(const thread of state.threads){if(q&&!titleOf(thread).toLowerCase().includes(q)&&!thread.cwd?.toLowerCase().includes(q))continue;if(state.pinnedSectionId&&thread.section?.id===state.pinnedSectionId){pinnedThreads.push(thread);continue}const key=(state.projects&&state.projects.length)?('project:'+(thread.projectId||'__none__')):sidebarProjectKey(thread),group=groups.get(key)||{key,threads:[],recency:0};group.threads.push(thread);group.recency=Math.max(group.recency,Number(thread.recencyAt||thread.updatedAt)||0);groups.set(key,group)}
  if(pinnedThreads.length)groups.set('__pinned__',{key:'__pinned__',threads:pinnedThreads,recency:Number.MAX_SAFE_INTEGER});
  const currentKey=currentSidebarProjectKey(),ordered=[...groups.values()].sort((a,b)=>a.key==='__pinned__'?-1:b.key==='__pinned__'?1:a.key===currentKey?-1:b.key===currentKey?1:b.recency-a.recency);
  for(const group of ordered){const containsActive=group.threads.some(thread=>thread.id===state.active?.id),expanded=Boolean(q)||(Object.hasOwn(sidebarProjectExpansion,group.key)?sidebarProjectExpansion[group.key]:containsActive||group.key===currentKey),section=document.createElement('section');section.className='sidebar-project-group';section.dataset.project=group.key;const heading=document.createElement('button');heading.type='button';heading.className='sidebar-project-row';heading.setAttribute('aria-expanded',String(expanded));heading.title=group.key==='__tasks__'?t('Tasks'):shortPath(group.key);heading.innerHTML=`${codexIcon(group.key==='__tasks__'?'messageSquare':'folderOpen')}<span>${escapeHtml(sidebarProjectName(group.key))}</span>${codexIcon('chevronRight','sidebar-project-chevron')}`;section.append(heading);const threads=document.createElement('div');threads.className='sidebar-project-threads'+(expanded?' expanded':'');threads.setAttribute('aria-hidden',String(!expanded));threads.style.setProperty('--sidebar-thread-count',String(group.threads.length));heading.onclick=()=>{const next=heading.getAttribute('aria-expanded')!=='true';sidebarProjectExpansion[group.key]=next;saveSidebarProjectExpansion();heading.setAttribute('aria-expanded',String(next));threads.setAttribute('aria-hidden',String(!next));threads.classList.toggle('expanded',next)};for(const thread of group.threads){const row=document.createElement('div');row.className='thread-item'+(state.active?.id===thread.id?' active':'');row.dataset.id=thread.id;row.title=[titleOf(thread),shortPath(thread.cwd)].filter(Boolean).join(' — ');row.setAttribute('role','button');row.tabIndex=0;const name=document.createElement('span');name.className='thread-name';name.textContent=titleOf(thread);const meta=document.createElement('span');meta.className='thread-meta';const time=document.createElement('time');time.textContent=formatAge(thread.recencyAt||thread.updatedAt);meta.append(time);
const waiting=threadWaitingFlag(thread);
if(waiting){const badge=document.createElement('span');badge.className='thread-waiting '+(waiting==='approval'?'approval':'input');badge.textContent=t(waiting==='approval'?'Needs approval':'Needs an answer');meta.prepend(badge);row.dataset.waiting=waiting}const remove=document.createElement('button');remove.type='button';remove.className='thread-delete';remove.title=t('Delete thread');remove.setAttribute('aria-label',t('Delete thread “{title}”',{title:titleOf(thread)}));remove.innerHTML=codexIcon('trash');remove.onkeydown=event=>event.stopPropagation();remove.onclick=event=>{event.stopPropagation();deleteThread(thread)};row.append(name,meta,remove,threadActionsButton(thread));const open=()=>{if(mobileSidebarEnabled())setSidebarOpen(false);openThread(thread.id)};row.onclick=event=>{if(event.target.closest('.thread-delete'))return;open()};row.onkeydown=event=>{if(event.target.closest('.thread-delete'))return;if(event.key==='Enter'||event.key===' '){event.preventDefault();open()}};threads.append(row)}section.append(threads);list.append(section)}
  if(!list.children.length)list.innerHTML='<div class="list-state">No matching tasks</div>';
}
async function openThread(id,fallbackSummary=null){
  const listedSummary=state.threads.find(x=>x.id===id),summary=listedSummary||fallbackSummary,deferTransition=Boolean(fallbackSummary&&!listedSummary);
  if(!deferTransition){resetActiveThreadSync();setActiveTurnId('');rememberActiveThread(id);if(summary){state.active=summary;state.composerMentions=[];state.turnWindow=null;clearConversationRuntime();state.changes.clear();resetReviewState();closeComposerAutocomplete();renderContextTray();renderContextUsage();renderHeader();renderThreads();$('#conversation').innerHTML='<div class="list-state conversation-loading">Loading conversation…</div>'}}
  try{const loaded=await loadThreadHistory(id),thread={...(summary||{}),...loaded};resetActiveThreadSync();setActiveTurnId('');state.active=thread;rememberActiveThread(thread.id);state.composerMentions=[];state.turnWindow=null;clearConversationRuntime();state.changes.clear();resetReviewState();closeComposerAutocomplete();renderContextTray();renderContextUsage();renderHeader();renderThreads();$('#conversation').innerHTML='';if((thread.turns||[]).length){for(const turn of thread.turns)renderTurn(turn)}else{$('#conversation').innerHTML='<div class="list-state conversation-loading">No conversation history loaded. Send a message to continue.</div>'}scrollOpenedThreadToBottom();scheduleActiveThreadSync(0);void restorePendingRequests();return true}
  catch(e){clientLog('history load FAILED for '+id+': '+((e&&e.message)||e));if(deferTransition){toast(e?.message||'Could not load side task');return false}if(!summary||state.active?.id!==id)return false;$('#conversation').innerHTML='<div class="list-state conversation-loading">Could not load history. Send a message to start fresh.</div>';return false}}

function renderHeader(){const t=state.active;if(!t)return;$('#threadTitle').textContent=titleOf(t);if(t.projectless){state.projectless=true;state.workspaceContext=null;$('#projectName').textContent='Tasks';$('#projectPath').textContent='~';$('#threadPath').textContent=''}else{$('#threadPath').textContent=shortPath(t.cwd);setWorkspace(t.cwd||state.config.home)}syncProjectControl();refreshComposerPlaceholder();$('#threadSource').textContent=t.source||'local'}
function renderThread(thread,loadMore=0){const root=$('#conversation'),turns=thread.turns||[];state.turnWindow=createTurnWindow(turns,DEFAULT_TURN_PAGE_SIZE,state.turnWindow?.threadId===thread.id?state.turnWindow.start:undefined,loadMore);state.turnWindow.threadId=thread.id;clearConversationRuntime();root.innerHTML='';if(state.turnWindow.hiddenCount){const more=document.createElement('button');more.className='load-older';more.textContent=`Load earlier messages (${state.turnWindow.hiddenCount})`;more.onclick=()=>renderThread(thread,DEFAULT_TURN_PAGE_SIZE);root.append(more)}for(const turn of state.turnWindow.visible)renderTurn(turn,root);if(!root.children.length)showEmpty();else if(!loadMore)scrollBottom()}
function showEmpty(){const root=$('#conversation'),project=state.projectless?null:(state.workspaceContext?.project||$('#projectName').textContent?.trim());root.innerHTML=`<div class="empty-state" id="emptyState">${codexInterfaceMark('empty-codex-mark')}<h1>${project?`What can I help with in ${escapeHtml(project)}?`:'What can I help?'}</h1></div>`}
function ensureTurnTimeline(turnId,root=$('#conversation')){let turn=state.turns.get(turnId);if(turn?.isConnected)return turn;turn=document.createElement('article');turn.className='turn assistant-turn native-turn-timeline';turn.dataset.turnId=turnId;turn.innerHTML='<div class="assistant-body"><div class="turn-event-stream"></div></div><div class="worked-for-divider" data-worked-for-divider hidden><span>Worked</span><div></div></div><div class="turn-final-slot"></div>';root.append(turn);state.turns.set(turnId,turn);state.dividers.set(turnId,turn.querySelector('[data-worked-for-divider]'));return turn}
function formatWorkedDuration(durationMs){if(!Number.isFinite(durationMs)||durationMs<1000)return null;const seconds=Math.max(1,Math.round(durationMs/1000));if(seconds<60)return`${seconds}s`;const minutes=Math.floor(seconds/60),rest=seconds%60;return rest?`${minutes}m ${rest}s`:`${minutes}m`}
function turnDurationMs(turn={}){if(Number.isFinite(turn.durationMs))return turn.durationMs;if(Number.isFinite(turn.startedAt)&&Number.isFinite(turn.completedAt))return Math.max(0,(turn.completedAt-turn.startedAt)*1000);if(Number.isFinite(turn.startedAtMs)&&Number.isFinite(turn.completedAtMs))return Math.max(0,turn.completedAtMs-turn.startedAtMs);return undefined}
function syncWorkedForDivider(turnId,durationMs){const turn=state.turns.get(turnId),divider=state.dividers.get(turnId);if(!turn||!divider)return;if(Number.isFinite(durationMs))turn.dataset.durationMs=String(durationMs);const hasActivity=Boolean(turn.querySelector('[data-agent-activity-group]')),hasFinal=Boolean(turn.querySelector('[data-local-conversation-final-assistant]'));divider.hidden=!(hasActivity&&hasFinal);const duration=formatWorkedDuration(Number(turn.dataset.durationMs));divider.querySelector('span').textContent=duration?`Worked for ${duration}`:'Worked'}
function renderTurn(turn,root=$('#conversation')){for(const item of turn.items||[])upsertItem(item,turn.id,root,false);syncWorkedForDivider(turn.id,turnDurationMs(turn))}
function textFromInput(content=[]){return content.map(part=>typeof part?.text==='string'?part.text:'').filter(text=>text.trim()&&!/^\s*<image\b[\s\S]*?<\/image>\s*$/.test(text)&&!/^\s*<image\b[^>]*>\s*$/.test(text)).join('\n')}
function claimOptimisticUser(item,root){if(String(item.id).startsWith('local-'))return null;const text=textFromInput(item.content),candidates=[...root.querySelectorAll('.user-turn[data-optimistic-user="true"]')];const el=candidates.find(node=>{const host=node.querySelector('.user-message');return (host?.dataset.rawText??host?.textContent)===text});if(!el)return null;for(const[id,node]of state.items)if(node===el)state.items.delete(id);delete el.dataset.optimisticUser;state.items.set(item.id,el);return el}
function agentMessageIdFamily(id){const value=String(id||'');return /^item[-_]/.test(value)?'app':/^(?:msg_|host-message-)/.test(value)?'rollout':''}
function claimEquivalentAgentMessage(item,turnId){const family=agentMessageIdFamily(item.id);if(!family)return null;const text=agentMessageText(item,''),commentary=item.phase==='commentary';for(const[id,node]of state.items){if(agentMessageIdFamily(id)===family||node.closest('[data-turn-id]')?.dataset.turnId!==turnId)continue;const body=node.querySelector('.message-text'),existingCommentary=node.dataset.localConversationCommentary!==undefined;if(existingCommentary===commentary&&body?.dataset.raw===text){state.items.set(item.id,node);return node}}return null}
function placeAgentMessage(el,item,timeline){const commentary=item.phase==='commentary',slot=timeline.querySelector(commentary?'.turn-event-stream':'.turn-final-slot');el.className=commentary?'assistant-response assistant-commentary':'assistant-response';if(commentary){delete el.dataset.localConversationFinalAssistant;el.dataset.localConversationCommentary=''}else{delete el.dataset.localConversationCommentary;el.dataset.localConversationFinalAssistant=''}if(el.parentElement!==slot)slot.append(el)}
function imageCwd(item={}){return item.cwd||state.active?.cwd||state.config.defaultCwd||'.'}
function sideTaskStatus(item,threadId){const agent=item.agentsStates?.[threadId];if(agent?.status)return agent.status;if(item.type==='subAgentActivity')return item.kind==='interrupted'?'interrupted':'running';return item.status==='failed'?'errored':item.status==='completed'?'completed':'running'}
function updateSideTasks(item){if(item.type==='collabAgentToolCall'){for(const threadId of item.receiverThreadIds||[]){const previous=state.sideTasks.get(threadId)||{};state.sideTasks.set(threadId,{...previous,threadId,prompt:item.prompt||previous.prompt||'',model:item.model||previous.model||'',reasoningEffort:item.reasoningEffort||previous.reasoningEffort||'',status:sideTaskStatus(item,threadId),message:item.agentsStates?.[threadId]?.message||previous.message||''})}}else if(item.type==='subAgentActivity'){const previous=state.sideTasks.get(item.agentThreadId)||{};state.sideTasks.set(item.agentThreadId,{...previous,threadId:item.agentThreadId,agentPath:item.agentPath||previous.agentPath||'',status:sideTaskStatus(item,item.agentThreadId)})}renderSideTasks()}
function renderSideTasks(){const list=$('#sideTaskList');if(!list)return;list.innerHTML='';for(const task of state.sideTasks.values()){const button=document.createElement('button');button.type='button';button.className='side-task-card';button.dataset.threadId=task.threadId;button.innerHTML=`${codexIcon('messageSquare')}<span class="side-task-copy"><strong>${escapeHtml(task.agentPath||task.model||'Side task')}</strong><small>${escapeHtml(task.message||task.prompt||task.threadId)}</small></span><span class="side-task-status ${escapeHtml(task.status||'running')}">${escapeHtml(task.status||'running')}</span>`;button.onclick=async()=>{button.disabled=true;button.setAttribute('aria-busy','true');await openThread(task.threadId,{id:task.threadId,name:task.agentPath||task.model||'Side task',preview:task.prompt||task.message||'',cwd:state.active?.cwd||state.config.defaultCwd,source:'local',sideTask:true});if(button.isConnected){button.disabled=false;button.removeAttribute('aria-busy')}};list.append(button)}if(!state.sideTasks.size)list.innerHTML='<div class="side-task-empty">Side tasks started by this chat will appear here.</div>';const summary=$('#summarySideTasks');if(summary)summary.textContent=state.sideTasks.size?`${state.sideTasks.size} side task${state.sideTasks.size===1?'':'s'}`:'No side tasks'}
function upsertItem(item,turnId,root=$('#conversation'),live=true){
  root.querySelector('#emptyState')?.remove();
  let el=state.items.get(item.id);if(!el&&item.type==='userMessage')el=claimOptimisticUser(item,root);if(!el&&item.type==='agentMessage')el=claimEquivalentAgentMessage(item,turnId);if(!el){
    if(item.type==='userMessage'){el=document.createElement('article');el.className='turn user-turn';if(String(item.id).startsWith('local-'))el.dataset.optimisticUser='true';el.innerHTML='<div class="user-message"></div>';const timeline=state.turns.get(turnId);timeline?.isConnected?root.insertBefore(el,timeline):root.append(el)}
    else if(item.type==='agentMessage'){const timeline=ensureTurnTimeline(turnId,root);el=document.createElement('div');el.innerHTML='<div class="message-text"></div>';placeAgentMessage(el,item,timeline)}
    else if(item.type==='imageGeneration'){const timeline=ensureTurnTimeline(turnId,root);el=document.createElement('div');el.className='assistant-generated-image';timeline.querySelector('.turn-event-stream').append(el)}
    else if(['commandExecution','fileChange','mcpToolCall','dynamicToolCall','collabAgentToolCall','subAgentActivity','webSearch','reasoning','plan','imageView'].includes(item.type)){const id=activityItemId(item);el=ensureActivity(turnId,root,id,item.type==='imageView'||item.type==='reasoning');addActivity(item,el,id)}
    else return;
    if(item.type==='userMessage'||item.type==='agentMessage'||item.type==='imageGeneration')state.items.set(item.id,el);
  }
  if(item.type==='userMessage')renderUserMessage(el,item);
  if(item.type==='agentMessage'){const timeline=ensureTurnTimeline(turnId,root),body=el.querySelector('.message-text'),text=agentMessageText(item,body.dataset.raw??''),cwd=imageCwd(item);placeAgentMessage(el,item,timeline);body.dataset.raw=text;body.innerHTML=renderAssistantMarkdown(text,{cwd})+renderItemImages(item,{cwd,className:'message-image-grid structured-message-images',excludeText:text});syncWorkedForDivider(turnId)}
  if(item.type==='imageGeneration'){const html=renderItemImages(item,{cwd:imageCwd(item),className:'generated-image-grid'});el.innerHTML=html||`<div class="generated-image-pending ${item.status==='inProgress'?'loading-shimmer':''}">${item.status==='failed'?'Image generation failed':'Generating image'}</div>`}
  if(item.type==='fileChange'){for(const ch of item.changes||[]){const path=ch.path||ch.filePath||'Changed file';state.changes.set(path,ch)}syncTurnReviewFromItems(turnId);renderChanges()}
  if(item.type==='collabAgentToolCall'||item.type==='subAgentActivity')updateSideTasks(item)
  if(live)scrollBottom();
}
function activityGroupExpansionKey(activity){const threadId=state.active?.id,turnId=activity.closest('[data-turn-id]')?.dataset.turnId,anchor=activity.dataset.activityGroupAnchor;return threadId&&turnId&&anchor?`codex-webui-activity-group:${threadId}:${turnId}:${anchor}`:null}
function savedActivityGroupExpansion(activity){const key=activityGroupExpansionKey(activity),saved=key&&localStorage.getItem(key);return saved==='open'?true:saved==='closed'?false:null}
function setActivityGroupOpen(activity,open,persist=false){const button=activity.querySelector('.activity-summary'),items=activity.querySelector('.activity-items');button.classList.toggle('open',open);items.classList.toggle('open',open);if(persist&&!activity.classList.contains('single')){const key=activityGroupExpansionKey(activity);if(key)localStorage.setItem(key,open?'open':'closed')}}
function ensureActivity(turnId,root,itemId,standalone=false){const turn=ensureTurnTimeline(turnId,root),stream=turn.querySelector('.turn-event-stream'),existing=itemId?turn.querySelector(`[data-item-id="${CSS.escape(String(itemId))}"]`)?.closest('[data-agent-activity-group]'):null;if(existing)return existing;let activity=standalone?null:state.activities.get(turnId);if(!activity?.isConnected||activity.parentElement!==stream||stream.lastElementChild!==activity||activity.dataset.standalone==='true'){activity=document.createElement('div');activity.className='activity-group active';activity.dataset.agentActivityGroup='';activity.dataset.activityGroupAnchor=String(itemId||'activity');if(standalone)activity.dataset.standalone='true';activity.innerHTML=`<button class="activity-summary open"><span class="activity-summary-icon" aria-hidden="true"></span><span class="activity-summary-copy loading-shimmer">Working</span>${icons.chevron}</button><div class="activity-items open"></div>`;activity.querySelector('.activity-summary').onclick=()=>setActivityGroupOpen(activity,!activity.querySelector('.activity-summary').classList.contains('open'),true);stream.append(activity);state.activities.set(turnId,activity)}if(!state.activityItems.has(turnId))state.activityItems.set(turnId,new Map);return activity}
function joinActivityText(value){if(typeof value==='string')return value;if(Array.isArray(value))return value.filter(part=>typeof part==='string').join('\n');return''}
function activityOutput(item){if(item.type==='reasoning')return joinActivityText(item.summary)||joinActivityText(item.content);const output=item.aggregatedOutput??item.output?.aggregatedOutput??item.output;if(typeof output==='string')return output;if(Array.isArray(output))return output.join('\n');return joinActivityText(item.content)||(item.result?JSON.stringify(item.result,null,2):'')}
function commandText(item){return item.command||(item.commandActions||[]).map(action=>action?.command).filter(Boolean).join('\n')||''}
function commandExitCode(item){return item.exitCode??item.output?.exitCode}
function commandFooter(item,data){if(data.active)return{label:'',icon:''};if(item.executionStatus==='interrupted'||item.status==='interrupted'||item.status==='cancelled')return{label:'Stopped',icon:''};const exitCode=commandExitCode(item);if(data.tone==='error')return{label:exitCode==null?'Failed':`Exit code ${exitCode}`,icon:''};return{label:'Success',icon:icons.check}}
function renderCommandShell(out,item,data){if(out.dataset.outputKind!=='command'){out.dataset.outputKind='command';out.className='activity-output command-shell-wrap';out.innerHTML='<div class="command-shell"><div class="command-shell-body"><div class="command-shell-command"><span aria-hidden="true">$</span><code></code></div><div class="command-shell-output"><pre></pre></div></div><div class="command-shell-footer"></div></div>'}const output=activityOutput(item),pre=out.querySelector('.command-shell-output pre'),footer=commandFooter(item,data);out.querySelector('.command-shell-command code').textContent=commandText(item);pre.textContent=output||(data.active?'':'No output');pre.classList.toggle('empty',!output);out.querySelector('.command-shell-footer').innerHTML=`${footer.icon}<span>${footer.label}</span>`}
function inlineFileChangeDiff(change){const raw=unifiedDiffFromFileChanges([change]),review=parseUnifiedDiff(raw);if(!review.hasChanges){const diff=change.diff||change.unified_diff||'';return diff?`<pre>${escapeHtml(diff)}</pre>`:''}return `<div class="file-change-inline-diff">${review.files.flatMap(file=>file.hunks.map(hunk=>`<div class="file-change-inline-hunk"><div class="review-hunk-head">${escapeHtml(hunk.header)}</div><div class="review-lines">${hunk.lines.map(reviewLineHtml).join('')}</div></div>`)).join('')}</div>`}
function renderFileChangeOutput(out,item,data){out.dataset.outputKind='file-change';out.className='activity-output file-change-output';const changes=item.changes||[],legacy=activityOutput(item);if(!changes.length){out.innerHTML=`<div class="file-change-progress ${data.active?'loading-shimmer':''}">${escapeHtml(legacy||(data.active?'Waiting for patch details…':'No patch details'))}</div>`;return}out.innerHTML=changes.map(change=>{const path=change.path||change.filePath||'Changed file',kind=typeof change.kind==='string'?change.kind:change.kind?.type||'update';return `<section class="file-change-output-item"><div class="file-change-output-head">${codexIcon('fileDiff')}<span>${escapeHtml(shortPath(path))}</span><small>${escapeHtml(kind)}</small></div>${inlineFileChangeDiff(change)}</section>`}).join('')}
function isExplorationActivity(item,data=summarizeActivity(item)){return item.type==='commandExecution'&&['read','search','list'].includes(data.category)}
function renderActivityOutput(out,item,data){if(item.type==='imageView'){out.dataset.outputKind='image';out.className='activity-output activity-image-output';out.innerHTML=renderItemImages(item,{cwd:imageCwd(item),className:'activity-image-grid'})||'<div class="message-image-unavailable" data-i18n-ui>Image unavailable</div>';return}if(item.type==='commandExecution'&&data.category==='command'){renderCommandShell(out,item,data);return}if(item.type==='fileChange'){renderFileChangeOutput(out,item,data);return}if(item.type==='reasoning'){const text=activityOutput(item);out.dataset.outputKind='reasoning';out.className='activity-output reasoning-output message-text';out.innerHTML=text?renderAssistantMarkdown(text,{cwd:imageCwd(item)}):'';return}out.dataset.outputKind='plain';out.className='activity-output';out.textContent=isExplorationActivity(item,data)?'':activityOutput(item)||''}
function activityItemExpansionKey(row){const threadId=state.active?.id,turnId=row.closest('[data-turn-id]')?.dataset.turnId,itemId=row.dataset.itemId;return threadId&&turnId&&itemId?`codex-webui-activity-item:${threadId}:${turnId}:${itemId}`:null}
function savedActivityItemExpansion(row){const key=activityItemExpansionKey(row),saved=key&&localStorage.getItem(key);return saved==='open'?true:saved==='closed'?false:null}
function setActivityExpanded(row,expanded,persist=false){row.classList.toggle('expanded',expanded);row.setAttribute('aria-expanded',String(expanded));if(persist){const key=activityItemExpansionKey(row);if(key)localStorage.setItem(key,expanded?'open':'closed')}}
function motionIcon(name){return `<span class="activity-motion" data-animation="${name}"></span>`}
async function mountMotion(row,name){const holder=row.querySelector('.activity-motion');if(!holder)return;state.motion.get(row)?.destroy();try{const animationData=await fetch(`/assets/codex-motion/${name}.json`).then(r=>r.json());if(!holder.isConnected)return;const animation=lottie.loadAnimation({container:holder,renderer:'svg',loop:true,autoplay:true,animationData,rendererSettings:{preserveAspectRatio:'xMidYMid meet'}});state.motion.set(row,animation)}catch{holder.innerHTML=codexIcon('loaderCircle','motion-fallback')}}
function activityIconName(item,data=summarizeActivity(item)){if(item.type==='reasoning')return null;if(data.tone==='error')return'triangleAlert';if(item.type==='fileChange')return'fileDiff';if(data.category==='image')return'image';if(data.category==='read')return'file';if(data.category==='search'||item.type==='webSearch')return'search';if(data.category==='list')return'list';if(data.category==='command')return'terminal';return'wrench'}
function stopMotion(row,tone){const animation=state.motion.get(row);animation?.destroy();state.motion.delete(row);const holder=row.querySelector('.activity-motion'),turnId=row.closest('[data-turn-id]')?.dataset.turnId,item=state.activityItems.get(turnId)?.get(row.dataset.itemId),data=item?summarizeActivity(item):{tone};if(!holder)return;const icon=activityIconName(item||{},data);holder.innerHTML=icon?codexIcon(icon):''}
function activityItemId(item){return String(item.id||item.callId||item.requestId||`${item.type}-${Date.now()}`)}
function joinActivityParts(parts){return parts.length<2?parts[0]||'Worked':`${parts.slice(0,-1).join(', ')} and ${parts.at(-1)}`}
function completedActivitySummary(items){const summaries=items.map(item=>({item,data:summarizeActivity(item)})),commands=summaries.filter(({item,data})=>item.type==='commandExecution'&&data.category==='command').length,explored=summaries.some(({data})=>['read','search','list'].includes(data.category)&&data.tone!=='error'),edits=summaries.filter(({item,data})=>item.type==='fileChange'&&data.tone!=='error').reduce((count,{item})=>count+Math.max(1,item.changes?.length||0),0),web=summaries.some(({item,data})=>item.type==='webSearch'&&data.tone!=='error'),images=summaries.some(({data})=>data.category==='image'&&data.tone!=='error'),failed=summaries.some(({data})=>data.tone==='error'),parts=[],add=(leading,following)=>parts.push(parts.length?following:leading);if(edits)add(edits===1?'Edited a file':'Edited files',edits===1?'edited a file':'edited files');if(explored)add('Read files','read files');if(commands)add(commands===1?'Ran a command':'Ran commands',commands===1?'ran a command':'ran commands');if(web)add('Searched the web','searched the web');if(images)add('Viewed images','viewed images');if(!parts.length&&failed)return'Activity failed';return joinActivityParts(parts)}
function completedActivityPrimaryItem(items){const summaries=items.map(item=>({item,data:summarizeActivity(item)})),find=predicate=>summaries.find(predicate)?.item;return find(({item,data})=>item.type==='fileChange'&&data.tone!=='error')||find(({data})=>['read','search','list'].includes(data.category)&&data.tone!=='error')||find(({data})=>data.category==='command'&&data.tone!=='error')||find(({item,data})=>item.type==='webSearch'&&data.tone!=='error')||find(({data})=>data.category==='image'&&data.tone!=='error')||items.find(item=>summarizeActivity(item).tone==='error')||items[0]}
function setActivitySummaryIcon(activity,item){const holder=activity.querySelector('.activity-summary-icon'),icon=item&&activityIconName(item);if(holder){holder.hidden=!icon;holder.innerHTML=icon?codexIcon(icon):''}}
function commandRowSummary(item,data,expanded){if(data.active)return data.label;const interrupted=item.executionStatus==='interrupted'||item.status==='interrupted'||item.status==='cancelled',command=commandText(item);if(expanded)return t(interrupted?'Stopped command':'Ran command');return command?`${t(interrupted?'Stopped':'Ran')} ${command}`:t(interrupted?'Stopped command':'Ran command')}
function updateCommandRowSummary(row,item,data,expanded=row.classList.contains('expanded')){const summary=row.querySelector('.activity-name');if(summary)summary.textContent=commandRowSummary(item,data,expanded)}
function updateActivitySummary(activity){const turn=activity.closest('[data-turn-id]'),turnId=turn?.dataset.turnId,allItems=state.activityItems.get(turnId),rows=[...activity.querySelectorAll('.activity-item')],items=rows.map(row=>allItems?.get(row.dataset.itemId)).filter(Boolean),summary=activity.querySelector('.activity-summary-copy');if(!turn||!summary)return;activity.classList.toggle('single',items.length===1);const activeItem=items.findLast?.(item=>summarizeActivity(item).active)||[...items].reverse().find(item=>summarizeActivity(item).active),savedOpen=savedActivityGroupExpansion(activity);if(activeItem){const data=summarizeActivity(activeItem);setActivitySummaryIcon(activity,activeItem);summary.textContent=data.label;summary.classList.add('loading-shimmer');activity.classList.add('active');setActivityGroupOpen(activity,items.length===1||(savedOpen??true))}else{setActivitySummaryIcon(activity,completedActivityPrimaryItem(items));summary.textContent=completedActivitySummary(items);summary.classList.remove('loading-shimmer');activity.classList.remove('active');setActivityGroupOpen(activity,items.length===1||(savedOpen??false))}syncWorkedForDivider(turnId)}
function addActivity(item,activity,id=activityItemId(item)){const data=summarizeActivity(item),turn=activity.closest('[data-turn-id]'),turnId=turn.dataset.turnId,items=state.activityItems.get(turnId)||new Map,box=activity.querySelector('.activity-items');items.set(id,item);state.activityItems.set(turnId,items);let row=box.querySelector(`[data-item-id="${CSS.escape(id)}"]`);if(!row){row=document.createElement('div');row.className='activity-item entering';row.dataset.itemId=id;box.append(row);const out=document.createElement('div');out.className='activity-output';box.append(out)}const imageView=item.type==='imageView',reasoning=item.type==='reasoning',command=item.type==='commandExecution'&&data.category==='command',fileChange=item.type==='fileChange',wasActive=row.dataset.activityWasActive==='true',savedExpanded=savedActivityItemExpansion(row),existingExpanded=row.dataset.expansionInitialized?row.classList.contains('expanded'):imageView,expanded=reasoning?(data.active?true:wasActive?false:(savedExpanded??existingExpanded)):(savedExpanded??existingExpanded);row.dataset.expansionInitialized='true';row.dataset.activityWasActive=String(data.active);row.className=`activity-item ${command?'command-activity ':''}${reasoning?'reasoning-activity ':''}${imageView?'image-activity ':''}${fileChange?'file-change-activity ':''}${data.active?'active':'settled'} ${data.tone}`;if(command){state.motion.get(row)?.destroy();state.motion.delete(row);row.innerHTML=`<span class="activity-command-icon">${icons.terminal}</span><div class="activity-copy"><div class="activity-name ${data.active?'loading-shimmer':''}">${escapeHtml(commandRowSummary(item,data,expanded))}</div></div><span class="activity-command-chevron">${icons.chevron}</span>`}else if(reasoning){state.motion.get(row)?.destroy();state.motion.delete(row);row.innerHTML=`<div class="activity-copy"><div class="activity-name ${data.active?'loading-shimmer':''}">${escapeHtml(data.label)}</div></div><span class="activity-reasoning-chevron">${icons.chevron}</span>`}else{const detail=shortPath(data.detail||'');row.innerHTML=`${motionIcon(data.animation)}<div class="activity-copy"><div class="activity-name ${data.active?'loading-shimmer':''}"><span class="activity-label">${escapeHtml(data.label)}</span>${detail?` <span class="activity-detail">${escapeHtml(detail)}</span>`:''}</div></div><span class="activity-result">${fileChange?icons.chevron:''}</span>`}const out=row.nextElementSibling;renderActivityOutput(out,item,data);const reasoningOutput=reasoning&&!!activityOutput(item),expandable=imageView||command||fileChange||(reasoning&&!data.active&&reasoningOutput)||(!reasoning&&!isExplorationActivity(item,data)&&!!activityOutput(item));if(reasoning&&data.active&&reasoningOutput){row.removeAttribute('role');row.removeAttribute('aria-expanded');row.tabIndex=-1;row.classList.add('expanded')}else if(expandable){row.setAttribute('role','button');row.tabIndex=0;setActivityExpanded(row,expanded)}else{row.removeAttribute('role');row.removeAttribute('aria-expanded');row.tabIndex=-1;row.classList.remove('expanded')}row.onclick=expandable?()=>{const next=!row.classList.contains('expanded');setActivityExpanded(row,next,true);if(command)updateCommandRowSummary(row,item,data,next)}:null;row.onkeydown=expandable?event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();row.click()}}:null;if(!command&&!reasoning){if(data.active)mountMotion(row,data.animation);else stopMotion(row,data.tone)}updateActivitySummary(activity)}
function diffForTurn(turnId){return state.turnDiffs.get(turnId)||null}
function recordTurnReview(turnId,raw,source='fileChange'){if(!turnId||!raw)return null;const existing=state.turnDiffs.get(turnId);if(source!=='native'&&existing?.source==='native')return existing;const review=parseUnifiedDiff(raw);if(!review.hasChanges)return null;review.turnId=turnId;review.raw=raw;review.source=source;state.turnDiffs.set(turnId,review);state.activeReview=review;$('#reviewTab').hidden=false;renderChanges();return review}
function syncTurnReviewFromItems(turnId){const items=state.activityItems.get(turnId),changes=items?[...items.values()].flatMap(item=>item?.type==='fileChange'&&Array.isArray(item.changes)?item.changes:[]):[],raw=unifiedDiffFromFileChanges(changes);if(raw)recordTurnReview(turnId,raw)}
function saveReviewPreferences(){localStorage.setItem('codex-webui-review-preferences',JSON.stringify(reviewPreferences))}
function reviewLineHtml(line){if(!line)return '<div class="review-line empty"><span class="review-sign"></span><code></code></div>';return `<div class="review-line ${line.type}"><span class="review-sign">${line.type==='add'?'+':line.type==='delete'?'−':' '}</span><code>${escapeHtml(line.text)}</code></div>`}
function reviewHunkHtml(hunk){if(reviewPreferences.mode==='split'){return `<div class="review-split-lines">${splitDiffHunk(hunk).map(row=>`<div class="review-split-row"><div class="review-side old">${reviewLineHtml(row.left)}</div><div class="review-side new">${reviewLineHtml(row.right)}</div></div>`).join('')}</div>`}return `<div class="review-lines">${hunk.lines.map(reviewLineHtml).join('')}</div>`}
function syncReviewControls(review){const has=!!review?.hasChanges;$('#reviewMode').disabled=!has;$('#reviewWrap').disabled=!has;$('#reviewExpand').disabled=!has;$('#reviewPatch').disabled=!has||!state.active?.id||!review?.turnId;$('#reviewMode').title=reviewPreferences.mode==='unified'?'Switch to split diff':'Switch to unified diff';$('#reviewWrap').title=reviewPreferences.wrap?'Disable word wrap':'Enable word wrap';$('#reviewExpand').title=reviewPreferences.expanded?'Collapse all diffs':'Expand all diffs';$('#reviewPatch').title=reviewPatchState==='undo'?'Undo changes':'Reapply changes';$('#reviewPatch').innerHTML=codexIcon(reviewPatchState==='undo'?'undo':'redo')}
function renderChanges(){const list=$('#changeList'),review=state.activeReview||[...state.turnDiffs.values()].at(-1)||null,reviewVisible=document.body.classList.contains('side-panel-open')&&!$('#reviewPanelContent').hidden;document.body.classList.toggle('review-split-open',reviewVisible&&reviewPreferences.mode==='split'&&!!review?.hasChanges&&innerWidth>1200);list.dataset.mode=reviewPreferences.mode;list.classList.toggle('wrap',reviewPreferences.wrap);if(review?.hasChanges){$('#changeCount').textContent=review.fileCount;$('#changeSummary').textContent=`${review.fileCount} changed file${review.fileCount===1?'':'s'}`;$('#reviewStats').innerHTML=`<span class="plus">+${review.linesAdded}</span><span class="minus">−${review.linesDeleted}</span>`;list.innerHTML='';for(const file of review.files){const section=document.createElement('section');section.className='review-file';section.dataset.path=file.path;section.innerHTML=`<button class="review-file-head" aria-expanded="${reviewPreferences.expanded}">${codexIcon('chevronDown','review-chevron')}<span class="review-file-name">${escapeHtml(shortPath(file.path))}</span><span class="review-file-stats"><span class="plus">+${file.linesAdded}</span><span class="minus">−${file.linesDeleted}</span></span></button><div class="review-hunks"${reviewPreferences.expanded?'':' hidden'}></div>`;const body=section.querySelector('.review-hunks');for(const hunk of file.hunks){const h=document.createElement('div');h.className='review-hunk';h.innerHTML=`<div class="review-hunk-head">${escapeHtml(hunk.header)}</div>${reviewHunkHtml(hunk)}`;body.append(h)}section.querySelector('.review-file-head').onclick=e=>{const open=e.currentTarget.getAttribute('aria-expanded')==='true';e.currentTarget.setAttribute('aria-expanded',String(!open));body.hidden=open};list.append(section)}syncReviewControls(review);return}$('#reviewStats').textContent='';$('#changeCount').textContent=state.changes.size;$('#changeSummary').textContent=state.changes.size?`${state.changes.size} changed file${state.changes.size===1?'':'s'}`:'No changes yet';list.innerHTML='';for(const [path,ch] of state.changes){const el=document.createElement('div');el.className='change-item';el.innerHTML=`<div class="change-path">${icons.file}<span>${escapeHtml(shortPath(path))}</span></div><div class="change-stats"><span class="plus">+${ch.additions||0}</span> <span class="minus">−${ch.deletions||0}</span></div>`;list.append(el)}if(!state.changes.size)list.innerHTML='<div class="panel-empty">Changes made by Codex will appear here.</div>';syncReviewControls(null)}
async function applyActiveReviewPatch(){const review=state.activeReview;clientLog('review patch click: hasTurn='+Boolean(review?.turnId)+' thread='+String(state.active?.id||'-')+' disabled='+String($('#reviewPatch')?.disabled)+' action='+reviewPatchState);if(!review?.turnId||!state.active?.id)return;const action=reviewPatchState,button=$('#reviewPatch');button.disabled=true;button.innerHTML=codexIcon('loaderCircle','review-loading');try{const response=await fetch('/api/review/patch',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({threadId:state.active.id,turnId:review.turnId,action})}),result=await response.json();if(!response.ok)throw new Error(result.error||'Review patch failed');reviewPatchState=action==='undo'?'reapply':'undo';toast(action==='undo'?'Changes reverted':'Changes reapplied')}catch(error){toast(error.message)}finally{syncReviewControls(review)}}
function applyTerminalInteraction(p){const itemId=String(p.itemId),current=state.activityItems.get(p.turnId)?.get(itemId);if(current?.type!=='commandExecution')return;let buffer=current.terminalInputBuffer||'',commands=[];for(const char of String(p.stdin||'')){if(char==='\r'||char==='\n'){const command=buffer.trim();if(command)commands.push(command);buffer='';continue}if(char==='\u0003'){buffer='';continue}if(char==='\b'||char==='\u007f'){buffer=buffer.slice(0,-1);continue}buffer+=char}const actions=[...(current.commandActions||[]),...commands.map(command=>({type:'unknown',command}))];upsertItem({...current,status:'inProgress',terminalInputBuffer:buffer,commandActions:actions},p.turnId)}

function onNotification(method,p){if(method==='serverRequest/resolved'){resolveRequestCard(p?.requestId,'server');return}if(method==='notification/native'){const title=String(p?.title||'Codex'),body=String(p?.body||''),tag=String(p?.tag||'codex-status'),link=String(p?.threadId||'');clientLog('native notification: '+title+' — '+body.slice(0,60));if(!nativeNotify(title,body,tag,link)){if((notificationSupported())&&Notification.permission==='granted')try{new Notification(title,{body,tag})}catch(error){}}return}
  if(method==='account/updated')loadAccount(true);
  else if(method==='thread/started'){state.threads.unshift(p.thread);renderThreads()}
  else if(method==='thread/name/updated'){const t=state.threads.find(x=>x.id===p.threadId);if(t)t.name=p.name;renderThreads();renderHeader()}
  else if(method==='turn/started'){if(!p.threadId||p.threadId===state.active?.id)setActiveTurnId(p.turn?.id||'');scheduleActiveThreadSync(0)}
  else if(method==='item/started')upsertItem({...p.item,status:'inProgress'},p.turnId);
  else if(method==='item/completed'){const status=['failed','declined','interrupted','cancelled','canceled'].includes(p.item?.status)?p.item.status:'completed';upsertItem({...p.item,status},p.turnId)}
  else if(method==='item/agentMessage/delta'){let el=state.items.get(p.itemId);if(!el){upsertItem({id:p.itemId,type:'agentMessage',text:''},p.turnId);el=state.items.get(p.itemId)}const body=el.querySelector('.message-text');body.dataset.raw=(body.dataset.raw||'')+p.delta;body.innerHTML=renderAssistantMarkdown(body.dataset.raw,{cwd:imageCwd()});scrollBottom()}
  else if(method==='item/reasoning/summaryPartAdded')upsertReasoningDelta(p,null);
  else if(method==='item/reasoning/summaryTextDelta')upsertReasoningDelta(p,'summary');
  else if(method==='item/reasoning/textDelta')upsertReasoningDelta(p,'content');
  else if(method==='item/commandExecution/outputDelta'){const turn=state.turns.get(p.turnId),row=turn?.querySelector(`[data-item-id="${CSS.escape(p.itemId)}"]`),item=state.activityItems.get(p.turnId)?.get(String(p.itemId));if(item)item.aggregatedOutput=(item.aggregatedOutput||'')+(p.delta||'');if(row){const target=row.nextElementSibling.querySelector('.command-shell-output pre')||row.nextElementSibling;target.textContent=(target.classList.contains('empty')?'':target.textContent||'')+(p.delta||'');target.classList.remove('empty')}}
  else if(method==='item/commandExecution/terminalInteraction')applyTerminalInteraction(p)
  else if(method==='item/fileChange/outputDelta'){const itemId=String(p.itemId),current=state.activityItems.get(p.turnId)?.get(itemId),item=current?.type==='fileChange'?{...current,status:'inProgress'}:{id:itemId,type:'fileChange',status:'inProgress',changes:[]};item.aggregatedOutput=(item.aggregatedOutput||'')+(p.delta||'');upsertItem(item,p.turnId)}
  else if(method==='item/fileChange/patchUpdated'){const itemId=String(p.itemId),current=state.activityItems.get(p.turnId)?.get(itemId),item=current?.type==='fileChange'?{...current,status:'inProgress',changes:p.changes||[]}:{id:itemId,type:'fileChange',status:'inProgress',changes:p.changes||[]};upsertItem(item,p.turnId)}
  else if(method==='turn/diff/updated'){if(p.threadId&&state.active?.id&&p.threadId!==state.active.id)return;recordTurnReview(p.turnId,p.diff||'','native')}
  else if(method==='turn/completed'){if((!p.threadId||p.threadId===state.active?.id)&&(!p.turn?.id||activeTurnId()===p.turn.id))setActiveTurnId('');if(p.turn?.items)for(const i of p.turn.items)upsertItem(i,p.turn.id);if(p.turn?.id)syncWorkedForDivider(p.turn.id,turnDurationMs(p.turn));maybeNotifyTaskCompleted(p);scheduleActiveThreadSync(0);refreshThreadsSoon()}
  else if(method==='thread/tokenUsage/updated'){const threadId=p.threadId||state.active?.id;if(threadId&&p.tokenUsage)state.tokenUsage.set(threadId,p.tokenUsage);if(threadId===state.active?.id)renderContextUsage()}
  else if(method==='thread/status/changed'){if(p.threadId===state.active?.id){state.active.status=p.status;scheduleActiveThreadSync(0)}refreshThreadsSoon()}
  else if(method==='error')toast(p.error?.message||p.message||'Codex error');
}
function upsertReasoningDelta(p,field){const itemId=String(p.itemId),items=state.activityItems.get(p.turnId),current=items?.get(itemId),item=current?.type==='reasoning'?{...current,status:'inProgress'}:{id:itemId,type:'reasoning',status:'inProgress',summary:[],content:[]};if(field){const index=field==='summary'?(p.summaryIndex??0):(p.contentIndex??0),parts=Array.isArray(item[field])?[...item[field]]:[];while(parts.length<=index)parts.push('');parts[index]=(parts[index]||'')+(p.delta||'');item[field]=parts}upsertItem(item,p.turnId);scrollBottom()}
function setApprovalWaiting(group,itemId,waiting){if(!group)return;const row=itemId?group.querySelector(`[data-item-id="${CSS.escape(itemId)}"]`):null,summary=group.querySelector('.activity-summary-copy');group.classList.toggle('waiting-approval',waiting);if(waiting){summary.textContent='Waiting for approval';summary.classList.remove('loading-shimmer');if(row){row.querySelector('.activity-name')?.classList.remove('loading-shimmer');state.motion.get(row)?.pause()}}else{if(row){row.querySelector('.activity-name')?.classList.add('loading-shimmer');state.motion.get(row)?.play()}updateActivitySummary(group)}}
function approvalIcon(kind){return kind==='network'?codexIcon('globe'):kind==='patch'?codexIcon('fileDiff'):kind==='permission'?codexIcon('shield'):codexIcon('terminal')}
function approvalBody(model,p){if(model.kind==='exec'||model.kind==='network')return `<div class="approval-command"><code>${escapeHtml(p.command||model.title)}</code></div>`;if(model.kind==='patch'){if(model.legacyFiles){return model.legacyFiles.map(path=>'<div class="approval-command"><code>'+escapeHtml(shortPath(path))+'</code></div>').join('')}const review=diffForTurn(p.turnId);return review?.hasChanges?`<button type="button" class="approval-review-link">${codexIcon('fileDiff')}<span>Review ${review.fileCount} changed file${review.fileCount===1?'':'s'}</span><span class="plus">+${review.linesAdded}</span><span class="minus">−${review.linesDeleted}</span></button>`:''}return permissionRows(p.permissions).map(row=>`<div class="permission-row"><span>${escapeHtml(row.label)}</span><code>${escapeHtml(shortPath(row.value))}</code></div>`).join('')}
async function onServerRequest(req){const p=req.params||{};if(state.requestCards.has(req.id)){clientLog('approval: duplicate request '+req.id+' ignored');return}if(req.method==='item/tool/requestUserInput'){renderUserInputRequest(req);return}if(req.method==='mcpServer/elicitation/request'){renderElicitationRequest(req);return}const legacyApproval=req.method==='execCommandApproval'||req.method==='applyPatchApproval';if(legacyApproval){clientLog('approval: legacy '+req.method+' -> same card, decision enum approved|approved_for_session|denied|abort')}if(!legacyApproval&&!['item/commandExecution/requestApproval','item/fileChange/requestApproval','item/permissions/requestApproval'].includes(req.method)){void respondToCodex(req.id,null,{code:-32601,message:'Unsupported request'}).catch(error=>{if(!error?.silentTransportSwitch)toast(error.message)});return}const group=ensureActivity(p.turnId||'approval',$('#conversation'),p.itemId),model=legacyApproval?buildLegacyApprovalModel(req.method,p):buildApprovalModel(req),card=document.createElement('section');card.className='approval-card';card.dataset.codexApprovalSurface='';card.innerHTML=`<div class="approval-content"><div class="approval-identity">${approvalIcon(model.kind)}<span>${escapeHtml(t(model.identity))}</span></div><div class="approval-title">${escapeHtml(t(model.title))}</div>${model.subtitle?`<div class="approval-subtitle">${escapeHtml(shortPath(model.subtitle))}</div>`:''}${model.reason?`<div class="approval-reason"><span>${escapeHtml(t('Reason'))}</span><p>${escapeHtml(model.reason)}</p></div>`:''}</div><div class="approval-body">${approvalBody(model,p)}</div><form class="approval-actions">${model.leading?`<button type="button" class="approval-leading">${escapeHtml(t(model.leading.label))}</button>`:''}<div class="approval-actions-main">${model.deny?`<button type="button" class="approval-deny">${escapeHtml(t(model.deny.label))}</button>`:''}${model.cancel?`<button type="button" class="approval-cancel">${escapeHtml(t(model.cancel.label))}</button>`:''}${model.scoped?`<div class="approval-split">${model.primary?`<button type="submit" class="approval-primary" autofocus>${escapeHtml(t(model.primary.label))}</button>`:''}<button type="button" class="approval-menu-toggle" aria-label="Approval options" aria-expanded="false">${codexIcon('chevronDown')}</button><div class="approval-menu" hidden><button type="button" class="approval-scoped">${escapeHtml(t(model.scoped.label))}</button></div></div>`:model.primary?`<button type="submit" class="approval-primary" autofocus>${escapeHtml(t(model.primary.label))}</button>`:''}</div></form>`;group.after(card);card.dataset.requestId=String(req.id);state.requestCards.set(req.id,card);setApprovalWaiting(group,p.itemId,true);const answer=(decision)=>{setApprovalWaiting(group,p.itemId,decision!=='decline'&&decision!=='cancel');card.querySelectorAll('button').forEach(b=>b.disabled=true);respondToCodex(req.id,model.kind==='permission'?decision:{decision}).catch(error=>{if(!error?.silentTransportSwitch)toast(error.message)});card.remove();state.requestCards.delete(req.id)};card.querySelector('form').onsubmit=e=>{e.preventDefault();if(model.primary)answer(model.primary.decision)};card.querySelector('.approval-deny')?.addEventListener('click',()=>answer(model.deny.decision));card.querySelector('.approval-cancel')?.addEventListener('click',()=>answer(model.cancel.decision));card.querySelector('.approval-scoped')?.addEventListener('click',()=>answer(model.scoped.decision));card.querySelector('.approval-leading')?.addEventListener('click',()=>answer(model.leading.decision));card.querySelector('.approval-review-link')?.addEventListener('click',()=>openReviewPanel(diffForTurn(p.turnId)));const menuToggle=card.querySelector('.approval-menu-toggle'),menu=card.querySelector('.approval-menu');menuToggle?.addEventListener('click',()=>{const open=menu.hidden;menu.hidden=!open;menuToggle.setAttribute('aria-expanded',String(open))});scrollBottom()}
const slashCommandCatalog=[
  {id:'model',title:'Model',description:'Choose model and reasoning effort',icon:'wrench'},
  {id:'plan',title:'Plan mode',description:'Turn plan mode on',icon:'list'},
  {id:'project',title:'Project',description:'Choose project for new tasks',icon:'folderOpen'},
  {id:'reasoning',title:'Reasoning',description:'Choose reasoning effort',icon:'wrench'},
  {id:'init',title:'Init',description:'Create an AGENTS.md file with instructions for Codex',icon:'file'},
  {id:'mcp',title:'MCP',description:'Show MCP server status',icon:'wrench'},
  {id:'compact',title:'Compact',description:"Compact this task's context",icon:'list',requiresThread:true},
  {id:'status',title:'Status',description:'Show task id, context usage, and rate limits',icon:'info',requiresThread:true},
];
function closeComposerAutocomplete(){const menu=$('#composerAutocomplete');autocompleteState.requestId++;menu.hidden=true;menu.replaceChildren();delete menu.dataset.type;autocompleteState.match=null;autocompleteState.items=[];autocompleteState.selected=0;autocompleteState.message=''}
function renderComposerAutocomplete(){const menu=$('#composerAutocomplete'),items=autocompleteState.items;menu.innerHTML='';menu.dataset.type=autocompleteState.match?.type||'';menu.setAttribute('aria-label',autocompleteState.match?.type==='slash'?'Slash command menu':'Mention menu');if(!items.length){const empty=document.createElement('div');empty.className='autocomplete-empty';empty.textContent=autocompleteState.message||(autocompleteState.match?.type==='mention'?'Type to search for files':'No commands');menu.append(empty)}else for(const[index,item]of items.entries()){const button=document.createElement('button');button.type='button';button.className='autocomplete-item'+(index===autocompleteState.selected?' selected':'');button.dataset.autocompleteId=item.id;button.role='option';button.setAttribute('aria-selected',String(index===autocompleteState.selected));button.innerHTML=`${codexIcon(item.icon||'file')}<span class="autocomplete-copy"><strong class="autocomplete-title">${escapeHtml(item.title)}</strong><small class="autocomplete-description">${escapeHtml(item.description)}</small></span>`;button.onpointerdown=event=>event.preventDefault();button.onclick=()=>selectComposerAutocomplete(index);menu.append(button)}menu.hidden=false}
function currentComposerCwd(){if(state.projectless&&!state.active)return'';const path=state.active?.cwd||$('#projectPath').textContent||state.config.defaultCwd;return path.startsWith('~')?state.config.home+path.slice(1):path}
async function searchMentionSuggestions(match){const query=match.query.trim(),requestId=++autocompleteState.requestId;if(!query){autocompleteState.items=[];autocompleteState.message=state.projectless&&!state.active?'Choose a project to mention files':'Type to search for files';renderComposerAutocomplete();return}const tasks=state.threads.filter(thread=>titleOf(thread).toLowerCase().includes(query.toLowerCase())).slice(0,5).map(thread=>({id:`task:${thread.id}`,source:'task',threadId:thread.id,title:titleOf(thread),description:`Task · ${shortPath(thread.cwd)}`,icon:'messageSquare'})),cwd=currentComposerCwd();if(!cwd){autocompleteState.items=[{id:'choose-project',source:'action',title:'Choose project',description:'Select a project to mention files',icon:'folderOpen'},...tasks];autocompleteState.selected=0;autocompleteState.message='';renderComposerAutocomplete();return}autocompleteState.items=[];autocompleteState.message='Searching files…';renderComposerAutocomplete();try{const response=await fetch(`/api/files/search?cwd=${encodeURIComponent(cwd)}&query=${encodeURIComponent(query)}`,{cache:'no-store'}),data=await response.json();if(!response.ok)throw new Error(data.error||'File search unavailable');if(requestId!==autocompleteState.requestId||autocompleteState.match?.type!=='mention'||autocompleteState.match.query!==match.query)return;const files=(data.items||[]).map(item=>{const parts=item.path.split('/');return{id:`${item.kind}:${item.path}`,source:item.kind,path:item.path,title:parts.at(-1),description:parts.length>1?parts.slice(0,-1).join('/'):(item.kind==='folder'?'Folder':'File'),icon:item.kind==='folder'?'folderOpen':'file'}});autocompleteState.items=[...files,...tasks];autocompleteState.selected=0;autocompleteState.message=autocompleteState.items.length?'':'No files or tasks found';renderComposerAutocomplete()}catch(error){if(requestId!==autocompleteState.requestId)return;autocompleteState.items=tasks;autocompleteState.message=tasks.length?'':error.message;renderComposerAutocomplete()}}
function updateComposerAutocomplete(){const input=$('#prompt'),match=getComposerAutocomplete(input.value,input.selectionStart??input.value.length);if(!match){closeComposerAutocomplete();return}autocompleteState.match=match;autocompleteState.selected=0;if(match.type==='slash'){autocompleteState.requestId++;const query=match.query.trim().toLowerCase();autocompleteState.items=slashCommandCatalog.filter(item=>(!item.requiresThread||state.active)&&(item.id.includes(query)||item.title.toLowerCase().includes(query)));autocompleteState.message='';renderComposerAutocomplete();return}searchMentionSuggestions(match)}
function moveComposerAutocomplete(delta){if(!autocompleteState.items.length)return;autocompleteState.selected=(autocompleteState.selected+delta+autocompleteState.items.length)%autocompleteState.items.length;renderComposerAutocomplete()}
function setPlanMode(active){state.planMode=Boolean(active);refreshComposerPlaceholder();syncPermissionControl()}
function applyAutocompleteToken(match,replacement){const input=$('#prompt'),result=applyComposerSuggestion(input.value,match,replacement);input.value=result.text;input.setSelectionRange(result.cursor,result.cursor);resizePrompt()}
function renderContextTray(){const tray=$('#composerContextTray');tray.innerHTML='';for(const mention of state.composerMentions){const chip=document.createElement('div');chip.className='composer-context-chip';chip.dataset.contextId=mention.id;chip.innerHTML=`${codexIcon(mention.icon||'file')}<span>${escapeHtml(mention.title)}</span><button type="button" aria-label="Remove ${escapeHtml(mention.title)}">${codexIcon('x')}</button>`;chip.querySelector('button').onclick=()=>{state.composerMentions=state.composerMentions.filter(item=>item.id!==mention.id);renderContextTray()};tray.append(chip)}for(const attachment of state.composerAttachments){const chip=document.createElement('div');chip.className='composer-context-chip'+(attachment.pending?' pending':'');chip.dataset.attachmentId=attachment.id;const phase=attachment.pending?(attachment.phase||t('(uploading…)')):'';const fill=Math.round(Math.max(0,Math.min(1,Number(attachment.progress)||0))*100);chip.innerHTML=(attachment.pending?'<span class="composer-context-fill" style="width:'+fill+'%" aria-hidden="true"></span>':'')+codexIcon(attachment.kind==='image'?'image':'file')+'<span class="composer-context-label">'+escapeHtml(attachment.name)+'</span>'+(phase?'<span class="composer-context-phase">'+escapeHtml(phase)+'</span>':'')+'<button type="button" aria-label="Remove '+escapeHtml(attachment.name)+'">'+codexIcon('x')+'</button>';chip.querySelector('button').onclick=()=>{state.composerAttachments=state.composerAttachments.filter(item=>item.id!==attachment.id);renderContextTray()};tray.append(chip)}tray.hidden=!state.composerMentions.length&&!state.composerAttachments.length}
function selectComposerAutocomplete(index=autocompleteState.selected){const item=autocompleteState.items[index],match=autocompleteState.match;if(!item||!match)return;const id=item.id;if(item.source==='action'&&id==='choose-project'){closeComposerAutocomplete();openFolderPicker()}else if(item.source==='file'||item.source==='folder'){applyAutocompleteToken(match,`@${item.path}`);if(!state.composerMentions.some(mention=>mention.id===item.id))state.composerMentions.push({...item});renderContextTray();closeComposerAutocomplete()}else if(item.source==='task'){applyAutocompleteToken(match,`@${item.title}`);if(!state.composerMentions.some(mention=>mention.id===item.id))state.composerMentions.push({...item});renderContextTray();closeComposerAutocomplete()}else{if(id==='init')applyAutocompleteToken(match,'/init');closeComposerAutocomplete();if(id==='plan'){setPlanMode(!state.planMode);$('#prompt').value='';resizePrompt()}else if(id==='model'){ $('#prompt').value='';resizePrompt();openModelMenu()}else if(id==='reasoning'){ $('#prompt').value='';resizePrompt();openModelMenu()}else if(id==='project'){ $('#prompt').value='';resizePrompt();openFolderPicker()}else if(id==='mcp'){ $('#prompt').value='';resizePrompt();toast('MCP status requires the native desktop status surface.')}else if(id==='compact'){ $('#prompt').value='';resizePrompt();toast('Compact requires the native desktop command bridge.')}else if(id==='status'){ $('#prompt').value='';resizePrompt();toast(state.active?.id?`Task ${state.active.id}`:'No active task')}}requestAnimationFrame(()=>$('#prompt').focus())}
function handlePromptInput(){resizePrompt();updateComposerAutocomplete()}
function handlePromptKeydown(event){const open=!$('#composerAutocomplete').hidden;if(open){if(event.key==='ArrowDown'||event.key==='ArrowUp'){event.preventDefault();moveComposerAutocomplete(event.key==='ArrowDown'?1:-1);return}if((event.key==='Enter'&&!event.shiftKey)||event.key==='Tab'){event.preventDefault();selectComposerAutocomplete();return}if(event.key==='Escape'){event.preventDefault();closeComposerAutocomplete();return}}if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();$('#composer').requestSubmit()}}
async function resumeActiveThread(){if(!state.active)return null;const modelOverride=state.active.model?{}:{model:state.selectedModel||undefined};let resumed;try{resumed=await rpc('thread/resume',{threadId:state.active.id,...modelOverride})}catch(error){clientLog('thread/resume FAILED for '+state.active.id+': '+((error&&error.message)||error));throw error}state.active={...state.active,...resumed.thread};renderHeader();return resumed}
const submitGate=createSubmitGate();
async function submitPrompt(event){
  clientLog('submit: entered');
  if(submitGate.busy){clientLog('submit: SKIPPED — a previous submission is still in flight (gate busy)');toast(t('Still sending the previous message. Try again in a moment.'),4000);return}
  const submitStartedAt=Date.now();
  beginBridgeWait('submit');
  try{
    const outcome=await submitGate.run(()=>submitPromptInner(event));
    clientLog('submit: finished in '+(Date.now()-submitStartedAt)+'ms (gate released)');
    return outcome;
  }catch(error){
    // Any exception that escapes the inner function used to vanish silently:
    // the input was already cleared, no RPC was sent, and no toast appeared.
    // Report message + the first stack frame so the cause is visible from here.
    const frame=String((error&&error.stack)||'').split('\n')[1]||'';
    clientLog('submit CRASHED: '+String((error&&error.message)||error)+' @ '+frame.trim());
    throw error;
  }finally{endBridgeWait()}
}
async function submitPromptInner(event){event.preventDefault();closeComposerAutocomplete();closePermissionMenu();const input=$('#prompt'),text=input.value.trim(),turnId=activeTurnId();if(turnId&&!text){if(state.active)await rpc('turn/interrupt',{threadId:state.active.id,turnId});return}if(!state.selectedModel){toast(t('This provider returned no models. Check the Codex model catalog configuration.'),6000);syncModelLabel();return}const pendingAtSend=state.composerAttachments.filter(item=>item.pending);if(pendingAtSend.length){clientLog('submit: waiting for '+pendingAtSend.length+' upload(s) to finish');toast(t('Waiting for the upload to finish…'),3500);const uploadDeadline=Date.now()+60000;while(state.composerAttachments.some(item=>item.pending)&&Date.now()<uploadDeadline)await new Promise(resolve=>setTimeout(resolve,400));clientLog('submit: upload wait finished ('+(state.composerAttachments.some(item=>item.pending)?'still pending, sending without it':'all ready')+')')}const readyAttachments=state.composerAttachments.filter(item=>!item.pending),pendingUploads=state.composerAttachments.length-readyAttachments.length,hasContext=readyAttachments.length>0||state.composerMentions.length>0;if(!text&&!hasContext){if(pendingUploads){clientLog('submit: ignored — text empty, '+pendingUploads+' upload(s) still pending after the wait');toast(t('Still uploading — wait a moment.'),4000)}return}const mentions=state.composerMentions,attachments=state.composerAttachments;input.value='';state.composerMentions=[];state.composerAttachments=[];renderContextTray();resizePrompt();const restoreInput=()=>{input.value=text;state.composerMentions=mentions;state.composerAttachments=attachments;renderContextTray();resizePrompt()};if(turnId){let resumed=false;try{if(state.active?.canAcceptDirectInput!==true){await resumeActiveThread();resumed=true}if(state.active)await rpc('turn/steer',{threadId:state.active.id,expectedTurnId:turnId,input:[...textPart(text),...attachmentInputs(attachmentsForSend(attachments))]})}catch(error){let failure=error;if(!resumed&&bridgeErrorCode(error)===THREAD_NOT_FOUND&&state.active){try{await resumeActiveThread();await rpc('turn/steer',{threadId:state.active.id,expectedTurnId:turnId,input:[...textPart(text),...attachmentInputs(attachmentsForSend(attachments))]});return}catch(resumeError){failure=resumeError}}if(isNoActiveTurnError(failure)){setActiveTurnId('');restoreInput();submitPromptInner({preventDefault(){}});return}restoreInput();if(!failure?.silentTransportSwitch)toast(t(threadInputErrorMessage(failure)),5200)}return}let optimisticId=null;try{const optimistic={id:'local-'+Date.now(),type:'userMessage',content:[...textPart(text),...attachmentContent(attachmentsForSend(attachments))]};optimisticId=optimistic.id;if(!state.active){const startingProjectless=state.projectless,cwd=$('#projectPath').textContent.replace(/^~/,state.config.home);upsertItem(optimistic,'optimistic');const res=await rpc('thread/start',{cwd,model:state.selectedModel,...permissionThreadPolicy(),sessionStartSource:'startup',...collaborationModeParam()});state.active={...res.thread,projectless:startingProjectless};rememberActiveThread(state.active.id);state.threads.unshift(state.active);renderContextUsage();renderHeader();renderThreads();$('#conversation').querySelectorAll('#emptyState,.list-state').forEach(node=>node.remove());if(!state.items.get(optimisticId)?.isConnected){state.items.delete(optimisticId);upsertItem(optimistic,'optimistic')}}else{if(state.active.canAcceptDirectInput!==true)await resumeActiveThread();upsertItem(optimistic,'optimistic')}await rpc('turn/start',{threadId:state.active.id,input:[...textPart(text),...attachmentInputs(attachmentsForSend(attachments))],model:state.selectedModel,effort:$('#effortSelect').value,cwd:state.active.cwd,...permissionTurnPolicy(state.active.cwd),...collaborationModeParam()});}catch(error){if(optimisticId){state.items.get(optimisticId)?.remove();state.items.delete(optimisticId)}restoreInput();if(!error?.silentTransportSwitch)toast(t(threadInputErrorMessage(error)),5200)}}
function threadSummarySignature(threads){return JSON.stringify(threads.map(thread=>[thread.id,thread.updatedAt,thread.recencyAt,thread.status]))}
function applyThreadSummaries(threads){const nextSignature=threadSummarySignature(threads),changed=nextSignature!==threadListSignature;threadListSignature=nextSignature;state.threads=threads;const summary=state.active&&threads.find(thread=>thread.id===state.active.id);if(summary){const turns=state.active.turns;state.active={...state.active,...summary,turns};if(summary.status?.type==='active')scheduleActiveThreadSync(0)}if(changed)renderThreads()}
function scheduleThreadListRefresh(delay=THREAD_LIST_POLL_MS){clearTimeout(threadListTimer);threadListTimer=setTimeout(refreshThreadList,document.visibilityState==='hidden'?Math.max(delay,8000):delay)}
async function refreshThreadList(){if(threadListInFlight){scheduleThreadListRefresh(1000);return}threadListInFlight=true;try{const showArchived=state.archivedView===true;const result=await rpc('thread/list',{limit:50,sortKey:'recency_at',sortDirection:'desc',archived:showArchived});const list=(result.data||[]).map(thread=>showArchived?{...thread,archived:true}:thread);applyThreadSummaries(list)}catch{}finally{threadListInFlight=false;scheduleThreadListRefresh()}}
function refreshThreadsSoon(){scheduleThreadListRefresh(600)}
function resetActiveThreadSync(){activeThreadSyncGeneration++;clearTimeout(activeThreadSyncTimer);activeThreadSyncTimer=null;activeThreadSyncSignature=''}
function scheduleActiveThreadSync(delay=ACTIVE_THREAD_SYNC_IDLE_MS){clearTimeout(activeThreadSyncTimer);if(!state.active)return;activeThreadSyncTimer=setTimeout(syncActiveThread,document.visibilityState==='hidden'?Math.max(delay,6000):delay)}
async function latestThreadTurn(threadId){try{const live=await rpc('host/thread/live',{threadId});if(live?.active&&live.turn)return live.turn}catch{}try{const result=await rpc('thread/turns/list',{threadId,limit:1,sortDirection:'desc',itemsView:'full'});return result.data?.[0]||null}catch{const result=await rpc('thread/read',{threadId,includeTurns:true});return result.thread?.turns?.at(-1)||null}}
function activeTurnId(){return $('#sendButton')?.dataset.turnId||''}
function syncComposerSubmitState(){const button=$('#sendButton');if(!button)return;const mode=activeTurnId()?($('#prompt').value.trim()?'steer':'stop'):'send',label=mode==='stop'?'Stop':mode==='steer'?'Steer':'Send message';button.dataset.submitMode=mode;button.classList.toggle('stop',mode==='stop');button.classList.toggle('steer',mode==='steer');button.innerHTML=codexIcon(mode==='stop'?'square':'arrowUp');const queueButton=$('#queueButton');if(queueButton)queueButton.hidden=mode!=='steer';button.title=t(label);button.setAttribute('aria-label',t(label))}
function setActiveTurnId(turnId=''){const button=$('#sendButton');if(!button)return;button.dataset.turnId=turnId||'';syncComposerSubmitState()}
function syncTurnRuntime(turn){const active=turn?.status==='inProgress';if(active)setActiveTurnId(turn.id);else if(activeTurnId()===turn?.id)setActiveTurnId('')}
function syncTurnSnapshot(turn,threadId=state.active?.id){if(!turn||!threadId||threadId!==state.active?.id)return false;const root=$('#conversation'),nearBottom=root.scrollHeight-root.scrollTop-root.clientHeight<80,turns=state.active.turns||[],index=turns.findIndex(existing=>existing.id===turn.id);if(index<0)turns.push(turn);else turns[index]=turn;state.active.turns=turns;root.querySelectorAll('.conversation-loading').forEach(node=>node.remove());renderTurn(turn,root);syncTurnRuntime(turn);if(nearBottom)scrollBottom();return true}
async function syncActiveThread(){if(activeThreadSyncInFlight||!state.active){scheduleActiveThreadSync();return}const generation=activeThreadSyncGeneration,threadId=state.active.id;activeThreadSyncInFlight=true;let nextDelay=ACTIVE_THREAD_SYNC_IDLE_MS;try{const turn=await latestThreadTurn(threadId);if(generation!==activeThreadSyncGeneration||threadId!==state.active?.id)return;if(turn){const signature=JSON.stringify(turn);nextDelay=turn.status==='inProgress'?ACTIVE_THREAD_SYNC_ACTIVE_MS:ACTIVE_THREAD_SYNC_IDLE_MS;if(signature!==activeThreadSyncSignature){activeThreadSyncSignature=signature;syncTurnSnapshot(turn,threadId)}}}catch{}finally{activeThreadSyncInFlight=false;if(generation===activeThreadSyncGeneration&&threadId===state.active?.id)scheduleActiveThreadSync(nextDelay)}}
function resizePrompt(){const e=$('#prompt');e.style.height='auto';e.style.height=Math.min(190,e.scrollHeight)+'px';syncComposerSubmitState()}
function scrollBottom(){requestAnimationFrame(()=>{$('#conversation').scrollTop=$('#conversation').scrollHeight})}
function scrollOpenedThreadToBottom(){const root=$('#conversation'),apply=()=>{root.scrollTop=root.scrollHeight};requestAnimationFrame(()=>{apply();requestAnimationFrame(apply)})}
function formatAge(ts){const s=Math.max(0,Date.now()/1000-ts);if(s<60)return'now';if(s<3600)return Math.floor(s/60)+'m';if(s<86400)return Math.floor(s/3600)+'h';return new Date(ts*1000).toLocaleDateString(undefined,{month:'short',day:'numeric'})}
function escapeHtml(v=''){return String(v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
function toast(text,duration=2200){const e=$('#toast');e.textContent=text;e.classList.add('show');clearTimeout(toast.t);toast.t=setTimeout(()=>e.classList.remove('show'),duration)}
function syncSummaryPanel(){const workspace=state.projectless?'No project':($('#projectName').textContent||'Local workspace');$('#summaryWorkspace').textContent=workspace;$('#summaryBranch').textContent=state.projectless?'':state.active?.source==='remote'?'Remote workspace':'Local workspace'}
function overlayPanelsEnabled(){return matchMedia('(max-width:1200px)').matches}
function setOverlayBackgroundInert(inert){for(const selector of ['.topbar','.sidebar','.conversation-shell','.bottom-panel']){const node=$(selector);if(node)node.inert=inert}}
function focusPanel(panel,closeButton){if(!overlayPanelsEnabled())return;setOverlayBackgroundInert(true);panel.setAttribute('aria-modal','true');requestAnimationFrame(()=>closeButton.focus())}
function restorePanelFocus(panel,target){panel.setAttribute('aria-modal','false');if(!document.body.classList.contains('side-panel-open')&&!document.body.classList.contains('summary-panel-open'))setOverlayBackgroundInert(false);if(overlayPanelsEnabled()&&target?.isConnected)requestAnimationFrame(()=>target.focus())}
function syncOverlayPanelMode(){const overlay=overlayPanelsEnabled(),sideOpen=document.body.classList.contains('side-panel-open'),summaryOpen=document.body.classList.contains('summary-panel-open');setOverlayBackgroundInert(overlay&&(sideOpen||summaryOpen));$('#sidePanel').setAttribute('aria-modal',String(overlay&&sideOpen));$('#summaryPanel').setAttribute('aria-modal',String(overlay&&summaryOpen));if(overlay){const panel=summaryOpen?$('#summaryPanel'):sideOpen?$('#sidePanel'):null,close=summaryOpen?$('#closeSummaryPanel'):sideOpen?$('#closeSidePanel'):null;if(panel&&close&&!panel.contains(document.activeElement))requestAnimationFrame(()=>close.focus())}renderChanges()}
function setSidebarOpen(open){const sidebar=$('#sidebar'),mobile=mobileSidebarEnabled(),wasOpen=mobile&&sidebar.classList.contains('mobile-open');document.body.classList.toggle('sidebar-hidden',!mobile&&!open);sidebar.classList.toggle('mobile-open',mobile&&open);const isOpen=mobile&&sidebar.classList.contains('mobile-open');if(isOpen&&!wasOpen)overlayBack.opened();else if(!isOpen&&wasOpen)overlayBack.closed();const visible=mobile?sidebar.classList.contains('mobile-open'):!document.body.classList.contains('sidebar-hidden');$('#toggleSidebar').setAttribute('aria-expanded',String(visible));$('#toggleSidebar').setAttribute('aria-pressed',String(visible))}
function syncSidebarLayout(){const mobile=mobileSidebarEnabled();if(mobile===sidebarLayoutMobile)return;sidebarLayoutMobile=mobile;setSidebarOpen(!mobile)}
function setBrowserStatus(text,tone='ready'){const status=$('#browserStatus');status.dataset.tone=tone;$('#browserStatusText').textContent=text}
function updateBrowserControls(){const current=browserState.history[browserState.index]||'';$('#browserBack').disabled=browserState.index<=0;$('#browserForward').disabled=browserState.index<0||browserState.index>=browserState.history.length-1;$('#browserRefresh').disabled=!current;for(const link of [$('#browserOpenExternal'),$('#browserNoticeExternal')]){link.hidden=!current;if(current)link.href=current}}
function showBrowserNotice(title,description){$('#browserNoticeTitle').textContent=title;$('#browserNoticeDescription').textContent=description;$('#browserNotice').hidden=false;$('#browserLoading').hidden=true;$('#browserFrameShell').setAttribute('aria-busy','false');setBrowserStatus(title,'error')}
function finishBrowserLoad(requestId){if(requestId!==browserState.loadRequest)return;clearTimeout(browserState.loadTimer);$('#browserLoading').hidden=true;$('#browserNotice').hidden=true;$('#browserFrameShell').setAttribute('aria-busy','false');setBrowserStatus('Loaded. If the page is blank, the site may block embedding.','loaded')}
function navigateBrowser(value,{push=true}={}){const result=normalizeBrowserUrl(value);if(result.error){showBrowserNotice('Invalid address',result.error);$('#browserUrl').setAttribute('aria-invalid','true');return false}const url=result.url;$('#browserUrl').removeAttribute('aria-invalid');$('#browserUrl').value=url;if(push&&browserState.history[browserState.index]!==url){browserState.history=browserState.history.slice(0,browserState.index+1);browserState.history.push(url);browserState.index=browserState.history.length-1}const requestId=++browserState.loadRequest,frame=$('#browserFrame');clearTimeout(browserState.loadTimer);$('#browserEmpty').hidden=true;$('#browserNotice').hidden=true;$('#browserLoading').hidden=false;frame.hidden=false;frame.setAttribute('sandbox',browserSandboxFor(url,location.href));$('#browserFrameShell').setAttribute('aria-busy','true');setBrowserStatus('Loading page...','loading');updateBrowserControls();frame.onload=()=>finishBrowserLoad(requestId);frame.onerror=()=>requestId===browserState.loadRequest&&showBrowserNotice('Page could not be loaded','The site did not complete the embedded request. Open it externally to continue.');frame.src=url;browserState.loadTimer=setTimeout(()=>{if(requestId===browserState.loadRequest)showBrowserNotice('Page may have blocked embedding','This site did not finish loading in the panel. It may block embedded browsers; you can open it externally instead.')},10000);return true}
function moveBrowserHistory(delta){const next=browserState.index+delta;if(next<0||next>=browserState.history.length)return;browserState.index=next;navigateBrowser(browserState.history[next],{push:false});updateBrowserControls()}
function openBrowserPanel(){const tab=$('#utilityTab');tab.textContent='Browser';tab.dataset.sidePanelTab='browser';tab.hidden=false;setSidePanelOpen(true,false);setSidePanelView('browser','Browser');updateBrowserControls();if(browserState.index<0&&!overlayPanelsEnabled())requestAnimationFrame(()=>$('#browserUrl').focus())}
function sidePanelTabsSnapshot(){try{return [...document.querySelectorAll('.side-panel-tab,#newTab')].map(function(tab){return (tab.dataset.sidePanelTab||tab.id)+(tab.hidden?'(hidden)':'')+(tab.classList.contains('active')?'(active)':'')+'='+String(tab.textContent||'').trim()}).join(' | ')}catch(error){return 'unavailable'}}
function setSidePanelView(view,title){clientLog('side panel view='+view+' title='+(title||'')+' sections='+['sidePanelLauncher','reviewPanelContent','browserPanel','sideTerminalPanel','sideTaskPanel','utilityPanelContent','gitPanel'].map(function(id){const el=$('#'+id);return id+(el?(el.hidden?'(hidden)':'(shown)'):'(missing)')}).join(',')+' tabs='+sidePanelTabsSnapshot());const launcher=view==='launcher',review=view==='review',utility=view==='utility',browser=view==='browser',terminal=view==='terminal',sideTask=view==='side-task',git=view==='git',files=view==='files';const gitPanel=$('#gitPanel');if(gitPanel)gitPanel.hidden=!git;const filesPanel=$('#filesPanel');if(filesPanel)filesPanel.hidden=!files;$('#sidePanelLauncher').hidden=!launcher;$('#reviewPanelContent').hidden=!review;$('#browserPanel').hidden=!browser;$('#sideTerminalPanel').hidden=!terminal;$('#sideTaskPanel').hidden=!sideTask;$('#utilityPanelContent').hidden=!utility;for(const tab of document.querySelectorAll('.side-panel-tab')){const selected=tab.dataset.sidePanelTab===view;tab.classList.toggle('active',selected);tab.setAttribute('aria-selected',String(selected))}$('#newTab').hidden=false;if(review)$('#reviewTab').hidden=false;if(utility||browser||terminal||sideTask||git||files)$('#utilityTab').hidden=false;$('#sidePanelTitle').textContent=title||(launcher?'New tab':review?'Review':git?t('Git'):files?t('Files'):$('#utilityTab').textContent);renderChanges();if(terminal)requestAnimationFrame(()=>{initializeTerminal(terminalStates.side);fitTerminal(terminalStates.side);terminalStates.side.term?.focus()});if(sideTask)renderSideTasks();if(overlayPanelsEnabled()&&document.body.classList.contains('side-panel-open'))requestAnimationFrame(()=>$('#closeSidePanel').focus())}
function openReviewPanel(review=null){state.activeReview=review||[...state.turnDiffs.values()].at(-1)||state.activeReview;setSidePanelOpen(true,false);setSidePanelView('review','Review')}
function openUtilityPanel(kind){if(kind==='browser'){openBrowserPanel();return}if(kind==='git'){openGitPanel();return}if(kind==='files'){openFilesPanel();return}const tab=$('#utilityTab');if(kind==='terminal'){tab.textContent='Terminal';tab.dataset.sidePanelTab='terminal';setSidePanelOpen(true,false);setSidePanelView('terminal','Terminal');return}if(kind==='side-task'){tab.textContent='Side tasks';tab.dataset.sidePanelTab='side-task';setSidePanelOpen(true,false);setSidePanelView('side-task','Side tasks');return}const labels={files:['Files','folderOpen','Choose or switch the local project folder available to this WebUI.']},entry=labels[kind];if(!entry)return;const[title,icon,description]=entry;tab.textContent=title;tab.dataset.sidePanelTab='utility';$('#utilityPanelTitle').textContent=title;$('#utilityPanelDescription').textContent=description;$('#utilityPanelIcon').innerHTML=codexIcon(icon);const action=$('#utilityPanelAction');action.hidden=false;action.textContent='Choose project folder';action.onclick=openFolderPicker;setSidePanelOpen(true,false);setSidePanelView('utility',title)}
function setSidePanelOpen(open,reset=true){const panel=$('#sidePanel'),trigger=$('#toggleSidePanel'),wasOpen=!panel.hidden;if(open){setSummaryPanelOpen(false);if(!wasOpen){sidePanelReturnFocus=document.activeElement instanceof HTMLElement?document.activeElement:trigger;panel.hidden=false;document.body.classList.add('side-panel-open');trigger.setAttribute('aria-pressed','true');trigger.setAttribute('aria-expanded','true')}if(reset)setSidePanelView('launcher','New tab');if(!wasOpen)focusPanel(panel,$('#closeSidePanel'))}else{panel.hidden=true;document.body.classList.remove('side-panel-open','review-split-open');trigger.setAttribute('aria-pressed','false');trigger.setAttribute('aria-expanded','false');restorePanelFocus(panel,sidePanelReturnFocus);sidePanelReturnFocus=null}}
function setSummaryPanelOpen(open){const panel=$('#summaryPanel'),trigger=$('#toggleSummaryPanel');if(open){setSidePanelOpen(false,false);summaryPanelReturnFocus=document.activeElement instanceof HTMLElement?document.activeElement:trigger;panel.hidden=false;document.body.classList.add('summary-panel-open');trigger.setAttribute('aria-pressed','true');trigger.setAttribute('aria-expanded','true');syncSummaryPanel();focusPanel(panel,$('#closeSummaryPanel'))}else{panel.hidden=true;document.body.classList.remove('summary-panel-open');trigger.setAttribute('aria-pressed','false');trigger.setAttribute('aria-expanded','false');restorePanelFocus(panel,summaryPanelReturnFocus);summaryPanelReturnFocus=null}}
function closeImageViewer(){const dialog=$('#imageViewer');if(dialog.open)dialog.close()}
function openImageViewer(source,title='Image',path=''){const dialog=$('#imageViewer'),image=$('#imageViewerImage');imageViewerReturnFocus=document.activeElement instanceof HTMLElement?document.activeElement:null;$('#imageViewerTitle').textContent=title||'Image';$('#imageViewerPath').textContent=path||title||'';$('#imageViewerError').hidden=true;image.hidden=false;image.alt=title||'';image.src=source;$('#imageViewerOriginal').href=source;if(!dialog.open)dialog.showModal();requestAnimationFrame(()=>$('#closeImageViewer').focus())}
function currentTerminalCwd(){const path=state.active?.cwd||localStorage.getItem('codex-webui-project')||state.config.defaultCwd||$('#projectPath').textContent||'.';return path.startsWith('~')?state.config.home+path.slice(1):path}
function terminalIsVisible(terminalState){const host=$(`#${terminalState.hostId}`),panel=$(`#${terminalState.panelId}`);return host&&!host.hidden&&panel&&!panel.hidden}
function fitTerminal(terminalState){const host=$(`#${terminalState.hostId}`);if(!terminalState.fit||!terminalIsVisible(terminalState)||host.clientWidth<1||host.clientHeight<1)return;try{terminalState.fit.fit()}catch{}}
function sendTerminalResize(terminalState){const ws=terminalState.ws,term=terminalState.term;if(ws?.readyState===WebSocket.OPEN&&term)ws.send(JSON.stringify({type:'resize',cols:term.cols,rows:term.rows}))}
function connectTerminal(terminalState){if(terminalState.ws&&[WebSocket.OPEN,WebSocket.CONNECTING].includes(terminalState.ws.readyState))return;clearTimeout(terminalState.reconnectTimer);const proto=location.protocol==='https:'?'wss:':'ws:',host=$(`#${terminalState.hostId}`),ws=new WebSocket(`${proto}//${location.host}/terminal?cwd=${encodeURIComponent(currentTerminalCwd())}`);terminalState.ws=ws;ws.binaryType='arraybuffer';host.dataset.connected='false';ws.onopen=()=>{host.dataset.connected='true';requestAnimationFrame(()=>{fitTerminal(terminalState);sendTerminalResize(terminalState);terminalState.term?.focus()})};ws.onmessage=async event=>{const data=event.data instanceof Blob?new Uint8Array(await event.data.arrayBuffer()):event.data instanceof ArrayBuffer?new Uint8Array(event.data):String(event.data);terminalState.term?.write(data)};ws.onerror=()=>ws.close();ws.onclose=()=>{host.dataset.connected='false';if(terminalState.ws===ws)terminalState.ws=null;if(terminalIsVisible(terminalState))terminalState.reconnectTimer=setTimeout(()=>connectTerminal(terminalState),1000)}}
function initializeTerminal(terminalState){if(terminalState.term){connectTerminal(terminalState);requestAnimationFrame(()=>fitTerminal(terminalState));return}const dark=matchMedia('(prefers-color-scheme:dark)').matches,host=$(`#${terminalState.hostId}`),term=new Terminal({cursorBlink:true,cursorStyle:'block',fontFamily:'ui-monospace, "SFMono-Regular", "SF Mono", Menlo, Consolas, monospace',fontSize:12,lineHeight:1.2,scrollback:5000,theme:dark?{background:'#181818',foreground:'#f2f2f2',cursor:'#f2f2f2',selectionBackground:'#3b4a5a'}:{background:'#ffffff',foreground:'#0d0d0d',cursor:'#0d0d0d',selectionBackground:'#c8dcf4'}}),fit=new FitAddon;term.loadAddon(fit);term.open(host);terminalState.term=term;terminalState.fit=fit;term.onData(data=>{const ws=terminalState.ws;if(ws?.readyState===WebSocket.OPEN)ws.send(new TextEncoder().encode(data))});term.onResize(()=>sendTerminalResize(terminalState));terminalState.resizeObserver=new ResizeObserver(()=>requestAnimationFrame(()=>fitTerminal(terminalState)));terminalState.resizeObserver.observe(host);connectTerminal(terminalState);globalThis.__codexTerminals=terminalStates;if(terminalState===terminalStates.bottom)globalThis.__codexTerminal={term,fit,state:terminalState}}
function setBottomPanelView(kind='launcher'){const launcher=kind==='launcher',terminal=kind==='terminal',labels={browser:['Browser','globe','Open Browser from the right panel to keep it beside the chat.'],files:['Files','folderOpen','Choose or switch the local project folder available to this WebUI.']};$('#bottomPanelLauncher').hidden=!launcher;$('#terminalHost').hidden=!terminal;$('#bottomPanelUtility').hidden=launcher||terminal;$('#bottomPanelTab').textContent=launcher?'New tab':terminal?'Terminal':labels[kind]?.[0]||'New tab';if(launcher)return;bottomPanelLastView=kind;if(terminal){initializeTerminal(terminalStates.bottom);requestAnimationFrame(()=>{fitTerminal(terminalStates.bottom);terminalStates.bottom.term?.focus()});return}const[title,icon,description]=labels[kind];$('#bottomPanelIcon').innerHTML=codexIcon(icon);$('#bottomPanelUtilityTitle').textContent=title;$('#bottomPanelDescription').textContent=description;const action=$('#bottomPanelAction');action.hidden=kind!=='files';action.textContent='Choose project folder';action.onclick=kind==='files'?openFolderPicker:null}
function setBottomPanelOpen(open){const panel=$('#bottomPanel');panel.hidden=!open;document.body.classList.toggle('bottom-panel-open',open);$('#toggleBottomPanel').setAttribute('aria-pressed',String(open));$('#toggleBottomPanel').setAttribute('aria-expanded',String(open));if(open)setBottomPanelView(bottomPanelLastView||'launcher')}
function setSidebarSearchOpen(open){const panel=$('#sidebarSearchPanel'),input=$('#threadSearch');panel.hidden=!open;$('#sidebarSearchButton').setAttribute('aria-expanded',String(open));if(open){requestAnimationFrame(()=>input.focus());return}if(input.value){input.value='';renderThreads()}}
function setSidebarHelpOpen(open){$('#sidebarHelpMenu').hidden=!open;$('#sidebarHelpButton').setAttribute('aria-expanded',String(open))}

$('#newTab').onclick=()=>setSidePanelView('launcher','New tab');$('#reviewTab').onclick=()=>openReviewPanel(state.activeReview);$('#utilityTab').onclick=()=>setSidePanelView($('#utilityTab').dataset.sidePanelTab,$('#utilityTab').textContent);$('#openSidePanelTab').onclick=()=>setSidePanelView('launcher','New tab');for(const action of document.querySelectorAll('[data-side-panel-action]'))action.onclick=()=>action.dataset.sidePanelAction==='review'?openReviewPanel():openUtilityPanel(action.dataset.sidePanelAction);$('#browserAddressForm').onsubmit=event=>{event.preventDefault();navigateBrowser($('#browserUrl').value)};$('#browserBack').onclick=()=>moveBrowserHistory(-1);$('#browserForward').onclick=()=>moveBrowserHistory(1);$('#browserRefresh').onclick=()=>browserState.index>=0&&navigateBrowser(browserState.history[browserState.index],{push:false});$('#bottomPanelTab').onclick=()=>setBottomPanelView();for(const action of document.querySelectorAll('[data-bottom-panel-action]'))action.onclick=()=>setBottomPanelView(action.dataset.bottomPanelAction);$('#reviewMode').onclick=()=>{reviewPreferences.mode=reviewPreferences.mode==='unified'?'split':'unified';saveReviewPreferences();renderChanges()};$('#reviewWrap').onclick=()=>{reviewPreferences.wrap=!reviewPreferences.wrap;saveReviewPreferences();renderChanges()};$('#reviewExpand').onclick=()=>{reviewPreferences.expanded=!reviewPreferences.expanded;saveReviewPreferences();renderChanges()};$('#reviewPatch').onclick=applyActiveReviewPatch;$('#composer').addEventListener('submit',submitPrompt);$('#prompt').addEventListener('input',handlePromptInput);$('#prompt').addEventListener('keydown',handlePromptKeydown);$('#threadSearch').addEventListener('input',()=>{renderThreads();scheduleThreadSearch()});$('#archivedButton')?.addEventListener('click',()=>toggleArchivedView());$('#collabModeButton')?.addEventListener('click',()=>toggleCollaborationMode());$('#queueButton')?.addEventListener('click',(event)=>{event.preventDefault();queueMessage()});void loadThreadSections();void loadCollaborationModes();$('#modelButton').addEventListener('click',toggleModelMenu);$('#modeButton').onclick=togglePermissionMenu;$('#confirmFullAccess').onclick=()=>{const action=pendingFullAccessAction;$('#fullAccessDialog').close();if(action==='enable')setPermissionVisibility('fullAccess',true);else setPermissionMode('full-access');pendingFullAccessAction='select'};$('#fullAccessDialog').addEventListener('close',()=>{pendingFullAccessAction='select';syncPermissionSettings()});const addControl=document.querySelector('[data-composer-control="add"]');if(addControl)addControl.onclick=()=>openAttachmentPicker();const dictationControl=document.querySelector('[data-composer-control="dictation"]');if(dictationControl)dictationControl.onclick=()=>toast('Dictation requires the native desktop audio bridge.');$('#newTask').onclick=startNewTask;$('#projectButton').onclick=openFolderPicker;$('#composerProjectButton').onclick=openFolderPicker;$('#projectlessOption').onclick=useProjectless;$('#accountButton').onclick=e=>{e.stopPropagation();if(state.account?.type==='chatgpt')toggleAccountMenu();else openSettings('general')};$('#folderGo').onclick=()=>loadFolders($('#folderPathInput').value);$('#folderPathInput').onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();loadFolders(e.currentTarget.value)}};$('#folderUp').onclick=()=>folderBrowse.parent&&loadFolders(folderBrowse.parent);$('#folderConfirm').onclick=useSelectedFolder;$('#toggleSummaryPanel').onclick=()=>setSummaryPanelOpen($('#summaryPanel').hidden);$('#closeImageViewer').onclick=closeImageViewer;$('#imageViewerImage').onload=()=>{$('#imageViewerImage').hidden=false;$('#imageViewerError').hidden=true};$('#imageViewerImage').onerror=()=>{$('#imageViewerImage').hidden=true;$('#imageViewerError').hidden=false};$('#imageViewer').addEventListener('click',event=>{if(event.target===event.currentTarget)closeImageViewer()});$('#imageViewer').addEventListener('close',()=>{const image=$('#imageViewerImage');image.removeAttribute('src');if(imageViewerReturnFocus?.isConnected)imageViewerReturnFocus.focus();imageViewerReturnFocus=null});function mobileSidebarEnabled(){return document.documentElement.classList.contains('mobile-device')||innerWidth<720}
$('#productModeButton').onclick=()=>toast('Codex mode');$('#sidebarSearchButton').onclick=event=>{event.stopPropagation();setSidebarSearchOpen($('#sidebarSearchPanel').hidden)};$('#sidebarSearchClose').onclick=()=>setSidebarSearchOpen(false);$('#sidebarHelpButton').onclick=event=>{event.stopPropagation();setSidebarHelpOpen($('#sidebarHelpMenu').hidden)};$('#sidebarHelpSettings').onclick=()=>{setSidebarHelpOpen(false);openSettings('general-settings')};$('#sidebarHelpShortcuts').onclick=()=>{setSidebarHelpOpen(false);openSettings('keyboard-shortcuts')};$('#accountSettings').onclick=()=>openSettings('general-settings');$('#accountProfile').onclick=()=>openSettings('profile');$('#accountUsage').onclick=()=>openSettings('profile');$('#accountShortcuts').onclick=()=>openSettings('keyboard-shortcuts');for(const button of document.querySelectorAll('[data-settings-page]'))button.onclick=()=>setSettingsPage(button.dataset.settingsPage);$('#settingsAutoReviewToggle').onchange=event=>setPermissionVisibility('autoReview',event.currentTarget.checked);$('#settingsTaskNotifyToggle').onchange=event=>setTaskNotifyEnabled(event.currentTarget.checked);$('#settingsFullAccessToggle').onchange=event=>{if(!event.currentTarget.checked){setPermissionVisibility('fullAccess',false);return}event.currentTarget.checked=false;pendingFullAccessAction='enable';const dialog=$('#fullAccessDialog');if(!dialog.open)dialog.showModal()};$('#accountLogout').onclick=async()=>{if(!confirm('Log out?'))return;try{await rpc('account/logout');toggleAccountMenu(false);await loadAccount(true)}catch(error){toast(error.message)}};$('#settingsDialog').addEventListener('cancel',event=>{event.preventDefault();closeSettings()});
$('#languageSelect').value=i18n.preference;
$('#languageSelect').onchange=event=>i18n.setPreference(event.currentTarget.value);
function refreshLocalizedRuntime(){
  $('#languageSelect').value=i18n.preference;
  if(!state.active)$('#threadTitle').textContent=t('New task');
  if(!folderBrowse.selected)$('#folderSelection').textContent=t('No folder selected');
  if(state.account)renderAccount(state.account);else for(const id of ['accountName','accountMenuName','settingsAccountName'])$(`#${id}`).textContent=t('Settings');
  syncPermissionControl();syncModelLabel();refreshComposerPlaceholder();renderContextUsage();renderChanges();
  syncComposerSubmitState();
  if(!$('#modelMenu').hidden)renderModelMenuMain();
  if($('#settingsDialog').open){const current=document.querySelector('[data-settings-page].active')?.dataset.settingsPage||settingsRoutePage()||'general-settings';setSettingsPage(current,{updateRoute:false});filterSettingsNavigation($('#settingsSearch').value)}
}
i18n.subscribe(refreshLocalizedRuntime);
refreshLocalizedRuntime();
$('#toggleSidePanel').onclick=()=>setSidePanelOpen($('#sidePanel').hidden);$('#toggleBottomPanel').onclick=()=>setBottomPanelOpen($('#bottomPanel').hidden);$('#closeBottomPanel').onclick=()=>setBottomPanelOpen(false);$('#toggleSidebar').onclick=()=>setSidebarOpen(mobileSidebarEnabled()?!$('#sidebar').classList.contains('mobile-open'):document.body.classList.contains('sidebar-hidden'));$('#closeSidePanel').onclick=()=>setSidePanelOpen(false);$('#closeSummaryPanel').onclick=()=>setSummaryPanelOpen(false);document.addEventListener('click',e=>{const target=e.target instanceof Element?e.target:null,image=target?.closest('[data-image-src]');if(image){e.preventDefault();openImageViewer(image.dataset.imageSrc,image.dataset.imageTitle||image.querySelector('img')?.alt||'Image',image.dataset.imagePath||'');return}if(target?.closest('a[data-file-download]')){/* file-download link routed to the viewer（patches/0103）：放过它=点了没反应，所以也按打开处理 */}const citation=target?.closest('a[data-file-reference]');if(!citation)return;e.preventDefault();dispatchEvent(new CustomEvent('codex-webui:file-reference',{detail:{path:citation.dataset.fileReference,lineStart:Number(citation.dataset.fileLineStart)||null,lineEnd:Number(citation.dataset.fileLineEnd)||null}}))});document.addEventListener('click',e=>{const path=e.composedPath();if(!path.includes($('#modelPicker')))closeModelMenu();if(!path.includes($('#permissionPicker')))closePermissionMenu();if(!path.includes($('#accountMenu'))&&!path.includes($('#accountButton')))toggleAccountMenu(false);if(!path.includes($('#sidebarSearchPanel'))&&!path.includes($('#sidebarSearchButton')))setSidebarSearchOpen(false);if(!path.includes($('#sidebarHelpMenu'))&&!path.includes($('#sidebarHelpButton')))setSidebarHelpOpen(false)});document.addEventListener('visibilitychange',()=>{if(document.visibilityState!=='visible')return;scheduleThreadListRefresh(0);scheduleActiveThreadSync(0)});addEventListener('keydown',e=>{if(e.target instanceof Element&&e.target.closest('.terminal-host'))return;if(e.key==='Escape'){if($('#imageViewer').open){e.preventDefault();closeImageViewer();return}if($('#folderDialog').open||$('#fullAccessDialog').open)return;if(e.defaultPrevented)return;if(!$('#sidebarSearchPanel').hidden){e.preventDefault();setSidebarSearchOpen(false);return}if(!$('#sidebarHelpMenu').hidden){e.preventDefault();setSidebarHelpOpen(false);return}if($('#settingsDialog').open){e.preventDefault();closeSettings();return}closeModelMenu();closePermissionMenu();toggleAccountMenu(false);if(document.body.classList.contains('side-panel-open'))setSidePanelOpen(false);else if(document.body.classList.contains('summary-panel-open'))setSummaryPanelOpen(false)}if((e.metaKey||e.ctrlKey)&&e.key==='k'){e.preventDefault();startNewTask()}if((e.metaKey||e.ctrlKey)&&e.key==='b'){e.preventDefault();$('#toggleSidebar').click()}if((e.metaKey||e.ctrlKey)&&e.key==='j'){e.preventDefault();$('#toggleBottomPanel').click()}});addEventListener('resize',()=>{syncOverlayPanelMode();syncSidebarLayout();for(const terminalState of Object.values(terminalStates))requestAnimationFrame(()=>fitTerminal(terminalState))});
globalThis.__codexWebuiDebug={notify:onNotification,request:onServerRequest,state,browserState,navigateBrowser,renderChanges,renderAccount,renderHeader,refreshComposerPlaceholder,setProjectless,openImageViewer,openThread,loadInitial,startNewTask,setSidebarOpen,openSettings,closeSettings,settingsRoutePage,selectedPermission,permissionThreadPolicy,permissionTurnPolicy,setPermissionMode,setPermissionProfiles,setPermissionVisibility,renderPermissionMenu,filterAppModels,renderModels,syncTurnSnapshot,recordTurnReview,scrollOpenedThreadToBottom};
async function boot(){const savedProject=localStorage.getItem('codex-webui-project');syncSidebarLayout();syncPermissionControl();try{state.config=await fetch('/api/config').then(r=>r.json())}catch{}if(state.config.projectless||savedProject==='~')setProjectless();else setWorkspace(savedProject||state.config.defaultCwd||'.');refreshComposerPlaceholder();const initialSettingsPage=settingsRoutePage();if(initialSettingsPage)showSettings(initialSettingsPage,{updateRoute:false});connect()}
boot();


// --- interaction surfaces the upstream client does not implement ------------

function interactionCard(datasetKey){
  const card=document.createElement('section');
  card.className='approval-card';
  card.dataset[datasetKey]='';
  card.innerHTML='<div class="approval-body" data-interaction-body></div>';
  return card;
}

function interactionAnswer(card,req,respond){
  card.querySelectorAll('button,input,select,textarea').forEach(node=>{node.disabled=true});
  clientLog('interaction answer: id='+req.id+' method='+req.method+' payload='+JSON.stringify(respond).slice(0,300));
  respondToCodex(req.id,respond).catch(error=>{clientLog('interaction answer FAILED: id='+req.id+' -> '+((error&&error.message)||error));if(!error?.silentTransportSwitch)toast(error.message)});
  card.remove();
  state.requestCards.delete(req.id);
}

// item/tool/requestUserInput — the model asking the user a question.
// Leaving it unanswered parks the turn on waitingOnUserInput, so there is always
// a way to answer.
function renderUserInputRequest(req){
  const p=req.params||{},model=buildUserInputModel(req);
  const group=ensureActivity(p.turnId||'user-input',$('#conversation'),p.itemId);
  const card=interactionCard('codexUserInputSurface');
  const body=card.querySelector('[data-interaction-body]');
  body.insertAdjacentHTML('beforebegin',`<div class="approval-content"><div class="approval-identity">${codexIcon('question')}<span>${escapeHtml(model.identity)}</span></div><div class="approval-title">${escapeHtml(model.title)}</div></div>`);
  const form=document.createElement('form');
  form.className='approval-actions';
  form.style.flexDirection='column';
  form.style.alignItems='stretch';
  form.innerHTML=model.questions.map((q,index)=>{
    const options=(q.options||[]).map((o,optionIndex)=>`<label class="approval-choice"><input type="radio" name="q${index}" value="${escapeHtml(o.label)}"><span>${escapeHtml(o.label)}</span>${o.description?`<em>${escapeHtml(o.description)}</em>`:''}</label>`).join('');
    const freeText=q.options&&!q.isOther?'':`<input class="approval-text" type="${q.isSecret?'password':'text'}" data-free="${escapeHtml(q.id)}" placeholder="${q.options?'其他（可留空）':'输入你的回答'}">`;
    return `<div class="approval-question"><div class="approval-question-header">${escapeHtml(q.header||'问题')}</div><div class="approval-question-text">${escapeHtml(q.question)}</div>${options?`<div class="approval-choices">${options}</div>`:''}${freeText}</div>`;
  }).join('');
  const actions=document.createElement('div');
  actions.className='approval-actions-main';
  actions.innerHTML='<button type="submit" class="approval-primary" autofocus>提交回答</button>';
  form.append(actions);
  body.replaceWith(form);
  form.onsubmit=(event)=>{
    event.preventDefault();
    const answers={};
    model.questions.forEach((q,index)=>{
      const picked=form.querySelector(`input[name="q${index}"]:checked`);
      const free=form.querySelector(`[data-free="${q.id}"]`);
      const values=[];
      if(picked)values.push(picked.value);
      if(free&&free.value.trim())values.push(free.value.trim());
      if(values.length)answers[q.id]=values;
    });
    interactionAnswer(card,req,buildUserInputResponse(model,answers));
  };
  group.after(card);
  state.requestCards.set(req.id,card);
  scrollBottom();
}

// mcpServer/elicitation/request — MCP form input or browser authorization.
function renderElicitationRequest(req){
  const p=req.params||{},model=buildElicitationModel(req);
  const group=ensureActivity(p.turnId||'elicitation',$('#conversation'),null);
  const card=interactionCard('codexElicitationSurface');
  const body=card.querySelector('[data-interaction-body]');
  body.insertAdjacentHTML('beforebegin',`<div class="approval-content"><div class="approval-identity">${codexIcon('plug')}<span>${escapeHtml(model.identity)}</span></div><div class="approval-title">${escapeHtml(model.title)}</div>${model.message?`<div class="approval-subtitle">${escapeHtml(model.message)}</div>`:''}${model.untyped?'<div class="approval-reason"><span>说明</span><p>该请求使用未类型化的自定义表单，客户端不会凭空生成字段，只能拒绝或取消。</p></div>':''}</div>`);
  const wrapper=document.createElement('div');
  const collect=()=>{
    const values={};
    card.querySelectorAll('[data-field]').forEach(node=>{
      const name=node.dataset.field;
      if(node.type==='checkbox'&&node.dataset.multi!=='1'){values[name]=node.checked;return}
      if(node.type==='checkbox'){(values[name]=values[name]||[]).push(node.value);return}
      if(node.tagName==='SELECT'&&node.multiple)values[name]=[...node.selectedOptions].map(o=>o.value);
      else if(node.value!=='')values[name]=node.value;
    });
    return values;
  };
  const refresh=()=>{
    if(!model.canAccept){accept.disabled=true;return}
    accept.disabled=missingElicitationFields(model,collect()).length>0;
  };
  if(model.mode==='url'){
    wrapper.innerHTML=`<div class="approval-body"><a class="approval-review-link" href="${escapeHtml(model.url||'#')}" target="_blank" rel="noreferrer noopener">在浏览器中打开授权页面</a></div>`;
  }else if(model.mode==='form'){
    wrapper.className='approval-body';
    wrapper.innerHTML=model.fields.map(field=>{
      const options=(field.options||[]).map(o=>`<option value="${escapeHtml(o.value)}">${escapeHtml(o.label)}</option>`).join('');
      let control='';
      if(field.kind==='select')control=`<select data-field="${escapeHtml(field.name)}">${options}</select>`;
      else if(field.kind==='multiselect')control=`<div class="approval-choices">${(field.options||[]).map(o=>`<label class="approval-choice"><input type="checkbox" data-field="${escapeHtml(field.name)}" data-multi="1" value="${escapeHtml(o.value)}"><span>${escapeHtml(o.label)}</span></label>`).join('')}</div>`;
      else if(field.kind==='boolean')control=`<label class="approval-choice"><input type="checkbox" data-field="${escapeHtml(field.name)}"><span>是</span></label>`;
      else if(field.kind==='number')control=`<input class="approval-text" type="number" data-field="${escapeHtml(field.name)}" value="${field.default??''}">`;
      else if(field.kind==='text')control=`<input class="approval-text" type="text" data-field="${escapeHtml(field.name)}" value="${escapeHtml(String(field.default??''))}">`;
      else control='<div class="approval-reason"><p>此字段类型暂不支持自动填写</p></div>';
      return `<div class="approval-question"><div class="approval-question-header">${escapeHtml(field.label)}${field.required?' *':''}</div>${field.description?`<div class="approval-question-text">${escapeHtml(field.description)}</div>`:''}${control}</div>`;
    }).join('');
  }
  const actions=document.createElement('div');
  actions.className='approval-actions-main';
  actions.innerHTML='<button type="button" class="approval-deny">拒绝</button><button type="button" class="approval-cancel">取消</button><button type="button" class="approval-primary">提交</button>';
  const accept=actions.querySelector('.approval-primary');
  accept.textContent=model.mode==='url'?'我已在浏览器完成':'提交';
  wrapper.append(actions);
  body.replaceWith(wrapper);
  wrapper.addEventListener('input',refresh);
  actions.querySelector('.approval-deny').addEventListener('click',()=>interactionAnswer(card,req,buildElicitationResponse(model,{},'decline')));
  actions.querySelector('.approval-cancel').addEventListener('click',()=>interactionAnswer(card,req,buildElicitationResponse(model,{},'cancel')));
  accept.addEventListener('click',()=>{const response=buildElicitationResponse(model,collect(),'accept');clientLog('elicitation accept: '+JSON.stringify(response).slice(0,300));interactionAnswer(card,req,response)});
  refresh();
  group.after(card);
  state.requestCards.set(req.id,card);
  scrollBottom();
}


// The UI tracks the active turn from DOM state (send button dataset). If it
// misses turn/completed, the composer stays in "steer" mode while the server has
// no active turn, and turn/steer fails. Treat that specific failure as "the turn
// is over": clear the state and send as a normal new turn instead of erroring.
function isNoActiveTurnError(error){const message=String(error?.message||'').toLowerCase();return message.includes('no active turn')}


// A reload (or a browser opened after the fact) has no live request event to
// render, so ask the bridge what is still unanswered and rebuild the cards.
// Reusing onServerRequest keeps one rendering path for approvals, questions and
// MCP forms — and it is the same id the bridge will accept an answer for.
async function restorePendingRequests(){
  try{
    const response=await fetch('/api/requests/pending',{headers:{accept:'application/json'}});
    if(!response.ok)return;
    const payload=await response.json();
    // 卡片被会话重绘抹掉时，state 里还留着记录——那种情况必须重建，否则永远补不回来。
    for(const [id,card] of [...state.requestCards])if(!card.isConnected)state.requestCards.delete(id);
    for(const request of payload?.data||[]){
      if(state.requestCards.has(request.id))continue;
      await onServerRequest(request);
    }
  }catch(error){
    console.error('[codex-webui] could not restore pending requests',error);
  }
}


// Debounced server-side search. The immediate renderThreads() keeps typing
// responsive against what is already loaded; this then replaces the list with
// whatever the server finds across all history.
let threadSearchTimer=null;
function scheduleThreadSearch(){
  const query=$('#threadSearch').value.trim();
  if(threadSearchTimer)clearTimeout(threadSearchTimer);
  threadSearchTimer=setTimeout(()=>searchThreadsOnServer(query),220);
}
async function searchThreadsOnServer(query){
  try{
    const result=await rpc('thread/list',{limit:50,searchTerm:query||null});
    state.threads=result?.data||[];
    renderThreads();
  }catch(error){console.error('Could not search threads',error)}
}


// Archived threads are invisible in the normal list (thread/list returns them only
// with archived:true), so without this the Restore action had no way in.
async function toggleArchivedView(){
  state.archivedView=!state.archivedView;
  const button=$('#archivedButton');
  if(button)button.setAttribute('aria-pressed',String(state.archivedView));
  await refreshThreadList();
  renderThreads();
  toast(state.archivedView?t('Showing archived threads'):t('Showing active threads'));
}


// Pinning uses the server's own sections: threadSection/list already ships a
// "Pinned" one, and threadSection/move takes { threadId, sectionId | null }.
async function loadThreadSections(){
  try{
    const result=await rpc('threadSection/list',{});
    const pinned=(result?.data||[]).find(section=>String(section?.name||'').toLowerCase()==='pinned');
    state.pinnedSectionId=pinned?.id??null;
  }catch(error){console.error('Could not load thread sections',error)}
}

async function togglePinThread(thread){
  if(!thread?.id)return;
  if(!state.pinnedSectionId)await loadThreadSections();
  if(!state.pinnedSectionId){toast(t('Could not pin thread'));return}
  const isPinned=thread.section?.id===state.pinnedSectionId;
  try{
    await rpc('thread/section/move',{threadId:thread.id,sectionId:isPinned?null:state.pinnedSectionId});
    await refreshThreadList();renderThreads();
    toast(isPinned?t('Thread unpinned'):t('Thread pinned'));
  }catch(error){console.error('Could not pin thread',error);toast(t('Could not pin thread'))}
}


// Compacting summarises a long thread. It needs the thread to be loadable, so a
// non-active thread is resumed first (same rule as turn/start, E36/E47).
async function compactThread(thread){
  if(!thread?.id)return;
  try{
    if(state.active?.id!==thread.id)await rpc('thread/resume',{threadId:thread.id});
    await rpc('thread/compact/start',{threadId:thread.id});
    toast(t('Thread compaction started'));
  }catch(error){console.error('Could not compact thread',error);toast(t('Could not compact thread'))}
}


// Default/Plan switching (E66). The list comes from the server, so a future mode
// shows up without a code change; the chip hides itself if the server offers
// nothing but the default.
async function loadCollaborationModes(){
  try{
    const result=await rpc('collaborationMode/list',{});
    const modes=(result?.data||[]).filter(item=>item&&item.mode);
    state.collaborationModes=modes;clientLog('collab modes loaded: '+modes.map(function(m){return m.mode}).join('|'));
    const current=modes.find(item=>item.mode===state.collaborationMode);
    // Default MUST be the server's "default" mode. modes[0] was wrong: the server
    // lists Plan first, so every turn was silently sent in Plan mode (E79 — found
    // by the client-log channel).
    const fallback=modes.find(item=>item.mode==='default')||modes[0];
    state.collaborationMode=current?current.mode:(fallback?.mode||'default');
    renderCollaborationMode();
  }catch(error){console.error('Could not load collaboration modes',error);clientLog('collab modes FAILED: '+error.message)}
}

function collaborationModeParam(){
  const mode=state.collaborationMode;
  if(!mode||mode==='default')return{};
  // A null model is rejected here ("invalid type: null, expected a string"),
  // so if no model is known yet, skip the override entirely.
  if(!state.selectedModel)return{};
  return{collaborationMode:{mode,settings:{model:String(state.selectedModel),reasoning_effort:null,developer_instructions:null}}};
}

function renderCollaborationMode(){
  const button=$('#collabModeButton'),label=$('#collabModeLabel');
  if(!button||!label)return;
  const modes=state.collaborationModes||[];
  clientLog('renderMode: modes='+modes.length+' current='+state.collaborationMode);
  if(modes.length<2){button.hidden=true;clientLog('renderMode: keeping hidden (only '+modes.length+' mode)');return}
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


// 排队：等当前回合结束后再执行（thread/queue/add）。与 turn/steer 的「追加」是两件事，
// 这也是 P4 要求区分三者的那一档（E72）。
async function queueMessage(){
  const input=$('#prompt');
  const text=input.value.trim();
  if(!text)return;
  if(!state.active?.id){toast(t('No active thread to queue into'));return}
  try{
    await rpc('thread/queue/add',{threadId:state.active.id,input:[...textPart(text),...attachmentInputs(attachmentsForSend(attachments))],clientUserMessageId:(crypto.randomUUID?crypto.randomUUID():(Date.now()+'-'+Math.random().toString(16).slice(2)))});
    input.value='';
    state.composerMentions=[];
    renderContextTray();
    resizePrompt();
    syncComposerSubmitState();
    await refreshQueue();
    toast(t('Queued for after this turn'));
  }catch(error){console.error('Could not queue message',error);toast(t('Could not queue message'))}
}

// 队列当前是**只读展示**：删除/排序需要先探明 thread/queue/delete 与 reorder 的参数
// （E72 只确认了 add 与 list 的形状），留待下一步。
async function refreshQueue(){
  let tray=$('#queueTray');
  if(!tray){
    // Created on demand so this patch does not depend on the composer markup.
    const composer=$('#composer');
    if(!composer)return;
    tray=document.createElement('div');
    tray.id='queueTray';
    tray.className='queue-tray';
    tray.hidden=true;
    composer.parentNode.insertBefore(tray,composer);
  }
  if(!state.active?.id){tray.hidden=true;return}
  try{
    const result=await rpc('thread/queue/list',{threadId:state.active.id});
    const items=result?.data||[];
    tray.innerHTML='';
    tray.hidden=items.length===0;
    for(const item of items.slice(0,5)){
      const text=(item?.input||[]).map(part=>part?.text||'').join(' ').trim()||t('Queued message');
      const chip=document.createElement('span');
      chip.className='queue-chip';
      chip.textContent=text.length>60?text.slice(0,60)+'…':text;
      tray.append(chip);
    }
    if(items.length>5){const more=document.createElement('span');more.className='queue-chip';more.textContent=`+${items.length-5}`;tray.append(more)}
  }catch(error){console.error('Could not read the queue',error)}
}


// Development-only: report frontend state to the bridge log. Without this, the
// browser's own errors and branch outcomes are invisible from the terminal, which
// is what made E77 slow to diagnose. Nothing is stored; the endpoint just logs.
function clientLog(message){
  try{
    if(!globalThis.__codexPageId)globalThis.__codexPageId=(Math.random().toString(36)+Date.now().toString(36)).slice(2,9);
    fetch('/api/client-log',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({message:String(message),at:Date.now(),pid:globalThis.__codexPageId,vis:document.visibilityState,transport:String(state.transport||'?')})}).catch(function(){});
  }catch(error){/* diagnostics must never break the app */}
}

// Fires on every page load so the bridge log can tell whether a reload happened.
clientLog("app boot " + location.pathname);


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


// --- attachments (patches/0029) -------------------------------------------
// Images are sent as localImage{path} so the transcript can render them through
// /api/images/local; anything else becomes a mention{name,path}. Both are just
// paths: the bytes already landed in the bridge's upload directory.
function attachmentInputs(list=state.composerAttachments){
  return list.filter(attachment=>!attachment.pending).map(attachment=>attachment.kind==='image'
    ?{type:'localImage',path:attachment.path}
    :{type:'mention',name:attachment.name,path:attachment.path});
}
function attachmentContent(list=state.composerAttachments){return attachmentInputs(list)}

function openAttachmentPicker(){clientLog('openAttachmentPicker called (label path is used instead)')}

// 这里原来有个 readFileAsDataUrl()：上传前把整个文件读成 data URL，再 base64 塞进 JSON。
// patches/0098 起改成直接把 File 当 body 发（见 postUploadWithProgress），这个函数就没有调用者了。

async function uploadAttachments(files){
  for(const file of files){
    const placeholderId='pending-'+Date.now()+'-'+Math.random().toString(36).slice(2,6);
    const startedAt=Date.now();
    try{
      clientLog('upload start: '+file.name+' ('+file.size+' bytes, '+file.type+')');
      // Show the chip immediately: the bytes may take a while to move, and a silent
      // picker round-trip is what made this look broken (E87).
      state.composerAttachments.push({id:placeholderId,name:file.name,kind:String(file.type||'').startsWith('image/')?'image':'file',pending:true,progress:0,phase:t('(uploading…)')});
      renderContextTray();
      const response=await uploadWithRetry(file,startedAt,(fraction,label,options)=>updateAttachmentProgress(placeholderId,fraction,label,options));
      clientLog('upload http '+response.status+' in '+(Date.now()-startedAt)+'ms');
      const payload=await response.json().catch(()=>({}));
      if(!response.ok)throw new Error((payload&&payload.error)||('HTTP '+response.status));
      state.composerAttachments=state.composerAttachments.filter(item=>item.id!==placeholderId);
      state.composerAttachments.push({id:payload.path,name:payload.name,path:payload.path,kind:payload.kind,bytes:payload.bytes});
      renderContextTray();
      clientLog('attachment ready: '+payload.name+' ('+payload.bytes+' bytes, '+payload.kind+') in '+(Date.now()-startedAt)+'ms');
      pendingUploadRetry=null;
    }catch(error){
      state.composerAttachments=state.composerAttachments.filter(item=>item.id!==placeholderId);
      renderContextTray();
      const detail=uploadErrorText(error);
      clientLog('attachment failed: '+file.name+' -> '+((error&&error.message)||error)+' @'+((error&&error.name)||''));
      toast(t('Upload failed')+': '+file.name+' — '+detail,9000);
      pendingUploadRetry={file,at:Date.now()};
    }
  }
}


// Startup timing report: answers "why is it slow" with numbers instead of guesses.
// Reported once, after the first paint following the initial render.
requestAnimationFrame(()=>requestAnimationFrame(()=>{
  try{
    const nav=performance.getEntriesByType('navigation')[0]||{};
    clientLog('timing: nav dcl='+Math.round(nav.domContentLoadedEventEnd||0)
      +'ms load='+Math.round(nav.loadEventEnd||0)
      +'ms; firstPaintAt='+Math.round(performance.now())+'ms'
      +'; domNodes='+document.getElementsByTagName('*').length);
  }catch(error){/* diagnostics must never break the app */}
}));


// Label-driven attachments: the browser activates the file input natively, with no
// JS click() involved — the three click()-based attempts all failed on this device
// (picker opened, file never came back).
(function bindAttachmentInputs(){
  let bound=0;
  for(const id of ['attachmentPicker','filePicker']){
    const input=document.getElementById(id);
    if(!input)continue;
    input.addEventListener('change',()=>{
      const files=Array.prototype.slice.call(input.files||[]);
      input.value='';
      clientLog('attachment picked ('+id+'): '+files.length+' file(s)');
      void uploadAttachments(files);
    });
    bound+=1;
  }
  clientLog('attachment inputs bound: '+bound);
})();


// Report what local state this load restored. "First load fine, reload broken" is
// the signature of restored state (the site persists ~8 localStorage keys), so the
// next reload should show exactly which values were picked up.
try{
  const keys=[];
  for(let i=0;i<localStorage.length;i++){const k=localStorage.key(i);if(k&&k.startsWith('codex-webui'))keys.push(k+'='+String(localStorage.getItem(k)).slice(0,40))}
  const active=localStorage.getItem('codex-webui-active-thread')||localStorage.getItem('codex-webui-thread')||'(n/a)';
  clientLog('restored local state: '+keys.join(' | ')+' ; thread='+active);
  clientLog('first load? '+(keys.length===0));
}catch(error){/* diagnostics must never break the app */}


// Which build is this page running? Stamped by the bridge into index.html; without
// it I could not tell a stale page from a broken change (E86).
try{
  const build=(document.querySelector('meta[name="codex-build"]')||{}).content||'(none)';
  clientLog('build: '+build);
}catch(error){/* diagnostics must never break the app */}


// Boot fingerprint. Everything above this line runs during module evaluation, so
// "did the bundle reach the end?" is answerable from the bridge log alone. A missing
// element in the wiring block used to abort the module before any of it was visible
// (E86) — this line plus probe/dom-contract-audit.mjs is the guard against a repeat.
try{
  clientLog('bundle evaluated to end; controls wired, attachments bound');
}catch(error){/* diagnostics must never break the app */}


// --- stall diagnostics + history fallback (patches/0031) -------------------
// Everything here is diagnostic or a fallback: it must never break a normal load.

// Android backgrounds the tab while the system file picker is up; the page can be
// frozen and resume arbitrarily later. Recording the transitions is the only way to
// tell "the bridge was slow" from "the page was not running" (E87).
function heartbeatLog(message){
  try{
    if(!globalThis.__codexPageId)globalThis.__codexPageId=(Math.random().toString(36)+Date.now().toString(36)).slice(2,9);
    const payload=JSON.stringify({message:String(message),at:Date.now(),pid:globalThis.__codexPageId,vis:document.visibilityState});
    if(navigator.sendBeacon){navigator.sendBeacon('/api/client-log',new Blob([payload],{type:'application/json'}));return}
    clientLog(message);
  }catch(error){/* diagnostics must never break the app */}
}
try{
  document.addEventListener('visibilitychange',()=>{heartbeatLog('visibility: '+document.visibilityState);if(document.visibilityState==='visible')retryPendingUpload()});
  addEventListener('pagehide',()=>heartbeatLog('pagehide'));
  addEventListener('pageshow',()=>heartbeatLog('pageshow'));
  addEventListener('freeze',()=>heartbeatLog('freeze'));
  addEventListener('resume',()=>heartbeatLog('resume'));
  addEventListener('online',()=>heartbeatLog('online'));
  addEventListener('offline',()=>heartbeatLog('offline'));
  let lastTransport=state.transport;
  setInterval(()=>{if(state.transport!==lastTransport){lastTransport=state.transport;clientLog('transport switched to '+state.transport)}},1000);
}catch(error){/* diagnostics must never break the app */}

// History for an opened thread. thread/read with includeTurns is tried first because it
// is the documented path and matches the previous behaviour; some threads answer
// "list_turns is not supported yet" (E87), and then thread/resume — which returns
// the same turns and also attaches the thread — is used instead of showing the user
// an empty conversation.
async function loadThreadHistory(id){
  try{
    const result=await rpc('thread/read',{threadId:id,includeTurns:true});
    const thread=result?.thread||{};
    clientLog('history via thread/read: '+((thread.turns||[]).length)+' turns');
    return thread;
  }catch(readError){
    clientLog('thread/read failed for '+id+': '+((readError&&readError.message)||readError));
    const resumed=await rpc('thread/resume',{threadId:id});
    const thread=resumed?.thread||{};
    clientLog('history via thread/resume: '+((thread.turns||[]).length)+' turns');
    return thread;
  }
}


// --- attachment send + upload retry (patches/0032) -------------------------
// A text part only exists when there is text: an image alone is a valid message.
function textPart(text){return text?[{type:'text',text}]:[]}

// The bridge can be frozen mid-request (E87/E88). Without a bound the fetch simply
// never settles, the chip stays on "（上传中…）" and the user cannot tell whether it
// is working. One retry covers the "frozen for a few seconds, then thawed" case,
// which is the common one on this device.
function postUploadWithProgress(file,onProgress){
  return new Promise((resolve,reject)=>{
    beginBridgeWait('upload');
    const xhr=new XMLHttpRequest();
    xhr.open('POST','/api/uploads');
    // 直接发文件本身（原始字节），不再 base64 + JSON（patches/0098）。
    // 两个原因：① base64 让体积涨 33%，而且 `JSON.stringify` 一个十几 MB 的字符串是
    // 主线程同步操作；② **字符串 body 的 upload.onprogress 拿不到 lengthComputable/length**，
    // 于是下面的早退分支把进度条永远按在 0 —— 用户看到的就是"没有进度条"。
    // File body 有确定长度，进度事件可用；桥那边也改成边收边写盘。
    xhr.setRequestHeader('content-type',file.type||'application/octet-stream');
    xhr.setRequestHeader('x-upload-name',encodeURIComponent(file.name));
    xhr.timeout=45000;
    let waitTicker=null;
    const stopTicker=()=>{if(waitTicker){clearInterval(waitTicker);waitTicker=null}};
    if(xhr.upload&&onProgress){
      xhr.upload.onprogress=(event)=>{if(!event.lengthComputable||!event.total)return;const fraction=event.loaded/event.total;onProgress(fraction,Math.round(fraction*100)+'%')};
      // Bytes are out but the bridge has not answered yet: on this device that wait is
      // exactly where freezes show up, so it gets its own label and a running clock
      // (E90/E91/E92) — a number that moves is the difference between "working" and
      // "hung" for whoever is holding the phone.
      xhr.upload.onload=()=>{
        const sentAt=Date.now();
        const render=()=>onProgress(1,t('waiting for the bridge…')+' '+Math.round((Date.now()-sentAt)/1000)+'s',{waiting:true});
        render();
        stopTicker();
        waitTicker=setInterval(render,500);
      };
    }
    xhr.onload=()=>{
      stopTicker();
      endBridgeWait();
      let payload=null;
      try{payload=JSON.parse(xhr.responseText||'{}')}catch{payload=null}
      resolve({ok:xhr.status>=200&&xhr.status<300,status:xhr.status,json:async()=>payload||{}});
    };
    xhr.onerror=()=>{stopTicker();endBridgeWait();reject(new Error('Failed to fetch'))};
    xhr.ontimeout=()=>{stopTicker();endBridgeWait();reject(Object.assign(new Error('Bridge request timed out: /api/uploads'),{name:'TimeoutError'}))};
    xhr.onabort=()=>{stopTicker();endBridgeWait();reject(Object.assign(new Error('Upload aborted'),{name:'AbortError'}))};
    xhr.send(file);
  });
}
async function uploadWithRetry(file,startedAt,onProgress,attempt=1){
  try{
    const response=await postUploadWithProgress(file,onProgress);
    if(response.status>=500&&attempt<2){
      clientLog('upload retry: '+file.name+' (HTTP '+response.status+' after '+(Date.now()-startedAt)+'ms)');
      return uploadWithRetry(file,startedAt,onProgress,attempt+1);
    }
    return response;
  }catch(error){
    if(attempt<2){
      clientLog('upload retry: '+file.name+' ('+((error&&error.message)||error)+' after '+(Date.now()-startedAt)+'ms)');
      return uploadWithRetry(file,startedAt,onProgress,attempt+1);
    }
    throw error;
  }
}


// --- upload failure wording + resume retry (patches/0034) ------------------
// The raw error names ("signal is aborted without reason") are engine jargon; the
// user needs to know whether to wait, retry, or change a phone setting (E90).
let pendingUploadRetry=null;
function uploadErrorText(error){
  const raw=(error&&error.message)?String(error.message):String(error);
  if(/abort|timeout|timed out|Failed to fetch|network/i.test(raw))return t('no answer from the bridge (the phone may have slept)');
  return raw;
}
// The device sleeping is the usual cause, and waking up is the usual cure: retry the
// file we already hold (the File handle, not a base64 copy) once the page is visible.
function retryPendingUpload(){
  const pending=pendingUploadRetry;
  if(!pending||Date.now()-pending.at<8000)return;
  pendingUploadRetry=null;
  clientLog('upload resume retry after the page became visible again');
  void uploadAttachments([pending.file]);
}


// --- upload progress on the chip (patches/0035) ----------------------------
// The bar is the chip's own background layer, so the answer to "how far along is
// this file?" lives on the file itself. Updated in place: a full tray re-render on
// every progress event would rebuild the other chips under the user's fingers.
function updateAttachmentProgress(id,fraction,phase,options){
  const chip=document.querySelector('.composer-context-chip[data-attachment-id="'+id+'"]');
  if(!chip)return;
  const fill=chip.querySelector('.composer-context-fill');
  if(fill)fill.style.width=Math.round(Math.max(0,Math.min(1,Number(fraction)||0))*100)+'%';
  const phaseNode=chip.querySelector('.composer-context-phase');
  if(phaseNode&&phase)phaseNode.textContent=phase;
  // 字节已经发完、还在等桥回答时走条纹动画：这一段在本机是最长的等待，
  // "在动"和"卡死"必须一眼能分开（patches/0098）。
  chip.classList.toggle('waiting',Boolean(options&&options.waiting));
}


// --- user message rendering (patches/0037) ---------------------------------
// Which sources are pictures? localImage (the optimistic bubble), anything carrying
// a path/url/image_url that passes the image check, and the <image … path="…">
// marker the app-server writes into a text part. Paths win over inline data URLs:
// they are a few bytes and /api/images/local serves them, while a data URL is the
// whole file in the DOM.
function userMessageImageSources(content=[]){
  const paths=[],dataUrls=[];
  const classify=source=>{
    const value=String(source||'').trim();
    if(!value||!isImageReference(value))return;
    if(/^data:/i.test(value))dataUrls.push(value);
    else paths.push(value);
  };
  for(const part of content||[]){
    classify(part?.path||part?.url||part?.src||part?.imageUrl||part?.image_url);
    const text=String(part?.text||part?.input_text||'');
    if(!text.includes('<image'))continue;
    const marker=/<image\b[^>]*?\bpath="([^"]+)"/g;
    let match;
    while((match=marker.exec(text)))classify(match[1]);
  }
  return {paths:[...new Set(paths)],dataUrls:[...new Set(dataUrls)]};
}
function userMessageImageTitle(source){
  const value=String(source||'');
  if(/^data:/i.test(value))return 'Image';
  const name=value.split(/[\\/]/).filter(Boolean).at(-1)||'Image';
  try{return decodeURIComponent(name)}catch{return name}
}
// --- 附件芯片（patches/0056）----------------------------------------------
// 桥给文档附件生成的文本是固定句式「附件（本地路径，可直接读取）：<绝对路径>」（server.ts:568）。
// 手机上原样铺开会把气泡拉成七八行、每行只放得下几个字符（E119 真机截图），
// 所以渲染成桌面端那样的一行芯片：默认只显示文件名，点一下展开完整路径。
// 纯渲染层——发给模型、存进历史的文本仍是完整路径。
const USER_ATTACHMENT_LINE=/^附件（本地路径，可直接读取）：(.+)$/;
// 上传文件名常是 70+ 字符（时间戳 + 哈希），折叠态留头尾两截即可：
// 尾部带扩展名，一眼能分清 pdf / 图片；完整路径点开就有。
function shortAttachmentName(name){
  return name.length<=26?name:name.slice(0,12)+'…'+name.slice(-13);
}
function userAttachmentChipHtml(path){
  const name=shortAttachmentName(path.split('/').filter(Boolean).pop()||path);
  return '<button type="button" class="user-attachment" data-attachment-path="'+escapeHtml(path)+'" aria-expanded="false">'
    +'<span class="user-attachment-icon">'+icons.file+'</span>'
    +'<span class="user-attachment-body">'
    +'<span class="user-attachment-name">'+escapeHtml(name)+'</span>'
    +'<span class="user-attachment-path">'+escapeHtml(path)+'</span>'
    +'</span>'
    +'<span class="user-attachment-hint">'+escapeHtml(t('Path'))+'</span>'
    +'</button>';
}
function userMessageBody(text,images){
  const chips=[],rest=[];
  for(const line of String(text||'').split('\n')){
    const match=USER_ATTACHMENT_LINE.exec(line);
    if(match&&match[1].trim())chips.push(userAttachmentChipHtml(match[1].trim()));
    else rest.push(line);
  }
  const remaining=rest.join('\n').trim();
  return [remaining?escapeHtml(remaining):'',chips.join(''),images&&images.length?('<div class="user-message-grid">'+images.join('')+'</div>'):''].filter(Boolean).join('');
}

function userMessageHtml(item){
  const cwd=imageCwd(item),text=textFromInput(item.content),{paths,dataUrls}=userMessageImageSources(item.content);
  const sources=paths.length?paths:dataUrls.slice(0,2);
  const images=sources
    .map(source=>renderImagePreview(source,{cwd,title:userMessageImageTitle(source),className:'user-message-image'}))
    .filter(Boolean);
  const body=userMessageBody(text,images);
  return body||'<span class="user-message-placeholder">'+escapeHtml(t('(attachment)'))+'</span>';
}
// Re-rendering on every upsert would fight the user (selection, scroll position,
// half-loaded thumbnails), so the markup is compared before it is replaced.
function renderUserMessage(el,item){
  const host=el.querySelector('.user-message');
  if(!host)return;
  const html=userMessageHtml(item);
  // claimOptimisticUser 靠 textContent 认领本地气泡；芯片会改变 textContent（文件名+提示语），
  // 所以把原文存在 dataset 上，认领时优先用它。
  host.dataset.rawText=textFromInput(item.content);
  if(host.dataset.renderKey===html)return;
  host.dataset.renderKey=html;
  host.innerHTML=html;
}


// --- sending with an upload in flight (patches/0039) -----------------------
// The snapshot is what the composer held when send was pressed; the live state may have
// gained the finished attachment since. Take both, drop placeholders, keep order.
function attachmentsForSend(snapshot=[]){
  const merged=[],seen=new Set();
  for(const item of [...snapshot,...state.composerAttachments]){
    if(!item||item.pending)continue;
    const key=item.id||item.path;
    if(!key||seen.has(key))continue;
    seen.add(key);
    merged.push(item);
  }
  return merged;
}


// --- screen wake lock while waiting for the bridge (patches/0040) -----------
// The device suspending mid-request is what turns a 5 KB upload into a 42-second wait,
// and it also freezes the page's own timers — so the timeout and the retry cannot fire
// while it matters. Holding a screen wake lock for the duration of the wait keeps the
// device awake exactly then. It is released as soon as the wait ends (nothing to pay
// while idle) and the browser drops it by itself when the page is hidden.
let bridgeWaits=0,screenLock=null;
async function acquireScreenLock(reason){
  try{
    if(!navigator.wakeLock||screenLock)return;
    screenLock=await navigator.wakeLock.request('screen');
    screenLock.addEventListener('release',()=>{screenLock=null});
    clientLog('screen wake lock held ('+(reason||'wait')+')');
  }catch(error){/* unsupported or denied: never fatal */}
}
// While the page is visible the screen must not time out: a sleeping device stops the
// stream, which is exactly what "the answer never finishes loading" looks like. Held
// from the first paint, dropped when the page is hidden (the browser times it out
// anyway), retaken when the user comes back.
function syncScreenLock(){
  if(document.visibilityState==='visible')void acquireScreenLock('page visible');
  else try{screenLock?.release?.()}catch(error){/* ignore */}
}
function beginBridgeWait(reason){
  bridgeWaits+=1;
  clientLog('bridge wait begin ('+reason+'), '+bridgeWaits+' active');
  void acquireScreenLock();
  if(bridgeWaits===1&&!bridgeWaitWarned){
    clearTimeout(bridgeWaitWarnTimer);
    bridgeWaitWarnTimer=setTimeout(()=>{
      if(!bridgeWaits||bridgeWaitWarned)return;
      bridgeWaitWarned=true;
      clientLog('bridge wait exceeded 8s — asking the bridge why');
      // 问一句桥的 uptime：刚重启（<2 分钟）就是「我自己重启的锅」，否则才谈系统挂起。
      void (async()=>{
        let uptimeMs=null;
        try{
          const response=await fetch('/api/health',{cache:'no-store'});
          uptimeMs=Number((await response.json())?.uptimeMs);
        }catch(error){/* 桥不可达时保持沉默，下面按未知处理 */}
        if(Number.isFinite(uptimeMs)&&uptimeMs<120000){
          const seconds=Math.max(1,Math.round(uptimeMs/1000));
          clientLog('bridge uptime '+seconds+'s — it was restarted just now, the page is reconnecting');
          toast(t('The bridge was just restarted (N s ago) — the page is reconnecting.').replace('N',String(seconds)),7000);
          return;
        }
        clientLog('bridge uptime '+(Number.isFinite(uptimeMs)?Math.round(uptimeMs/1000)+'s':'unknown')+' — looks like a suspension');
        toast(t('The bridge has not answered for 8s. Termux is probably suspended; setting its battery policy to “Unrestricted” fixes it.'),9000);
      })();
    },8000);
  }
}
function endBridgeWait(){
  bridgeWaits=Math.max(0,bridgeWaits-1);
  if(bridgeWaits>0)return;
  clearTimeout(bridgeWaitWarnTimer);
  // Keep the screen lock while the page is visible — see syncScreenLock.
  if(document.visibilityState!=='visible')try{screenLock?.release?.()}catch(error){/* ignore */}
}
// The lock is dropped automatically when the page is hidden; re-take it if we are still
// waiting when the user comes back.
document.addEventListener('visibilitychange',syncScreenLock);
if(document.readyState==='complete')syncScreenLock();
else document.addEventListener('DOMContentLoaded',syncScreenLock);


// --- explaining a long wait (patches/0042) ---------------------------------
let bridgeWaitWarnTimer=null,bridgeWaitWarned=false;


// --- 请求生命周期（patches/0045）-------------------------------------------
// 服务端在请求被任何一方回答后会广播 serverRequest/resolved（桥把它当通知转发）。
// 多客户端/重连时，本地还留着卡片就必须收掉——否则用户会对着一个已经被回答的卡片点，
// 点了也没有效果（这正是 PLAN 里"已解决 / 重复点击"那两条要防的）。
function resolveRequestCard(requestId, reason){
  const card=state.requestCards.get(requestId);
  if(!card)return;
  clientLog('approval: request '+requestId+' resolved elsewhere'+(reason?': '+reason:''));
  card.querySelectorAll('button').forEach(button=>button.disabled=true);
  card.classList.add('resolved');
  const note=document.createElement('div');
  note.className='approval-subtitle';
  note.textContent=t('Answered elsewhere');
  card.querySelector('.approval-content')?.append(note);
  setTimeout(()=>card.remove(),1200);
  state.requestCards.delete(requestId);
}


// --- 页面级异常上报（patches/0050）-----------------------------------------
// 前端抛在事件处理器里的异常默认只进浏览器控制台，而查问题的人（我）在 Termux 这边。
// 这两条把它送进桥日志；和 Android 侧的崩溃上报是同一个思路（E106）。
try{
  addEventListener('error',(event)=>{
    try{
      const where=(event&&event.filename?event.filename:'')+':'+(event&&event.lineno||0);
      clientLog('page error: '+((event&&event.message)||'?')+' @ '+where);
    }catch(inner){}
  });
  addEventListener('unhandledrejection',(event)=>{
    try{
      const reason=event&&event.reason;
      clientLog('page unhandled rejection: '+((reason&&reason.message)||String(reason)).slice(0,200));
    }catch(inner){}
  });
}catch(error){/* diagnostics must never break the app */}


// --- 原生通知（patches/0053）-----------------------------------------------
// APK 通过 addJavascriptInterface 注入 window.CodexNative；浏览器里它不存在，
// 于是同一份页面在两处都能工作：原生优先，浏览器退回 Web Notification。
function nativeNotifier(){
  try{
    const api=globalThis.CodexNative;
    return api&&typeof api.notify==='function'?api:null;
  }catch(error){return null}
}
// 注册原生通知出口。**每次连上桥都要注册**：桥那边是内存计数，重启即归零；
// 页面只在启动时注册过一次的话，桥重启后就会把提醒退回 Termux（E116）。
function registerNativeNotifier(){
  try{
    if(!nativeNotifier())return;
    // 租约：每 30 秒续一次（见下面的定时器），桥侧 90 秒没收到续约就当作应用不在了，
    // 于是通知自动退回 Termux，而不是发给一个已经关掉的页面。
    if(!globalThis.__codexPageId)globalThis.__codexPageId=(Math.random().toString(36)+Date.now().toString(36)).slice(2,9);
    fetch('/api/notify/register',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({clientId:globalThis.__codexPageId})})
      .then(()=>clientLog('native notifier registered'))
      .catch(function(){});
  }catch(error){/* diagnostics must never break the app */}
}

function nativeNotify(title,body,tag,threadId){
  const api=nativeNotifier();
  if(!api)return false;
  try{
    // 深链（patches/0089/0090）：第 4 个参数是会话 id；老 APK 没有这个重载会忽略它。
    // 不能靠 api.notify.length 判断新老 APK：Java 桥接对象的方法 length 不可靠（实测=0）。
    // 直接按 4 参调用，老 APK 会抛异常，再退回 3 参。
    if(threadId){
      try{api.notify(String(title||'Codex'),String(body||''),String(tag||'codex-status'),String(threadId));return true}
      catch(error){clientLog('native notify with thread id failed, retrying without it: '+((error&&error.message)||error))}
    }
    api.notify(String(title||'Codex'),String(body||''),String(tag||'codex-status'));
    return true
  }
  catch(error){clientLog('native notify FAILED: '+((error&&error.message)||error));return false}
}
// 深链入口（patches/0090）：APK 点通知后调用它。会话已经开着就不动，避免白刷一次。
globalThis.codexDeepLinkOpen=function(threadId){
  const id=String(threadId||'').trim();
  if(!id)return;
  if(String(state.active?.id||'')===id){clientLog('deep link ignored (already open): '+id);return}
  clientLog('deep link -> open thread '+id);
  void openThread(id);
};

// 注册一次：桥据此知道"有应用在跑"，agent/CLI 侧的通知就能走原生而不是 Termux。
registerNativeNotifier();
// 续约：桥侧租约 90 秒过期，这里 30 秒续一次（页面的定时器在应用前台服务下正常跑）。
setInterval(registerNativeNotifier,30000);

// --- Git 面板（patches/0060 + 0061）------------------------------------------
// app-server 没有 Git 方法（FEATURES 第 4 节 B+C 类）：暂存/提交/拉取/推送、分支切换、
// worktree 全由桥调用 git 实现（app/git-service.js），页面只做展示与确认。
// 破坏性动作（丢弃改动、切换分支、push、删除 worktree）一律先过确认弹层。
const gitState={repo:null,name:null,branch:null,detached:false,upstream:null,ahead:null,behind:null,operation:null,
  staged:[],unstaged:[],untracked:[],worktrees:[],busy:false,error:null,loaded:false};

function gitWorkspaceCwd(){return state.active?.cwd||state.workspaceContext?.cwd||null}

async function gitCall(action,extra){
  const cwd=gitWorkspaceCwd();
  if(!cwd)throw new Error(t('No workspace folder is selected'));
  const response=await fetch('/api/git',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(Object.assign({action,cwd},extra||{}))});
  const data=await response.json().catch(function(){return {}});
  clientLog('git '+action+' -> '+response.status+(response.ok?'':' '+(data.error||'')));
  if(!response.ok)throw new Error(data.error||('Git '+action+' failed'));
  return data;
}

function gitConfirm(options){
  const settings=options||{};
  return new Promise(function(resolve){
    const dialog=$('#gitConfirmDialog');
    if(!dialog||typeof dialog.showModal!=='function'){resolve(globalThis.confirm((settings.title||'')+' '+(settings.message||'')));return}
    $('#gitConfirmTitle').textContent=settings.title||t('Confirm');
    $('#gitConfirmMessage').textContent=settings.message||'';
    const accept=$('#gitConfirmAccept');
    accept.textContent=settings.confirmLabel||t('Confirm');
    accept.classList.toggle('danger',Boolean(settings.danger));
    let settled=false;
    const done=function(value){if(settled)return;settled=true;accept.onclick=null;dialog.onclose=null;try{dialog.close()}catch(error){}resolve(value)};
    accept.onclick=function(){done(true)};
    dialog.onclose=function(){done(false)};
    try{dialog.showModal()}catch(error){done(true)}
  });
}

function gitStatusMark(status){
  const map={M:'modified',A:'added',D:'deleted',R:'renamed',C:'copied',U:'conflict'};
  return t(map[status]||'changed');
}

// 动作名（协议/桥用的）与显示文案分开：前者是 stage/unstage/discard，后者走 i18n。
const GIT_FILE_ACTION_LABELS={stage:'Stage',unstage:'Unstage',discard:'Discard'};
function gitFileRow(entry,actions){
  const row=document.createElement('div');
  row.className='git-file';
  const stats=(Number.isFinite(entry.additions)||Number.isFinite(entry.deletions))
    ?'<span class="git-file-stats">'+(Number.isFinite(entry.additions)?'<span class="plus">+'+entry.additions+'</span>':'')+(Number.isFinite(entry.deletions)?'<span class="minus">−'+entry.deletions+'</span>':'')+'</span>'
    :'';
  row.innerHTML='<span class="git-file-mark">'+escapeHtml(gitStatusMark(entry.status))+'</span>'
    +'<span class="git-file-path">'+escapeHtml(shortPath(entry.path))+'</span>'+stats+'<span class="git-file-actions"></span>';
  const host=row.querySelector('.git-file-actions');
  for(const action of actions){
    const button=document.createElement('button');
    button.type='button';
    button.className='git-file-action';
    button.textContent=t(GIT_FILE_ACTION_LABELS[action]||action);
    button.onclick=function(){void runGitFileAction(action,entry.path)};
    host.append(button);
  }
  return row;
}

function renderGitList(containerId,entries,actions,emptyLabel){
  const host=$(containerId);
  if(!host)return;
  host.innerHTML='';
  if(!entries.length){host.innerHTML='<div class="git-empty">'+escapeHtml(t(emptyLabel))+'</div>';return}
  for(const entry of entries)host.append(gitFileRow(entry,actions));
}

async function runGitFileAction(action,path){
  const labels={stage:t('Stage'),unstage:t('Unstage'),discard:t('Discard')};
  // 丢弃是唯一会真的丢东西的动作：确认文案与按钮文案一致，别让用户猜哪个按钮更狠。
  try{
    if(action==='discard'){
      const ok=await gitConfirm({title:labels.discard,message:t('These edits will be lost. This cannot be undone.'),confirmLabel:labels.discard,danger:true});
      if(!ok)return;
    }
    await gitCall(action,{paths:[path]});
    toast(labels[action]||action);
  }catch(error){toast(error.message)}
  await refreshGitPanel();
}

function gitWorktreeRow(entry,index){
  const row=document.createElement('div');
  row.className='git-file';
  const isMain=index===0;
  row.innerHTML='<span class="git-file-mark">'+escapeHtml(entry.branch||(entry.detached?'detached':'—'))+'</span>'
    +'<span class="git-file-path">'+escapeHtml(shortPath(entry.path))+'</span><span class="git-file-actions"></span>';
  const host=row.querySelector('.git-file-actions');
  const open=document.createElement('button');
  open.type='button';
  open.className='git-file-action';
  open.textContent=t('Open');
  open.onclick=function(){setWorkspace(entry.path);toast(t('Workspace switched'));void refreshGitPanel()};
  host.append(open);
  if(!isMain){
    const remove=document.createElement('button');
    remove.type='button';
    remove.className='git-file-action danger';
    remove.textContent=t('Remove');
    remove.onclick=function(){void removeGitWorktree(entry.path)};
    host.append(remove);
  }
  return row;
}

async function removeGitWorktree(path){
  const ok=await gitConfirm({title:t('Remove worktree'),message:path,danger:true,confirmLabel:t('Remove')});
  if(!ok)return;
  try{await gitCall('worktreeRemove',{path})}
  catch(error){
    const force=await gitConfirm({title:t('Removal failed'),message:error.message+'\n\n'+t('Force removal deletes uncommitted work in that worktree.'),danger:true,confirmLabel:t('Force remove')});
    if(force){try{await gitCall('worktreeRemove',{path,force:true})}catch(second){toast(second.message)}}
  }
  await refreshGitPanel();
}

function syncGitControls(){
  const busy=Boolean(gitState.busy);
  for(const id of ['#gitRefresh','#gitFetch','#gitPull','#gitPush','#gitCommitButton','#gitWorktreeCreate','#gitWorktreePrune']){
    const control=$(id);
    if(control)control.disabled=busy;
  }
}

function renderGitPanel(){
  const notice=$('#gitNotice');
  if(notice){
    if(gitState.error){notice.hidden=false;notice.textContent=gitState.error}
    else if(!gitState.loaded){notice.hidden=false;notice.textContent=t('Loading…')}
    else{notice.hidden=true;notice.textContent=''}
  }
  const branch=$('#gitBranch');
  if(branch)branch.textContent=gitState.repo?(gitState.detached?t('Detached HEAD'):(gitState.branch||'—')):'—';
  const upstream=$('#gitUpstream');
  if(upstream){
    if(gitState.repo&&gitState.upstream){
      upstream.hidden=false;
      upstream.textContent=gitState.upstream
        +((Number.isFinite(gitState.ahead)&&gitState.ahead)?' ↑'+gitState.ahead:'')
        +((Number.isFinite(gitState.behind)&&gitState.behind)?' ↓'+gitState.behind:'');
    }else upstream.hidden=true;
  }
  const operation=$('#gitOperation');
  if(operation){
    if(gitState.operation){operation.hidden=false;operation.textContent=t('In progress: ')+gitState.operation}
    else operation.hidden=true;
  }
  const count=(id,value)=>{const el=$(id);if(el)el.textContent=String(value)};
  count('#gitStagedCount',gitState.staged.length);
  count('#gitUnstagedCount',gitState.unstaged.length);
  count('#gitUntrackedCount',gitState.untracked.length);
  renderGitList('#gitStagedList',gitState.staged,['unstage'],'Nothing staged');
  renderGitList('#gitUnstagedList',gitState.unstaged,['stage','discard'],'No changes');
  renderGitList('#gitUntrackedList',gitState.untracked,['stage'],'No untracked files');
  const worktrees=$('#gitWorktreeList');
  if(worktrees){
    worktrees.innerHTML='';
    if(!gitState.worktrees.length)worktrees.innerHTML='<div class="git-empty">'+escapeHtml(t('No worktrees'))+'</div>';
    else gitState.worktrees.forEach(function(entry,index){worktrees.append(gitWorktreeRow(entry,index))});
  }
}

async function refreshGitPanel(){
  gitState.busy=true;
  syncGitControls();
  try{
    const data=await gitCall('status');
    gitState.repo=data.repo;gitState.name=data.name;gitState.branch=data.branch;gitState.detached=Boolean(data.detached);
    gitState.upstream=data.upstream;gitState.ahead=data.ahead;gitState.behind=data.behind;gitState.operation=data.operation;
    gitState.staged=data.staged||[];
    gitState.unstaged=data.unstaged||[];
    gitState.untracked=(data.untracked||[]).map(function(path){return {path,status:'A'}});
    gitState.worktrees=data.worktrees||[];
    gitState.error=null;
  }catch(error){
    gitState.error=error.message;
    gitState.repo=null;gitState.branch=null;gitState.detached=false;gitState.upstream=null;gitState.ahead=null;gitState.behind=null;
    gitState.operation=null;gitState.staged=[];gitState.unstaged=[];gitState.untracked=[];gitState.worktrees=[];
  }
  gitState.loaded=true;
  gitState.busy=false;
  clientLog('git panel['+(gitState.repo||'no repo')+'] err='+(gitState.error||'-')+' staged='+gitState.staged.length+' changes='+gitState.unstaged.length+' untracked='+gitState.untracked.length+' worktrees='+gitState.worktrees.length);
  renderGitPanel();
  syncGitControls();
}

function openGitPanel(){
  const tab=$('#utilityTab');
  if(tab){tab.textContent=t('Git');tab.dataset.sidePanelTab='git';tab.hidden=false}
  setSidePanelOpen(true,false);
  setSidePanelView('git',t('Git'));
  void refreshGitPanel().then(autoFetchGitPanel);
}

// 尽力取一次远端引用：本地没有 remote、断网、需要凭据都属正常，静默跳过——
// 它只负责把 ahead/behind 从"上次的样子"更新成"现在的样子"。
async function autoFetchGitPanel(){
  try{await gitCall('fetch')}catch(error){return}
  await refreshGitPanel();
}

async function gitCommitFromPanel(){
  const field=$('#gitCommitMessage');
  const message=field?field.value.trim():'';
  if(!message){toast(t('Commit message is required'));return}
  try{
    const result=await gitCall('commit',{message});
    if(field)field.value='';
    toast(result.summary||t('Committed'));
  }catch(error){toast(error.message)}
  await refreshGitPanel();
}

async function gitRemoteAction(action){
  const label=action==='pull'?t('Pull'):t('Push');
  const message=action==='pull'
    ?t('Fetch and fast-forward the current branch. No merge commit is created.')
    :t('Push the current branch to its upstream. This publishes commits to the remote.');
  const ok=await gitConfirm({title:label,message,confirmLabel:label});
  if(!ok)return;
  toast(label+'…');
  try{const result=await gitCall(action);toast(result.output||label)}catch(error){toast(error.message)}
  await refreshGitPanel();
}

function defaultWorktreePath(branch){
  const slug=String(branch||'').replace(/[^A-Za-z0-9._-]+/g,'-').replace(/^-+|-+$/g,'')||'worktree';
  return '~/codex-worktrees/'+(gitState.name||'repo')+'-'+slug;
}

async function createGitWorktree(){
  const branchField=$('#gitWorktreeBranch');
  const pathField=$('#gitWorktreePath');
  const branch=branchField?branchField.value.trim():'';
  if(!branch){toast(t('Branch name is required'));return}
  const path=pathField&&pathField.value.trim()?pathField.value.trim():defaultWorktreePath(branch);
  const createBranch=$('#gitWorktreeNewBranch')?$('#gitWorktreeNewBranch').checked:true;
  try{
    const result=await gitCall('worktreeAdd',{path,branch,createBranch});
    toast(t('Worktree created')+': '+shortPath(result.path));
    if(branchField)branchField.value='';
    if(pathField)pathField.value='';
    const use=await gitConfirm({title:t('Switch workspace?'),message:t('Use this worktree as the working folder for new sessions?')+'\n'+result.path,confirmLabel:t('Switch')});
    if(use)setWorkspace(result.path);
  }catch(error){toast(error.message)}
  await refreshGitPanel();
}

function wireGitPanel(){
  const refresh=$('#gitRefresh');
  if(refresh)refresh.onclick=function(){void refreshGitPanel()};
  const fetch=$('#gitFetch');
  if(fetch)fetch.onclick=async function(){
    try{await gitCall('fetch');toast(t('Fetched'))}catch(error){toast(error.message)}
    await refreshGitPanel();
  };
  const pull=$('#gitPull');
  if(pull)pull.onclick=function(){void gitRemoteAction('pull')};
  const push=$('#gitPush');
  if(push)push.onclick=function(){void gitRemoteAction('push')};
  const commit=$('#gitCommitButton');
  if(commit)commit.onclick=function(){void gitCommitFromPanel()};
  const create=$('#gitWorktreeCreate');
  if(create)create.onclick=function(){void createGitWorktree()};
  const prune=$('#gitWorktreePrune');
  if(prune)prune.onclick=async function(){
    try{const result=await gitCall('worktreePrune');toast(result.output||t('Pruned'))}catch(error){toast(error.message)}
    await refreshGitPanel();
  };
  const pathField=$('#gitWorktreePath');
  const branchField=$('#gitWorktreeBranch');
  if(branchField&&pathField)branchField.addEventListener('input',function(){
    if(!pathField.dataset.touched)pathField.placeholder=defaultWorktreePath(branchField.value);
  });
  if(pathField)pathField.addEventListener('input',function(){pathField.dataset.touched='true'});
}
wireGitPanel();

// --- 手机端终端辅助按键（patches/0066）-------------------------------------
// 手机没有 Ctrl/Tab/Esc/方向键。这里把按键直接编码成字节写进 pty（二进制帧=键盘输入，
// 与 xterm 自己的 onData 走同一条路），Ctrl+C 就是 \x03，由 pty 的 ISIG 送给前台进程组。
const TERMINAL_KEYS={esc:'\u001b',tab:'\t','ctrl-c':'\u0003','ctrl-d':'\u0004','ctrl-z':'\u001a','ctrl-l':'\u000c',up:'\u001b[A',down:'\u001b[B',right:'\u001b[C',left:'\u001b[D'};

// 手机上终端是侧栏那一个；桌面上可能用底部面板，所以按"连着的那个"发。
function activeTerminalState(){
  const connected=(state)=>state&&state.ws&&state.ws.readyState===WebSocket.OPEN;
  if(connected(terminalStates.side))return terminalStates.side;
  if(connected(terminalStates.bottom))return terminalStates.bottom;
  return terminalStates.side||terminalStates.bottom||null;
}

function sendTerminalKey(kind){
  const data=TERMINAL_KEYS[kind];
  if(!data)return;
  const terminalState=activeTerminalState();
  const ws=terminalState&&terminalState.ws;
  if(!ws||ws.readyState!==WebSocket.OPEN){toast(t('Terminal is not connected'));return}
  ws.send(new TextEncoder().encode(data));
  try{terminalState.term?.focus()}catch(error){}
}

function wireTerminalKeys(){
  for(const button of document.querySelectorAll('[data-terminal-key]')){
    button.onclick=function(){sendTerminalKey(button.dataset.terminalKey)};
  }
}
wireTerminalKeys();

// --- 文件面板（patches/0067）------------------------------------------------
// 后端是协议的 fs/readDirectory / fs/readFile / fs/writeFile（桥转成 /api/fs）。
// 手机上一屏只做一件事：列表（目录在前）→ 点文件进查看 → 编辑切换 → 保存。
// 读取上限 2 MB、超出/二进制都明说，不截断也不假装成功。
// 用一个只可能由本补丁引入的字符串做标记：上游也许会有 `kind==='files'`，但不会有这个。
// 标记本身不参与逻辑（永远为 false），只用来让脚本认出"打过了"。
const filesPanelMarker=null;
const filesState={path:null,parent:null,root:null,entries:[],notice:null,busy:false,open:null,editing:false};

function filesWorkspaceRoot(){return state.active?.cwd||state.workspaceContext?.cwd||state.config?.defaultCwd||null}

function formatBytes(bytes){
  const value=Number(bytes)||0;
  if(value<1024)return value+' B';
  if(value<1024*1024)return (value/1024).toFixed(1)+' KB';
  return (value/1048576).toFixed(1)+' MB';
}

async function filesCall(action,extra){
  const response=await fetch('/api/fs',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(Object.assign({action},extra||{}))});
  const data=await response.json().catch(function(){return {}});
  clientLog('fs '+action+' -> '+response.status+(response.ok?'':' '+(data.error||'')));
  if(!response.ok)throw new Error(data.error||('Files '+action+' failed'));
  return data;
}

function renderFilesPanel(){
  const notice=$('#filesNotice');
  if(notice){
    if(filesState.notice){notice.hidden=false;notice.textContent=filesState.notice}
    else{notice.hidden=true;notice.textContent=''}
  }
  const path=$('#filesPath');
  if(path)path.textContent=filesState.path?shortPath(filesState.path):'—';
  const up=$('#filesUp');
  if(up)up.disabled=!filesState.path||filesState.path===filesState.root;
  const list=$('#filesList');
  if(!list)return;
  list.innerHTML='';
  if(filesState.busy){list.innerHTML='<div class="files-empty">'+escapeHtml(t('Loading…'))+'</div>';return}
  if(!filesState.entries.length){list.innerHTML='<div class="files-empty">'+escapeHtml(t('Nothing here'))+'</div>';return}
  for(const entry of filesState.entries){
    const row=document.createElement('button');
    row.type='button';
    row.className='files-row'+(entry.directory?' directory':'');
    row.innerHTML='<span class="icon-slot">'+codexIcon(entry.directory?'folderOpen':'file')+'</span>'
      +'<span class="files-row-name">'+escapeHtml(entry.name)+'</span>';
    row.onclick=function(){entry.directory?void openFilesDir(entry.path):void openFilesFile(entry.path)};
    list.append(row);
  }
}

async function openFilesDir(path){
  if(!path)return;
  filesState.busy=true;filesState.notice=null;renderFilesPanel();
  try{
    const data=await filesCall('list',{path});
    filesState.path=data.path;
    filesState.parent=data.parent;
    filesState.entries=data.entries||[];
    if(!filesState.root)filesState.root=data.path;
  }catch(error){filesState.notice=error.message;filesState.entries=[]}
  filesState.busy=false;
  renderFilesPanel();
}

async function openFilesFile(path){
  filesState.busy=true;filesState.notice=null;renderFilesPanel();
  try{
    const data=await filesCall('read',{path});
    filesState.open=data;
    filesState.editing=false;
    // 手机上查看器要独占面板：列表让位（否则内容排在整页目录下面，等于打不开）。
    filesPanelFocusViewer(true);
    const name=$('#filesViewerName');
    if(name)name.textContent=shortPath(data.path)+' · '+formatBytes(data.size);
    const text=$('#filesViewerText');
    const editor=$('#filesViewerEditor');
    const edit=$('#filesViewerEdit');
    const save=$('#filesViewerSave');
    const imageBox=$('#filesViewerImage'),imageNode=$('#filesViewerImageNode');
    const extension=String(data.path||'').split('.').pop();
    // 图片直接内联显示（走 /api/images/local）；其余二进制仍如实说"不能预览"，但可以打开/分享。
    const isImage=!data.binary&&FILES_IMAGE_EXTENSIONS.test(extension||'');
    if(isImage){
      if(text)text.hidden=true;
      if(editor)editor.hidden=true;
      if(imageNode)imageNode.src=filesImageUrl(data.path);
      if(imageBox)imageBox.hidden=false;
      if(edit)edit.hidden=true;
      if(save)save.hidden=true;
      return;
    }
    if(imageBox)imageBox.hidden=true;
    if(imageNode)imageNode.removeAttribute('src');
    if(data.binary){
      if(text){text.hidden=false;text.textContent=t('Binary file — no text preview')}
      if(editor){editor.hidden=true;editor.value=''}
      if(edit)edit.hidden=true;
    }else{
      if(text){text.hidden=false;text.textContent=data.text}
      if(editor){editor.hidden=true;editor.value=data.text}
      if(edit)edit.hidden=false;
    }
    if(save)save.hidden=true;
    syncFilesPreviewButton();
  }catch(error){filesState.notice=error.message}
  filesState.busy=false;
  renderFilesPanel();
}

function filesPanelFocusViewer(viewing){
  const list=$('#filesList'),search=$('#filesSearchForm'),viewer=$('#filesViewer');
  if(list)list.hidden=viewing;
  if(search)search.hidden=viewing;
  if(viewer)viewer.hidden=!viewing;
}
function closeFilesFile(){
  filesState.open=null;filesState.editing=false;
  filesPanelFocusViewer(false);
}

function toggleFilesEdit(){
  if(!filesState.open||filesState.open.binary)return;
  filesState.editing=!filesState.editing;
  const text=$('#filesViewerText'),editor=$('#filesViewerEditor'),save=$('#filesViewerSave');
  if(editor)editor.hidden=!filesState.editing;
  if(text)text.hidden=filesState.editing;
  if(save)save.hidden=!filesState.editing;
  if(filesState.editing&&editor)editor.focus();
}

async function saveFilesFile(){
  const editor=$('#filesViewerEditor');
  if(!filesState.open||!editor)return;
  const target=filesState.open.path;
  const ok=await gitConfirm({title:t('Save file?'),message:shortPath(target),confirmLabel:t('Save')});
  if(!ok)return;
  try{
    const bytes=new TextEncoder().encode(editor.value);
    let raw='';
    for(const byte of bytes)raw+=String.fromCharCode(byte);
    const data=await filesCall('write',{path:target,dataBase64:btoa(raw)});
    filesState.open={path:target,size:data.size,binary:false,text:editor.value};
    const text=$('#filesViewerText');
    if(text)text.textContent=editor.value;
    toggleFilesEdit();
    toast(t('Saved'));
  }catch(error){toast(error.message)}
}

async function searchFiles(query){
  const needle=String(query||'').trim();
  if(!needle){await openFilesDir(filesState.path||filesWorkspaceRoot());return}
  filesState.busy=true;filesState.notice=null;renderFilesPanel();
  try{
    const root=filesWorkspaceRoot()||filesState.root;
    const data=await filesCall('search',{cwd:root,query:needle});
    // 搜索结果给的是**工作区相对路径**（file-search.js 里就是 relativePath），
    // 必须补成绝对路径，否则点开时桥按自己的 cwd 解析、直接 ENOENT（真机撞过）。
    const filesSearchAbsolutePath=function(raw){const value=String(raw||'');if(!value||value.startsWith('/'))return value;return ((root||'').replace(/\/+$/,'')+'/'+value).replace(/\/{2,}/g,'/')};
    filesState.entries=(data.items||[]).map(function(item){const path=filesSearchAbsolutePath(item.path);return {name:shortPath(path||item.name||''),path,directory:item.kind==='folder'}});
    filesState.path=null;
    if(!filesState.entries.length)filesState.notice=t('No matches');
  }catch(error){filesState.notice=error.message;filesState.entries=[]}
  filesState.busy=false;
  renderFilesPanel();
}

// ---- 点模型输出里的文件引用（patches/0102）-----------------------------------
// 之前这里缺了监听：渲染层生成的 `<a data-file-reference>` 被点击后只派发一个事件，
// 没有任何人接，而点击处理器已经 preventDefault 了 —— 用户看到的就是"点了没反应"。
function resolveFileReferencePath(rawPath,cwd){
  const value=String(rawPath||'').trim();
  if(!value)return '';
  if(value.startsWith('~/'))return String(state.config?.home||'').replace(/\/$/,'')+'/'+value.slice(2);
  if(value.startsWith('/'))return value;
  const base=String(cwd||'').replace(/\/$/,'');
  if(!base)return value;
  // 相对路径里可能有 ./ 前缀，交给桥那边的路径解析去规范化，这里只负责拼出绝对路径
  return base+(value.startsWith('./')?value.slice(1):'/'+value);
}
async function openFileReference(reference){
  const raw=String(reference?.path||'').trim();
  if(!raw){clientLog('file reference: empty path, ignored');return}
  const cwd=filesWorkspaceRoot();
  const target=resolveFileReferencePath(raw,cwd);
  clientLog('file reference click: '+raw+' -> '+target);
  openFilesPanel();
  try{
    await openFilesFile(target);
    if(filesState.notice)throw new Error(filesState.notice);
    const lineStart=Number(reference?.lineStart)||0;
    const lineEnd=Number(reference?.lineEnd)||0;
    if(lineStart>0){
      const name=$('#filesViewerName');
      if(name)name.textContent=shortPath(target)+(lineEnd&&lineEnd!==lineStart?': '+lineStart+'-'+lineEnd:': '+lineStart);
      // 文本查看器是个滚动容器：按行号比例滚过去就够了（精确到行的排版依赖字体，不值当）。
      const viewer=$('#filesViewerText');
      const total=String(filesState.open?.text||'').split('\n').length;
      if(viewer&&total>1)viewer.scrollTop=Math.max(0,(lineStart-1)/(total-1)*(viewer.scrollHeight-viewer.clientHeight));
    }
  }catch(error){
    const detail=(error&&error.message)||String(error);
    clientLog('file reference FAILED: '+target+' -> '+detail);
    toast(t('Could not open this file')+': '+detail,9000);
  }
}
addEventListener('codex-webui:file-reference',function(event){void openFileReference(event.detail||{})});
function openFilesPanel(){
  const tab=$('#utilityTab');
  if(tab){tab.textContent=t('Files');tab.dataset.sidePanelTab='files';tab.hidden=false}
  setSidePanelOpen(true,false);
  setSidePanelView('files',t('Files'));
  const root=filesWorkspaceRoot();
  filesState.root=root;
  closeFilesFile();
  void openFilesDir(filesState.path||root);
}

function wireFilesPanel(){
  const up=$('#filesUp');
  if(up)up.onclick=function(){if(filesState.parent)void openFilesDir(filesState.parent)};
  const root=$('#filesRoot');
  if(root)root.onclick=function(){const target=filesWorkspaceRoot();filesState.root=target;void openFilesDir(target)};
  const form=$('#filesSearchForm');
  if(form)form.onsubmit=function(event){event.preventDefault();void searchFiles($('#filesSearchInput').value)};
  const close=$('#filesViewerClose');
  if(close)close.onclick=closeFilesFile;
  const edit=$('#filesViewerEdit');
  if(edit)edit.onclick=toggleFilesEdit;
  const save=$('#filesViewerSave');
  if(save)save.onclick=function(){void saveFilesFile()};
}
wireFilesPanel();

// --- 审查目标（patches/0084）------------------------------------------------
// `review/start {threadId,target}`：target 四种变体见 proto-ts/v2/ReviewTarget.ts。
// 它会**真发起一次审查回合**（结论出现在对话里），所以按钮文案与 toast 都要说清楚。
async function startReview(target){
  const threadId=state.active?.id;
  if(!threadId){toast(t('No active conversation'));return}
  try{
    const result=await rpc('review/start',{threadId,target});
    clientLog('review/start -> '+JSON.stringify(result||{}).slice(0,140));
    toast(t('Review started — the result appears in the conversation'));
  }catch(error){clientLog('review/start FAILED: '+error.message);toast(error.message)}
  closeReviewTarget();
}

function closeReviewTarget(){
  const dialog=$('#reviewTargetDialog');
  if(dialog&&dialog.open)try{dialog.close()}catch(error){}
}

function reviewTargetOption(label,description,onclick){
  const button=document.createElement('button');
  button.type='button';
  button.className='review-target-option';
  button.innerHTML='<strong>'+escapeHtml(label)+'</strong><small>'+escapeHtml(description)+'</small>';
  button.onclick=onclick;
  return button;
}

async function openReviewTarget(){
  const dialog=$('#reviewTargetDialog'),list=$('#reviewTargetList'),custom=$('#reviewTargetCustom');
  if(!dialog||!list)return;
  list.innerHTML='';
  if(custom)custom.hidden=true;
  list.append(
    reviewTargetOption(t('Uncommitted changes'),t('Everything not yet committed'),function(){void startReview({type:'uncommittedChanges'})}),
    reviewTargetOption(t('Compare against a branch'),t('Pick a base branch'),function(){void listReviewBranches()}),
    reviewTargetOption(t('Review a commit'),t('Pick a recent commit'),function(){void listReviewCommits()}),
    reviewTargetOption(t('Custom instructions'),t('Describe what to review'),function(){if(custom)custom.hidden=false;const input=$('#reviewTargetInput');if(input)input.focus()}),
  );
  try{dialog.showModal()}catch(error){toast(error.message)}
}

async function listReviewBranches(){
  const list=$('#reviewTargetList');
  if(!list)return;
  list.innerHTML='<div class="review-target-empty">'+escapeHtml(t('Loading…'))+'</div>';
  try{
    const data=await gitCall('branches');
    list.innerHTML='';
    for(const branch of (data.branches||[]).slice(0,20)){
      list.append(reviewTargetOption(branch.name,branch.short||'',function(){void startReview({type:'baseBranch',branch:branch.name})}));
    }
    if(!list.childElementCount)list.innerHTML='<div class="review-target-empty">'+escapeHtml(t('No branches'))+'</div>';
  }catch(error){list.innerHTML='<div class="review-target-empty">'+escapeHtml(error.message)+'</div>'}
}

async function listReviewCommits(){
  const list=$('#reviewTargetList');
  if(!list)return;
  list.innerHTML='<div class="review-target-empty">'+escapeHtml(t('Loading…'))+'</div>';
  try{
    const data=await gitCall('log',{limit:20});
    list.innerHTML='';
    for(const commit of (data.commits||[])){
      list.append(reviewTargetOption(commit.short+' · '+commit.subject,commit.date||'',function(){void startReview({type:'commit',sha:commit.sha,title:commit.subject})}));
    }
    if(!list.childElementCount)list.innerHTML='<div class="review-target-empty">'+escapeHtml(t('No commits'))+'</div>';
  }catch(error){list.innerHTML='<div class="review-target-empty">'+escapeHtml(error.message)+'</div>'}
}

// --- 行内定位：agentMessage.memoryCitation（patches/0084）--------------------
// 协议形状：{entries:[{path,lineStart,lineEnd,note}]}（ThreadItem.ts / MemoryCitationEntry.ts）。
// 点一下 → 打开文件面板 → 打开该文件 → 滚到那一行附近。
function citationHtml(item){
  const entries=item?.memoryCitation?.entries;
  if(!Array.isArray(entries)||!entries.length)return '';
  return '<div class="message-citations">'+entries.map(function(entry,index){
    const path=String(entry?.path||'');
    if(!path)return '';
    const label=shortPath(path)+' :'+String(entry.lineStart||1)+(entry.lineEnd&&entry.lineEnd!==entry.lineStart?'-'+entry.lineEnd:'');
    return '<button type="button" class="message-citation" data-citation-index="'+index+'" title="'+escapeHtml(entry.note||label)+'">'+escapeHtml(label)+'</button>';
  }).join('')+'</div>';
}

async function openCitation(path,line){
  const target=String(path||'');
  if(!target)return;
  openFilesPanel();
  await openFilesFile(target);
  const viewer=$('#filesViewerText');
  if(!viewer)return;
  // 等一帧再滚：查看器刚被填充。行高按等宽字号估算（差几行不影响定位用途）。
  requestAnimationFrame(function(){
    const lineHeight=parseFloat(getComputedStyle(viewer).lineHeight)||18;
    viewer.scrollTop=Math.max(0,(Number(line||1)-3)*lineHeight);
  });
}

function wireReviewTargets(){
  const button=$('#reviewTargetButton');
  if(button)button.onclick=function(){void openReviewTarget()};
  const close=$('#reviewTargetClose');
  if(close)close.onclick=closeReviewTarget;
  const go=$('#reviewTargetGo');
  if(go)go.onclick=function(){const field=$('#reviewTargetInput');const value=field?field.value.trim():'';if(!value){toast(t('Describe what to review'));return}void startReview({type:'custom',instructions:value})};
  // 行内定位用事件委托：消息随时会重渲染，绑定在 document 上最省事。
  document.addEventListener('click',function(event){
    const chip=event.target?.closest?.('.message-citation');
    if(!chip)return;
    const message=chip.closest('.assistant-response');
    const item=message&&state.items.get(message.dataset.itemId||'');
    const entries=item?.memoryCitation?.entries;
    const entry=entries?entries[Number(chip.dataset.citationIndex)]:null;
    if(entry)void openCitation(entry.path,entry.lineStart);
  });
}
wireReviewTargets();

// --- 设置页的真数据（patches/0085）------------------------------------------
// 上游的设置页大多是静态占位符（"Not configured"），这里按页去取**真实**信息：
//   agent → config/read + permissionProfile/list（含沙箱在本平台是否生效的实测结论）
//   profile → account/read + usage/rateLimits（第三方 provider 的真实原因）
//   plugins-settings → plugin/installed + mcpServerStatus/list
//   skills-settings → skills/list    hooks-settings → hooks/list
// 拿不到就显示真实错误文本，不写"None"糊弄。
const SETTINGS_PLATFORM_NOTES={
  'browser-use':['浏览器自动化','本机 app-server 没有 browser_use 后端（Android 上无对应实现）；要预览网页请用侧栏「浏览器」面板，它是普通 WebView，不是自动化驱动。'],
  'computer-use':['电脑操作','无 Android 对等实现（依赖桌面图形栈）。替代：本项目的无障碍桥 CodexBridge 能驱动本机 UI，但那是另一套东西。'],
  connections:['连接器','connector 依赖官方账户（第三方 provider 下不可用）。替代：直接用 MCP 服务器，见 Plugins 页。'],
  'cloud-settings':['云任务','Codex Cloud 依赖官方账户；本机 provider 是第三方，不可用。替代：本地会话 + 后台任务（P8 会做本地调度）。'],
  'cloud-environments':['云环境','同上：需要官方账户。替代：本地 worktree（Git 面板里已可用）。'],
  worktrees:['worktree','本机走侧栏 Git 面板的 worktree 段（创建/打开/删除/清理）——那是真实实现，不是这个占位页。'],
  'git-settings':['Git','本机走侧栏 Git 面板：暂存/提交/推送/拉取/丢弃/worktree 都是桥直接调 git。'],
  'data-controls':['归档会话','侧栏「已归档」入口可以直接恢复会话。'],
};

function settingsRow(label,value,note){
  const row=document.createElement('div');
  row.className='settings-row settings-readonly-row';
  const copy=document.createElement('span'),strong=document.createElement('strong'),status=document.createElement('span');
  strong.textContent=t(label);
  copy.append(strong);
  if(note)copy.append(Object.assign(document.createElement('small'),{className:'settings-row-note',textContent:note}));
  status.className='settings-row-value';
  status.textContent=value;
  row.append(copy,status);
  return row;
}

function settingsNotice(text,tone){
  const note=document.createElement('p');
  note.className='settings-notice'+(tone?' '+tone:'');
  note.textContent=text;
  return note;
}

// ---- 定时任务页（patches/0096）：后端是桥自己的 /api/automation，不是 app-server 方法 ----
async function automationCall(action,extra){
  const response=await fetch('/api/automation',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(Object.assign({action:action},extra||{}))});
  const data=await response.json().catch(function(){return{}});
  if(!response.ok)throw new Error((data&&data.error)||'Automation request failed');
  return data;
}
function automationClock(ms){
  if(!ms)return '—';
  const date=new Date(ms),now=new Date();
  const clock=String(date.getHours()).padStart(2,'0')+':'+String(date.getMinutes()).padStart(2,'0');
  return date.toDateString()===now.toDateString()?clock:(String(date.getMonth()+1)+'/'+String(date.getDate())+' '+clock);
}
// 状态标签用英文当源串，中文交给 i18n（项目和其它页面一致）
const automationRunLabels={ok:'Completed',failed:'Failed',timeout:'Timed out',interrupted:'Interrupted',skipped:'Skipped',running:'Running'};
function automationRunLabel(status){return t(automationRunLabels[status]||status||'')}
function automationField(labelText,control){
  const row=document.createElement('div');row.className='settings-write-row';
  row.append(Object.assign(document.createElement('strong'),{textContent:t(labelText)}),control);
  return row;
}
function automationInput(type,placeholder,value){
  const input=document.createElement('input');input.type=type;
  if(placeholder)input.placeholder=t(placeholder);
  if(value!==undefined)input.value=value;
  input.autocomplete='off';input.spellcheck=false;
  return input;
}
function automationSelect(options,value){
  const select=document.createElement('select');
  for(const option of options){const item=document.createElement('option');item.value=option.value;item.textContent=t(option.label);if(option.value===value)item.selected=true;select.append(item)}
  return select;
}
function automationCreateForm(reload){
  const form=document.createElement('div');form.className='settings-automation-form';
  const name=automationInput('text','Task name','');
  const prompt=automationInput('text','Prompt to send each run','');
  const defaultCwd=(state.workspaceContext&&state.workspaceContext.cwd)||state.config.defaultCwd||'';
  const cwd=automationInput('text','Working directory',defaultCwd);
  const scheduleType=automationSelect([{value:'daily',label:'Daily'},{value:'weekdays',label:'Weekdays'},{value:'weekly',label:'Weekly'},{value:'hourly',label:'Every N hours'}],'daily');
  const interval=automationSelect([1,2,3,4,6,8,12].map(function(hours){return{value:String(hours),label:String(hours)+' h'}}),'1');
  const time=document.createElement('input');time.type='time';time.value='09:00';
  const dayBoxes={};
  const dayRow=document.createElement('div');dayRow.className='settings-write-row';
  dayRow.append(Object.assign(document.createElement('strong'),{textContent:t('Day of week')}));
  for(const day of ['mon','tue','wed','thu','fri','sat','sun']){
    const label=document.createElement('label');label.className='settings-day-toggle';
    const box=document.createElement('input');box.type='checkbox';box.value=day;dayBoxes[day]=box;
    label.append(box,document.createTextNode(t(day)));dayRow.append(label);
  }
  const intervalRow=automationField('Every N hours',interval);
  const timeRow=automationField('Time',time);
  const targetMode=automationSelect([{value:'newThread',label:'A new conversation'},{value:'continueThread',label:'An existing conversation'}],'newThread');
  // automationThreadPicker（patches/0099）：会话选择器。真的从 thread/list 拉最近 50 条；
  // 拉不到就退回手填并说明原因——空下拉框会让人误以为"没有会话"。
  const targetPick=document.createElement('select');
  const targetPickRow=automationField('An existing conversation',targetPick);
  const targetThread=automationInput('text','Conversation id','');
  const targetThreadRow=automationField('Conversation id (manual)',targetThread);
  const targetNotice=settingsNotice(t('Loading conversations…'));
  const targetNoticeRow=document.createElement('div');targetNoticeRow.className='settings-write-row';targetNoticeRow.append(targetNotice);
  let targetFallback=false,targetsLoaded=false;
  const loadTargets=async function(){
    try{
      const result=await rpc('thread/list',{limit:50,sortKey:'recency_at',sortDirection:'desc'});
      const threads=(result&&result.data)||[];
      targetPick.replaceChildren();
      if(!threads.length){
        targetPick.append(Object.assign(document.createElement('option'),{value:'',textContent:t('No conversations yet')}));
        targetNotice.textContent=t('No conversations to continue yet — the first one appears here after you chat once.');
        return;
      }
      for(const thread of threads){
        const label=String(thread.name||thread.title||thread.preview||t('Untitled')).slice(0,60)+' · '+String(thread.id).slice(0,8);
        targetPick.append(Object.assign(document.createElement('option'),{value:thread.id,textContent:label}));
      }
      targetNoticeRow.hidden=true;
    }catch(error){
      targetFallback=true;
      targetNotice.textContent=t('Could not load conversations')+': '+(error&&error.message?error.message:String(error))+' '+t('— type the conversation id instead.');
      syncTarget();
    }
  };
  const catchUp=automationSelect([{value:'runOnce',label:'Run the newest missed slot once'},{value:'skip',label:'Do not catch up (still logged)'}],'runOnce');
  const permission=automationSelect([{value:'default',label:'Ask for approval (may wait for you)'},{value:'full-access',label:'Full access (unattended)'}],'default');
  const timeout=automationInput('number','Turn timeout (minutes)','30');
  const syncSchedule=function(){
    const type=scheduleType.value;
    intervalRow.hidden=type!=='hourly';
    timeRow.hidden=type==='hourly';
    dayRow.hidden=type!=='weekly';
  };
  const syncTarget=function(){
    const continuing=targetMode.value==='continueThread';
    targetPickRow.hidden=!continuing||targetFallback;
    targetThreadRow.hidden=!continuing||!targetFallback;
    targetNoticeRow.hidden=!continuing;
    if(continuing&&!targetsLoaded&&!targetFallback){targetsLoaded=true;void loadTargets()}
  };
  scheduleType.onchange=syncSchedule;targetMode.onchange=syncTarget;
  form.append(
    automationField('Task name',name),
    automationField('Prompt to send each run',prompt),
    automationField('Working directory',cwd),
    automationField('Schedule',scheduleType),
    intervalRow,
    timeRow,
    dayRow,
    automationField('Run in',targetMode),
    targetPickRow,
    targetThreadRow,
    targetNoticeRow,
    automationField('If the bridge was away',catchUp),
    automationField('Approval mode',permission),
    automationField('Turn timeout (minutes)',timeout),
  );
  const submitRow=document.createElement('div');submitRow.className='settings-write-row';
  const submit=document.createElement('button');submit.type='button';submit.className='settings-save';submit.textContent=t('Create task');
  submit.onclick=async function(){
    const type=scheduleType.value;
    const schedule=type==='hourly'
      ? {type:'hourly',intervalHours:Number(interval.value)||1}
      : type==='weekly'
        ? {type:'weekly',time:time.value,days:Object.keys(dayBoxes).filter(function(day){return dayBoxes[day].checked})}
        : {type:type,time:time.value};
    const chosenThread=targetFallback?targetThread.value.trim():String(targetPick.value||'').trim();
    if(targetMode.value==='continueThread'&&!chosenThread){toast(t('Pick a conversation first'));submit.disabled=false;return}
    const target=targetMode.value==='continueThread'?{mode:'continueThread',threadId:chosenThread}:{mode:'newThread'};
    submit.disabled=true;
    try{
      await automationCall('create',{job:{name:name.value.trim(),prompt:prompt.value.trim(),cwd:cwd.value.trim(),schedule:schedule,target:target,catchUp:catchUp.value,permissionMode:permission.value,turnTimeoutMinutes:Number(timeout.value)||30}});
      toast(t('A scheduled task was created'));reload();
    }catch(error){toast(error.message)}finally{submit.disabled=false}
  };
  submitRow.append(submit);form.append(submitRow);
  syncSchedule();syncTarget();
  return form;
}
async function renderAutomationSettings(rows){
  let data;
  try{const response=await fetch('/api/automation');if(!response.ok)throw new Error(String(response.status));data=await response.json()}
  catch(error){rows.append(settingsNotice(t('Could not read the local scheduler')+': '+(error&&error.message?error.message:String(error)),'warning'));return true}
  const jobs=Array.isArray(data.jobs)?data.jobs:[],runs=Array.isArray(data.runs)?data.runs:[],limits=data.limits||{};
  rows.append(settingsNotice(t('Scheduled tasks are driven by the local bridge')));
  rows.append(settingsRow(t('What is guaranteed'),String(limits.background||'—'),t('Bridge tick')+': '+Math.round((limits.tickMs||0)/1000)+'s · '+t('Concurrency')+': '+String(limits.concurrency||'?')));
  // 保活与限制（FEATURES 第 7 节最后一行）：三种机制各自解决什么、不解决什么，写清楚而不是含糊承诺。
  const aliveTitle=document.createElement('div');aliveTitle.className='settings-section-title';aliveTitle.textContent=t('Keeping it alive');
  rows.append(aliveTitle);
  rows.append(settingsRow(t('termux-wake-lock'),t('Keeps the CPU awake (codex-gui-web takes it while the bridge runs)'),t('Costs one Termux notification and cannot stop Android from reclaiming the app process.')));
  rows.append(settingsRow(t('Foreground service + pinned notification (APK)'),t('What the APK uses today'),t('Makes the bridge process foreground, so it is far less likely to be killed — not a promise that it never will be.')));
  // 兜底唤醒：这块以前写的是"本项目尚未接入（未验证）"——那是错的。systemd 一样的 15 分钟作业
  // 从 2026-10-15 起就挂着（watchdog.log 每小时 6~8 拍），桥被停掉时它真的拉起来过（E136）。
  // 现在这里显示它的真实状态，缺了还能一键补装。
  const wake=data.wake||{};
  const wakeValue=wake.installed?(t('Registered')+(wake.jobs&&wake.jobs.length?'（'+wake.jobs.length+'）':'')):(wake.scriptExists?t('Not registered'):t('Wake script missing'));
  const wakeRow=settingsRow(t('JobScheduler / termux-job-scheduler'),wakeValue,wake.lastRun?(t('Last run')+': '+wake.lastRun):t('Never ran yet'));
  if(!wake.installed&&wake.scriptExists){
    const install=document.createElement('button');
    install.type='button';install.className='settings-save';install.textContent=t('Register now');
    install.onclick=async function(){
      install.disabled=true;
      try{await automationCall('wakeInstall',{});toast(t('Registered the 15-minute wake-up'));reload()}
      catch(error){toast(error.message)}
      finally{install.disabled=false}
    };
    wakeRow.append(install);
  }
  rows.append(wakeRow);
  if(wake.installed)rows.append(settingsNotice(t('A 15-minute system job keeps the wake lock alive and starts the bridge if it is not running; when the bridge comes back it settles the missed slots with the catch-up rule above. Expect up to ~15 minutes of lateness after the bridge was gone — that is the platform minimum for periodic jobs, not something I can tune away.')));
  const reload=function(){void renderSettingsLive('automation-settings')};
  if(!jobs.length)rows.append(settingsNotice(t('No scheduled tasks yet — create one below.')));
  for(const job of jobs){
    const last=job.lastRun?(t('Last run')+': '+automationRunLabel(job.lastRun.status)):t('Never ran');
    const targetHint=job.target&&job.target.mode==='continueThread'?(t('Continues')+' '+String(job.target.threadId||'').slice(0,8)+' · '):'';
    const row=settingsRow(job.name,job.enabled?automationClock(job.nextRunAt):t('Paused'),targetHint+job.scheduleLabel+' · '+last);
    const actions=document.createElement('div');actions.className='settings-write-row';
    const runButton=document.createElement('button');runButton.type='button';runButton.className='settings-save';runButton.textContent=t('Run now');
    runButton.onclick=async function(){runButton.disabled=true;try{await automationCall('runNow',{id:job.id});toast(t('Started'));setTimeout(reload,1500)}catch(error){toast(error.message)}finally{runButton.disabled=false}};
    const toggle=document.createElement('button');toggle.type='button';toggle.className='settings-save';toggle.textContent=job.enabled?t('Pause'):t('Resume');
    toggle.onclick=async function(){try{await automationCall(job.enabled?'disable':'enable',{id:job.id});reload()}catch(error){toast(error.message)}};
    const remove=document.createElement('button');remove.type='button';remove.className='settings-save';remove.textContent=t('Delete');
    remove.onclick=async function(){
      const confirmed=await gitConfirm({title:t('Delete this scheduled task?'),message:job.name,confirmLabel:t('Delete')});
      if(!confirmed)return;
      try{await automationCall('remove',{id:job.id});reload()}catch(error){toast(error.message)}
    };
    actions.append(runButton,toggle,remove);row.append(actions);rows.append(row);
  }
  rows.append(automationCreateForm(reload));
  rows.append(settingsRow(t('Run history'),String(runs.length),''));
  if(!runs.length)rows.append(settingsNotice(t('No runs yet.')));
  for(const run of runs.slice(0,10)){
    const detail=run.summary||run.error||run.slotId||'';
    // 正在等审批/回答的运行要一眼看出来——不然用户只会看到'运行中'然后半小时后变成超时。
    const awaiting=run.awaiting?(run.awaiting.kind==='approval'?t('Waiting for your approval'):t('Waiting for your answer'))+' · ':'';
    const row=settingsRow((run.jobName||'')+' · '+automationRunLabel(run.status),automationClock(run.finishedAt||run.startedAt),awaiting+String(detail).slice(0,140));
    if(run.threadId){
      const openRun=document.createElement('button');openRun.type='button';openRun.className='settings-save';openRun.textContent=t('Open conversation');
      openRun.onclick=function(){closeSettings();void openThread(run.threadId)};
      row.append(openRun);
    }
    rows.append(row);
  }
  if(runs.length){
    const clearRow=document.createElement('div');clearRow.className='settings-write-row';
    const clearButton=document.createElement('button');clearButton.type='button';clearButton.className='settings-save';clearButton.textContent=t('Clearing run history');
    clearButton.onclick=async function(){
      const confirmed=await gitConfirm({title:t('Clearing run history'),message:String(runs.length),confirmLabel:t('Delete')});
      if(!confirmed)return;
      try{await automationCall('clearRuns',{});reload()}catch(error){toast(error.message)}
    };
    clearRow.append(clearButton);rows.append(clearRow);
  }
  return true;
}
async function renderSettingsLive(page){
  const title=$('#settingsPlaceholderTitle'),description=$('#settingsPlaceholderDescription'),rows=$('#settingsPlaceholderRows');
  if(!rows)return false;
  const hosted=['agent','profile','plugins-settings','skills-settings','hooks-settings','experimental-settings','automation-settings'];
  const platform=SETTINGS_PLATFORM_NOTES[page];
  if(!hosted.includes(page)&&!platform)return false;
  rows.replaceChildren();
  if(page==='automation-settings')return renderAutomationSettings(rows);
  if(description){description.hidden=true;description.textContent=''}
  if(title)title.textContent=t(settingsPages[page]?.title||page);
  if(platform){
    rows.append(settingsNotice(t(platform[0]),'warning'),settingsRow(t('What this build uses instead'),t(platform[1])));
    return true;
  }
  rows.append(settingsNotice(t('Loading…')));
  try{
    if(page==='agent'){
      const config=await rpc('config/read',{});
      const cfg=config?.config||{};
      const profiles=await rpc('permissionProfile/list',{}).catch(function(){return null});
      rows.replaceChildren();
      rows.append(settingsNotice(t('Sandbox is NOT enforced on this platform: measured with read-only and workspace-write policies, commands could still write outside the workspace and reach the network. Treat the permission chips as a display of intent, not as a boundary.'),'warning'));
      rows.append(settingsRow('approval_policy',String(cfg.approval_policy??'—'),t('This is what actually gates commands: the agent asks, and nothing runs until you answer.')));
      rows.append(settingsRow('sandbox_mode',String(cfg.sandbox_mode??'—'),t('Accepted by the backend, but see the notice above — it does not isolate anything here.')));
      rows.append(settingsRow(t('Model'),modelDisplay(selectedModel()),t('Per-conversation; change it in the composer.')));
      rows.append(settingsRow(t('Provider'),String(cfg.model_provider??'—'),''));
      rows.append(settingsRow(t('Reasoning effort'),reasoningLabel($('#effortSelect')?.value),''));
      // 启动自检（patches/0101，E139）：Android 侧的事实由应用上报，Termux 侧由桥现查。
      // 查不到就说查不到（例如应用还没上报过），缺什么给具体动作——不用'未知'糊过去。
      try{
        const setup=await (await fetch('/api/setup')).json();
        const termux=setup.termux||{};
        const androidFacts=(setup.android&&setup.android.facts)||null;
        const selfCheckTitle=document.createElement('div');selfCheckTitle.className='settings-section-title';selfCheckTitle.textContent=t('Startup self-check');
        rows.append(selfCheckTitle);
        rows.append(settingsRow(t('Bridge start script'),(termux.bridgeScript&&termux.bridgeScript.exists?'✅ ':'⚠️ ')+String((termux.bridgeScript&&termux.bridgeScript.path)||'—'),t('What the app asks Termux to run.')));
        const api=termux.termuxApi||{};
        rows.append(settingsRow('Termux:API',['wake-lock','notification','job-scheduler'].map(function(name){const key=name==='wake-lock'?'wakeLock':name==='notification'?'notification':'jobScheduler';return (api[key]?'✅ ':'⚠️ ')+name}).join(' · '),t('Needed for the wake lock, notifications, and the 15-minute fallback wake-up.')));
        rows.append(settingsRow(t('Codex CLI'),String((termux.codex&&termux.codex.version)||t('not found on PATH')),''));
        rows.append(settingsRow(t('Bridge state directory'),((termux.stateDir&&termux.stateDir.writable)?'✅ ':'⚠️ ')+String((termux.stateDir&&termux.stateDir.path)||'—'),t('Automation records and uploads live here.')));
        rows.append(settingsRow(t('Fallback wake-up job'),(termux.wake&&termux.wake.installed)?('✅ '+t('registered')):('⚠️ '+t('not registered')),String((termux.wake&&termux.wake.lastRun)||'')));
        rows.append(settingsRow(t('App side (last report)'),androidFacts?[androidFacts.termuxInstalled?t('Termux installed'):t('Termux missing'),androidFacts.runCommandGranted?t('run command granted'):t('run command NOT granted'),(androidFacts.notificationsAllowed?t('notifications allowed'):t('notifications blocked')),'v'+String(androidFacts.version||'?')].join(' · '):t('no report yet — open the app once'),''));
        if(termux.bridgeScript&&!termux.bridgeScript.exists)rows.append(settingsNotice(t('~/bin/codex-gui-web is missing — the app cannot start the bridge. Restore it from the project or reinstall the Termux side.'),'warning'));
        if(!api.jobScheduler)rows.append(settingsNotice(t('Termux:API is missing: no wake lock, no notifications from Termux, and no 15-minute fallback wake-up.'),'warning'));
        if(androidFacts&&androidFacts.runCommandGranted===false)rows.append(settingsNotice(t('The run-command permission is not granted: every cold start will briefly switch to Termux.')));
      }catch(error){
        rows.append(settingsNotice(t('Startup self-check failed')+': '+String((error&&error.message)||error),'warning'));
      }
      const ids=(profiles?.data||[]).map(function(item){return item.id}).join(', ');
      rows.append(settingsRow(t('Permission profiles'),ids||'—',t('Reported by permissionProfile/list.')));
      const writeRow=document.createElement('div');
      writeRow.className='settings-row settings-write-row';
      const label=document.createElement('span');
      label.append(Object.assign(document.createElement('strong'),{textContent:t('Approval policy')}));
      const select=document.createElement('select');
      for(const value of ['never','on-request','on-failure','untrusted']){
        const option=document.createElement('option');
        option.value=value;option.textContent=value;
        if(String(cfg.approval_policy)===value)option.selected=true;
        select.append(option);
      }
      const save=document.createElement('button');
      save.type='button';save.className='settings-save';save.textContent=t('Save');
      save.onclick=async function(){
        const value=select.value;
        const ok=await gitConfirm({title:t('Write to config.toml?'),message:'approval_policy = "'+value+'"',confirmLabel:t('Save')});
        if(!ok)return;
        try{
          const response=await fetch('/api/config/write',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({keyPath:'approval_policy',value})});
          const data=await response.json().catch(function(){return {}});
          if(!response.ok)throw new Error(data.error||'Config write failed');
          toast(t('Saved')+' · approval_policy = '+value);
          clientLog('config write ok: approval_policy='+value+' status='+(data.status||'?'));
          void renderSettingsLive('agent');
        }catch(error){toast(error.message)}
      };
      writeRow.append(label,select,save);
      rows.append(writeRow);
      return true;
    }
    if(page==='profile'){
      const account=await rpc('account/read',{}).catch(function(error){return {__error:error.message}});
      const usage=await rpc('account/usage/read',{}).catch(function(error){return {__error:error.message}});
      const limits=await rpc('account/rateLimits/read',{}).catch(function(error){return {__error:error.message}});
      rows.replaceChildren();
      const info=account?.account;
      rows.append(settingsRow(t('Account'),info?(info.email||info.planType||info.type||'—'):'—',info?'':t('This provider does not expose an account (third-party provider). Everything above is local; billing and limits live with your provider.')));
      rows.append(settingsRow(t('Usage'),usage?.__error?usage.__error:(usage?JSON.stringify(usage).slice(0,80):'—'),''));
      rows.append(settingsRow(t('Rate limits'),limits?.__error?limits.__error:(limits?JSON.stringify(limits).slice(0,80):'—'),''));
      return true;
    }
    if(page==='plugins-settings'){
      const installed=await rpc('plugin/installed',{}).catch(function(error){return {__error:error.message}});
      const servers=await rpc('mcpServerStatus/list',{}).catch(function(error){return {__error:error.message}});
      rows.replaceChildren();
      // plugin/list 与 plugin/installed 的返回结构是 {marketplaces:[{name,plugins:[…]}], marketplaceLoadErrors:[]}。
      const markets=installed?.marketplaces||[];
      const list=markets.flatMap(function(market){return (market.plugins||[]).map(function(plugin){return Object.assign({},plugin,{marketplaceName:market.marketplaceName||market.name,marketplacePath:market.path||market.marketplacePath||null})})});
      if(!markets.length){rows.append(settingsNotice(t('No plugin marketplace is configured. Add one below (a local directory containing marketplace.json, or an https URL).')))}
      rows.append(settingsRow(t('Installed plugins'),installed?.__error?installed.__error:String(list.length),installed?.__error?'':list.map(function(item){return item.id||item.name}).slice(0,6).join(', ')));
      const mcp=servers?.data||servers?.servers||[];
      const reload=document.createElement('button');
      reload.type='button';reload.className='settings-save';reload.textContent=t('Reload MCP config');
      reload.onclick=async function(){
        try{const result=await rpc('config/mcpServer/reload',{});clientLog('mcp reload -> '+JSON.stringify(result||{}).slice(0,80));toast(t('MCP config reloaded'));void renderSettingsLive('plugins-settings')}
        catch(error){toast(error.message)}
      };
      /* mcp-server-row-real-fields（patches/0095）：daemon 0.160.0 的 mcpServerStatus/list
         返回 runtimeStatus / httpOrigin / serverInfo / tools(map)，原来的 item.status 永远是 undefined。 */
      const mcpDescribe=function(item){
        const name=item.name||item.id||'?';
        const state=item.runtimeStatus||item.status||item.state||t('configured');
        const tools=item.tools?(Array.isArray(item.tools)?item.tools.length:Object.keys(item.tools).length):null;
        const serverName=item.serverInfo&&item.serverInfo.name?item.serverInfo.name:null;
        return name+'·'+state+(tools===null?'':'·'+tools+' '+t('tools'))+(serverName&&serverName!==name?' ('+serverName+')':'');
      };
      rows.append(settingsRow(t('MCP servers'),servers?.__error?servers.__error:String(mcp.length),servers?.__error?'':mcp.map(mcpDescribe).slice(0,6).join(', ')),reload);
      if(!servers?.__error&&mcp.some(function(item){return !item.runtimeStatus})){
        rows.append(settingsNotice(t('A server without a runtime status is loaded from config but no thread has connected to it yet (runtime status is per-thread).')));
      }
      const form=document.createElement('div');
      form.className='settings-write-row';
      const label2=document.createElement('span');
      label2.append(Object.assign(document.createElement('strong'),{textContent:t('Add a marketplace')}));
      const input=document.createElement('input');
      input.type='text';input.placeholder=t('local directory or https URL');input.autocomplete='off';input.spellcheck=false;
      const add=document.createElement('button');
      add.type='button';add.className='settings-save';add.textContent=t('Add');
      add.onclick=async function(){
        const source=input.value.trim();
        if(!source){toast(t('A marketplace source is required'));return}
        const ok=await gitConfirm({title:t('Add a plugin marketplace?'),message:source,confirmLabel:t('Add')});
        if(!ok)return;
        try{
          const data=await pluginsCall('marketplaceAdd',{source});
          toast(t('Marketplace added')+': '+(data.marketplaceName||source));
          void renderSettingsLive('plugins-settings');
        }catch(error){toast(error.message)}
      };
      form.append(label2,input,add);
      rows.append(form);
      const marketList=document.createElement('div');
      marketList.className='settings-plugin-list';
      for(const market of markets){
        const name=market.marketplaceName||market.name;
        const row=settingsRow(name,String((market.plugins||[]).length)+' '+t('plugins'),'');
        const remove=document.createElement('button');
        remove.type='button';remove.className='settings-save';remove.textContent=t('Remove');
        remove.onclick=async function(){
          const ok=await gitConfirm({title:t('Remove this marketplace?'),message:name,danger:true,confirmLabel:t('Remove')});
          if(!ok)return;
          try{await pluginsCall('marketplaceRemove',{name});toast(t('Marketplace removed'));void renderSettingsLive('plugins-settings')}catch(error){toast(error.message)}
        };
        row.append(remove);
        marketList.append(row);
      }
      for(const plugin of list){
        const row=settingsRow(plugin.name||plugin.id,plugin.installed?t('installed'):t('not installed'),plugin.description||'');
        const action=document.createElement('button');
        action.type='button';action.className='settings-save';
        action.textContent=plugin.installed?t('Uninstall'):t('Install');
        action.onclick=async function(){
          try{
            if(plugin.installed)await pluginsCall('uninstall',{pluginId:plugin.id||plugin.name});
            else await pluginsCall('install',{pluginName:plugin.name,marketplacePath:plugin.marketplacePath});
            toast((plugin.name||plugin.id)+': '+(plugin.installed?t('uninstalled'):t('installed')));
            void renderSettingsLive('plugins-settings');
          }catch(error){toast(error.message)}
        };
        row.append(action);
        marketList.append(row);
      }
      rows.append(marketList);
      return true;
    }
    if(page==='skills-settings'){
      const skills=await rpc('skills/list',{}).catch(function(error){return {__error:error.message}});
      rows.replaceChildren();
      const list=skills?.data||skills?.skills||[];
      rows.append(settingsRow(t('Skills'),skills?.__error?skills.__error:String(list.length),skills?.__error?'':list.map(function(item){return item.name||item.id}).slice(0,8).join(', ')));
      return true;
    }
    if(page==='experimental-settings'){
      rows.replaceChildren();
      await renderExperimentalFeatures(rows);
      return true;
    }
    if(page==='hooks-settings'){
      const hooks=await rpc('hooks/list',{}).catch(function(error){return {__error:error.message}});
      rows.replaceChildren();
      const list=hooks?.data||hooks?.hooks||[];
      rows.append(settingsRow(t('Hooks'),hooks?.__error?hooks.__error:String(list.length),hooks?.__error?'':list.map(function(item){return item.event||item.name||item.id}).slice(0,8).join(', ')));
      return true;
    }
  }catch(error){
    rows.replaceChildren(settingsNotice(t('Could not load: ')+error.message,'warning'));
    return true;
  }
  return false;
}

// --- 产物动作（patches/0087）------------------------------------------------
// 打开/分享走 Termux 的 termux-open（外部应用），存到 Download 走桥侧复制；
// 图片走桥的 /api/images/local 内联显示（消息里的缩略图也是它）。
const FILES_IMAGE_EXTENSIONS=/^(png|jpe?g|gif|webp|bmp|heic|heif|avif)$/i;

function filesImageUrl(path){return '/api/images/local?path='+encodeURIComponent(path)}

async function filesArtifactAction(action){
  const target=filesState.open?.path;
  if(!target)return;
  if(action==='saveToDownloads'){
    const ok=await gitConfirm({title:t('Copy into Downloads?'),message:shortPath(target)+' → /sdcard/Download/codex-gui/',confirmLabel:t('Copy')});
    if(!ok)return;
  }
  try{
    const response=await fetch('/api/files/action',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action,path:target})});
    const data=await response.json().catch(function(){return {}});
    if(!response.ok)throw new Error(data.error||('Files '+action+' failed'));
    clientLog('files '+action+' -> '+(data.path||'ok'));
    toast(action==='saveToDownloads'?t('Copied to Downloads')+': '+shortPath(data.path||''):t('Handed to the system app'));
  }catch(error){clientLog('files '+action+' FAILED: '+error.message);toast(error.message)}
}

function wireFilesArtifactActions(){
  const open=$('#filesViewerOpen');
  if(open)open.onclick=function(){void filesArtifactAction('open')};
  const share=$('#filesViewerShare');
  if(share)share.onclick=function(){void filesArtifactAction('share')};
  const download=$('#filesViewerDownload');
  if(download)download.onclick=function(){void filesArtifactAction('saveToDownloads')};
  const preview=$('#filesViewerPreview');
  if(preview)preview.onclick=previewFilesArtifact;
}
wireFilesArtifactActions();

// --- 实验特性页（patches/0088）----------------------------------------------
// 只展示、不提供开关：本机构建对 `experimentalFeature/enablement/set` 是**空操作**——
// 实测调用返回 {"enablement":{}}（什么都没更新），切换后 enabled 状态不变
// （试过 beta/stable/underDevelopment 三个特性都一样）。所以这里如实说明，
// 而不是放一排点了没用的开关（用户明确禁止空按钮）。
async function renderExperimentalFeatures(rows){
  const list=await rpc('experimentalFeature/list',{}).catch(function(error){return {__error:error.message}});
  if(list?.__error){rows.append(settingsNotice(t('Could not load: ')+list.__error,'warning'));return}
  const features=list?.data||[];
  if(!features.length){rows.append(settingsNotice(t('No experimental features are reported by this build.')));return}
  rows.append(settingsNotice(t('This build ignores experimentalFeature/enablement/set: measured, the call returns an empty enablement and the state never changes. So this page lists the real flags without offering switches.'),'warning'));
  for(const feature of features){
    const note=[feature.stage,feature.description].filter(Boolean).join(' · ');
    rows.append(settingsRow(feature.displayName||feature.name,(feature.enabled?'On':'Off')+(feature.defaultEnabled?' (default)':''),note));
  }
}

// --- HTML 预览（patches/0091）-----------------------------------------------
// 走桥的 /api/files/preview（带 CSP sandbox：被预览的本地页面拿不到桥的同源数据），
// 显示在侧栏浏览器面板里。只在能预览的类型上给按钮，其余仍是打开/分享。
const FILES_PREVIEWABLE=/^(html?|svg|md|txt|json|css|js|png|jpe?g|gif|webp)$/i;

function filesPreviewable(path){return FILES_PREVIEWABLE.test(String(path||'').split('.').pop()||'')}

function previewFilesArtifact(){
  const target=filesState.open?.path;
  if(!target)return;
  // 必须给绝对 URL：面板的地址解析器会把相对路径当成主机名（实测变成 https://api/files/…）。
  const url=location.origin+'/api/files/preview?path='+encodeURIComponent(target);
  clientLog('files preview -> '+target);
  // 用面板自己的导航函数：它会设 iframe 的 sandbox 属性、清掉空态并维护历史；
  // 直接写 frame.src 会被面板随后的渲染覆盖掉（真机撞过：面板停在"输入网址开始浏览"）。
  openBrowserPanel();
  navigateBrowser(url);
  toast(t('Previewing in the Browser panel'));
}

function syncFilesPreviewButton(){
  const button=$('#filesViewerPreview');
  if(!button)return;
  const path=filesState.open?.path;
  button.hidden=!(path&&filesPreviewable(path));
}

// --- 插件动作的桥出口（patches/0093）----------------------------------------
// marketplace/* 不在浏览器白名单里（实测被拒），所以安装/卸载/加市场都走这个受控出口。
async function pluginsCall(action,extra){
  const response=await fetch('/api/plugins',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(Object.assign({action},extra||{}))});
  const data=await response.json().catch(function(){return {}});
  clientLog('plugins '+action+' -> '+response.status+(response.ok?'':' '+(data.error||'')));
  if(!response.ok)throw new Error(data.error||('Plugins '+action+' failed'));
  return data;
}
