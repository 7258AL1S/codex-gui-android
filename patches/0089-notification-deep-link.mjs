// Patch 0089 — P7：通知点击直达对应会话（深链）。
//
// 现状：点通知只把应用拉到前台，不管那条通知说的是哪个会话——多开会话时就只能自己翻。
// 协议/桥已经把 threadId 摆在手边（回合完成/审批都属于某个 thread），所以整条链路是：
//
//   桥（notification/native 载荷带 threadId）
//     → 页面 nativeNotify(title, body, tag, threadId)
//       → APK 的 CodexNative.notify(..., threadId)（4 个参数）
//         → 通知的 PendingIntent 带上 threadId extra
//           → MainActivity 在 onPageFinished / onNewIntent 里把 threadId 交给页面
//             → window.codexDeepLinkOpen(threadId) → 打开那个会话
//
// 兼容：老页面（3 个参数）仍然能用——APK 侧把第四个参数当可选。
// 本脚本改的是 APK 源码（~/android-build/codexgui/src/...），不是 WebUI；改完要重建 APK。
//
// Usage: node patches/0089-notification-deep-link.mjs
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const root = process.env.CODEXGUI_APK_DIR || join(homedir(), "android-build", "codexgui");
const notifier = join(root, "src/dev/termux/codexgui/NativeNotifier.java");
const activity = join(root, "src/dev/termux/codexgui/MainActivity.java");
for (const file of [notifier, activity]) {
  if (!existsSync(file)) throw new Error("APK source not found: " + file);
}

function replaceOnce(file, from, to, label) {
  const source = readFileSync(file, "utf8");
  if (source.includes(to) && to.length > 40) {
    console.log("skip  " + label);
    return;
  }
  const hits = source.split(from).length - 1;
  if (hits !== 1) throw new Error(`${label}: cannot locate exactly once (hits=${hits})`);
  writeFileSync(file, source.replace(from, to));
  console.log("apply " + label);
}

// 1) NativeNotifier：多一个 threadId 参数，并塞进 PendingIntent
replaceOnce(notifier,
  `    @JavascriptInterface
    public void notify(String title, String body, String tag) {
        try {
            NotificationManager manager = context.getSystemService(NotificationManager.class);
            if (manager == null) return;
            ensureChannel(manager);

            PendingIntent open = PendingIntent.getActivity(
                    context, 0,
                    new Intent(context, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
                    PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);`,
  `    @JavascriptInterface
    public void notify(String title, String body, String tag) {
        notify(title, body, tag, null);
    }

    /**
     * 第 4 个参数是会话 id（深链）：点通知直接把应用带到那条会话，而不是只把应用拉到前台。
     * 页面的老版本只传 3 个参数，所以保留上面那个重载。
     */
    @JavascriptInterface
    public void notify(String title, String body, String tag, String threadId) {
        try {
            NotificationManager manager = context.getSystemService(NotificationManager.class);
            if (manager == null) return;
            ensureChannel(manager);

            Intent openIntent = new Intent(context, MainActivity.class)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                    .putExtra("codexThreadId", threadId == null ? "" : threadId);
            PendingIntent open = PendingIntent.getActivity(
                    context, 0,
                    openIntent,
                    PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);`,
  "NativeNotifier.notify(threadId)");

// 2) MainActivity：把 threadId 交给页面（页面加载完成后 / 已在运行时收到新 Intent）
replaceOnce(activity,
  `            @Override
            public void onPageFinished(WebView view, String url) {
                pageLoaded = true;
                showPage();
            }`,
  `            @Override
            public void onPageFinished(WebView view, String url) {
                pageLoaded = true;
                showPage();
                deliverDeepLink();
            }`,
  "MainActivity.onPageFinished delivers the deep link");

replaceOnce(activity,
  `    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        if (intent != null && BridgeService.ACTION_RELOAD.equals(intent.getAction())) {
            if (webView != null) webView.reload();
        }
    }`,
  `    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        if (intent != null && BridgeService.ACTION_RELOAD.equals(intent.getAction())) {
            if (webView != null) webView.reload();
            return;
        }
        if (intent != null && intent.hasExtra("codexThreadId")) {
            pendingDeepLink = intent.getStringExtra("codexThreadId");
            deliverDeepLink();
        }
    }

    /** 通知里带的会话 id；页面没加载好就先存着，等 onPageFinished 再交。 */
    private String pendingDeepLink = null;

    private void deliverDeepLink() {
        if (pendingDeepLink == null || pendingDeepLink.isEmpty()) return;
        if (webView == null || !pageLoaded) return;
        final String threadId = pendingDeepLink;
        pendingDeepLink = null;
        try {
            webView.evaluateJavascript(
                    "window.codexDeepLinkOpen && window.codexDeepLinkOpen('" + threadId.replace("'", "") + "')",
                    value -> BridgeClient.report("deep link delivered: " + threadId));
        } catch (Exception error) {
            BridgeClient.report("deep link failed: " + error.getMessage());
        }
    }`,
  "MainActivity deep link plumbing");

// 3) 冷启动（onCreate）也要收：Intent 里可能已经有 threadId
replaceOnce(activity,
  `    private void loadPage() {
        pageLoaded = false;`,
  `    private void loadPage() {
        if (pendingDeepLink == null && getIntent() != null && getIntent().hasExtra("codexThreadId")) {
            pendingDeepLink = getIntent().getStringExtra("codexThreadId");
        }
        pageLoaded = false;`,
  "MainActivity picks up the deep link on a cold start");

// 4) 桥：通知载荷带 threadId（回合完成时用它所属的会话）
{
  const server = join(homedir(), "codex-gui", "app", "server.ts");
  const source = readFileSync(server, "utf8");
  const marker = "sendNativeNotification({ title, body, tag, threadId";
  if (source.includes("threadId?: string")) {
    console.log("skip  bridge notification payload");
  } else {
    const from = "function sendNativeNotification(payload: { title: string; body: string; tag: string }) {";
    const to = "function sendNativeNotification(payload: { title: string; body: string; tag: string; threadId?: string }) {";
    if (source.split(from).length - 1 !== 1) throw new Error("cannot locate sendNativeNotification");
    writeFileSync(server, source.replace(from, to));
    console.log("apply bridge notification payload (threadId)");
  }
  void marker;
}

console.log("done — rebuild the APK: cd ~/android-build/codexgui && sh build.sh --install");
