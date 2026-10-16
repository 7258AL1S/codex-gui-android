package dev.termux.codexgui;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.webkit.JavascriptInterface;

/**
 * 页面的原生通知出口。
 *
 * WebView 里没有 Web Notification API（`Notification is undefined`，E102），所以
 * "任务完成 / agent 有话要说"这些提醒此前只能靠 agent 调 `termux-notification`——
 * 通知来源是 Termux 而不是应用（用户 2026-10-16 要求改成应用原生通知）。
 *
 * 页面通过 `window.CodexNative.notify(title, body, tag)` 调用；同一个 tag 覆盖同一条通知
 * （与 Termux 那边 `-i codex-status` 的语义一致，不会堆一屏）。
 *
 * 安全边界：JS 接口只在 WebView 载入我们自己的页面时注入，且页面只加载 127.0.0.1 的桥；
 * 外部网页（浏览器面板里的 iframe）拿不到这个对象（不同 WebView）。
 */
final class NativeNotifier {
    private static final String CHANNEL_ID = "codex-app";
    private static final int BASE_ID = 7100;

    private final Context context;

    NativeNotifier(Context context) {
        this.context = context;
    }

    @JavascriptInterface
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
                    PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

            Notification.Builder builder = new Notification.Builder(context, CHANNEL_ID)
                    .setSmallIcon(android.R.drawable.stat_notify_chat)
                    .setContentTitle(title == null || title.isEmpty() ? "Codex" : title)
                    .setContentText(body == null ? "" : body)
                    .setStyle(new Notification.BigTextStyle().bigText(body == null ? "" : body))
                    .setAutoCancel(true)
                    .setContentIntent(open);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                builder.setForegroundServiceBehavior(Notification.FOREGROUND_SERVICE_IMMEDIATE);
            }
            // tag 相同的通知互相覆盖；id 由 tag 稳定映射，避免"每来一条堆一条"。
            manager.notify(String.valueOf(tag == null ? "codex-status" : tag), BASE_ID + stableIndex(tag), builder.build());
            BridgeClient.report("native notification posted: " + title + " — " + (body == null ? "" : body));
        } catch (Exception error) {
            BridgeClient.report("native notification FAILED: " + error);
        }
    }

    private void ensureChannel(NotificationManager manager) {
        if (manager.getNotificationChannel(CHANNEL_ID) != null) return;
        NotificationChannel channel = new NotificationChannel(
                CHANNEL_ID,
                context.getString(R.string.app_channel_name),
                NotificationManager.IMPORTANCE_HIGH);
        channel.setDescription(context.getString(R.string.app_channel_description));
        channel.setShowBadge(true);
        manager.createNotificationChannel(channel);
    }

    private int stableIndex(String tag) {
        int hash = tag == null ? 0 : tag.hashCode();
        return Math.abs(hash % 100);
    }
}
