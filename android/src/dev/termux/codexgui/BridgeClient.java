package dev.termux.codexgui;

import android.content.Context;
import android.content.Intent;

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.net.URL;
import java.nio.charset.StandardCharsets;

/**
 * 与 Termux 里的桥 + 通过 Termux:API 拉起它。
 *
 * 运行依赖（APK 自带 WebView 壳，不含 Codex 运行时）：
 *   - Termux 已安装，且 ~/.termux/termux.properties 里 allow-external-apps = true
 *   - 本应用被授予 com.termux.permission.RUN_COMMAND（用户手动给一次）
 *   - 桥脚本位于 ~/bin/codex-gui-web
 */
final class BridgeClient {
    static final String HOST = "127.0.0.1";
    static final int PORT = 8899;
    static final String BASE_URL = "http://" + HOST + ":" + PORT;
    static final String HOME = "/data/data/com.termux/files/home";
    static final String LAUNCHER = HOME + "/bin/codex-gui-web";

    private static final String TERMUX_PACKAGE = "com.termux";
    private static final String TERMUX_RUN_COMMAND_SERVICE = "com.termux.app.RunCommandService";
    private static final String ACTION_RUN_COMMAND = "com.termux.RUN_COMMAND";

    private BridgeClient() {}

    /**
     * 桥的 HTTP 端口是否"连得上"。
     *
     * **注意：连得上不等于桥活着。** Termux 进程被系统冻结（cached-app freezer）时，
     * 内核仍然会用 listen backlog 完成三次握手 —— 2026-10-16 实测（E135）：
     * 用户点开应用后一直转圈，日志里是 `port=open ready=false` 整整 90 秒，
     * 打开 Termux 立刻就好。就是这条判断把"冻住的僵尸监听"当成了"桥在启动"。
     * 判断存活请用 {@link #health()}（要真的收到 HTTP 应答）。
     */
    static boolean isPortOpen() {
        try (Socket socket = new Socket()) {
            socket.connect(new InetSocketAddress(HOST, PORT), 300);
            return true;
        } catch (Exception ignored) {
            return false;
        }
    }

    /**
     * 桥是否已经可以干活。用 `ready`（而不是 `ok`）：桥刚起来时 HTTP 已经在应答，
     * 但 app-server 还没接上，这时候把页面放出来只会看到一堆失败请求。
     */
    static boolean isReady() {
        String body = health();
        return body != null && body.contains("\"ready\":true");
    }

    /**
     * 解冻 Termux：把它切到前台，并再请求一次启动。
     *
     * 为什么只有这招管用：RUN_COMMAND / 分享的意图送进冻结的进程后会**排队**，
     * 要等它解冻才会被执行；而让它解冻的唯一外部手段就是让 Termux 变可见。
     * 用户已经把这条路走通了一遍（"我点开 Termux 就好了"），这里把它自动化，
     * 免得每次都靠人去点。
     */
    static boolean wakeTermux(Context context) {
        openTermux(context);
        // 两条一起发：分享通道会在 Termux 里跑 termux-url-opener（实测要几秒，而且中间可能被
        // 文件接收界面挡一下）；RUN_COMMAND 是静默的 startService —— 之前它在 Termux 处于
        // 后台/冻结时会被 Android 的"前台服务启动限制"挡掉，但我们刚刚已经把 Termux 切到前台了，
        // 这时候它多半能直接生效。两条都发，谁先到都行（launcher 是幂等的）。
        boolean shared = sendCommandViaShare(context, "codex-gui://start");
        boolean ran = runLauncher(context, "start");
        report("escalate: launched Termux + start requests (share=" + (shared ? "sent" : "failed")
                + " runCommand=" + (ran ? "sent" : "failed") + ")");
        return shared || ran;
    }

    /** 返回 /api/health 的原文，失败返回 null。 */
    static String health() {
        HttpURLConnection connection = null;
        try {
            URL url = new URL(BASE_URL + "/api/health");
            connection = (HttpURLConnection) url.openConnection();
            connection.setConnectTimeout(1200);
            connection.setReadTimeout(1200);
            connection.setRequestMethod("GET");
            int code = connection.getResponseCode();
            InputStream stream = code >= 400 ? connection.getErrorStream() : connection.getInputStream();
            if (stream == null) return null;
            StringBuilder text = new StringBuilder();
            try (BufferedReader reader = new BufferedReader(new InputStreamReader(stream, StandardCharsets.UTF_8))) {
                String line;
                while ((line = reader.readLine()) != null) text.append(line);
            }
            return text.toString();
        } catch (Exception ignored) {
            return null;
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    /** 让 Termux 执行 `codex-gui-web <args…>`。返回是否成功把意图送出去。 */
    static boolean runLauncher(Context context, String... args) {
        Intent intent = new Intent();
        intent.setClassName(TERMUX_PACKAGE, TERMUX_RUN_COMMAND_SERVICE);
        intent.setAction(ACTION_RUN_COMMAND);
        intent.putExtra("com.termux.RUN_COMMAND_PATH", LAUNCHER);
        intent.putExtra("com.termux.RUN_COMMAND_ARGUMENTS", args);
        intent.putExtra("com.termux.RUN_COMMAND_WORKDIR", HOME);
        // 后台执行：Session 不在前台，桥自己 setsid 脱离
        intent.putExtra("com.termux.RUN_COMMAND_BACKGROUND", true);
        try {
            context.startService(intent);
            return true;
        } catch (Exception first) {
            try {
                context.startForegroundService(intent);
                return true;
            } catch (Exception ignored) {
                return false;
            }
        }
    }

    /**
     * 请 Termux 启动桥。
     *
     * 首选「分享文本给 Termux」通道：Termux 会执行 `~/bin/termux-url-opener <payload>`，
     * 那条路**不需要** `com.termux.permission.RUN_COMMAND`。这是 2026-10-16 实测的教训——
     * 那条权限没授予时 RUN_COMMAND 会被静默忽略，应用只能干等到 90 秒超时
     * （界面上就是"正在启动桥… 81s（还在等 Termux 执行启动命令）"）。
     * RUN_COMMAND 仍然作为退路保留（用户万一授了权，那条路更直接）。
     */
    static boolean startBridge(Context context) {
        return startBridge(context, "start");
    }

    /**
     * 启动/重启桥，**优先走安静的那条路**。
     *
     * 实测教训（2026-10-16 用户反馈"打开 Codex 会自动跳转 Termux"）：
     * 分享通道虽然不需要权限，但它是通过**拉起 Termux 的 Activity** 实现的，
     * 所以界面会跳到 Termux。`RUN_COMMAND` 走的是 startService，完全不打扰界面——
     * 代价是需要用户授予一次 `com.termux.permission.RUN_COMMAND`。
     *
     * 所以顺序是：有权限 → RUN_COMMAND（安静）；没权限 → 分享（会跳 Termux，
     * 界面必须提前告诉用户，不能让他莫名其妙被切走）。
     */
    private static boolean startBridge(Context context, String action) {
        if (hasRunCommandPermission(context)) {
            if (runLauncher(context, action)) return true;
        }
        if (sendCommandViaShare(context, "codex-gui://" + action)) return true;
        return runLauncher(context, action);
    }

    /** 是否已经拿到 Termux 的 RUN_COMMAND 权限（有它才不会跳到 Termux 界面）。 */
    static boolean hasRunCommandPermission(Context context) {
        try {
            return context.checkSelfPermission("com.termux.permission.RUN_COMMAND")
                    == android.content.pm.PackageManager.PERMISSION_GRANTED;
        } catch (Exception ignored) {
            return false;
        }
    }

    /** 重启桥（通知上的"重启桥"动作用）。 */
    static boolean restartBridge(Context context) {
        return startBridge(context, "restart");
    }

    /**
     * 分享一段**固定字面量**给 Termux。payload 必须是常量（由本方法内部提供），
     * termux-url-opener 那边也只做等值匹配——绝不把外部输入拼进 shell。
     */
    private static boolean sendCommandViaShare(Context context, String payload) {
        Intent intent = new Intent(Intent.ACTION_SEND);
        intent.setType("text/plain");
        intent.putExtra(Intent.EXTRA_TEXT, payload);
        intent.setPackage(TERMUX_PACKAGE);
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            context.startActivity(intent);
            return true;
        } catch (Exception ignored) {
            return false;
        }
    }

    /**
     * 把启动过程中的判断写进桥日志（POST /api/client-log）。
     *
     * 为什么值得做：应用启动失败时用户只看到"转圈"，而我从 Termux 这边看不到任何痕迹
     * ——"端口开着吗、ready 了吗、意图发出去了吗、权限有没有"全靠猜。
     * 现在这些一行一行落在 ~/.codex/codex-webui/bridge.log 里，远程就能定位。
     */
    static void report(String message) {
        new Thread(() -> {
            post("apk: " + message);
        }).start();
    }

    /**
     * 阻塞版上报：给"进程马上就要死"的场合用（未捕获异常处理器）。
     * 那种时候异步线程可能来不及跑完，而这条日志恰恰是最有用的一条。
     */
    static void reportSync(String message) {
        post("apk: " + message);
    }

    private static void post(String message) {
        HttpURLConnection connection = null;
        try {
            URL url = new URL(BASE_URL + "/api/client-log");
            connection = (HttpURLConnection) url.openConnection();
            connection.setConnectTimeout(1500);
            connection.setReadTimeout(1500);
            connection.setRequestMethod("POST");
            connection.setDoOutput(true);
            connection.setRequestProperty("content-type", "application/json");
            String body = "{\"message\":\"" + message.replace("\\", "").replace("\"", "'") + "\"}";
            connection.getOutputStream().write(body.getBytes(StandardCharsets.UTF_8));
            connection.getResponseCode();
            flushQueuedLogs();
        } catch (Exception ignored) {
            // 桥没起来时发不出去 —— 但这恰恰是最该留下的一段日志（启动失败就是在这一段里
            // 决定的）：E135 排查时我在桥日志里只能看到现象、看不到应用自己的判断。
            // 所以先排队，等桥起来后的第一条日志把它一起冲出去。
            queueLog(message);
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    private static final java.util.Deque<String> QUEUED_LOGS = new java.util.ArrayDeque<>();
    private static final int QUEUED_LOG_LIMIT = 60;

    private static synchronized void queueLog(String message) {
        if (QUEUED_LOGS.size() >= QUEUED_LOG_LIMIT) QUEUED_LOGS.pollFirst();
        QUEUED_LOGS.addLast(message);
    }

    /** 桥起来后把启动阶段排队的日志补发出去（带前缀，方便一眼看出是补发的）。 */
    private static void flushQueuedLogs() {
        String[] queued;
        synchronized (BridgeClient.class) {
            if (QUEUED_LOGS.isEmpty()) return;
            queued = QUEUED_LOGS.toArray(new String[0]);
            QUEUED_LOGS.clear();
        }
        for (String line : queued) {
            HttpURLConnection connection = null;
            try {
                URL url = new URL(BASE_URL + "/api/client-log");
                connection = (HttpURLConnection) url.openConnection();
                connection.setConnectTimeout(1500);
                connection.setReadTimeout(1500);
                connection.setRequestMethod("POST");
                connection.setDoOutput(true);
                connection.setRequestProperty("content-type", "application/json");
                String body = "{\"message\":\"" + (line + " [queued while the bridge was down]").replace("\\", "").replace("\"", "'") + "\"}";
                connection.getOutputStream().write(body.getBytes(StandardCharsets.UTF_8));
                connection.getResponseCode();
            } catch (Exception ignored) {
                // 还是发不出去就再排队，下次成功时一起补
                queueLog(line);
                return;
            } finally {
                if (connection != null) connection.disconnect();
            }
        }
    }

    /**
     * 把 Android 侧的自检事实报给桥（`POST /api/setup`），让设置 → 配置 页能显示一张完整清单。
     *
     * 为什么只有应用能提供这几项：Termux 装没装、RUN_COMMAND 授权没有、通知有没有被禁，
     * 都是 Android 这边的状态；桥（跑在 Termux 里）看不到。查不到就**不报**（桥那边会如实显示
     * "应用最近没有上报过"），不猜。
     */
    static void reportSetup(org.json.JSONObject facts) {
        HttpURLConnection connection = null;
        try {
            URL url = new URL(BASE_URL + "/api/setup");
            connection = (HttpURLConnection) url.openConnection();
            connection.setConnectTimeout(1500);
            connection.setReadTimeout(2500);
            connection.setRequestMethod("POST");
            connection.setDoOutput(true);
            connection.setRequestProperty("content-type", "application/json");
            String body = "{\"facts\":" + (facts == null ? "{}" : facts.toString()) + "}";
            connection.getOutputStream().write(body.getBytes(StandardCharsets.UTF_8));
            connection.getResponseCode();
        } catch (Exception ignored) {
            // 桥没起来就等下一次启动再报
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    /** 打开 Termux 应用，供用户手工排查（权限、日志等）。 */
    static void openTermux(Context context) {
        Intent intent = context.getPackageManager().getLaunchIntentForPackage(TERMUX_PACKAGE);
        if (intent == null) return;
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            context.startActivity(intent);
        } catch (Exception ignored) {
            // Termux 没装或不可启动：调用方负责提示
        }
    }

    /** Termux 是否安装（用于把"没装 Termux"和"桥没起来"区分开）。 */
    static boolean isTermuxInstalled(Context context) {
        return context.getPackageManager().getLaunchIntentForPackage(TERMUX_PACKAGE) != null;
    }

    /** 当前安装的版本名（versionName），用来在通知/启动页上显示"我现在是哪一版"。 */
    static String versionName(Context context) {
        try {
            return context.getPackageManager().getPackageInfo(context.getPackageName(), 0).versionName;
        } catch (Exception ignored) {
            return "";
        }
    }
}
