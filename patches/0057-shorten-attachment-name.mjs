// Patch 0057 — 折叠态的附件名也要收短（0056 的收尾）。
//
// 0056 之后气泡缩到 3 行，但上传文件名本身有 70+ 字符（时间戳 + 哈希），
// 在 1080px 宽的手机上照样折三行、每行都是乱码般的哈希——仍然读不出是哪个文件（E119 后续截图）。
// 折叠态改成「头 14 + … + 尾 18」：尾部带扩展名，一眼能分清 pdf/图片；
// 完整路径仍然点一下就有，并且展开时不再重复显示文件名。
//
// Usage: node patches/0057-shorten-attachment-name.mjs [appDir]
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const appDir = resolve(process.argv[2] ?? new URL("../app", import.meta.url).pathname);

{
  const path = resolve(appDir, "public/app.js");
  let source = readFileSync(path, "utf8");
  const WANT = "return name.length<=26?name:name.slice(0,12)+'…'+name.slice(-13);";
  const OLD = "return name.length<=36?name:name.slice(0,14)+'…'+name.slice(-18);";
  if (source.includes(WANT)) {
    console.log("skip  public/app.js (already applied)");
  } else if (source.includes(OLD)) {
    // 26 字符的预算来自真机：33 字符在 1080px 宽的手机上仍然折成两行（E119 第二次截图）。
    writeFileSync(path, source.replace(OLD, WANT));
    console.log("apply public/app.js: tighten shortAttachmentName");
  } else {
    const from = "function userAttachmentChipHtml(path){\n  const name=path.split('/').filter(Boolean).pop()||path;";
    if (source.split(from).length - 1 !== 1) throw new Error("cannot locate userAttachmentChipHtml exactly once");
    const to = "// 上传文件名常是 70+ 字符（时间戳 + 哈希），折叠态留头尾两截即可：\n"
      + "// 尾部带扩展名，一眼能分清 pdf / 图片；完整路径点开就有。\n"
      + "// 26 字符的预算来自真机：33 字符在 1080px 宽的手机上仍然折成两行（E119）。\n"
      + "function shortAttachmentName(name){\n"
      + "  " + WANT + "\n"
      + "}\n"
      + "function userAttachmentChipHtml(path){\n"
      + "  const name=shortAttachmentName(path.split('/').filter(Boolean).pop()||path);";
    writeFileSync(path, source.replace(from, to));
    console.log("apply public/app.js: shortAttachmentName");
  }
}

{
  const path = resolve(appDir, "public/style.css");
  let css = readFileSync(path, "utf8");
  if (css.includes(".user-attachment.open .user-attachment-name")) {
    console.log("skip  public/style.css (already applied)");
  } else {
    const from = ".user-attachment.open .user-attachment-hint{opacity:.65}";
    if (css.split(from).length - 1 !== 1) throw new Error("cannot locate the open-state hint rule exactly once");
    writeFileSync(path, css.replace(from, from + "\n/* 展开时文件名就多余了：路径本身就以文件名结尾。 */\n.user-attachment.open .user-attachment-name{display:none}"));
    console.log("apply public/style.css: hide the name while open");
  }
}

console.log("done — rebuild the bundle: cd app && bun build public/app.js --target=browser --outfile=public/app.bundle.js");
