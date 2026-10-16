// P2 item 4 — the composer must not submit twice.
//
// Background: the server merges overlapping turn/start calls into one turn but
// records the user message twice (E49), and clientUserMessageId does not stop it
// (E51). So the client has to be the one that refuses the second submission.
import { createSubmitGate } from "../app/public/ui-core.js";

let failures = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}: ${JSON.stringify(actual)}${ok ? "" : ` (expected ${JSON.stringify(expected)})`}`);
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log("— 双击：第二次必须被拦下 —");
{
  const gate = createSubmitGate();
  let runs = 0;
  const submit = async () => gate.run(async () => { runs += 1; await sleep(50); return "done"; });
  const [a, b] = await Promise.all([submit(), submit()]);
  check("第一次执行了", a, "done");
  check("第二次没有执行（返回 undefined）", b, undefined);
  check("实际只跑了一次", runs, 1);
  check("结束后闸门重新打开", gate.busy, false);
}

console.log("\n— 连续（跨事件循环）的两次提交：第二次在第一次结束前到达 —");
{
  const gate = createSubmitGate();
  let runs = 0;
  const first = gate.run(async () => { runs += 1; await sleep(80); });
  await sleep(10); // 第二次点击到达
  const second = await gate.run(async () => { runs += 1; });
  await first;
  check("第二次被拦下", second, undefined);
  check("只跑了一次", runs, 1);
}

console.log("\n— 失败不会卡住闸门（否则以后就发不出去了）—");
{
  const gate = createSubmitGate();
  await gate.run(async () => { throw new Error("turn/start failed"); }).catch(() => {});
  check("抛错后闸门已释放", gate.busy, false);
  check("之后仍然可以提交", await gate.run(async () => "ok"), "ok");
}

console.log("\n— 串行提交互不影响 —");
{
  const gate = createSubmitGate();
  await gate.run(async () => {});
  check("第二次（串行）可以正常执行", await gate.run(async () => "second"), "second");
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
