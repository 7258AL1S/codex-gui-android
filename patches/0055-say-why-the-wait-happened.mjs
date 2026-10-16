// Patch 0055 — "等待桥响应"要说清是哪一种。
//
// 现场（E117）：用户报"又有等待桥响应的 bug，等了一小会"。查日志发现那段时间桥被我**重启了四次**
// （02:10:28 / 02:11:28 / 02:13:00 / 02:17:12，都是我在改通知链路）——每次重启都会让页面
// 断开几秒，用户看到的就是"等待桥响应"。同一窗口里还有一个 12.9 秒和一个 129 秒的冻结。
//
// 两种等待在日志上长得一样，但处置完全不同：
//   - 桥刚重启过 → 几秒内自愈，什么都不用做；
//   - 设备把 Termux 挂起 → 几十秒到几分钟，而且不是前端能修的。
// 所以 0042 那句提示要在两种情形下说不同的话。
//
// Usage: node patches/0055-say-why-the-wait-happened.mjs [appDir]
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const appDir = resolve(process.argv[2] ?? new URL("../app", import.meta.url).pathname);
const file = resolve(appDir, "public/app.js");
let source = readFileSync(file, "utf8");

const from = "      clientLog('bridge wait exceeded 8s — the app is probably suspended');\n      toast(t('The bridge has not answered for 8s. Termux is probably suspended; setting its battery policy to \u201cUnrestricted\u201d fixes it.'),9000);";
const to = "      clientLog('bridge wait exceeded 8s — asking the bridge why');\n"
  + "      // 问一句桥的 uptime：刚重启（<2 分钟）就是「我自己重启的锅」，否则才谈系统挂起。\n"
  + "      void (async()=>{\n"
  + "        let uptimeMs=null;\n"
  + "        try{\n"
  + "          const response=await fetch('/api/health',{cache:'no-store'});\n"
  + "          uptimeMs=Number((await response.json())?.uptimeMs);\n"
  + "        }catch(error){/* 桥不可达时保持沉默，下面按未知处理 */}\n"
  + "        if(Number.isFinite(uptimeMs)&&uptimeMs<120000){\n"
  + "          const seconds=Math.max(1,Math.round(uptimeMs/1000));\n"
  + "          clientLog('bridge uptime '+seconds+'s — it was restarted just now, the page is reconnecting');\n"
  + "          toast(t('The bridge was just restarted (N s ago) — the page is reconnecting.').replace('N',String(seconds)),7000);\n"
  + "          return;\n"
  + "        }\n"
  + "        clientLog('bridge uptime '+(Number.isFinite(uptimeMs)?Math.round(uptimeMs/1000)+'s':'unknown')+' — looks like a suspension');\n"
  + "        toast(t('The bridge has not answered for 8s. Termux is probably suspended; setting its battery policy to \u201cUnrestricted\u201d fixes it.'),9000);\n"
  + "      })();";

if (source.includes("asking the bridge why")) {
  console.log("skip  already applied");
} else {
  if (source.split(from).length - 1 !== 1) throw new Error("cannot locate the 8s warning block exactly once");
  writeFileSync(file, source.replace(from, to));
  console.log("apply uptime-aware wait message (1x)");
}

console.log("done — rebuild the bundle: bun build public/app.js --target=browser --outfile=public/app.bundle.js");
