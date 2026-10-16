// P2 item 1 — pin the bridge's auth/origin behaviour and the hardening target.
//
// Threat model that matters on Android: "loopback" is NOT a boundary between
// apps. Any other app on the phone can open a socket to 127.0.0.1:8899 and send
// whatever headers it likes. So the free pass for loopback callers means another
// app can drive this bridge — which can run shell commands as the Termux user.
//
// These assertions state the DESIRED behaviour, so a failing case is work to do.
import { isRequestAuthorized } from "../app/server-security.js";

let failures = 0;
const check = (label, actual, expected) => {
  const ok = actual === expected;
  if (!ok) failures += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}: ${actual}${ok ? "" : ` (expected ${expected})`}`);
};

const LOOPBACK = { remoteAddress: "127.0.0.1", hostHeader: "127.0.0.1:8899" };
const LAN = { remoteAddress: "192.168.1.50", hostHeader: "192.168.1.50:8899" };

console.log("— 攻击面：这些必须被拒绝（与是否有密码无关）—");
check("DNS 重绑定：回环 socket + Host 是外部域名",
  isRequestAuthorized({ ...LOOPBACK, hostHeader: "evil.example" }), false);
check("跨站 Origin",
  isRequestAuthorized({ ...LOOPBACK, origin: "https://evil.example" }), false);
check("浏览器标记为跨站（sec-fetch-site: cross-site）",
  isRequestAuthorized({ ...LOOPBACK, fetchSite: "cross-site" }), false);
check("局域网来客冒充回环 Host（socket 地址不可伪造）",
  isRequestAuthorized({ ...LAN, hostHeader: "127.0.0.1:8899" }), false);
check("回环 socket 但经过代理（x-forwarded-for）不能再吃免费通道",
  isRequestAuthorized({ ...LOOPBACK, forwardedFor: "127.0.0.1" }), false);
check("IPv6 回环映射地址 + 外部 Host",
  isRequestAuthorized({ remoteAddress: "::ffff:127.0.0.1", hostHeader: "evil.example" }), false);

console.log("\n— 默认（未设密码）：保持现有便利，本机浏览器可直接用 —");
check("回环 + 回环 Host + 无凭据",
  isRequestAuthorized({ ...LOOPBACK }), true);
check("IPv6 回环 ::1",
  isRequestAuthorized({ remoteAddress: "::1", hostHeader: "[::1]:8899" }), true);
check("Host 写成 localhost",
  isRequestAuthorized({ remoteAddress: "127.0.0.1", hostHeader: "localhost:8899" }), true);
check("同源 Origin（页面自己发起的请求）",
  isRequestAuthorized({ ...LOOPBACK, origin: "http://127.0.0.1:8899" }), true);

console.log("\n— 硬化目标：一旦设置了密码/令牌，回环也不再免鉴权 —");
const token = "s3cret-token-value";
check("回环 + 设了令牌 + 不带凭据 → 必须拒绝",
  isRequestAuthorized({ ...LOOPBACK, accessToken: token }), false);
check("回环 + 设了令牌 + 正确 Bearer → 通过",
  isRequestAuthorized({ ...LOOPBACK, accessToken: token, authorization: `Bearer ${token}` }), true);
check("回环 + 设了令牌 + 错误 Bearer → 拒绝",
  isRequestAuthorized({ ...LOOPBACK, accessToken: token, authorization: "Bearer wrong" }), false);
check("局域网 + 设了令牌 + 正确 Bearer → 通过",
  isRequestAuthorized({ ...LAN, accessToken: token, authorization: `Bearer ${token}` }), true);
check("局域网 + 设了令牌 + 不带凭据 → 拒绝",
  isRequestAuthorized({ ...LAN, accessToken: token }), false);

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
