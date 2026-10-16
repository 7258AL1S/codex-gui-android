// Logic checks for the two interaction surfaces the upstream UI does not handle:
// item/tool/requestUserInput and mcpServer/elicitation/request.
import {
  buildElicitationModel,
  buildElicitationResponse,
  buildUserInputModel,
  buildUserInputResponse,
  missingElicitationFields,
} from "../app/public/codex-surfaces.js";

let failures = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}: ${JSON.stringify(actual)}${ok ? "" : ` (expected ${JSON.stringify(expected)})`}`);
};

// --- request_user_input ----------------------------------------------------
const userInputRequest = {
  method: "item/tool/requestUserInput",
  params: {
    threadId: "01a1",
    turnId: "01b2",
    itemId: "01c3",
    isBlocking: true,
    autoResolutionMs: null,
    questions: [
      { id: "q1", header: "范围", question: "要覆盖哪个范围？", isOther: false, isSecret: false,
        options: [{ label: "仅前端", description: "只改界面" }, { label: "全栈", description: "含后端" }] },
      { id: "q2", header: "补充", question: "还有其他要求吗？", isOther: true, isSecret: false, options: null },
    ],
  },
};
const ui = buildUserInputModel(userInputRequest);
console.log("requestUserInput — 1 select + 1 free text, blocking");
check("question count", ui.questions.length, 2);
check("select options", ui.questions[0].options.map((o) => o.label), ["仅前端", "全栈"]);
check("free-text question has no options", ui.questions[1].options, null);
check("needs text input somewhere", ui.needsText, true);
check("blocking", ui.blocking, true);
check("response from picks + typed text",
  buildUserInputResponse(ui, { q1: ["全栈"], q2: ["希望支持离线"] }),
  { answers: { q1: { answers: ["全栈"] }, q2: { answers: ["希望支持离线"] } } });
check("blank answers are dropped, not sent as empty strings",
  buildUserInputResponse(ui, { q1: ["  "], q2: [] }),
  { answers: {} });
check("non-blocking variant is surfaced", buildUserInputModel({ params: { isBlocking: false, questions: [] } }).blocking, false);

// --- elicitation: form ----------------------------------------------------
const formRequest = {
  method: "mcpServer/elicitation/request",
  params: {
    threadId: "01a1",
    turnId: null,
    serverName: "demo-server",
    mode: "form",
    _meta: null,
    message: "请选择部署目标",
    requestedSchema: {
      type: "object",
      required: ["env", "replicas"],
      properties: {
        env: { type: "string", title: "环境", enum: ["dev", "prod"] },
        region: { type: "string", title: "区域", oneOf: [{ const: "cn", title: "中国" }, { const: "us", title: "美国" }] },
        tags: { type: "array", title: "标签", items: { type: "string", enum: ["a", "b"] } },
        dryRun: { type: "boolean", title: "试运行" },
        replicas: { type: "integer", title: "副本数", default: 1 },
        note: { type: "string", title: "备注" },
        weird: { type: "object", title: "嵌套对象" },
      },
    },
  },
};
const form = buildElicitationModel(formRequest);
console.log("elicitation form — mixed field kinds");
check("identity includes the server", form.identity, "MCP · demo-server");
check("field kinds", form.fields.map((f) => [f.name, f.kind]),
  [["env", "select"], ["region", "select"], ["tags", "multiselect"], ["dryRun", "boolean"], ["replicas", "number"], ["note", "text"], ["weird", "unsupported"]]);
check("titled enum keeps the title as the label", form.fields[1].options, [{ value: "cn", label: "中国" }, { value: "us", label: "美国" }]);
check("required flags", form.fields.filter((f) => f.required).map((f) => f.name), ["env", "replicas"]);
check("unsupported field blocks accept (no fabricated input)", form.canAccept, false);
check("missing required detected", missingElicitationFields(form, { note: "x" }), ["env", "replicas"]);
check("number field is coerced, not sent as a string",
  buildElicitationResponse(form, { env: "prod", replicas: "3", dryRun: true }),
  { action: "accept", content: { env: "prod", dryRun: true, replicas: 3 }, _meta: null });
check("decline carries no content", buildElicitationResponse(form, {}, "decline"), { action: "decline", content: null, _meta: null });
check("cancel carries no content", buildElicitationResponse(form, {}, "cancel"), { action: "cancel", content: null, _meta: null });

// --- elicitation: url mode -------------------------------------------------
const urlForm = buildElicitationModel({ params: { serverName: "oauth-server", mode: "url", message: "请授权", url: "https://example.com/auth", elicitationId: "el-1" } });
console.log("elicitation url — browser authorization");
check("url surfaced", urlForm.url, "https://example.com/auth");
check("no fields invented", urlForm.fields, []);
check("accept means 'I finished in the browser'", buildElicitationResponse(urlForm, {}, "accept"), { action: "accept", content: null, _meta: null });

// --- elicitation: untyped openai form --------------------------------------
const openaiForm = buildElicitationModel({ params: { serverName: "x", mode: "openaiForm", message: "自定义表单", requestedSchema: { foo: "bar" } } });
console.log("elicitation openaiForm — untyped schema");
check("accept disabled for untyped schema", openaiForm.canAccept, false);
check("raw schema kept for inspection", openaiForm.schema, { foo: "bar" });
check("accept attempt degrades to decline rather than sending junk", buildElicitationResponse(openaiForm, { a: 1 }, "accept"), { action: "decline", content: null, _meta: null });

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
