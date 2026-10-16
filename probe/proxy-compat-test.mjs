// Controlled experiment: does `codex app-server proxy --sock` work against a
// CURRENT-version app-server, while failing against the long-running daemon?
//
// Starts a throwaway app-server on a private unix socket, connects the official
// proxy to it, and reports what happens. The throwaway server is killed at the
// end. The long-running daemon is never touched.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const SOCK = join(tmpdir(), `compat-test-${process.pid}.sock`);

const server = spawn("codex", ["app-server", "--listen", `unix://${SOCK}`], {
  stdio: ["ignore", "pipe", "pipe"],
});
server.stdout.on("data", (d) => process.stdout.write("[server] " + d));
server.stderr.on("data", (d) => process.stdout.write("[server:err] " + d));

const cleanup = (code = 0) => {
  try { server.kill("SIGTERM"); } catch {}
  setTimeout(() => process.exit(code), 300);
};

// wait for the socket to appear
for (let i = 0; i < 60; i++) {
  if (existsSync(SOCK)) break;
  await new Promise((r) => setTimeout(r, 250));
}
console.log(`socket present: ${existsSync(SOCK)} at ${SOCK}`);

const proxy = spawn("codex", ["app-server", "proxy", "--sock", SOCK], {
  stdio: ["pipe", "pipe", "pipe"],
});
let out = "";
proxy.stdout.on("data", (d) => { out += d.toString(); });
proxy.stderr.on("data", (d) => console.error("[proxy:err]", String(d).trimEnd().slice(0, 200)));

proxy.stdin.write(JSON.stringify({
  method: "initialize",
  id: 1,
  params: {
    clientInfo: { name: "compat-test", title: "Compat Test", version: "0.0.1" },
    capabilities: { experimentalApi: true, requestAttestation: false },
  },
}) + "\n");

await new Promise((r) => setTimeout(r, 6000));
console.log("== proxy -> current-version app-server, initialize result ==");
console.log(out.slice(0, 600) || "(no response)");
cleanup(0);
