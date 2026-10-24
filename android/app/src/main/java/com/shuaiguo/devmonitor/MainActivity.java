package com.shuaiguo.devmonitor;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.Editable;
import android.text.InputType;
import android.text.TextWatcher;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.webkit.ConsoleMessage;
import android.webkit.SslErrorHandler;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.SocketTimeoutException;
import java.net.URL;
import java.text.SimpleDateFormat;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Date;
import java.util.Deque;
import java.util.List;
import java.util.Locale;

/**
 * 工程监控 App 入口。
 *
 * 设计要点：
 * 1. APK 本身不携带数据，监控内容全部实时来自电脑端 dev-monitor 服务，
 *    所以首启需要用户填写电脑地址（局域网 IP 或蒲公英组网虚拟 IP）。
 * 2. 所有字号一律用 DIP 而不是默认的 SP —— 系统字体缩放开到最大时
 *    SP 会被放大数倍，文字会撑破布局（小米澎湃 OS 上尤其明显）。
 * 3. 输入框/按钮自绘背景，不依赖 AppCompat 默认样式，避免浅色主题渗入。
 * 4. 任何一步失败都弹可复制的对话框（见 ErrDialog），并把细节追加进
 *    「诊断日志」，手机上随时可以打开、复制走。
 */
public class MainActivity extends Activity {

    private static final String PREF = "monitor_pref";
    private static final String KEY_ADDR = "addr";

    private static final int BG = 0xFF0B1020;
    private static final int CARD = 0xFF1A2340;
    private static final int BORDER = 0xFF253052;
    private static final int TXT = 0xFFE8ECF8;
    private static final int DIM = 0xFF8B96B8;
    private static final int ACC = 0xFF4C8DFF;

    private static final int PROBE_TIMEOUT = 6000;

    /* 作者信息 —— 与网页页脚、app/build.gradle 的 versionName 保持一致。
       ⚠ 改版本号时这三处一起改（gradle versionName / 本常量 / 网页里的兜底文本）。 */
    private static final String DEV_AUTHOR = "B站-传说中帅锅";
    private static final String DEV_VERSION = "1.2.0";
    private static final String DEV_SITE = "https://www.sgguo.com";

    private WebView web;
    private EditText addrInput;
    private Button goBtn;
    private TextView statusView;

    private final Handler ui = new Handler(Looper.getMainLooper());
    private final Deque<String> logLines = new ArrayDeque<>();
    private volatile boolean probeRunning = false;
    private String pendingAddr = "";

    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        mark("应用启动");
        String addr = prefs().getString(KEY_ADDR, "");
        if (addr.isEmpty()) {
            showSetup();
        } else {
            mark("读取已保存地址: " + addr);
            showMonitor(addr);
        }
    }

    private SharedPreferences prefs() {
        return getSharedPreferences(PREF, MODE_PRIVATE);
    }

    private int dp(float v) {
        return (int) (v * getResources().getDisplayMetrics().density + 0.5f);
    }

    /* ==================== 首次启动：配置电脑地址 ==================== */

    private void showSetup() {
        web = null;

        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setGravity(Gravity.CENTER_HORIZONTAL);
        box.setBackground(Glass.backdrop());
        box.setPadding(dp(24), dp(46), dp(24), dp(24));

        box.addView(mkText("工程监控", 24, TXT, true), lpWrap(0, 0, 0, 6));
        box.addView(mkText("填写运行监控服务的电脑地址", 13, DIM, false), lpWrap(0, 0, 0, 24));

        addrInput = new EditText(this);
        addrInput.setHint("192.168.3.225:8787");
        addrInput.setHintTextColor(DIM);
        addrInput.setTextColor(TXT);
        addrInput.setSingleLine(true);
        addrInput.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        addrInput.setTextSize(TypedValue.COMPLEX_UNIT_DIP, 15);
        addrInput.setBackground(Glass.panel(getResources().getDisplayMetrics().density, 12));
        addrInput.setPadding(dp(14), dp(12), dp(14), dp(12));
        addrInput.setText(prefs().getString(KEY_ADDR, ""));
        addrInput.addTextChangedListener(new TextWatcher() {
            @Override
            public void beforeTextChanged(CharSequence s, int a, int b, int c) {
            }

            @Override
            public void onTextChanged(CharSequence s, int a, int b, int c) {
            }

            @Override
            public void afterTextChanged(Editable s) {
                statusView.setText(previewTarget(s.toString()));
            }
        });
        box.addView(addrInput, new LinearLayout.LayoutParams(-1, dp(52)));

        statusView = mkText(previewTarget(addrInput.getText().toString()), 11.5f, DIM, false);
        statusView.setLineSpacing(dp(3), 1f);
        box.addView(statusView, lpWrap(0, 8, 0, 0));

        goBtn = new Button(this);
        goBtn.setText("连接");
        goBtn.setTextColor(Color.WHITE);
        goBtn.setTextSize(TypedValue.COMPLEX_UNIT_DIP, 16);
        goBtn.setAllCaps(false);
        goBtn.setTypeface(Typeface.DEFAULT_BOLD);
        goBtn.setBackground(pressedAccent());
        goBtn.setStateListAnimator(null);
        goBtn.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                onConnectClicked();
            }
        });
        LinearLayout.LayoutParams goLp = new LinearLayout.LayoutParams(-1, dp(50));
        goLp.topMargin = dp(16);
        box.addView(goBtn, goLp);

        TextView logBtn = mkText("查看诊断日志", 12.5f, ACC, true);
        logBtn.setGravity(Gravity.CENTER);
        logBtn.setPadding(dp(8), dp(14), dp(8), dp(14));
        // 纯文字按钮也要有按压感：包一层涟漪，按下有圆角高亮
        logBtn.setBackground(Glass.ripple(null,
                getResources().getDisplayMetrics().density, 12, 0x334C8DFF));
        logBtn.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                ErrDialog.showLog(MainActivity.this, "诊断日志", dumpLog());
            }
        });
        box.addView(logBtn, lpWrap(0, 18, 0, 0));

        TextView tip = mkText(
            "使用说明\n"
          + "· 电脑端先双击 dev-monitor\\start.bat 启动服务\n"
          + "· 同一 WiFi 下填写电脑局域网 IP，如 192.168.3.225:8787\n"
          + "· 外网请用蒲公英组网后的虚拟 IP，形如 172.16.x.x:8787\n"
          + "· 地址填错可随时点右上角「设置」更换",
            12, DIM, false);
        tip.setLineSpacing(dp(5), 1.0f);
        tip.setBackground(Glass.panel(getResources().getDisplayMetrics().density, 14));
        tip.setPadding(dp(16), dp(14), dp(16), dp(14));
        box.addView(tip, lpWrap(0, 20, 0, 0));

        /* ---- 作者信息：与网页页脚一致 ---- */
        TextView author = mkText("作者 " + DEV_AUTHOR + " · v" + DEV_VERSION, 11.5f, DIM, false);
        author.setGravity(Gravity.CENTER);
        box.addView(author, lpWrap(0, 22, 0, 0));

        TextView siteBtn = mkText("发掘更多实用工具 →", 12.5f, ACC, true);
        siteBtn.setGravity(Gravity.CENTER);
        siteBtn.setPadding(dp(8), dp(12), dp(8), dp(12));
        siteBtn.setBackground(Glass.ripple(null,
                getResources().getDisplayMetrics().density, 12, 0x334C8DFF));
        siteBtn.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                openAuthorSite();
            }
        });
        box.addView(siteBtn, lpWrap(0, 4, 0, 0));

        setContentView(box);
        statusView.setText(previewTarget(addrInput.getText().toString()));
    }

    private String previewTarget(String raw) {
        String n = normalize(raw);
        return n.isEmpty() ? "待输入，例如 192.168.3.225:8787" : "将连接: " + n + "/";
    }

    /** 「发掘更多实用工具」—— 打开作者的工具站；没浏览器时退化成可复制的弹窗 */
    private void openAuthorSite() {
        mark("打开作者工具站: " + DEV_SITE);
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(DEV_SITE)));
        } catch (Exception e) {
            ErrDialog.showLog(this, "打不开浏览器",
                    "请手动在浏览器里访问：\n\n" + DEV_SITE + "\n\n（" + e + "）");
        }
    }

    /* ==================== 连接动作（含预检） ==================== */

    private void onConnectClicked() {
        String raw = addrInput.getText().toString();
        String addr = normalize(raw);

        if (raw.trim().isEmpty()) {
            mark("失败: 地址为空");
            ErrDialog.show(this, "地址没填",
                    "输入框是空的。",
                    "填写电脑地址：同一 WiFi 用电脑局域网 IP，例如 192.168.3.225:8787；"
                  + "外网用蒲公英组网虚拟 IP，例如 172.16.x.x:8787。",
                    null, null, null);
            return;
        }

        if (!looksLikeTarget(addr)) {
            mark("失败: 地址格式异常 -> " + addr);
            ErrDialog.show(this, "地址格式不对",
                    "无法把「" + raw.trim() + "」解析成一个可访问的网址。",
                    "正确写法示例:\n"
                  + "  192.168.3.225:8787\n"
                  + "  192.168.3.225\n"
                  + "  172.16.22.33:8787（蒲公英虚拟 IP）\n"
                  + "不要填 http:// 后面接中文或空格，也不要填 https://。",
                    "归一化结果: " + addr,
                    null, null);
            return;
        }

        pendingAddr = addr;
        prefs().edit().putString(KEY_ADDR, addr).apply();
        mark("开始连接: " + addr);
        setBusy(true, "正在检测 " + stripScheme(addr) + " …");
        probe(addr);
    }

    /**
     * 预检：先不开 WebView，直接用 HTTP 请求探一次。
     * 这样能把「连不上」拆成 DNS 失败 / 拒绝连接 / 超时 / HTTP 错误 / 服务非本程序
     * 五种完全不同的原因，而不是只丢一句 net::ERR_CONNECTION_REFUSED。
     */
    private void probe(final String addr) {
        probeRunning = true;
        new Thread(new Runnable() {
            @Override
            public void run() {
                String host = Uri.parse(addr).getHost();
                String detail;
                int code = -1;
                String reason = null;
                String advice = null;
                String title = null;
                boolean ok = false;

                long t0 = System.currentTimeMillis();
                HttpURLConnection con = null;
                try {
                    URL u = new URL(addr + "/api/snapshot");
                    con = (HttpURLConnection) u.openConnection();
                    con.setConnectTimeout(PROBE_TIMEOUT);
                    con.setReadTimeout(PROBE_TIMEOUT);
                    con.setRequestMethod("GET");
                    code = con.getResponseCode();
                    long ms = System.currentTimeMillis() - t0;
                    detail = "目标: " + u + "\n"
                           + "解析出的主机: " + host + "\n"
                           + "HTTP 状态: " + code + "\n"
                           + "耗时: " + ms + " ms\n"
                           + "Content-Type: " + (con.getContentType() == null ? "(无)" : con.getContentType());

                    if (code == 200) {
                        String body = readBody(con);
                        detail += "\n响应体前 200 字符: " + snippet(body, 200);
                        if (body.contains("\"ueLog\"") && body.contains("\"build\"")) {
                            ok = true;
                        } else {
                            title = "服务存在但接口不对";
                            reason = addr + " 返回了 200，但响应体不是本程序的 /api/snapshot。";
                            advice = "这个端口上跑的是别的服务。请确认电脑端启动的是 "
                                   + "dev-monitor\\start.bat，端口与手机填写的一致。";
                        }
                    } else if (code == 404) {
                        title = "路径不对（404）";
                        reason = addr + " 能连上，但 /api/snapshot 不存在。";
                        advice = "端口对了、服务不对。确认启动的是 dev-monitor 服务，而不是其他占用同一端口的程序。";
                    } else {
                        title = "服务返回 HTTP " + code;
                        reason = "已连上 " + addr + "，但服务返回 " + code + "。";
                        advice = "查看电脑端窗口里的报错输出；若是 500，多半是某个日志文件正被占用或路径配置有误。";
                    }
                } catch (SocketTimeoutException e) {
                    detail = "目标: " + addr + "\n主机: " + host
                           + "\n结果: 连接或读取超时（各 " + PROBE_TIMEOUT + " ms）\n"
                           + "异常: SocketTimeoutException";
                    title = "连接超时";
                    reason = PROBE_TIMEOUT + " ms 内没有收到任何响应。";
                    advice = "常见三种原因：\n"
                           + "1. 电脑端服务没启动，或已退出（先在电脑上双击 start.bat 看窗口）\n"
                           + "2. 手机和电脑不在同一个网络（确认 IP 段一致，如都是 192.168.3.x）\n"
                           + "3. Windows 防火墙拦截了 8787 端口，首次运行需允许 Java/Node 访问专用网络";
                } catch (java.net.UnknownHostException e) {
                    detail = "目标: " + addr + "\n主机: " + host
                           + "\n结果: 域名无法解析\n异常: UnknownHostException";
                    title = "地址无法解析";
                    reason = "系统不认识「" + host + "」这个地址。";
                    advice = "本程序只接受数字 IP。检查是否打错、是否多了空格或中文标点；"
                           + "不要填电脑名或网址，本程序不做域名解析。";
                } catch (java.net.ConnectException e) {
                    detail = "目标: " + addr + "\n主机: " + host
                           + "\n结果: 端口拒绝连接\n异常: ConnectException: " + safeMsg(e);
                    title = "端口没有服务在听";
                    reason = stripScheme(addr) + " 能路由到，但该端口没有进程监听。";
                    advice = "说明 IP 大概率是对的，是电脑端服务没开。双击 dev-monitor\\start.bat，"
                           + "确认窗口打印出「服务已启动」再回手机重试。";
                } catch (Exception e) {
                    detail = "目标: " + addr + "\n主机: " + host
                           + "\n结果: 其他异常\n异常: " + e.getClass().getName() + ": " + safeMsg(e);
                    title = "连接失败";
                    reason = "预检阶段出现未预期的异常。";
                    advice = "复制下面的详情排查。如果手机当前用的是移动数据而非 WiFi，而电脑在局域网内，"
                           + "也需要走蒲公英组网才能互通。";
                } finally {
                    if (con != null) {
                        try {
                            con.disconnect();
                        } catch (Throwable ignored) {
                        }
                    }
                    probeRunning = false;
                }

                final boolean fOk = ok;
                final String fTitle = title;
                final String fReason = reason;
                final String fAdvice = advice;
                final String fDetail = detail;
                ui.post(new Runnable() {
                    @Override
                    public void run() {
                        mark((fOk ? "预检通过: " : "预检失败: ") + stripScheme(addr));
                        setBusy(false, fOk ? "连接成功，正在加载面板 …" : "");
                        if (fOk) {
                            showMonitor(addr);
                        } else {
                            ErrDialog.show(MainActivity.this, fTitle, fReason, fAdvice, fDetail,
                                    new Runnable() {
                                        @Override
                                        public void run() {
                                            onConnectClicked();
                                        }
                                    },
                                    null);
                        }
                    }
                });
            }
        }, "devmon-probe").start();
    }

    /* ==================== 监控页 ==================== */

    @SuppressLint("SetJavaScriptEnabled")
    private void showMonitor(final String addr) {
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setBackgroundColor(BG);

        LinearLayout bar = new LinearLayout(this);
        bar.setOrientation(LinearLayout.HORIZONTAL);
        bar.setGravity(Gravity.CENTER_VERTICAL);
        bar.setPadding(dp(14), dp(10), dp(4), dp(10));
        bar.setBackground(Glass.panel(getResources().getDisplayMetrics().density, 0));
        bar.addView(mkText("工程监控", 15, TXT, true));
        bar.addView(mkText(stripScheme(addr), 11, DIM, false),
                new LinearLayout.LayoutParams(0, -2, 1f));

        TextView diag = mkText("诊断", 14, ACC, true);
        diag.setPadding(dp(12), dp(10), dp(12), dp(10));
        diag.setBackground(Glass.ripple(null,
                getResources().getDisplayMetrics().density, 10, 0x334C8DFF));
        diag.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                ErrDialog.showLog(MainActivity.this, "诊断日志", dumpLog());
            }
        });
        bar.addView(diag);

        TextView set = mkText("设置", 14, ACC, true);
        set.setPadding(dp(12), dp(10), dp(16), dp(10));
        set.setBackground(Glass.ripple(null,
                getResources().getDisplayMetrics().density, 10, 0x334C8DFF));
        set.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                mark("进入设置页");
                showSetup();
            }
        });
        bar.addView(set);
        box.addView(bar, new LinearLayout.LayoutParams(-1, -2));

        web = new WebView(this);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setUseWideViewPort(true);
        s.setLoadWithOverviewMode(true);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        }
        web.setBackgroundColor(BG);
        web.setOverScrollMode(View.OVER_SCROLL_NEVER);

        web.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
                mark("页面开始加载: " + url);
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                mark("页面加载完成: " + url);
                if (web != null && web.getUrl() != null && web.getUrl().startsWith("about:")) {
                    errBack();
                }
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest req, WebResourceError err) {
                if (req == null || !req.isForMainFrame()) {
                    mark("子资源加载失败(忽略): " + (req == null ? "?" : req.getUrl()));
                    return;
                }
                int code = err == null ? -1 : err.getErrorCode();
                String desc = err == null ? "" : String.valueOf(err.getDescription());
                mark("主文档加载失败: " + req.getUrl() + " code=" + code + " " + desc);
                ErrDialog.show(MainActivity.this,
                        "页面加载失败（错误码 " + code + "）",
                        explainCode(code) + "\n\n地址: " + req.getUrl(),
                        adviceForCode(code, addr),
                        "URL: " + req.getUrl() + "\n错误码: " + code + "（-" + Math.abs(code)
                              + " = WebView 内部错误）\n描述: " + desc + "\n"
                              + "已保存地址: " + prefs().getString(KEY_ADDR, "(无)") + "\n"
                              + "最近日志:\n" + dumpLog(),
                        new Runnable() {
                            @Override
                            public void run() {
                                if (web != null) {
                                    mark("重试加载 " + addr);
                                    web.loadUrl(addr + "/");
                                }
                            }
                        },
                        new Runnable() {
                            @Override
                            public void run() {
                                showSetup();
                            }
                        });
            }

            @SuppressWarnings("deprecation")
            @Override
            public void onReceivedError(WebView view, int errorCode, String description, String failingUrl) {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                    return; // 新回调已处理
                }
                mark("主文档加载失败(legacy): " + failingUrl + " " + errorCode + " " + description);
            }

            @Override
            public void onReceivedHttpError(WebView view, WebResourceRequest req, WebResourceResponse res) {
                if (req == null || !req.isForMainFrame()) {
                    return;
                }
                int code = res == null ? -1 : res.getStatusCode();
                mark("HTTP 错误: " + code + " " + req.getUrl());
                ErrDialog.show(MainActivity.this, "服务返回 HTTP " + code,
                        "已经连上电脑，但服务没有正常提供面板。",
                        "若为 404，多半是端口上跑的不是 dev-monitor 服务；"
                      + "若为 500，看电脑端 start.bat 窗口里的红色报错并复制给我。",
                        "URL: " + req.getUrl() + "\n状态码: " + code + "\n"
                              + "原因: " + (res == null ? "(无)" : String.valueOf(res.getReasonPhrase())) + "\n"
                              + "响应: " + (res == null ? "(无)" : String.valueOf(res.getData())) + "\n\n"
                              + "最近日志:\n" + dumpLog(),
                        null,
                        new Runnable() {
                            @Override
                            public void run() {
                                showSetup();
                            }
                        });
            }

            @Override
            public void onReceivedSslError(WebView view, SslErrorHandler handler, final android.net.http.SslError error) {
                mark("SSL 错误: " + error.getPrimaryError());
                handler.cancel();
                ErrDialog.show(MainActivity.this, "HTTPS 证书错误",
                        "证书校验失败（" + error.getPrimaryError() + "），连接已被取消。",
                        "本程序只用 http:// 明文访问局域网地址，请把地址改成以 http 开头的形式。",
                        "错误码: " + error.getPrimaryError() + "\n"
                              + "受影响地址: " + (error.getUrl() == null ? "(无)" : error.getUrl()),
                        null, null);
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
                if (req != null && req.getUrl() != null) {
                    String scheme = req.getUrl().getScheme();
                    if (!"http".equals(scheme) && !"https".equals(scheme)) {
                        mark("拦截外部跳转: " + req.getUrl());
                        ErrDialog.show(MainActivity.this, "已拦截跳转",
                                "面板里的内容试图跳转到非 http 地址，已阻止。",
                                "这通常不会发生；若反复出现，请复制下面的日志。",
                                req.getUrl().toString(), null, null);
                        return true;
                    }
                }
                return false;
            }
        });

        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onConsoleMessage(ConsoleMessage cm) {
                // 把页面里的 JS 报错也纳入诊断，否则面板半白屏时无从查起
                mark("JS " + cm.messageLevel() + ": " + cm.message()
                        + " @" + cm.sourceId() + ":" + cm.lineNumber());
                return true;
            }
        });

        box.addView(web, new LinearLayout.LayoutParams(-1, 0, 1f));
        setContentView(box);

        mark("WebView 加载 " + addr + "/");
        web.loadUrl(addr + "/");
    }

    private void errBack() {
        ErrDialog.show(this, "面板没能加载出来",
                "页面打开了，但没有渲染出监控界面。",
                "这通常是页面脚本执行失败。点「诊断」查看 JS 报错，或在电脑上访问 "
              + stripScheme(pendingAddr) + " 看浏览器里是否也白屏。",
                dumpLog(), null, null);
    }

    /* ==================== 诊断日志 ==================== */

    private void mark(String line) {
        String t = new SimpleDateFormat("HH:mm:ss", Locale.CHINA).format(new Date());
        logLines.addLast("[" + t + "] " + line);
        while (logLines.size() > 200) {
            logLines.removeFirst();
        }
    }

    private String dumpLog() {
        if (logLines.isEmpty()) {
            return "（暂无记录）";
        }
        StringBuilder sb = new StringBuilder();
        for (String l : logLines) {
            sb.append(l).append('\n');
        }
        return sb.toString();
    }

    /* ==================== 工具 ==================== */

    private void setBusy(boolean busy, String text) {
        if (goBtn == null) {
            return;
        }
        goBtn.setEnabled(!busy);
        goBtn.setText(busy ? "检测中 …" : "连接");
        // 禁用态没有按压意义，直接用静态底色；可用态必须重新包涟漪，
        // 否则换背景的瞬间点击反馈就丢了
        goBtn.setBackground(busy
                ? roundBox(0xFF3A4A70, 0, 12)
                : pressedAccent());
        if (statusView != null) {
            String cur = statusView.getText().toString();
            if (busy) {
                statusView.setText(text);
            } else if (!text.isEmpty()) {
                statusView.setText(text);
            } else if (!cur.isEmpty()) {
                statusView.setText(cur);
            }
        }
    }

    private TextView mkText(String s, float dip, int color, boolean bold) {
        TextView tv = new TextView(this);
        tv.setText(s);
        // 必须显式指定 DIP：setTextSize(float) 默认按 SP 走，
        // 而系统字体缩放一旦调大，文字会溢出容器甚至被裁切。
        tv.setTextSize(TypedValue.COMPLEX_UNIT_DIP, dip);
        tv.setTextColor(color);
        tv.setIncludeFontPadding(false);
        if (bold) {
            tv.setTypeface(Typeface.DEFAULT_BOLD);
        }
        return tv;
    }

    private GradientDrawable roundBox(int fill, int stroke, int radiusDp) {
        GradientDrawable gd = new GradientDrawable();
        gd.setShape(GradientDrawable.RECTANGLE);
        gd.setColor(fill);
        gd.setCornerRadius(dp(radiusDp));
        if (stroke != 0) {
            gd.setStroke(dp(1), stroke);
        }
        return gd;
    }

    /** 连接按钮的可用态背景：玻璃渐变 + 白色涟漪（按压反馈） */
    private android.graphics.drawable.Drawable pressedAccent() {
        return Glass.ripple(Glass.buttonAccent(getResources().getDisplayMetrics().density, 12),
                getResources().getDisplayMetrics().density, 12, 0x40FFFFFF);
    }

    private LinearLayout.LayoutParams lpWrap(int l, int t, int r, int b) {
        LinearLayout.LayoutParams p = new LinearLayout.LayoutParams(-1, -2);
        p.setMargins(dp(l), dp(t), dp(r), dp(b));
        return p;
    }

    /** 补全协议头、去掉尾部斜杠 */
    private String normalize(String s) {
        s = s.trim();
        if (s.isEmpty()) {
            return "";
        }
        // 顺手清掉用户可能粘贴进来的中文标点与全角字符
        s = s.replace('，', '.').replace('。', '.')
             .replace('：', ':').replace('．', '.')
             .replaceAll("[\\s]+", "");
        if (!s.startsWith("http://") && !s.startsWith("https://")) {
            s = "http://" + s;
        }
        while (s.endsWith("/")) {
            s = s.substring(0, s.length() - 1);
        }
        return s;
    }

    /** 是否像一个可访问的 http 目标：必须有纯数字主机，可带端口 */
    private boolean looksLikeTarget(String addr) {
        try {
            Uri u = Uri.parse(addr);
            String host = u.getHost();
            if (host == null || host.isEmpty()) {
                return false;
            }
            if (!host.matches("^(\\d{1,3}\\.){3}\\d{1,3}$")) {
                return false;
            }
            for (String seg : host.split("\\.")) {
                if (Integer.parseInt(seg) > 255) {
                    return false;
                }
            }
            if (u.getPort() != -1 && (u.getPort() < 1 || u.getPort() > 65535)) {
                return false;
            }
            return true;
        } catch (Throwable t) {
            return false;
        }
    }

    private String stripScheme(String s) {
        return s.replace("https://", "").replace("http://", "");
    }

    private String readBody(HttpURLConnection con) {
        try {
            BufferedReader r = new BufferedReader(new InputStreamReader(con.getInputStream(), "UTF-8"));
            StringBuilder sb = new StringBuilder();
            String line;
            while ((line = r.readLine()) != null && sb.length() < 4096) {
                sb.append(line).append('\n');
            }
            r.close();
            return sb.toString();
        } catch (Throwable t) {
            return "(读取响应体失败: " + t.getClass().getSimpleName() + ")";
        }
    }

    private static String snippet(String s, int max) {
        if (s == null) {
            return "(null)";
        }
        s = s.trim();
        return s.length() <= max ? s : s.substring(0, max) + " …(截断)";
    }

    private static String safeMsg(Throwable t) {
        String m = t.getMessage();
        return m == null ? "(无消息)" : m;
    }

    private String explainCode(int code) {
        switch (code) {
            case -1:
                return "未知错误。";
            case -2:
                return "域名解析失败（ERR_HOST_LOOKUP）：系统找不到这个地址。";
            case -3:
                return "客户端拒绝了该地址。";
            case -4:
                return "文件不存在或无法读取。";
            case -5:
                return "地址格式非法（ERR_BAD_URL）。";
            case -6:
                return "连接被拒绝（ERR_CONNECTION_REFUSED）：地址能到，但端口没有服务在听。";
            case -7:
                return "网络中断或读写失败（ERR_IO）。";
            case -8:
                return "连接超时（ERR_CONNECTION_TIMED_OUT）：限定时间内没有响应。";
            case -9:
                return "代理认证失败。";
            case -10:
                return "被拒绝访问（ERR_ACCESS_DENIED）。";
            case -11:
                return "不支持的认证方式。";
            case -12:
                return "预加载资源失败。";
            case -13:
                return "渲染进程被杀死（ERR_RENDER_PROCESS_GONE），多半是内存不足。";
            case -14:
                return "安全策略拒绝加载（ERR_UNSAFE_RESOURCE）。";
            case -15:
                return "SD 卡不可用。";
            case -16:
                return "请求被拦截。";
            default:
                return "WebView 内部错误码 " + code + "。";
        }
    }

    private String adviceForCode(int code, String addr) {
        switch (code) {
            case -2:
                return "手机系统不认识这个地址。确认没打错字、没多空格；本程序只接受数字 IP。";
            case -6:
                return "IP 大概率正确，但电脑端服务没开。双击 dev-monitor\\start.bat，"
                     + "确认窗口打印「服务已启动」后回到手机点「重试」。";
            case -8:
                return "先看电脑端服务是否在跑；再确认手机和电脑在同一网络（IP 段一致）；"
                     + "最后检查 Windows 防火墙是否拦了 8787 端口。";
            case -13:
                return "渲染进程被系统杀掉，通常是内存不足。关掉其他应用后重试。";
            default:
                return "在电脑上用浏览器打开 http://" + stripScheme(addr)
                     + " 看是否正常。若电脑上也打不开，问题在电脑端服务而非手机。";
        }
    }

    private void toast(String msg) {
        Toast.makeText(this, msg, Toast.LENGTH_LONG).show();
    }

    @Override
    public void onBackPressed() {
        if (web != null && web.canGoBack()) {
            web.goBack();
        } else {
            super.onBackPressed();
        }
    }
}