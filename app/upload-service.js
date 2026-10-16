// Saves files the browser picked with the system file chooser, so the app-server
// can read them by path.
//
// Why this exists at all: a browser hands a page the file *bytes* (File/Blob) and
// never a real filesystem path, while the protocol wants `{type:"localImage",path}`
// / `{type:"mention",path}`. Termux is the one place both sides can meet, so the
// bytes land here once and the page gets a path back.
//
// Trust model: the caller is the authenticated page, but a filename arriving over
// HTTP is still hostile input — it is sanitized, never used verbatim as a path
// component, and the final path is re-checked to be inside the upload directory.
import { mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { open, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { resolve, sep } from "node:path";

// Same ceiling as image-service.js: larger files could not be rendered anyway.
export const UPLOAD_MAX_BYTES = 25 * 1024 * 1024;
export const DEFAULT_PRUNE_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const DEFAULT_PRUNE_INTERVAL_MS = 60 * 60 * 1000;

// Mirrors image-service.js IMAGE_TYPES: anything else is a plain file reference.
const IMAGE_EXTENSIONS = new Set([".avif", ".bmp", ".gif", ".jpeg", ".jpg", ".png", ".webp"]);

export function sanitizeUploadName(name) {
  const raw = String(name ?? "").split(/[\\/]/).pop() ?? "";
  const cleaned = raw
    .replace(/[\u0000-\u001f]/g, "")
    .replace(/[^\p{L}\p{N}._-]+/gu, "_")
    // Leading dots would make the upload a hidden file; a leading "_" reads like
    // "the bridge changed this name", which is noise. Strip both.
    .replace(/^[._]+/, "")
    .replace(/_+\./g, ".")
    .replace(/[._]+$/, "")
    .trim();
  // Keep the tail: the extension has to survive to be recognizable later.
  return cleaned.slice(-120) || "upload";
}

export function uploadKind(name) {
  const value = String(name ?? "");
  const dot = value.lastIndexOf(".");
  const extension = dot >= 0 ? value.slice(dot).toLowerCase() : "";
  return IMAGE_EXTENSIONS.has(extension) ? "image" : "file";
}

function decodeBase64(data) {
  const text = String(data ?? "");
  const payload = (text.startsWith("data:") ? text.slice(text.indexOf(",") + 1) : text).trim();
  if (!payload) throw new Error("Empty upload payload");
  if (!/^[A-Za-z0-9+/=\s]+$/.test(payload)) throw new Error("Upload payload is not base64");
  return Buffer.from(payload, "base64");
}

function tooLarge(maxBytes) {
  return new Error(`File is larger than ${Math.floor(maxBytes / (1024 * 1024))} MB`);
}

export function saveUpload({ name, dataBase64 } = {}, { dir, maxBytes = UPLOAD_MAX_BYTES, now = Date.now } = {}) {
  if (!dir) throw new Error("Uploads are not configured");
  // Check the encoded length first: decoding a 100 MB payload just to reject it
  // would cost exactly as much memory as accepting it.
  if (String(dataBase64 ?? "").length > Math.ceil((maxBytes * 4) / 3) + 1024) throw tooLarge(maxBytes);
  const bytes = decodeBase64(dataBase64);
  if (!bytes.length) throw new Error("Empty file");
  if (bytes.length > maxBytes) throw tooLarge(maxBytes);

  const root = resolve(dir);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const safe = sanitizeUploadName(name);
  const stamp = new Date(now()).toISOString().replace(/[-:T]/g, "").slice(0, 14);
  const target = resolve(root, `${stamp}-${randomUUID().slice(0, 8)}-${safe}`);
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  if (!target.startsWith(prefix)) throw new Error("Refusing to write outside the upload directory");
  writeFileSync(target, bytes, { mode: 0o600 });
  return { path: target, name: safe, bytes: bytes.length, kind: uploadKind(safe) };
}

/**
 * 原始字节流版本（浏览器直接把 `File` 当 body 发，不走 base64+JSON）。
 *
 * 为什么要有它：base64 会让体积涨 33%，客户端还要先把整个文件读成 data URL、再
 * `JSON.stringify` 成一个十几 MB 的字符串 —— 那一步在 WebView 主线程上是同步的，
 * 而且**字符串 body 的 `xhr.upload.onprogress` 拿不到 `lengthComputable/length`**，
 * 于是进度条永远停在 0（用户看到的"没有进度条"就是这个）。发原始字节就没有这两件事：
 * 体积不膨胀、进度事件可用、桥这边也是边收边写盘（不再把整份内容堆在内存里）。
 */
export async function saveUploadStream(body, { dir, name, maxBytes = UPLOAD_MAX_BYTES, now = Date.now } = {}) {
  if (!dir) throw new Error("Uploads are not configured");
  if (!body || typeof body[Symbol.asyncIterator] !== "function") throw new Error("Upload body is not a stream");
  const root = resolve(dir);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const safe = sanitizeUploadName(name);
  const stamp = new Date(now()).toISOString().replace(/[-:T]/g, "").slice(0, 14);
  const target = resolve(root, `${stamp}-${randomUUID().slice(0, 8)}-${safe}`);
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  if (!target.startsWith(prefix)) throw new Error("Refusing to write outside the upload directory");

  const handle = await open(target, "wx", 0o600);
  let bytes = 0;
  try {
    for await (const chunk of body) {
      bytes += chunk.length;
      // 先写超出部分再报错是不行的：宁可这里拒掉，也不要落一个半截文件。
      if (bytes > maxBytes) throw tooLarge(maxBytes);
      await handle.write(chunk);
    }
    if (!bytes) throw new Error("Empty file");
  } catch (error) {
    await handle.close().catch(() => {});
    await unlink(target).catch(() => {});
    throw error;
  }
  await handle.close();
  return { path: target, name: safe, bytes, kind: uploadKind(safe) };
}

export function pruneUploads(dir, { maxAgeMs = DEFAULT_PRUNE_AGE_MS, now = Date.now } = {}) {
  const removed = [];
  let entries = [];
  try { entries = readdirSync(resolve(dir)); }
  catch { return removed; }
  const cutoff = now() - maxAgeMs;
  for (const entry of entries) {
    const path = resolve(dir, entry);
    try {
      const stats = statSync(path);
      if (!stats.isFile() || stats.mtimeMs >= cutoff) continue;
      unlinkSync(path);
      removed.push(entry);
    } catch { /* a file that vanished mid-scan is not a problem */ }
  }
  return removed;
}

// Uploads are a cache, not an archive: prune old ones on a timer so a long-lived
// bridge does not slowly fill the phone. Call with force=true to run it now.
export function createUploadPruner(dir, { maxAgeMs = DEFAULT_PRUNE_AGE_MS, intervalMs = DEFAULT_PRUNE_INTERVAL_MS, now = Date.now } = {}) {
  let nextRunAt = 0;
  return (force = false) => {
    if (!force && now() < nextRunAt) return [];
    nextRunAt = now() + intervalMs;
    return pruneUploads(dir, { maxAgeMs, now });
  };
}
