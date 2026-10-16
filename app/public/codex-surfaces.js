export const CODEX_MOTION = Object.freeze({
  shimmer: Object.freeze({ durationMs: 2000, steps: 48, from: "-100%", to: "250%" }),
  approvalEnter: null,
  accordion: Object.freeze({ durationMs: 300, easing: "cubic-bezier(.19,1,.22,1)" }),
});

// A decision may only be offered when the server listed it.
//
// `availableDecisions` is present on the wire even though it is missing from the
// generated protocol types (see VERIFICATION.md E29), and the sets differ per
// request: a read-only command approval offered
// ["accept", {acceptWithExecpolicyAmendment}, "cancel"] — with no "decline" at all.
// Offering an unlisted decision would widen the user's authorization, so:
//   - absent  => legacy/older server, keep the previous permissive behaviour
//   - present => strict membership test, and a non-array fails closed
const hasDecision = (available, name) => {
  if (available == null) return true;
  if (!Array.isArray(available)) return false;
  return available.some((decision) => {
    if (typeof decision === "string") return decision === name;
    return decision && typeof decision === "object" && name in decision;
  });
};

// Only offered when the server explicitly listed it (used for opt-in extras).
const explicitlyOffered = (available, name) => Array.isArray(available) && hasDecision(available, name);

export function buildApprovalModel(request) {
  const method = request.method;
  const params = request.params || {};
  const available = params.availableDecisions;
  const base = {
    reason: params.reason || null,
    cwd: params.cwd || null,
    command: params.command || null,
    primary: hasDecision(available, "accept") ? { label: "Allow once", decision: "accept" } : null,
    deny: hasDecision(available, "decline") ? { label: "Deny", decision: "decline" } : null,
    // "cancel" is a distinct outcome from "decline": only surface it when offered.
    cancel: explicitlyOffered(available, "cancel") ? { label: "Cancel", decision: "cancel" } : null,
    leading: null,
    scoped: null,
  };

  if (method === "item/commandExecution/requestApproval") {
    let scoped = hasDecision(available, "acceptForSession")
      ? { label: "Allow this conversation", decision: "acceptForSession" }
      : null;
    if (
      params.proposedExecpolicyAmendment?.length
      && hasDecision(available, "acceptWithExecpolicyAmendment")
      && params.proposedExecpolicyAmendment.every((line) => !/[\r\n]/.test(line))
    ) {
      scoped = {
        label: "Allow similar commands",
        decision: { acceptWithExecpolicyAmendment: { execpolicy_amendment: params.proposedExecpolicyAmendment } },
      };
    }
    const network = params.networkApprovalContext;
    if (params.proposedNetworkPolicyAmendments?.length && hasDecision(available, "applyNetworkPolicyAmendment")) {
      const amendment = params.proposedNetworkPolicyAmendments.find((entry) => entry.action === "allow") || params.proposedNetworkPolicyAmendments[0];
      const leading = {
        label: amendment?.host ? `Always allow ${amendment.host}` : "Always allow",
        decision: { applyNetworkPolicyAmendment: { network_policy_amendment: amendment } },
      };
      return {
        ...base,
        kind: "network",
        identity: "Internet access",
        title: `Allow ChatGPT to connect to ${network?.host || amendment?.host || "the internet"}?`,
        subtitle: `${network?.host || amendment?.host} isn't on the current network allowlist`,
        scoped: hasDecision(available, "acceptForSession") ? { label: "Allow this conversation", decision: "acceptForSession" } : null,
        leading,
      };
    }
    return {
      ...base,
      kind: network ? "network" : "exec",
      identity: network ? "Internet access" : "Terminal",
      title: network ? `Allow ChatGPT to connect to ${network.host || "the internet"}?` : "Allow ChatGPT to run this command?",
      subtitle: network?.host ? `${network.host} isn't on the current network allowlist` : params.cwd || null,
      scoped,
    };
  }

  if (method === "item/fileChange/requestApproval") {
    return {
      ...base,
      kind: "patch",
      identity: "Edit files",
      title: `Allow ChatGPT to edit the following ${params.fileCount === 1 ? "file" : "files"}?`,
      subtitle: params.grantRoot || null,
      scoped: hasDecision(available, "acceptForSession")
        ? { label: "Allow all edits", decision: "acceptForSession" }
        : null,
    };
  }

  if (method === "item/permissions/requestApproval") {
    const permissions = params.permissions || {};
    const rows = permissionRows(permissions);
    const network = permissions.network?.enabled;
    const reads = rows.filter((row) => row.label === "Read").map((row) => row.value);
    const writes = rows.filter((row) => row.label === "Write").map((row) => row.value);
    const paths = [...new Set([...reads, ...writes])].join(", ");
    let action = network ? "connect to the internet" : "";
    const fileAction = reads.length && writes.length ? `view and edit the contents of ${paths}` : writes.length ? `edit the contents of ${paths}` : reads.length ? `view the contents of ${paths}` : "";
    if (action && fileAction) action += ` and ${fileAction}`; else action ||= fileAction || "use additional permissions";
    const decision = (scope) => ({ permissions, scope, strictAutoReview: false });
    return {
      ...base,
      kind: "permission",
      identity: network && !fileAction ? "Internet access" : "Permissions",
      title: `Allow ChatGPT to ${action}?`,
      subtitle: params.reason || null,
      reason: null,
      primary: { label: "Allow once", decision: decision("turn") },
      scoped: { label: "Allow this conversation", decision: decision("session") },
      deny: { label: "Deny", decision: { permissions: {}, scope: "turn" } },
      cancel: null,
      permissions,
    };
  }

  throw new Error(`Unsupported approval request: ${method}`);
}

function cleanDiffPath(value = "") {
  return value.replace(/^[ab]\//, "").replace(/\t.*$/, "");
}

export function parseUnifiedDiff(diff = "") {
  const files = [];
  let file = null;
  let hunk = null;
  let linesAdded = 0;
  let linesDeleted = 0;
  for (const raw of String(diff).split("\n")) {
    const git = raw.match(/^diff --git a\/(.+) b\/(.+)$/);
    if (git) {
      file = { path: git[2], oldPath: git[1], linesAdded: 0, linesDeleted: 0, hunks: [] };
      files.push(file);
      hunk = null;
      continue;
    }
    if (!file && raw.startsWith("+++ ")) {
      file = { path: cleanDiffPath(raw.slice(4)), oldPath: "", linesAdded: 0, linesDeleted: 0, hunks: [] };
      files.push(file);
    }
    if (!file) continue;
    if (raw.startsWith("--- ")) { file.oldPath = cleanDiffPath(raw.slice(4)); continue; }
    if (raw.startsWith("+++ ")) { file.path = cleanDiffPath(raw.slice(4)); continue; }
    if (raw.startsWith("@@")) {
      hunk = { header: raw, lines: [] };
      file.hunks.push(hunk);
      continue;
    }
    if (!hunk) continue;
    let type = "context";
    if (raw.startsWith("+") && !raw.startsWith("+++")) { type = "add"; file.linesAdded++; linesAdded++; }
    else if (raw.startsWith("-") && !raw.startsWith("---")) { type = "delete"; file.linesDeleted++; linesDeleted++; }
    else if (raw.startsWith("\\ No newline")) type = "meta";
    hunk.lines.push({ type, text: raw.slice(type === "add" || type === "delete" || type === "context" ? 1 : 0) });
  }
  return { hasChanges: files.length > 0 && (linesAdded + linesDeleted > 0), fileCount: files.length, linesAdded, linesDeleted, files };
}

function fileChangeKind(change = {}) {
  return typeof change.kind === "string" ? change.kind : change.kind?.type || "update";
}

// add/delete 时后端给的是**整份内容**（不是 diff）：必须自己补 hunk 头与 +/- 前缀，
// 否则 `git apply` 和前端解析都不认（E122：真机上「审阅」面板看不到这一轮的改动）。
function fileContentPatch(path, content, kind) {
  const lines = content === "" ? [] : content.split("\n");
  const marker = kind === "add" ? "+" : "-";
  const hunk = lines.length
    ? `@@ -${kind === "add" ? "0,0" : `1,${lines.length}`} +${kind === "add" ? `1,${lines.length}` : "0,0"} @@\n${lines.map((line) => marker + line).join("\n")}`
    : null;
  return [
    `diff --git a/${path} b/${path}`,
    kind === "add" ? "new file mode 100644" : "deleted file mode 100644",
    kind === "add" ? "--- /dev/null" : `--- a/${path}`,
    kind === "add" ? `+++ b/${path}` : "+++ /dev/null",
    hunk,
  ].filter(Boolean).join("\n");
}

export function unifiedDiffFromFileChanges(changes = []) {
  const sections = [];
  for (const change of changes) {
    const path = String(change?.path || change?.filePath || "");
    const diff = String(change?.diff || change?.unified_diff || "");
    if (!path || /[\r\n]/.test(path)) continue;
    if (/^diff --git /m.test(diff)) {
      sections.push(diff.trimEnd());
      continue;
    }
    const kind = fileChangeKind(change);
    if (kind === "add" || kind === "delete") {
      sections.push(fileContentPatch(path, diff.replace(/\n$/, ""), kind));
      continue;
    }
    const body = diff.trimEnd();
    if (!body) continue;
    const metadata = /^--- /m.test(body) && /^\+\+\+ /m.test(body)
      ? body
      : `--- a/${path}\n+++ b/${path}\n${body}`;
    sections.push(`diff --git a/${path} b/${path}\n${metadata}`);
  }
  // git apply 要求补丁以换行结尾，少这一行会报 "corrupt patch"。
  return sections.length ? sections.join("\n") + "\n" : "";
}

function shellWords(command = "") {
  return String(command).match(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s]+/g)?.map((word) => word.replace(/^(['"])(.*)\1$/, "$2")) || [];
}

function hasShellControl(command = "") {
  let quote = null;
  const value = String(command);
  for (let index = 0; index < value.length; index++) {
    const char = value[index];
    if (char === "\\" && quote !== "'") { index++; continue; }
    if (char === "'" || char === '"') {
      if (quote === char) quote = null;
      else if (quote == null) quote = char;
      continue;
    }
    if (quote !== "'" && (char === "`" || (char === "$" && value[index + 1] === "("))) return true;
    if (quote == null && (";&|<>\n\r".includes(char))) return true;
  }
  return false;
}

function explorationCommand(command = "") {
  if (hasShellControl(command)) return null;
  const words = shellWords(command);
  const name = words[0]?.split("/").at(-1);
  const hasOption = (options) => words.some((word) => options.some((option) => word === option || word.startsWith(`${option}=`)));
  if (name === "find" && hasOption(["-delete", "-exec", "-execdir", "-ok", "-okdir", "-fprint", "-fprint0", "-fprintf", "-fls"])) return null;
  if (name === "fd" && hasOption(["-x", "-X", "--exec", "--exec-batch"])) return null;
  if (["cat", "head", "tail", "bat", "less"].includes(name)) {
    const target = [...words.slice(1)].reverse().find((word) => !word.startsWith("-")) || "file";
    return { category: "read", detail: target, activeLabel: "Reading", completedLabel: "Read", animation: "local-context" };
  }
  if (["rg", "grep", "ag", "ack"].includes(name)) {
    const values = words.slice(1).filter((word) => !word.startsWith("-"));
    const query = values[0];
    return { category: "search", detail: query ? `for ${query}` : "files", activeLabel: "Searching", completedLabel: "Searched", animation: "searching" };
  }
  if (["ls", "find", "fd"].includes(name)) {
    const target = words.slice(1).find((word) => !word.startsWith("-")) || "files";
    return { category: "list", detail: target === "files" ? "files" : `files in ${target}`, activeLabel: "Listing", completedLabel: "Listed", animation: "local-context" };
  }
  return null;
}

export function summarizeActivity(item) {
  const status = item.status || "completed";
  const active = status === "inProgress" || status === "running" || status === "pendingInit";
  const failed = ["failed", "declined", "errored", "interrupted", "cancelled", "canceled"].includes(status);
  if (item.type === "imageView") {
    const paths = item.imagePaths || [];
    const count = paths.length;
    return {
      label: active ? "Viewing images" : failed ? "Image view failed" : count === 1 ? "Viewed image" : "Viewed images",
      detail: count === 1 ? paths[0] : count ? `${count} images` : "",
      category: "image",
      animation: "local-context",
      active,
      tone: failed ? "error" : active ? "active" : "success",
    };
  }
  if (item.type === "commandExecution") {
    const command = item.command || (item.commandActions || []).map((action) => action?.command).filter(Boolean).join("\n");
    const exploration = explorationCommand(command);
    if (exploration && !failed) return {
      label: active ? exploration.activeLabel : exploration.completedLabel,
      detail: exploration.detail,
      category: exploration.category,
      animation: exploration.animation,
      active,
      tone: active ? "active" : "success",
    };
    return {
      label: active ? "Running command" : failed ? "Command failed" : "Ran command",
      detail: command || "",
      category: "command",
      animation: "run-command",
      active,
      tone: failed ? "error" : active ? "active" : "success",
    };
  }
  if (item.type === "fileChange") {
    const count = item.changes?.length || 0;
    return {
      label: active ? "Editing files" : failed ? "File edit failed" : count === 1 ? "Edited a file" : "Edited files",
      detail: (item.changes || []).map((change) => change.path || change.filePath).filter(Boolean).join(", "),
      animation: "edit-files",
      active,
      tone: failed ? "error" : active ? "active" : "success",
    };
  }
  if (item.type === "collabAgentToolCall") {
    const receivers = item.receiverThreadIds || [];
    const count = receivers.length;
    const labels = {
      spawnAgent: ["Starting side task", "Started side task"],
      sendInput: ["Sending input to side task", "Sent input to side task"],
      resumeAgent: ["Resuming side task", "Resumed side task"],
      wait: ["Waiting for side tasks", "Waited for side tasks"],
      closeAgent: ["Closing side task", "Closed side task"],
    };
    const [activeLabel, completedLabel] = labels[item.tool] || ["Updating side task", "Updated side task"];
    return {
      label: active ? activeLabel : failed ? "Side task failed" : completedLabel,
      detail: item.prompt || (count ? `${count} side task${count === 1 ? "" : "s"}` : ""),
      category: "side-task",
      animation: "local-context",
      active,
      tone: failed ? "error" : active ? "active" : "success",
    };
  }
  if (item.type === "subAgentActivity") return {
    label: item.kind === "interrupted" ? "Side task interrupted" : item.kind === "interacted" ? "Side task active" : "Side task started",
    detail: item.agentPath || item.agentThreadId || "",
    category: "side-task",
    animation: "local-context",
    active: item.kind !== "interrupted" && active,
    tone: item.kind === "interrupted" ? "error" : active ? "active" : "success",
  };
  if (item.type === "webSearch") return {
    label: active ? "Searching the web" : failed ? "Search failed" : "Searched the web",
    detail: item.query || "",
    animation: "searching",
    active,
    tone: failed ? "error" : active ? "active" : "success",
  };
  if (item.type === "reasoning") return { label: active ? "Thinking" : "Thought", detail: "", animation: "local-context", active, tone: failed ? "error" : active ? "active" : "success" };
  return { label: active ? "Working" : failed ? "Tool failed" : "Completed", detail: item.tool || item.type || "", animation: "local-context", active, tone: failed ? "error" : active ? "active" : "success" };
}

export function createReviewPreferences(value = {}) {
  return {
    mode: value.mode === "split" ? "split" : "unified",
    wrap: value.wrap === true,
    expanded: value.expanded !== false,
  };
}

export function splitDiffHunk(hunk = { lines: [] }) {
  const rows = [];
  const lines = hunk.lines || [];
  for (let index = 0; index < lines.length;) {
    const line = lines[index];
    if (line.type !== "delete" && line.type !== "add") {
      rows.push({ left: line, right: line });
      index++;
      continue;
    }
    const deletes = [];
    const adds = [];
    while (index < lines.length && lines[index].type === "delete") deletes.push(lines[index++]);
    while (index < lines.length && lines[index].type === "add") adds.push(lines[index++]);
    const count = Math.max(deletes.length, adds.length);
    for (let row = 0; row < count; row++) rows.push({ left: deletes[row] || null, right: adds[row] || null });
  }
  return rows;
}

export function permissionRows(permissions = {}) {
  const rows = [];
  if (permissions.network?.enabled) rows.push({ label: "Network", value: "Allow network access" });
  const fs = permissions.fileSystem || {};
  for (const path of fs.read || []) rows.push({ label: "Read", value: path });
  for (const path of fs.write || []) rows.push({ label: "Write", value: path });
  for (const entry of fs.entries || []) {
    const path = entry.path?.path || entry.path?.pattern || entry.path?.value?.kind || "File system";
    rows.push({ label: entry.access?.[0]?.toUpperCase() + entry.access?.slice(1) || "Access", value: path });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// item/tool/requestUserInput — the model asking the user a question.
//
// Protocol shape (VERIFICATION.md E16):
//   params  = { threadId, turnId, itemId, questions[], isBlocking, autoResolutionMs }
//   question= { id, header, question, isOther, isSecret, options[] | null }
//   option  = { label, description }
//   answer  = { answers: { <questionId>: { answers: string[] } } }
//
// An unanswered request leaves the turn parked on `waitingOnUserInput`, so the
// UI must always answer it (E32).
export function buildUserInputModel(request) {
  const params = request?.params || {};
  const questions = (Array.isArray(params.questions) ? params.questions : []).map((question) => ({
    id: String(question?.id ?? ""),
    header: question?.header || "",
    question: question?.question || "",
    isOther: Boolean(question?.isOther),
    isSecret: Boolean(question?.isSecret),
    options: Array.isArray(question?.options) && question.options.length
      ? question.options.map((option) => ({ label: String(option?.label ?? ""), description: option?.description || "" }))
      : null,
  })).filter((question) => question.id);
  return {
    kind: "userInput",
    identity: "Codex 提问",
    blocking: params.isBlocking !== false,
    title: params.isBlocking === false ? "Codex 有一个问题（不阻塞）" : "Codex 需要你的回答才能继续",
    questions,
    // A question with options is a picker; without options it is free text.
    needsText: questions.some((question) => !question.options || question.isOther),
  };
}

// answers: { [questionId]: string[] }
export function buildUserInputResponse(model, answers = {}) {
  const out = {};
  for (const question of model?.questions || []) {
    const values = (answers[question.id] ?? [])
      .map((value) => String(value))
      .filter((value) => value.trim().length > 0);
    if (values.length) out[question.id] = { answers: values };
  }
  return { answers: out };
}

// ---------------------------------------------------------------------------
// mcpServer/elicitation/request — MCP form / browser-authorization flows.
//
// modes: "form" | "openai/form" | "openaiForm" | "url" (VERIFICATION.md E15)
// response: { action: "accept" | "decline" | "cancel", content: JsonValue | null, _meta: null }
const ELICITATION_CONST_OPTIONS = (entries) => (Array.isArray(entries) ? entries : [])
  .map((entry) => ({ value: String(entry?.const ?? ""), label: String(entry?.title ?? entry?.const ?? "") }))
  .filter((option) => option.value !== "");

function describeElicitationField(name, spec = {}, required) {
  const base = {
    name,
    label: spec.title || name,
    description: spec.description || "",
    required,
    kind: "text",
    options: null,
    default: spec.default ?? null,
  };
  if (spec.type === "string" && Array.isArray(spec.enum)) {
    const labels = Array.isArray(spec.enumNames) ? spec.enumNames : null;
    return { ...base, kind: "select", options: spec.enum.map((value, index) => ({ value: String(value), label: String(labels?.[index] ?? value) })) };
  }
  if (spec.type === "string" && Array.isArray(spec.oneOf)) {
    return { ...base, kind: "select", options: ELICITATION_CONST_OPTIONS(spec.oneOf) };
  }
  if (spec.type === "array") {
    const items = spec.items || {};
    const options = Array.isArray(items.enum)
      ? items.enum.map((value) => ({ value: String(value), label: String(value) }))
      : ELICITATION_CONST_OPTIONS(items.anyOf);
    if (options.length) return { ...base, kind: "multiselect", options };
    return { ...base, kind: "unsupported" };
  }
  if (spec.type === "boolean") return { ...base, kind: "boolean" };
  if (spec.type === "number" || spec.type === "integer") return { ...base, kind: "number" };
  if (spec.type === "string") return { ...base, kind: "text" };
  return { ...base, kind: "unsupported" };
}

export function buildElicitationModel(request) {
  const params = request?.params || {};
  const mode = params.mode || "form";
  const base = {
    kind: "elicitation",
    mode,
    identity: `MCP · ${params.serverName || "server"}`,
    message: params.message || "",
    serverName: params.serverName || null,
    threadId: params.threadId || null,
    turnId: params.turnId || null,
  };
  if (mode === "url") {
    return {
      ...base,
      title: "需要在浏览器中完成授权",
      url: params.url || null,
      elicitationId: params.elicitationId || null,
      fields: [],
      canAccept: true,
    };
  }
  if (mode !== "form") {
    // openai/form and openaiForm carry an untyped schema; we refuse to invent a
    // form for it and offer decline/cancel only (never fabricate fields).
    return { ...base, title: "MCP 请求输入（自定义表单）", fields: [], untyped: true, schema: params.requestedSchema ?? null, canAccept: false };
  }
  const schema = params.requestedSchema || {};
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  const fields = Object.entries(schema.properties || {})
    .map(([name, spec]) => describeElicitationField(name, spec || {}, required.has(name)));
  return {
    ...base,
    title: "MCP 请求输入",
    fields,
    // 0 个字段是合法情形（无输入可填，等同于「确认」）：MCP 工具授权就是这种。
    // 只有出现客户端无法识别的字段时才必须挡住——那才是「不凭空生成字段」。
    canAccept: fields.every((field) => field.kind !== "unsupported"),
  };
}

export function missingElicitationFields(model, values = {}) {
  if (!model || model.mode !== "form") return [];
  return (model.fields || [])
    .filter((field) => field.required)
    .filter((field) => {
      const value = values[field.name];
      if (value === undefined || value === null || value === "") return true;
      if (Array.isArray(value)) return value.length === 0;
      return false;
    })
    .map((field) => field.name);
}

export function buildElicitationResponse(model, values = {}, action = "accept") {
  if (action !== "accept") return { action, content: null, _meta: null };
  if (model?.mode === "url") return { action: "accept", content: null, _meta: null };
  if (model?.mode !== "form") return { action: "decline", content: null, _meta: null };
  const content = {};
  for (const field of model.fields || []) {
    const value = values[field.name];
    if (value === undefined || value === "" || (Array.isArray(value) && value.length === 0)) continue;
    content[field.name] = field.kind === "number" ? Number(value) : field.kind === "boolean" ? Boolean(value) : value;
  }
  return { action: "accept", content, _meta: null };
}


// 旧版审批（codex 早期协议）。decision 是**字符串**枚举：
//   approved / approved_for_session / denied / abort
// 与新版 {decision:"accept"} 不同，所以这里单独构造，但按钮语义与卡片结构保持同款，
// 复用同一套渲染与提交路径（app.js 的 answer() 对非 permission 类型统一发 {decision}）。
export function buildLegacyApprovalModel(method, params = {}) {
  const isPatch = method === "applyPatchApproval";
  const command = Array.isArray(params.command) ? params.command.join(" ") : String(params.command || "");
  const files = params.fileChanges ? Object.keys(params.fileChanges) : [];
  if (isPatch) {
    return {
      kind: "patch",
      identity: "Edit files",
      // 注意：这里刻意不用模板字符串——本文件是"补丁脚本里的模板字符串"，
      // 里面再出现反引号/美元花括号会把补丁脚本自己拆掉（这条踩过三次）。
      title: "Allow ChatGPT to edit the following " + (files.length === 1 ? "file" : "files") + "?",
      subtitle: params.grantRoot || params.cwd || null,
      reason: params.reason || null,
      command: null,
      legacyFiles: files,
      legacy: method,
      primary: { label: "Allow once", decision: "approved" },
      scoped: { label: "Allow all edits", decision: "approved_for_session" },
      deny: { label: "Deny", decision: "denied" },
      cancel: { label: "Cancel", decision: "abort" },
      leading: null,
    };
  }
  return {
    kind: "exec",
    identity: "Terminal",
    title: "Allow ChatGPT to run this command?",
    subtitle: params.cwd || null,
    reason: params.reason || null,
    command: command || null,
    legacy: method,
    primary: { label: "Allow once", decision: "approved" },
    scoped: { label: "Allow this conversation", decision: "approved_for_session" },
    deny: { label: "Deny", decision: "denied" },
    cancel: { label: "Cancel", decision: "abort" },
    leading: null,
  };
}
