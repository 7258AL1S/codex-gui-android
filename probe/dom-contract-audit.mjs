// DOM contract audit: every element the frontend grabs by id or by data attribute
// must exist in index.html, or exist because JS creates it.
//
// Why this exists (VERIFICATION.md E86): `document.querySelector('[data-composer-control="add"]')`
// survived in the wiring block after that attribute was dropped from the markup. The
// resulting `null.onclick = …` aborted the whole bundle at module evaluation — the page
// still painted its static markup, so it looked like a caching problem and cost several
// rounds of wrong theories. Run this after ANY edit to public/*.js or index.html.
//
// Usage: node probe/dom-contract-audit.mjs [appDir]
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const appDir = resolve(process.argv[2] ?? fileURLToPath(new URL("../app", import.meta.url)));
const publicDir = resolve(appDir, "public");

const html = readFileSync(resolve(publicDir, "index.html"), "utf8");
const declaredIds = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]));
const declaredDataAttrs = new Set(
  [...html.matchAll(/\bdata-([a-z0-9-]+)="([^"]*)"/g)].map((match) => `${match[1]}=${match[2]}`),
);

const scripts = readdirSync(publicDir).filter((name) => name.endsWith(".js") && name !== "app.bundle.js");

// A lookup is safe only when it is explicitly guarded. Accepted shapes:
//   $('[data-x]')?.onclick = …            (optional chaining)
//   const el = $('[data-x]'); if (el) …   (guarded binding)
// Anything else — including `const el = $(…); el.onclick = …` — dies on a null.
const guardPatterns = (name) => [
  `if(${name})`,
  `if (${name})`,
  `if(!${name})`,
  `if (!${name})`,
  `${name}&&`,
  `${name} &&`,
];
const isGuarded = (source, match) => {
  const after = source.slice(match.index + match[0].length, match.index + match[0].length + 4);
  if (after.startsWith("?.")) return true;
  const before = source.slice(Math.max(0, match.index - 40), match.index);
  const binding = /(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*=\s*(?:document\.|globalThis\.)?$/.exec(before);
  if (!binding) return false;
  return guardPatterns(binding[1]).some((guard) => source.includes(guard));
};

const missingIds = new Map();
const optionalIds = new Map();
const dynamicIds = new Map();
const missingDataAttrs = new Map();
const optionalDataAttrs = new Map();

for (const name of scripts) {
  const source = readFileSync(resolve(publicDir, name), "utf8");
  const idPatterns = [
    /\$\(\s*['"]#([A-Za-z0-9_-]+)['"]\s*\)/g,
    /getElementById\(\s*['"]([A-Za-z0-9_-]+)['"]\s*\)/g,
    /querySelector\(\s*['"]#([A-Za-z0-9_-]+)['"]\s*\)/g,
  ];
  for (const pattern of idPatterns) {
    for (const match of source.matchAll(pattern)) {
      const id = match[1];
      if (declaredIds.has(id)) continue;
      const created =
        source.includes(`.id='${id}'`) ||
        source.includes(`.id="${id}"`) ||
        source.includes(`id='${id}'`) ||
        source.includes(`id="${id}"`);
      if (created) { dynamicIds.set(id, name); continue; }
      (isGuarded(source, match) ? optionalIds : missingIds).set(id, name);
    }
  }
  for (const match of source.matchAll(/querySelector\(\s*['"]\[(data-[a-z0-9-]+)="([^"]+)"\]['"]\s*\)/g)) {
    const key = `${match[1].slice("data-".length)}=${match[2]}`;
    if (declaredDataAttrs.has(key)) continue;
    (isGuarded(source, match) ? optionalDataAttrs : missingDataAttrs).set(key, name);
  }
}

console.log(`index.html declares ${declaredIds.size} ids and ${declaredDataAttrs.size} data-* attributes`);
console.log(`scanned ${scripts.length} frontend scripts`);
for (const [id, file] of dynamicIds) console.log(`  dynamic  #${id} (created by ${file})`);
for (const [id, file] of optionalIds) console.log(`  optional #${id} (looked up and guarded by ${file})`);
for (const [key, file] of optionalDataAttrs) console.log(`  optional [data-${key}] (looked up and guarded by ${file})`);

let failed = false;
for (const [id, file] of missingIds) {
  console.log(`MISSING  #${id} referenced by ${file} but never declared and never created`);
  failed = true;
}
for (const [key, file] of missingDataAttrs) {
  console.log(`MISSING  [data-${key}] referenced by ${file} but never declared`);
  failed = true;
}

if (failed) {
  console.log("FAIL — a null lookup here aborts the bundle at module evaluation (E86)");
  process.exit(1);
}
console.log("ok — every frontend selector resolves");
