package dev.termux.codexgui;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.Gravity;
import android.view.View;
import android.view.WindowInsets;
import android.view.ViewGroup;
import android.webkit.PermissionRequest;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebChromeClient.FileChooserParams;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;

import java.util.ArrayList;

/**
 * WebView 壳。
 *
 * 启动顺序（目标是"打开就能用"，不需要用户先开 Termux 敲命令）：
 *   1. 请求通知权限 + 起前台服务（保活 + 置顶通知）；
 *   2. 桥 ready？→ 直接加载页面；
 *   3. 没 ready → 通过 Termux 的 RUN_COMMAND 执行 `codex-gui-web start`，最多等 40 秒；
 *   4. 还是没起来 → 显示失败原因 + 重试/打开 Termux，而不是白屏。
 */
public class MainActivity extends Activity {
    private static final int REQUEST_NOTIFICATIONS = 1;
    private static final int REQUEST_FILE_CHOOSER = 2;
    // 桥冷启动要起 app-server；设备还会偶发把进程挂起十几秒（E104）。
    // 40 秒太短——用户看到的就是"转圈到失败"。给到 90 秒，并且把每一步写进桥日志。
    private static final long BOOT_TIMEOUT_MS = 90_000L;

    private WebView webView;
    private ProgressBar progress;
    private LinearLayout bootPanel;
    private TextView bootText;
    private ValueCallback<Uri[]> fileCallback;
    /** 「拍照」那条路的目标 URI：相机把照片写进这里，我们最后把它交回 WebView（E141）。 */
    private Uri cameraOutputUri;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private long bootStartedAt;
    private boolean pageLoaded;
    private boolean startedBridge;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        installCrashReporter();
        buildUi();
        askForNotificationPermission();
        BridgeService.start(this);
        boot();
    }

    private void buildUi() {
        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(0xFF171717);

        // targetSdk 35 → 系统强制 edge-to-edge，WebView 会画到状态栏/导航栏/键盘下面。
        // 页面里的 env(safe-area-inset-*) 在 WebView 里是 0，所以必须由壳把安全区补上，
        // 否则输入区会被手势条压住（2026-10-16 截图里就是这样）。
        root.setOnApplyWindowInsetsListener((view, insets) -> {
            android.graphics.Insets bars = insets.getInsets(
                    WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
            android.graphics.Insets ime = insets.getInsets(WindowInsets.Type.ime());
            view.setPadding(bars.left, bars.top, bars.right, Math.max(bars.bottom, ime.bottom));
            return WindowInsets.CONSUMED;
        });

        webView = new WebView(this);
        webView.setLayoutParams(new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        webView.setBackgroundColor(0xFF171717);
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setSupportZoom(false);
        settings.setBuiltInZoomControls(false);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        settings.setCacheMode(WebSettings.LOAD_NO_CACHE);
        // 原生通知出口：页面用 window.CodexNative.notify(title, body, tag) 让应用发通知
        // （WebView 里没有 Web Notification API，见 E102/E116）。
        webView.addJavascriptInterface(new NativeNotifier(this), "CodexNative");
        webView.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageFinished(WebView view, String url) {
                pageLoaded = true;
                showPage();
                deliverDeepLink();
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request == null || !request.isForMainFrame()) return;
                // 桥可能在页面加载中途被系统挂起：给出可操作的界面，而不是空白
                showBootPanel(getString(R.string.boot_failed), true);
            }
        });
        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (fileCallback != null) fileCallback.onReceiveValue(null);
                fileCallback = callback;
                try {
                    // params.createIntent() 已经带上页面的 accept 类型（image/*, application/* 等）
                    Intent chooser = Intent.createChooser(params.createIntent(), getString(R.string.choose_file));
                    // 「拍照」入口（E141）：只选图时额外挂一个 ACTION_IMAGE_CAPTURE。
                    //
                    // 为什么用 MediaStore 而不是 FileProvider：本项目的 APK 是手写流水线（没有 AndroidX），
                    // 用不了 `androidx.core.content.FileProvider`；而 Q 起可以直接往 MediaStore 插一条
                    // 待写图片、把它的 content:// 当 EXTRA_OUTPUT 交给相机（不需要任何权限），
                    // 回来后把这个 URI 交回 WebView —— 不会再踩 FileUriExposedException。
                    cameraOutputUri = null;
                    if (acceptsImages(params)) {
                        Uri output = createCameraOutput();
                        if (output != null) {
                            Intent capture = new Intent(android.provider.MediaStore.ACTION_IMAGE_CAPTURE);
                            capture.putExtra(android.provider.MediaStore.EXTRA_OUTPUT, output);
                            capture.addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION | Intent.FLAG_GRANT_READ_URI_PERMISSION);
                            chooser.putExtra(Intent.EXTRA_INITIAL_INTENTS, new Intent[]{ capture });
                            cameraOutputUri = output;
                        }
                    }
                    startActivityForResult(chooser, REQUEST_FILE_CHOOSER);
                    return true;
                } catch (Exception error) {
                    fileCallback = null;
                    return false;
                }
            }

            @Override
            public void onPermissionRequest(final PermissionRequest request) {
                // 目前页面不需要摄像头/麦克风；直接拒绝比静默挂起更清楚
                request.deny();
            }
        });
        root.addView(webView);

        bootPanel = new LinearLayout(this);
        bootPanel.setOrientation(LinearLayout.VERTICAL);
        bootPanel.setGravity(Gravity.CENTER);
        bootPanel.setLayoutParams(new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        bootPanel.setBackgroundColor(0xFF171717);
        bootPanel.setPadding(dp(28), dp(28), dp(28), dp(28));

        progress = new ProgressBar(this);
        bootPanel.addView(progress);

        bootText = new TextView(this);
        bootText.setTextColor(0xFFECECEC);
        bootText.setTextSize(15f);
        bootText.setGravity(Gravity.CENTER);
        bootText.setPadding(0, dp(16), 0, dp(16));
        bootText.setText(R.string.booting);
        bootPanel.addView(bootText);

        Button retry = new Button(this);
        retry.setText(R.string.retry);
        retry.setOnClickListener(v -> {
            startedBridge = false;
            boot();
        });
        retry.setVisibility(View.GONE);
        bootPanel.addView(retry);

        Button openTermux = new Button(this);
        openTermux.setText(R.string.open_termux);
        openTermux.setOnClickListener(v -> BridgeClient.openTermux(this));
        openTermux.setVisibility(View.GONE);
        bootPanel.addView(openTermux);

        Button appSettings = new Button(this);
        appSettings.setText(R.string.open_app_settings);
        appSettings.setOnClickListener(v -> {
            Intent intent = new Intent(android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                    Uri.parse("package:" + getPackageName()));
            try {
                startActivity(intent);
            } catch (Exception ignored) {
                // 极简系统可能没有这个页面：忽略
            }
        });
        appSettings.setVisibility(View.GONE);
        bootPanel.addView(appSettings);

        Button grantButton = new Button(this);
        grantButton.setText(R.string.grant_run_command);
        grantButton.setOnClickListener(v -> openAppSettings());
        grantButton.setVisibility(View.GONE);
        bootPanel.addView(grantButton);
        this.grantButton = grantButton;

        this.retryButton = retry;
        this.termuxButton = openTermux;
        this.settingsButton = appSettings;
        root.addView(bootPanel);

        // 这条只在"根本没装 Termux"时出现：那种情况下应用什么也做不了，必须说清楚。
        // （0.1.4 起启动桥走 Termux 的分享通道，不再需要 RUN_COMMAND 权限，
        //   所以原来那条"缺权限"的常驻提示已经过时，会误导用户。）
        permissionBanner = new TextView(this);
        permissionBanner.setText(R.string.no_termux_banner);
        permissionBanner.setTextColor(0xFFD7A95E);
        permissionBanner.setTextSize(12f);
        permissionBanner.setBackgroundColor(0xFF221E17);
        permissionBanner.setPadding(dp(14), dp(10), dp(14), dp(10));
        FrameLayout.LayoutParams bannerParams = new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.TOP);
        permissionBanner.setLayoutParams(bannerParams);
        permissionBanner.setVisibility(View.GONE);
        root.addView(permissionBanner);

        setContentView(root);
    }

    private Button retryButton;
    private Button termuxButton;
    private Button settingsButton;
    private Button grantButton;
    private TextView permissionBanner;

    private void boot() {
        bootStartedAt = System.currentTimeMillis();
        showBootPanel(getString(R.string.booting), false);
        if (permissionBanner != null) {
            permissionBanner.setVisibility(BridgeClient.isTermuxInstalled(this) ? View.GONE : View.VISIBLE);
        }
        new Thread(() -> {
            // 自检上报（只报能真查证的：Termux 装没装、RUN_COMMAND 授权没有、通知有没有被禁、版本号）。
            // 冷启动和每次回前台都会报（onResume），见 reportSelfCheck()。
            reportSelfCheck();
            // 关键：用"HTTP 有没有真的应答"判断桥活没活，而不是"TCP 端口连不连得上"。
            // 冻结的进程照样能被内核 backlog 完成握手 → 旧判断会把僵尸监听当成"正在启动"，
            // 于是既不重试也不叫醒 Termux，只转圈（E135 实测）。
            String health = BridgeClient.health();
            boolean answers = health != null;
            boolean ready = answers && health.contains("\"ready\":true");
            BridgeClient.report("boot: http=" + (answers ? "answers" : "silent")
                    + " port=" + (BridgeClient.isPortOpen() ? "open" : "closed")
                    + " ready=" + ready
                    + " termux=" + BridgeClient.isTermuxInstalled(this)
                    + " runCommand=" + (runCommandPermissionGranted() ? "granted" : "denied")
                    + " version=" + BridgeClient.versionName(this));
            if (ready) {
                BridgeClient.report("boot: already ready, loading page");
                handler.post(this::loadPage);
                return;
            }
            // 不管端口看起来开没开，都要试着启动：桥没起来时"端口开着"很可能只是冻结的监听。
            final boolean mayJump = !BridgeClient.hasRunCommandPermission(this);
            if (!startedBridge) {
                startedBridge = BridgeClient.startBridge(MainActivity.this);
                BridgeClient.report("boot: asked termux to start the bridge, intent=" + (startedBridge ? "sent" : "failed"));
                if (mayJump) {
                    // 分享通道会拉起 Termux 的界面：提前说明，别让用户以为自己点错了
                    handler.post(() -> bootText.setText(getString(R.string.booting_switching_to_termux)));
                }
            } else {
                BridgeClient.report("boot: start already requested, still waiting");
            }
            // 静默请求送出去 8 秒还没就绪 → 升级：把 Termux 切到前台解冻它，并再请求一次。
            // 之后每 20 秒重复，直到 90 秒超时（用户以前是手动做这件事的，太麻烦）。
            long escalateAt = System.currentTimeMillis() + 8000L;
            // 升级会切到 Termux，应用退到后台；就绪后系统不许我们从后台把自己拉回来
            // （Android 12+ 的后台启动限制），所以发一条通知让用户点回应用 —— 不撒谎，也不硬闯。
            final boolean[] escalated = { false };
            while (System.currentTimeMillis() - bootStartedAt < BOOT_TIMEOUT_MS) {
                String body = BridgeClient.health();
                if (body != null && body.contains("\"ready\":true")) {
                    BridgeClient.report("boot: ready after "
                            + ((System.currentTimeMillis() - bootStartedAt) / 1000) + "s, loading page");
                    if (escalated[0]) {
                        new NativeNotifier(MainActivity.this).notify(
                                getString(R.string.boot_ready_title),
                                getString(R.string.boot_ready_body),
                                "codex-boot",
                                null);
                    }
                    handler.post(this::loadPage);
                    return;
                }
                final boolean silent = body == null;
                final long elapsed = (System.currentTimeMillis() - bootStartedAt) / 1000;
                // 只在"HTTP 完全没应答"（= 进程被冻结那种）时才去抢前台。
                // 桥自己正在起（HTTP 已应答、只是还没 ready）时不该把用户切走 —— 日志里
                // "ready after 13s/15s" 就是这种正常慢启动，抢前台是误伤。
                if (silent && System.currentTimeMillis() >= escalateAt) {
                    BridgeClient.report("boot: no ready after " + elapsed + "s (http="
                            + (silent ? "silent" : "answers") + ") -> waking Termux");
                    escalated[0] = true;
                    BridgeClient.wakeTermux(MainActivity.this);
                    // 10 秒一轮：第一次升级没生效（Termux 那边刚被叫醒、脚本还在排队）时，别让用户
                    // 多等 20 秒。实测（E140）：桥侧现在能自己收掉"冻住的监听"，所以多数情况一轮就够。
                    escalateAt = System.currentTimeMillis() + 10000L;
                    handler.post(() -> bootText.setText(getString(R.string.booting_waking_termux)));
                } else {
                    handler.post(() -> bootText.setText(getString(R.string.booting)
                            + " " + elapsed + "s"
                            + (silent
                                ? getString(R.string.booting_waiting_termux)
                                : getString(R.string.booting_waiting_appserver))
                            + "  v" + BridgeClient.versionName(this)));
                }
                try {
                    Thread.sleep(1200);
                } catch (InterruptedException ignored) {
                    return;
                }
            }
            BridgeClient.report("boot: gave up after "
                    + ((System.currentTimeMillis() - bootStartedAt) / 1000)
                    + "s (port=" + (BridgeClient.isPortOpen() ? "open" : "closed") + ")");
            handler.post(() -> showBootPanel(getString(R.string.boot_failed)
                    + (BridgeClient.isTermuxInstalled(MainActivity.this) ? "" : "（没有检测到 Termux）"), true));
        }).start();
    }

    /**
     * 拉起桥最可能的失败原因是权限：Termux 的 RUN_COMMAND 需要用户手动授予一次
     * （com.termux.permission.RUN_COMMAND）。把这句话直接写在失败界面上，
     * 并给一个跳转到本应用设置页的按钮，别让用户去猜。
     */
    private boolean runCommandPermissionGranted() {
        try {
            return checkSelfPermission("com.termux.permission.RUN_COMMAND")
                    == android.content.pm.PackageManager.PERMISSION_GRANTED;
        } catch (Exception ignored) {
            return true;
        }
    }

    /** 通知有没有被用户/系统禁掉（自检用；被禁时后台完成提醒就发不出来）。 */
    private boolean notificationsAllowed() {
        try {
            android.app.NotificationManager manager = getSystemService(android.app.NotificationManager.class);
            return manager != null && manager.areNotificationsEnabled();
        } catch (Exception ignored) {
            return false;
        }
    }

    private void loadPage() {
        if (pendingDeepLink == null && getIntent() != null && getIntent().hasExtra("codexThreadId")) {
            pendingDeepLink = getIntent().getStringExtra("codexThreadId");
        }
        pageLoaded = false;
        webView.loadUrl(BridgeClient.BASE_URL + "/");
    }

    private void showBootPanel(String message, boolean withActions) {
        bootText.setText(message);
        progress.setVisibility(withActions ? View.GONE : View.VISIBLE);
        retryButton.setVisibility(withActions ? View.VISIBLE : View.GONE);
        termuxButton.setVisibility(withActions ? View.VISIBLE : View.GONE);
        boolean needsPermission = withActions && !runCommandPermissionGranted();
        settingsButton.setVisibility(needsPermission ? View.VISIBLE : View.GONE);
        if (needsPermission) {
            bootText.setText(message + "\n\n" + getString(R.string.need_run_command));
        }
        if (grantButton != null) grantButton.setVisibility(needsPermission ? View.VISIBLE : View.GONE);
        bootPanel.setVisibility(View.VISIBLE);
    }

    private void showPage() {
        bootPanel.setVisibility(View.GONE);
    }

    /** 跳到本应用的应用信息页（Termux 的 Run command 权限在那里改）。 */
    private void openAppSettings() {
        Intent intent = new Intent(android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                Uri.parse("package:" + getPackageName()));
        try {
            startActivity(intent);
        } catch (Exception ignored) {
            // 极简系统可能没有这个页面：忽略
        }
    }

    private void askForNotificationPermission() {

        if (Build.VERSION.SDK_INT < 33) return;
        if (checkSelfPermission("android.permission.POST_NOTIFICATIONS") == android.content.pm.PackageManager.PERMISSION_GRANTED) return;
        requestPermissions(new String[]{"android.permission.POST_NOTIFICATIONS"}, REQUEST_NOTIFICATIONS);
    }

    /**
     * 每次回到前台都刷一次自检上报（E139/E140）。
     *
     * 为什么不能只在 onCreate 报：桥可能刚被重启（上报存在桥的内存里，随之消失），而用户此时
     * 只是"切回应用"、不会冷启动 → 清单会一直显示"应用还没上报过"。实测踩到过：我重启桥后
     * `am start`，应用只是 onResume，页面于是显示没上报。上报很便宜（一个 POST、失败就算了），放这里最稳。
     */
    @Override
    protected void onResume() {
        super.onResume();
        reportSelfCheck();
    }

    private void reportSelfCheck() {
        try {
            org.json.JSONObject facts = new org.json.JSONObject();
            facts.put("termuxInstalled", BridgeClient.isTermuxInstalled(this));
            facts.put("runCommandGranted", runCommandPermissionGranted());
            facts.put("notificationsAllowed", notificationsAllowed());
            facts.put("version", BridgeClient.versionName(this));
            BridgeClient.reportSetup(facts);
        } catch (Exception ignored) {
            // 上报失败不影响任何功能
        }
    }

    @Override
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
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == REQUEST_FILE_CHOOSER) {
            deliverFileChooserResult(resultCode, data);
            return;
        }
        super.onActivityResult(requestCode, resultCode, data);
    }

    /**
     * 把选择器的结果交回 WebView。
     *
     * 实测（E106）：小米/HyperOS 的"安全访问"图片选择器把选中的项放在 `ClipData` 里，
     * 而 AOSP 的 `FileChooserParams.parseResult()` **只读 `getData()`**，于是返回 null，
     * WebView 拿不到文件、`change` 事件不触发——用户看到的就是"选了图但什么都没发生"。
     * 所以这里自己解析：先 ClipData（多选），再 getData（单选），两条都没有就把结果记为 null，
     * 并把结果写进桥日志——这类失败以前是彻底静默的。
     */
    private void deliverFileChooserResult(int resultCode, Intent data) {
        if (fileCallback == null) return;
        ArrayList<Uri> uris = new ArrayList<>();
        try {
            if (resultCode == RESULT_OK && data != null) {
                android.content.ClipData clip = data.getClipData();
                if (clip != null) {
                    for (int i = 0; i < clip.getItemCount(); i++) {
                        Uri uri = clip.getItemAt(i).getUri();
                        if (uri != null) uris.add(uri);
                    }
                }
                if (uris.isEmpty() && data.getData() != null) uris.add(data.getData());
            }
        } catch (Exception error) {
            BridgeClient.report("file chooser result parse failed: " + error);
        }
        BridgeClient.report("file chooser result: resultCode=" + resultCode
                + " clip=" + (data != null && data.getClipData() != null ? data.getClipData().getItemCount() : 0)
                + " data=" + (data != null && data.getData() != null)
                + " uris=" + uris.size());
        // 「拍照」这条路回来的结果不是 URI（相机把照片按 EXTRA_OUTPUT 写进我们给的那条 MediaStore 记录），
        // 所以上面解析出来是空的 —— 这里补上，并把取消的情况收拾干净。
        if (cameraOutputUri != null) {
            // 只有"相机把照片写进来了"这一种情况才交付：选择器会给 URI，相机不给（照片按 EXTRA_OUTPUT 落盘）。
            if (uris.isEmpty() && resultCode == RESULT_OK) {
                uris.add(cameraOutputUri);
                BridgeClient.report("camera capture delivered: " + cameraOutputUri);
                cameraOutputUri = null;
            } else {
                // 用户改选了相册、或者干脆取消：把我们预插的那条空记录删掉，别在相册里留 0 字节目录项。
                BridgeClient.report("camera capture not used (resultCode=" + resultCode + ", pickerUris=" + uris.size() + ")");
                discardCameraOutput();
            }
        }
        try {
            fileCallback.onReceiveValue(uris.isEmpty() ? null : uris.toArray(new Uri[0]));
        } catch (Exception error) {
            BridgeClient.report("file chooser callback threw: " + error);
        } finally {
            fileCallback = null;
        }
    }

    /**
     * 页面的 accept 里有没有图片类型（决定要不要挂"拍照"这一项）。
     * `image/*` 与 `image/jpeg` 这种都算。
     */
    private boolean acceptsImages(FileChooserParams params) {
        try {
            String[] types = params.getAcceptTypes();
            if (types == null) return false;
            for (String type : types) {
                if (type != null && type.trim().toLowerCase().startsWith("image/")) return true;
            }
        } catch (Exception ignored) { /* 拿不到 accept 就不挂相机 */ }
        return false;
    }

    /**
     * 往 MediaStore 插一条"待写"图片，返回它的 content:// —— 交给相机的 EXTRA_OUTPUT。
     * 不用 FileProvider：本项目的 APK 是手写流水线（没有 AndroidX），而 Q 起这条路不需要任何权限。
     * 失败就返回 null（那就只是没有"拍照"这一项，不影响选文件）。
     */
    private Uri createCameraOutput() {
        try {
            String name = "codex-" + new java.text.SimpleDateFormat("yyyyMMdd-HHmmss", java.util.Locale.US).format(new java.util.Date()) + ".jpg";
            android.content.ContentValues values = new android.content.ContentValues();
            values.put(android.provider.MediaStore.Images.Media.DISPLAY_NAME, name);
            values.put(android.provider.MediaStore.Images.Media.MIME_TYPE, "image/jpeg");
            values.put(android.provider.MediaStore.Images.Media.RELATIVE_PATH, "Pictures/Codex");
            return getContentResolver().insert(android.provider.MediaStore.Images.Media.EXTERNAL_CONTENT_URI, values);
        } catch (Exception error) {
            BridgeClient.report("camera output insert failed: " + error);
            return null;
        }
    }

    /** 拍照被取消/失败时，把那条空的 MediaStore 记录删掉，别在相册里留垃圾。 */
    private void discardCameraOutput() {
        if (cameraOutputUri == null) return;
        try { getContentResolver().delete(cameraOutputUri, null, null); } catch (Exception ignored) { /* 尽力而为 */ }
        cameraOutputUri = null;
    }

    @Override
    public void onBackPressed() {
        // 页面自己用 history 管理抽屉/弹层的返回（E86）；能回就走页面历史
        if (webView != null && webView.canGoBack()) {
            webView.goBack();
            return;
        }
        super.onBackPressed();
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }

    /**
     * 崩溃也要能远程看见：默认情况下应用闪退在 Termux 这侧没有任何痕迹
     * （E106 就是"选了图之后应用直接没了"）。把未捕获异常写进桥日志，
     * 我从 Termux 就能读到栈顶几行，不必让用户复现描述。
     */
    private void installCrashReporter() {
        final Thread.UncaughtExceptionHandler previous = Thread.getDefaultUncaughtExceptionHandler();
        Thread.setDefaultUncaughtExceptionHandler((thread, error) -> {
            StringBuilder text = new StringBuilder("CRASH " + error.getClass().getSimpleName() + ": " + error.getMessage());
            StackTraceElement[] frames = error.getStackTrace();
            for (int i = 0; i < Math.min(4, frames.length); i++) text.append(" @ ").append(frames[i]);
            BridgeClient.reportSync(text.toString());
            if (previous != null) previous.uncaughtException(thread, error);
        });
    }
}
