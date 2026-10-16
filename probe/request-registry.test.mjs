// P2 item 2 — a server request (approval / elicitation / question) must be
// answerable exactly once, and must not survive its turn.
import { createRequestRegistry } from "../app/request-registry.js";

let failures = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}: ${JSON.stringify(actual)}${ok ? "" : ` (expected ${JSON.stringify(expected)})`}`);
};

const approval = (id, extra = {}) => ({
  id,
  method: "item/commandExecution/requestApproval",
  params: { threadId: "t1", turnId: "u1", itemId: "i1", kind: "command", ...extra },
});

console.log("— 正常路径 —");
{
  const reg = createRequestRegistry();
  const entry = reg.register(approval(7));
  check("register 记下关联信息", [entry.requestId, entry.threadId, entry.turnId, entry.itemId, entry.kind], [7, "t1", "u1", "i1", "command"]);
  check("原始请求被保留（供刷新后的页面恢复卡片）", entry.request?.id, 7);
  const claim = reg.claim(7);
  check("第一次应答可以拿到所有权", [claim.ok, claim.entry.method], [true, "item/commandExecution/requestApproval"]);
  check("认领后登记表为空", reg.size, 0);
}

console.log("\n— 第二个客户端（或重复点击）必须被拒绝 —");
{
  const reg = createRequestRegistry();
  reg.register(approval(7));
  check("第一个客户端成功", reg.claim(7).ok, true);
  check("第二个客户端被拒（同一 requestId）", reg.claim(7), { ok: false, reason: "already-resolved-or-unknown" });
  check("从未见过的 id 也被拒", reg.claim(999), { ok: false, reason: "already-resolved-or-unknown" });
  check("非法 id 被拒", reg.claim("abc"), { ok: false, reason: "invalid-request-id" });
  check("null id 被拒", reg.claim(null), { ok: false, reason: "invalid-request-id" });
}

console.log("\n— 服务端说这个请求已经解决了 —");
{
  const reg = createRequestRegistry();
  reg.register(approval(7));
  check("resolve 命中", reg.resolve(7), true);
  check("之后再应答会被拒（晚到的应答不能转发）", reg.claim(7).ok, false);
  check("resolve 未知 id 返回 false", reg.resolve(7), false);
}

console.log("\n— 回合结束时清账 —");
{
  const reg = createRequestRegistry();
  reg.register(approval(1, { turnId: "u1" }));
  reg.register(approval(2, { turnId: "u1" }));
  reg.register(approval(3, { turnId: "u2" }));
  check("清掉该回合的两条，留下别的", reg.clearTurn("t1", "u1"), 2);
  check("剩下的属于另一个回合", reg.list().map((e) => e.requestId), [3]);
  check("该回合的请求之后不能应答", reg.claim(1).ok, false);
}
{
  const reg = createRequestRegistry();
  // Some requests carry no turnId (e.g. MCP elicitation can be raised outside a
  // turn): clearing by thread must still take them.
  reg.register({ id: 5, method: "mcpServer/elicitation/request", params: { threadId: "t1", turnId: null } });
  check("没有 turnId 的请求按 thread 清", reg.clearTurn("t1", null), 1);
}

console.log("\n— 同 item 多个回调（approvalId 区分）—");
{
  const reg = createRequestRegistry();
  reg.register(approval(11, { approvalId: "cb-a", kind: "writeStdin" }));
  reg.register(approval(12, { approvalId: "cb-b", kind: "writeStdin" }));
  check("两条各自独立", reg.list().map((e) => e.approvalId), ["cb-a", "cb-b"]);
  check("按 requestId 各自认领", [reg.claim(11).ok, reg.claim(12).ok], [true, true]);
}

console.log("\n— 兜底：过期条目不会永远留着 —");
{
  const reg = createRequestRegistry({ ttlMs: 1000 });
  reg.register(approval(9), 10_000);
  check("未过期时仍在", reg.size, 1);
  check("超过 TTL 后应答被拒", reg.claim(9, 12_000).ok, false);
  check("并且已经被清掉", reg.size, 0);
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
