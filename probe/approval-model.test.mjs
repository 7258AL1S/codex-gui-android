// Logic check for buildApprovalModel: buttons must follow the server's
// availableDecisions, never a hard-coded set (VERIFICATION.md E29/E31).
// The first fixture is the decision set actually observed on the wire.
import { buildApprovalModel, buildLegacyApprovalModel } from "../app/public/codex-surfaces.js";

let failures = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}: ${JSON.stringify(actual)}${ok ? "" : ` (expected ${JSON.stringify(expected)})`}`);
};

const execMethod = "item/commandExecution/requestApproval";
const decisionName = (button) => (button ? (typeof button.decision === "string" ? button.decision : Object.keys(button.decision)[0]) : null);

// Fixture 1 — copied verbatim from a live request (E31).
const observed = {
  method: execMethod,
  params: {
    kind: "command",
    command: "/bin/sh -lc 'ls -la /data/data/com.termux/files/home/codex-gui/probe 2>&1 || echo \"NO_PROBE_DIR\"'",
    cwd: "/data/data/com.termux/files/home/codex-gui",
    proposedExecpolicyAmendment: ["/bin/sh", "-lc", "ls -la /data/data/com.termux/files/home/codex-gui/probe 2>&1 || echo \"NO_PROBE_DIR\""],
    availableDecisions: ["accept", { acceptWithExecpolicyAmendment: { execpolicy_amendment: ["/bin/sh"] } }, "cancel"],
  },
};
const m1 = buildApprovalModel(observed);
console.log("fixture 1 — live wire set [" + observed.params.availableDecisions.map((d) => (typeof d === "string" ? d : Object.keys(d)[0])).join(", ") + "]");
check("primary", decisionName(m1.primary), "accept");
check("deny is omitted (server never offered it)", m1.deny, null);
check("cancel surfaced", decisionName(m1.cancel), "cancel");
check("scoped = allow similar commands", decisionName(m1.scoped), "acceptWithExecpolicyAmendment");

// Fixture 2 — same request but without the execpolicy amendment offered.
const m2 = buildApprovalModel({ method: execMethod, params: { ...observed.params, availableDecisions: ["accept", "decline", "cancel"] } });
console.log("fixture 2 — [accept, decline, cancel]");
check("deny offered when listed", decisionName(m2.deny), "decline");
check("scoped suppressed when not offered", m2.scoped, null);

// Fixture 3 — legacy server sends no availableDecisions: stay permissive.
const m3 = buildApprovalModel({ method: execMethod, params: { command: "ls", cwd: "/tmp" } });
console.log("fixture 3 — no availableDecisions (legacy)");
check("primary", decisionName(m3.primary), "accept");
check("deny", decisionName(m3.deny), "decline");
check("cancel stays hidden unless explicitly offered", m3.cancel, null);

// Fixture 4 — malformed value must fail closed.
const m4 = buildApprovalModel({ method: execMethod, params: { command: "ls", availableDecisions: "accept" } });
console.log("fixture 4 — malformed availableDecisions (string)");
check("primary omitted", m4.primary, null);
check("deny omitted", m4.deny, null);

// Fixture 5 — file-change approvals have a smaller decision set.
const m5 = buildApprovalModel({ method: "item/fileChange/requestApproval", params: { availableDecisions: ["accept", "acceptForSession", "decline", "cancel"] } });
console.log("fixture 5 — file change");
check("scoped = allow all edits", decisionName(m5.scoped), "acceptForSession");

// Fixture 6 — 旧版协议（execCommandApproval / applyPatchApproval）。
// 这两个方法的回应是**字符串枚举**（approved | approved_for_session | denied | abort），
// 与新版的 {decision:"accept"} 不同；前端 answer() 对非 permission 类型统一发 {decision}，
// 所以这里必须确认 decision 就是旧版字面量——写成 "accept" 会让旧服务端无法识别。
console.log("fixture 6 — legacy execCommandApproval");
const l1 = buildLegacyApprovalModel("execCommandApproval", {
  command: ["/bin/sh", "-lc", "echo p5-check"],
  cwd: "/data/data/com.termux/files/home",
  reason: "需要运行命令",
});
check("kind drives the command body", l1.kind, "exec");
check("command array is joined", l1.command, "/bin/sh -lc echo p5-check");
check("primary is the legacy enum", l1.primary, { label: "Allow once", decision: "approved" });
check("scoped is the legacy enum", l1.scoped, { label: "Allow this conversation", decision: "approved_for_session" });
check("deny is the legacy enum", l1.deny, { label: "Deny", decision: "denied" });
check("cancel maps to abort", l1.cancel.label === "Cancel" ? l1.cancel.decision : null, "abort");

console.log("fixture 7 — legacy applyPatchApproval");
const l2 = buildLegacyApprovalModel("applyPatchApproval", {
  fileChanges: { "/tmp/a.txt": { type: "update" }, "/tmp/b.txt": { type: "add" } },
  grantRoot: "/tmp",
});
check("kind drives the patch body", l2.kind, "patch");
check("files are listed for the card", l2.legacyFiles, ["/tmp/a.txt", "/tmp/b.txt"]);
check("title counts files", l2.title, "Allow ChatGPT to edit the following files?");
check("scoped label for patches", l2.scoped.label, "Allow all edits");

// 自检：把 decision 换成新版字面量必须被抓出来（否则这个断言没有意义）
const tampered = JSON.parse(JSON.stringify(l1));
tampered.primary.decision = "accept";
check("self-check: new-style decision is not the legacy enum", tampered.primary.decision === l1.primary.decision, false);

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
