package dev.termux.codexgui;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;

/**
 * 前台服务：APK 形态的存在理由。
 *
 * 三件事，都是"进程能被调度"的必要条件：
 *   1. 置顶通知 —— 用户 2026-10-14 明确要求"后台跑任务时加置顶通知防杀"；
 *   2. 设备级 PARTIAL_WAKE_LOCK —— E100 实测：屏幕熄灭后整台设备会睡，连持锁的
 *      Termux 一起被挂起，流式输出就断在半路。APK 是前台服务应用，它拿的锁不会被
 *      当成"缓存应用的锁"忽略，而且要定期续期（不设成永久，应用异常退出时自然释放）；
 *   3. 每 60 秒检查一次桥的 ready —— 不在就通过 Termux 的 RUN_COMMAND 拉起来。
 *      这比 termux-job-scheduler（最小 15 分钟）快一个数量级，因为服务一直在跑。
 */
public class BridgeService extends Service {
    static final String ACTION_RELOAD = "dev.termux.codexgui.RELOAD";
    static final String ACTION_RESTART_BRIDGE = "dev.termux.codexgui.RESTART_BRIDGE";
    static final String ACTION_START = "dev.termux.codexgui.START";

    private static final String CHANNEL_ID = "codex-status";
    private static final int NOTIFICATION_ID = 4711;
    private static final long CHECK_INTERVAL_MS = 60_000L;
    private static final long WAKE_LOCK_TIMEOUT_MS = 10 * 60_000L;

    private PowerManager.WakeLock wakeLock;
    private Handler handler;
    private boolean bridgeReady = false;
    private boolean startingSent = false;
    private String lastReported = "";

    static void start(Context context) {
        Intent intent = new Intent(context, BridgeService.class);
        intent.setAction(ACTION_START);
        try {
            context.startForegroundService(intent);
        } catch (Exception ignored) {
            try {
                context.startService(intent);
            } catch (Exception ignoredAgain) {
                // 服务起不来时界面仍可用，只是没有保活
            }
        }
    }

    @Override
    public void onCreate() {
        super.onCreate();
        handler = new Handler(Looper.getMainLooper());
        createChannel();
        startForegroundCompat(buildNotification(getString(R.string.notif_bridge_starting)));
        ensureWakeLock();
        handler.post(checkTask);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent == null ? null : intent.getAction();
        if (ACTION_RESTART_BRIDGE.equals(action)) {
            BridgeClient.restartBridge(this);
            startingSent = true;
            updateNotification(getString(R.string.notif_bridge_starting));
        }
        // START_STICKY：被系统清掉之后尽量自己回来（不承诺一定回来，如实写在 HANDOFF）
        return START_STICKY;
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public void onDestroy() {
        handler.removeCallbacksAndMessages(null);
        releaseWakeLock();
        super.onDestroy();
    }

    private final Runnable checkTask = new Runnable() {
        @Override
        public void run() {
            // 健康检查是**阻塞网络调用**，必须在工作线程上跑。
            // 第一版直接在 handler（主线程）里调用：Android 抛
            // NetworkOnMainThreadException，被 BridgeClient.health() 的 catch 吞掉 → isReady()
            // 永远 false → 常驻通知永远停在"正在启动桥…"（用户 2026-10-16 反馈的就是这个），
            // 而桥日志里服务上报一直是 `ready=false`。
            new Thread(BridgeService.this::runCheck, "codex-bridge-check").start();
        }
    };

    private void runCheck() {
        ensureWakeLock();
        final boolean ready = BridgeClient.isReady();
        reportHealth(ready);
        handler.post(() -> applyBridgeState(ready));
        handler.postDelayed(checkTask, CHECK_INTERVAL_MS);
    }

    private void applyBridgeState(boolean ready) {
        if (ready != bridgeReady) {
            bridgeReady = ready;
            if (ready) startingSent = false;
            updateNotification(getString(ready ? R.string.notif_bridge_ready : R.string.notif_bridge_missing));
        } else if (!ready && !startingSent) {
            // 只尝试拉起一次，避免每次检查都往 Termux 灌意图
            startingSent = BridgeClient.startBridge(this);
            updateNotification(getString(startingSent
                    ? R.string.notif_bridge_starting
                    : R.string.notif_bridge_missing));
        }
    }

    /**
     * 把服务自身的状态写进桥日志——"前台服务到底还在不在、锁有没有握上"这件事，
     * 在 Termux 这侧本来是看不见的（E104 时我只能靠猜）。状态变化时才写，避免刷日志。
     */
    private void reportHealth(boolean ready) {
        String summary = "service: v" + BridgeClient.versionName(this)
                + " ready=" + ready
                + " wakeLock=" + (wakeLock != null && wakeLock.isHeld())
                + " fg=true";
        if (summary.equals(lastReported)) return;
        lastReported = summary;
        BridgeClient.report(summary);
    }

    private void createChannel() {
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager == null) return;
        if (manager.getNotificationChannel(CHANNEL_ID) != null) return;
        NotificationChannel channel = new NotificationChannel(
                CHANNEL_ID,
                getString(R.string.channel_name),
                NotificationManager.IMPORTANCE_LOW);
        channel.setDescription(getString(R.string.channel_description));
        channel.setShowBadge(false);
        manager.createNotificationChannel(channel);
    }

    private Notification buildNotification(String status) {
        PendingIntent open = PendingIntent.getActivity(
                this, 0,
                new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        PendingIntent reload = PendingIntent.getActivity(
                this, 1,
                new Intent(this, MainActivity.class).setAction(ACTION_RELOAD).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        PendingIntent restart = PendingIntent.getService(
                this, 2,
                new Intent(this, BridgeService.class).setAction(ACTION_RESTART_BRIDGE),
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        Notification.Builder builder = new Notification.Builder(this, CHANNEL_ID)
                .setSmallIcon(android.R.drawable.stat_notify_sync)
                // 版本号放进标题：一眼就知道装的是哪一版，省得反复确认"这次更新生效了吗"
                .setContentTitle(getString(R.string.notif_title) + " " + BridgeClient.versionName(this))
                .setContentText(status)
                .setOngoing(true)
                .setShowWhen(false)
                .setContentIntent(open)
                .setCategory(Notification.CATEGORY_SERVICE);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            builder.setForegroundServiceBehavior(Notification.FOREGROUND_SERVICE_IMMEDIATE);
        }
        // 显式转型：Icon 版和 int 版的第一个参数都是 null 时 javac 会报歧义
        android.graphics.drawable.Icon noIcon = null;
        builder.addAction(new Notification.Action.Builder(noIcon, getString(R.string.action_reload), reload).build());
        builder.addAction(new Notification.Action.Builder(noIcon, getString(R.string.action_restart), restart).build());
        return builder.build();
    }

    private void startForegroundCompat(Notification notification) {
        if (Build.VERSION.SDK_INT >= 34) {
            startForeground(NOTIFICATION_ID, notification, android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
        } else {
            startForeground(NOTIFICATION_ID, notification);
        }
    }

    private void updateNotification(String status) {
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager != null) manager.notify(NOTIFICATION_ID, buildNotification(status));
    }

    private void ensureWakeLock() {
        try {
            if (wakeLock == null) {
                PowerManager power = getSystemService(PowerManager.class);
                if (power == null) return;
                wakeLock = power.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "codexgui:bridge");
                wakeLock.setReferenceCounted(false);
            }
            if (!wakeLock.isHeld()) wakeLock.acquire(WAKE_LOCK_TIMEOUT_MS);
        } catch (Exception ignored) {
            // 拿不到锁不该影响界面：如实降级
        }
    }

    private void releaseWakeLock() {
        try {
            if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        } catch (Exception ignored) {
            // ignore
        }
        wakeLock = null;
    }
}
