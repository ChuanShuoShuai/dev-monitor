package com.shuaiguo.devmonitor;

import android.app.Dialog;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.ColorDrawable;
import android.graphics.drawable.Drawable;
import android.graphics.drawable.GradientDrawable;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.Window;
import android.view.WindowManager;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;

/**
 * 可复制的错误弹窗。
 *
 * 设计意图：手机端出问题时，用户没法像在电脑前那样开控制台看日志，
 * 所以每一次失败都必须「看得见 + 拿得走」：
 *   · 看得出原因和下一步怎么做（原因 / 建议 / 原始诊断信息三段分开）
 *   · 一键把完整信息（含设备型号、系统版本、地址、耗时、原始异常）
 *     复制进剪贴板，方便直接粘到聊天里或存进工单
 */
public class ErrDialog extends Dialog {

    private static final int BG = 0xFF141C33;
    private static final int CARD = 0xFF1E2942;
    private static final int BORDER = 0xFF2E3C63;
    private static final int TXT = 0xFFE8ECF8;
    private static final int DIM = 0xFF98A4C6;
    private static final int ACC = 0xFF4C8DFF;
    private static final int RED = 0xFFFF6B6B;
    private static final int GREEN = 0xFF2FBF71;

    private String copyText = "";

    private ErrDialog(Context c) {
        super(c);
    }

    /** 错误弹窗：可选择重试 / 改地址。 */
    public static void show(Context c, String title, String reason, String advice,
                            String debug, final Runnable onRetry, final Runnable onChange) {
        ErrDialog d = new ErrDialog(c);
        d.render(title, RED, reason, advice, debug, onRetry, onChange);
        d.show();
    }

    /** 诊断日志弹窗：只读 + 复制。 */
    public static void showLog(Context c, String title, String body) {
        ErrDialog d = new ErrDialog(c);
        d.render(title, ACC, body, null, null, null, null);
        d.show();
    }

    private int dp(float v) {
        return (int) (v * getContext().getResources().getDisplayMetrics().density + 0.5f);
    }

    private GradientDrawable box(int fill, int stroke, float r) {
        GradientDrawable gd = new GradientDrawable();
        gd.setShape(GradientDrawable.RECTANGLE);
        gd.setColor(fill);
        gd.setCornerRadius(dp(r));
        if (stroke != 0) {
            gd.setStroke(dp(1), stroke);
        }
        return gd;
    }

    private TextView mkText(String s, float dip, int color, boolean bold) {
        TextView tv = new TextView(getContext());
        tv.setText(s);
        tv.setTextSize(TypedValue.COMPLEX_UNIT_DIP, dip);
        tv.setTextColor(color);
        tv.setIncludeFontPadding(false);
        if (bold) {
            tv.setTypeface(Typeface.DEFAULT_BOLD);
        }
        return tv;
    }

    private void render(String title, int titleColor, String reason, String advice,
                        String debug, final Runnable onRetry, final Runnable onChange) {
        final Context ctx = getContext();

        copyText = buildCopyText(title, reason, advice, debug);

        LinearLayout root = new LinearLayout(ctx);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackground(Glass.panel(ctx.getResources().getDisplayMetrics().density, 16));
        root.setPadding(dp(20), dp(18), dp(20), dp(14));

        /* ---- 标题条 ---- */
        LinearLayout head = new LinearLayout(ctx);
        head.setOrientation(LinearLayout.HORIZONTAL);
        head.setGravity(Gravity.CENTER_VERTICAL);

        TextView bar = new TextView(ctx);
        bar.setBackground(box(titleColor, 0, 2));
        head.addView(bar, new LinearLayout.LayoutParams(dp(4), dp(17)));

        TextView tv = mkText(title, 17, TXT, true);
        LinearLayout.LayoutParams tvLp = new LinearLayout.LayoutParams(0, -2, 1f);
        tvLp.leftMargin = dp(10);
        head.addView(tv, tvLp);
        root.addView(head);

        /* ---- 正文（可滚动，避免长文本被裁） ---- */
        ScrollView scroll = new ScrollView(ctx);
        LinearLayout body = new LinearLayout(ctx);
        body.setOrientation(LinearLayout.VERTICAL);

        if (notEmpty(reason)) {
            addBlock(body, "原因", reason, TXT, 13.5f);
        }
        if (notEmpty(advice)) {
            addBlock(body, "建议", advice, 0xFFD9E4FF, 13.5f);
        }
        if (notEmpty(debug)) {
            addBlock(body, "诊断详情", debug, DIM, 12f);
        }

        scroll.addView(body, new ScrollView.LayoutParams(-1, -2));
        LinearLayout.LayoutParams scrollLp = new LinearLayout.LayoutParams(-1, 0, 1f);
        scrollLp.topMargin = dp(14);
        root.addView(scroll, scrollLp);

        /* ---- 按钮 ---- */
        LinearLayout row = new LinearLayout(ctx);
        row.setOrientation(LinearLayout.HORIZONTAL);
        LinearLayout.LayoutParams rowLp = new LinearLayout.LayoutParams(-1, -2);
        rowLp.topMargin = dp(14);
        root.addView(row, rowLp);

        addBtn(row, "复制详情", GREEN, new Runnable() {
            @Override
            public void run() {
                copyToClipboard(copyText);
                Toast.makeText(ctx, "已复制，可直接粘贴发送", Toast.LENGTH_SHORT).show();
            }
        }, false);

        if (onRetry != null) {
            addBtn(row, "重试", ACC, onRetry, true);
        }
        if (onChange != null) {
            addBtn(row, "改地址", CARD, onChange, true);
        }
        addBtn(row, "关闭", CARD, null, true);

        setContentView(root);
    }

    private void addBlock(LinearLayout parent, String label, String value, int color, float dip) {
        LinearLayout wrap = new LinearLayout(getContext());
        wrap.setOrientation(LinearLayout.VERTICAL);
        wrap.setBackground(Glass.inner(getContext().getResources().getDisplayMetrics().density, 10));
        wrap.setPadding(dp(12), dp(10), dp(12), dp(10));
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(-1, -2);
        lp.bottomMargin = dp(8);
        wrap.setLayoutParams(lp);

        wrap.addView(mkText(label, 11, ACC, true));

        TextView v = mkText(value, dip, color, false);
        v.setTextIsSelectable(true);
        v.setLineSpacing(dp(4), 1.05f);
        LinearLayout.LayoutParams vLp = new LinearLayout.LayoutParams(-1, -2);
        vLp.topMargin = dp(5);
        wrap.addView(v, vLp);

        parent.addView(wrap);
    }

    private void addBtn(LinearLayout row, String label, int fill, final Runnable act, boolean closeFirst) {
        TextView b = mkText(label, 14, Color.WHITE, true);
        b.setGravity(Gravity.CENTER);
        b.setPadding(dp(4), dp(11), dp(4), dp(11));
        // 自绘背景没有系统涟漪，必须显式包一层，否则按下毫无反馈
        float density = getContext().getResources().getDisplayMetrics().density;
        b.setBackground(Glass.ripple(box(fill, fill == CARD ? BORDER : 0, 10), density, 10, 0x38FFFFFF));
        b.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                if (closeFirst) {
                    dismiss();
                }
                if (act != null) {
                    act.run();
                }
            }
        });
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(0, -2, 1f);
        lp.leftMargin = dp(6);
        row.addView(b, lp);
    }

    private boolean notEmpty(String s) {
        return s != null && s.trim().length() > 0;
    }

    private String buildCopyText(String title, String reason, String advice, String debug) {
        StringBuilder sb = new StringBuilder();
        sb.append("【工程监控】连接/加载异常\n");
        sb.append("时间: ").append(new SimpleDateFormat("yyyy-MM-dd HH:mm:ss", Locale.CHINA).format(new Date())).append('\n');
        sb.append("设备: ").append(android.os.Build.MANUFACTURER).append(' ').append(android.os.Build.MODEL)
          .append(" / Android ").append(android.os.Build.VERSION.RELEASE)
          .append(" (API ").append(android.os.Build.VERSION.SDK_INT).append(")\n");
        sb.append("问题: ").append(title).append('\n');
        if (notEmpty(reason)) {
            sb.append("原因: ").append(reason).append('\n');
        }
        if (notEmpty(advice)) {
            sb.append("建议: ").append(advice).append('\n');
        }
        if (notEmpty(debug)) {
            sb.append("诊断详情:\n").append(debug).append('\n');
        }
        return sb.toString();
    }

    private void copyToClipboard(String text) {
        try {
            ClipboardManager cm = (ClipboardManager) getContext().getSystemService(Context.CLIPBOARD_SERVICE);
            if (cm != null) {
                cm.setPrimaryClip(ClipData.newPlainText("工程监控-错误详情", text));
            }
        } catch (Throwable ignored) {
            // 部分定制系统（如澎湃 OS）在后台限制剪贴板，失败也不影响关闭弹窗
        }
    }

    @Override
    public void show() {
        Window w = getWindow();
        if (w != null) {
            w.setBackgroundDrawable(new ColorDrawable(0x00000000));
            WindowManager.LayoutParams lp = w.getAttributes();
            lp.width = (int) (getContext().getResources().getDisplayMetrics().widthPixels * 0.93f);
            lp.height = WindowManager.LayoutParams.WRAP_CONTENT;
            lp.gravity = Gravity.CENTER;
            w.setAttributes(lp);
        }
        super.show();
    }
}