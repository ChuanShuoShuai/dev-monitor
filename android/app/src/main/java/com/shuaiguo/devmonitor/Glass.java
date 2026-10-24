package com.shuaiguo.devmonitor;

import android.content.res.ColorStateList;
import android.graphics.drawable.Drawable;
import android.graphics.drawable.GradientDrawable;
import android.graphics.drawable.LayerDrawable;
import android.graphics.drawable.RippleDrawable;

/**
 * 玻璃拟态绘制工具（原生端）。
 *
 * 为什么不是真 blur：Window 背景做实时模糊需要 RenderEffect（API 31+），
 * 而 App 的 minSdk 是 22；市面上的液态玻璃库（Kyant0/AndroidLiquidGlass 等）
 * 全部基于 Jetpack Compose + Kotlin，且完整效果要求 AGSL（API 33+），
 * 为两个原生小页面引入整套 Compose 工具链不划算。
 *
 * 本类的近似思路与 Web 端一致：
 *   左上→右下的深色渐变填充（模拟玻璃厚度）
 *   + 顶部亮、两侧淡的 1px 渐变描边（高光边，玻璃的"边缘折射"）
 *   + 内容区再垫一层更亮的内衬（模拟玻璃内侧反光）。
 * 页面背景先铺一层深蓝渐变 + 光斑色块，卡片叠上去就有玻璃的分层感。
 */
public final class Glass {

    private Glass() {
    }

    /** 页面背景：深蓝底 + 三块光斑色，给玻璃提供折射源 */
    public static Drawable backdrop() {
        GradientDrawable bg = new GradientDrawable();
        bg.setOrientation(GradientDrawable.Orientation.TL_BR);
        bg.setColors(new int[]{0xFF0B1020, 0xFF0D1430, 0xFF121B3E});
        bg.setGradientRadius(1f); // 线性渐变忽略
        return bg;
    }

    /**
     * 玻璃面板：渐变填充 + 渐变描边。
     * 实现方式与 CSS 的 background-clip 双层技巧相同——
     * 外层画"边框渐变"，内层 inset 1dp 画填充，露出的一圈就是高光边。
     */
    public static Drawable panel(float density, float radiusDp) {
        float r = radiusDp * density;
        GradientDrawable border = new GradientDrawable(GradientDrawable.Orientation.TL_BR,
                new int[]{0x73A8C4FF, 0x1A7A91DC, 0x3A46589E});
        border.setShape(GradientDrawable.RECTANGLE);
        border.setCornerRadius(r);

        GradientDrawable fill = new GradientDrawable(GradientDrawable.Orientation.TL_BR,
                new int[]{0xF21F2949, 0xF2172038});
        fill.setShape(GradientDrawable.RECTANGLE);
        fill.setCornerRadius(Math.max(0f, r - 0.5f * density));

        LayerDrawable layer = new LayerDrawable(new Drawable[]{border, fill});
        int in = (int) (density + 0.5f);
        layer.setLayerInset(1, in, in, in, in);
        return layer;
    }

    /** 强调按钮（连接）：实色渐变 + 顶部高光内衬 */
    public static GradientDrawable buttonAccent(float density, float radiusDp) {
        GradientDrawable gd = new GradientDrawable(GradientDrawable.Orientation.TL_BR,
                new int[]{0xFF6B9EFF, 0xFF3F74E0});
        gd.setShape(GradientDrawable.RECTANGLE);
        gd.setCornerRadius(radiusDp * density);
        return gd;
    }

    /** 弹窗内的信息块：比面板更亮的内衬 */
    public static Drawable inner(float density, float radiusDp) {
        GradientDrawable gd = new GradientDrawable(GradientDrawable.Orientation.TL_BR,
                new int[]{0x14243C66, 0x101A2C55});
        gd.setShape(GradientDrawable.RECTANGLE);
        gd.setCornerRadius(radiusDp * density);
        gd.setStroke((int) (density + 0.5f), 0x2E7A91DC);
        return gd;
    }

    /**
     * 给内容包一层圆角 ripple —— 原生按钮的按压反馈。
     * 背景 是自绘 GradientDrawable 时系统不再提供涟漪，必须显式包一层；
     * content 传 null 就是"纯文字链接"式按钮，按下只有涟漪高亮。
     */
    public static Drawable ripple(Drawable content, float density, float radiusDp, int rippleColor) {
        GradientDrawable mask = new GradientDrawable();
        mask.setShape(GradientDrawable.RECTANGLE);
        mask.setCornerRadius(radiusDp * density);
        return new RippleDrawable(ColorStateList.valueOf(rippleColor), content, mask);
    }
}