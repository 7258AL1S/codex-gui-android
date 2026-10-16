import { lstatSync, realpathSync, statSync } from "node:fs";
import { createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { resolve, sep } from "node:path";

// Methods the browser client may invoke through the bridge.
//
// Trust model: the bridge is reachable only from loopback and every request
// must pass origin + auth checks (see isRequestAuthorized). A client that can
// reach it can already drive an agent that runs shell commands, so blocking
// these methods would be theatre — the real boundary is "only our own page may
// talk to the bridge". Content rendered from agent output (previews, generated
// HTML) must therefore live on a different origin or in a sandboxed frame so it
// cannot reach this API.
//
// Grouped for review; every entry was verified against the generated protocol
// types (see VERIFICATION.md E6) before being added.
const BROWSER_RPC_METHODS = new Set([
  // --- discovery / read-only ---------------------------------------------
  "model/list",
  // The composer's Default/Plan chip calls this (E66). It was missing from the
  // allowlist, so the chip silently never appeared — see E75.
  "collaborationMode/list",
  "modelProvider/capabilities/read",
  "account/read",
  "account/usage/read",
  "account/rateLimits/read",
  "config/read",
  "configRequirements/read",
  "permissionProfile/list",
  "experimentalFeature/list",
  "skills/list",
  "hooks/list",
  "mcpServerStatus/list",
  "plugin/list",
  "plugin/installed",
  "plugin/read",
  "plugin/skill/read",
  "app/list",
  "app/installed",
  "app/read",
  "getAuthStatus",
  "getConversationSummary",
  "gitDiffToRemote",
  "fuzzyFileSearch",
  // --- threads / sessions -------------------------------------------------
  "thread/list",
  // The sidebar groups by project when any exist (patches/0028). Missing from the
  // allowlist at first — caught by the audit for the second time (E81).
  "project/list",
  "thread/read",
  "thread/turns/list",
  "thread/items/list",
  "thread/loaded/list",
  "thread/start",
  "thread/resume",
  "thread/fork",
  "thread/name/set",
  "thread/archive",
  "thread/unarchive",
  "thread/delete", // destructive: the UI must confirm before calling
  "thread/compact/start",
  "thread/revert", // history only; does NOT revert files (see VERIFICATION.md E12)
  "thread/unsubscribe",
  "thread/goal/set",
  "thread/goal/get",
  "thread/goal/clear",
  "thread/attachment/add",
  "thread/attachment/list",
  "thread/attachment/remove",
  "thread/shellCommand",
  "threadSection/list",
  // The generated types say `threadSection/move`, but the running server rejects
  // that name ("unknown variant") and accepts `thread/section/move` instead — see
  // VERIFICATION.md E59. Only the working name is listed now: probe/allowlist-audit.mjs
  // diffs this list against the server's real method set, and an entry that can
  // never succeed is just noise.
  "thread/section/move",
  // Queued messages (patches 0026/0027). Both were missing from the allowlist, so
  // the queue silently failed in the browser — caught by the new "frontend calls vs
  // allowlist" check in probe/allowlist-audit.mjs (E76).
  "thread/queue/add",
  "thread/queue/list",
  "threadSection/create",
  "threadSection/update",
  "threadSection/delete",
  // --- turns --------------------------------------------------------------
  "turn/start",
  "turn/steer",
  "turn/interrupt",
  "review/start",
  // --- filesystem ---------------------------------------------------------
  "fs/readFile",
  "fs/readDirectory",
  "fs/getMetadata",
  "fs/writeFile",
  "fs/createDirectory",
  "fs/remove", // destructive: the UI must confirm before calling
  "fs/copy",
  "fs/watch",
  "fs/unwatch",
  // --- integrated terminal (protocol PTY, see VERIFICATION.md E11) --------
  "command/exec",
  "command/exec/write",
  "command/exec/resize",
  "command/exec/terminate",
  // --- configuration / extensions ----------------------------------------
  // config writes go through the bridge's guarded route (POST /api/config/write):
  // the browser must not be able to write arbitrary keyPaths (P7 requirement).
  "skills/config/write",
  "skills/extraRoots/set",
  "experimentalFeature/enablement/set",
  "mcpServer/oauth/login",
  "mcpServer/tool/call",
  "mcpServer/resource/read",
  "config/mcpServer/reload",
  "plugin/install",
  "plugin/uninstall",
  "plugin/reconcile",
  // --- bridge-internal ----------------------------------------------------
  "host/thread/live",
  "account/logout",
]);

const PUBLIC_ASSETS = new Set([
  "/index.html",
  "/style.css",
  "/favicon.svg",
  "/auth-bootstrap.js",
  "/i18n.js",
  "/codex-brand.js",
  "/app.bundle.js",
  "/assets/codex-app-icon-128.png",
  "/assets/codex-app-icon.png",
  "/assets/codex-motion/local-context.json",
  "/assets/codex-motion/searching.json",
  "/assets/codex-motion/list-files.json",
  "/assets/codex-motion/edit-files.json",
  "/assets/codex-motion/run-command.json",
]);

const inside = (path, root) => path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);

function safeEqual(left, right) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

const PASSWORD_SESSION_COOKIE = "codex_webui_session";
const DEFAULT_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const STORED_PASSWORD_VERSION = 1;

function sessionSignature(payload, password) {
  return createHmac("sha256", password).update(payload).digest("base64url");
}

export function parseCookieHeader(header) {
  const values = {};
  for (const part of String(header || "").split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    const name = part.slice(0, separator).trim();
    if (!name) continue;
    try { values[name] = decodeURIComponent(part.slice(separator + 1).trim()); }
    catch { values[name] = part.slice(separator + 1).trim(); }
  }
  return values;
}

export function createPasswordSession(password, { now = Date.now(), ttlMs = DEFAULT_SESSION_TTL_MS } = {}) {
  const expiresAt = now + ttlMs;
  const payload = `${expiresAt}.${randomBytes(24).toString("base64url")}`;
  return { token: `${payload}.${sessionSignature(payload, password)}`, expiresAt };
}

export function verifyPasswordSession(token, password, { now = Date.now() } = {}) {
  if (!token || !password) return false;
  const pieces = String(token).split(".");
  if (pieces.length !== 3) return false;
  const [expiresText, nonce, signature] = pieces;
  const expiresAt = Number(expiresText);
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= now || !nonce || !signature) return false;
  return safeEqual(signature, sessionSignature(`${expiresText}.${nonce}`, password));
}

export function passwordSessionCookie(token, { secure = false, maxAgeSeconds = Math.floor(DEFAULT_SESSION_TTL_MS / 1000) } = {}) {
  return `${PASSWORD_SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSeconds}${secure ? "; Secure" : ""}`;
}

export function createStoredPassword(password, { salt = randomBytes(16).toString("base64url") } = {}) {
  if (typeof password !== "string" || !password || typeof salt !== "string" || !salt) throw new Error("Password and salt are required");
  const hash = scryptSync(password, salt, 32).toString("base64url");
  return { version: STORED_PASSWORD_VERSION, algorithm: "scrypt", salt, hash };
}

export function isStoredPassword(value) {
  return value?.version === STORED_PASSWORD_VERSION
    && value?.algorithm === "scrypt"
    && typeof value?.salt === "string"
    && value.salt.length >= 16
    && typeof value?.hash === "string"
    && value.hash.length >= 32;
}

export function verifyStoredPassword(password, credential) {
  if (typeof password !== "string" || !isStoredPassword(credential)) return false;
  try { return safeEqual(scryptSync(password, credential.salt, 32).toString("base64url"), credential.hash); }
  catch { return false; }
}

export function storedPasswordSessionSecret(credential) {
  if (!isStoredPassword(credential)) return null;
  return createHash("sha256").update(`codex-webui-session:${credential.salt}:${credential.hash}`).digest("base64url");
}

function hostnameOf(hostHeader) {
  if (!hostHeader) return null;
  try { return new URL(`http://${hostHeader}`).hostname.replace(/^\[|\]$/g, "").toLowerCase(); }
  catch { return null; }
}

function isLoopbackAddress(address) {
  const value = (address || "").replace(/^::ffff:/, "").toLowerCase();
  return value === "127.0.0.1" || value === "::1";
}

function isLoopbackHost(hostHeader) {
  const host = hostnameOf(hostHeader);
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

function isSameOrigin(origin, hostHeader) {
  if (!origin) return true;
  try { return new URL(origin).host.toLowerCase() === String(hostHeader || "").toLowerCase(); }
  catch { return false; }
}

function suppliedToken(authorization) {
  if (!authorization) return null;
  if (authorization.startsWith("Bearer ")) return authorization.slice(7);
  if (!authorization.startsWith("Basic ")) return null;
  try {
    const decoded = Buffer.from(authorization.slice(6), "base64").toString("utf8");
    const separator = decoded.indexOf(":");
    if (separator < 0 || decoded.slice(0, separator) !== "codex") return null;
    return decoded.slice(separator + 1);
  } catch { return null; }
}

export function isAllowedBrowserRpcMethod(method) {
  return typeof method === "string" && BROWSER_RPC_METHODS.has(method);
}

export function isRequestAuthorized({ remoteAddress, hostHeader, authorization, accessToken, cookie = null, origin = null, fetchSite = null, forwardedFor = null, forwarded = null, realIp = null, allowLoopback = true, now = Date.now() }) {
  if (fetchSite === "cross-site" || !isSameOrigin(origin, hostHeader)) return false;
  const proxied = Boolean(forwardedFor || forwarded || realIp);
  // Loopback is NOT a trust boundary on Android: any other app on the phone can
  // open a socket to 127.0.0.1 and forge any header. So the free pass only applies
  // while no secret has been configured. Once the operator sets a password or a
  // token, it is required on loopback too — previously a wrong token from loopback
  // was still accepted (VERIFICATION.md E52).
  if (allowLoopback && !proxied && isLoopbackAddress(remoteAddress) && isLoopbackHost(hostHeader)) {
    if (!accessToken) return true;
  }
  if (accessToken) {
    const candidate = suppliedToken(authorization);
    if (candidate != null && safeEqual(candidate, accessToken)) return true;
    return verifyPasswordSession(parseCookieHeader(cookie)[PASSWORD_SESSION_COOKIE], accessToken, { now });
  }
  return false;
}

export function resolveSafeRegularFile(root, relativePath) {
  try {
    const canonicalRoot = realpathSync(root);
    const candidate = resolve(root, relativePath);
    if (!inside(candidate, resolve(root))) return null;
    const metadata = lstatSync(candidate);
    if (metadata.isSymbolicLink() || !metadata.isFile()) return null;
    const canonicalFile = realpathSync(candidate);
    if (!inside(canonicalFile, canonicalRoot) || !statSync(canonicalFile).isFile()) return null;
    return canonicalFile;
  } catch { return null; }
}

export function resolvePublicAsset(pathname, publicDir) {
  let decoded;
  try { decoded = decodeURIComponent(pathname); }
  catch { return null; }
  if (decoded === "/") decoded = "/index.html";
  if (!PUBLIC_ASSETS.has(decoded)) return null;
  return resolveSafeRegularFile(publicDir, `.${decoded}`);
}

export function unauthorizedResponse(res) {
  res.writeHead(401, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "www-authenticate": 'Basic realm="Codex WebUI", charset="UTF-8"',
    "x-content-type-options": "nosniff",
  });
  res.end(JSON.stringify({ error: "Authentication required" }));
}

export function isAuthorizedHttpRequest(req, accessToken, allowLoopback = true) {
  return isRequestAuthorized({
    remoteAddress: req.socket.remoteAddress,
    hostHeader: req.headers.host,
    authorization: req.headers.authorization,
    cookie: req.headers.cookie,
    accessToken,
    origin: req.headers.origin,
    fetchSite: req.headers["sec-fetch-site"],
    forwardedFor: req.headers["x-forwarded-for"],
    forwarded: req.headers.forwarded,
    realIp: req.headers["x-real-ip"],
    allowLoopback,
  });
}
