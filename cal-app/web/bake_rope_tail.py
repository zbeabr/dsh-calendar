#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""烘焙麻绳末端贴图 rope-tail.png（带透明通道，4x 超采样抗锯齿）。

为什么要烘焙，而不是继续用 CSS 画：
  拟物时代的资产是美术画好、预烘焙成位图再贴上去的（见 skeuomorphic-ui
  的 retro-mac-research）。上一版用 repeating-linear-gradient 画「散纤维」，
  出来是一排等距竖线 + 一个矩形块，像刷子，用户一眼看出假。

形状依据（前两版为什么还是假，第三版改了什么）：
  · 第一版把麻线结画成 8 圈覆盖整个矩形，叠成了一块「砖墙」；
    第二版顶部又自己画了一段绳身，捻纹相位和 CSS .rope-seg 对不上，
    接到一起就是「上面细密斜纹、下面粗斜条」，一眼两截绳。
  · 纤维从同一点向外放射、长度接近，像烟花；真绳尾是三股各自解开，
    每股再分几根短纤维，整体向下垂、只微微外张，长短参差。
  所以第三版：贴图顶部 0..7 完全透明，让 CSS 绳段自己延伸到结的位置；
  只画「绕圆柱的弧形麻线结 → 三股刚松开的实体段 → 每股散出的短纤维」。

脚本只用标准库（zlib / struct / math / random），固定随机种子，
换机器也能重跑出逐字节一致的贴图。

用法: python3 bake_rope_tail.py [输出路径]
"""
import math
import random
import struct
import sys
import zlib
from pathlib import Path

OUT = Path(sys.argv[1] if len(sys.argv) > 1 else "rope-tail.png")

# CSS 尺寸：绳身 9px 宽，尾巴散开到 28px，向下 46px
W, H = 28.0, 46.0
SS = 4                      # 超采样倍率，输出即 4x 高清图
PW, PH = int(W * SS), int(H * SS)
CX = W / 2.0
BODY = 7.0                  # 顶部 0..7 透明：绳身由 CSS .rope-seg 一直画到这里，
                            # 贴图绝不重画一遍，否则两套捻纹必打架

random.seed(20261109)       # 固定种子：每次生成完全一致

buf = bytearray(PW * PH * 4)   # RGBA，0 表示透明


def blend(px, py, r, g, b, a):
    """源覆盖混合，支持目标本身带 alpha。坐标为超采样像素。"""
    if a <= 0 or px < 0 or px >= PW or py < 0 or py >= PH:
        return
    a = min(1.0, a)
    i = (py * PW + px) * 4
    da = buf[i + 3] / 255.0
    oa = a + da * (1 - a)
    if oa <= 0:
        return
    for k, c in enumerate((r, g, b)):
        buf[i + k] = int((c * a + buf[i + k] * da * (1 - a)) / oa)
    buf[i + 3] = int(oa * 255)


def hexrgb(s):
    return tuple(int(s[i:i + 2], 16) for i in (1, 3, 5))


# 与 .rope-seg 完全同一套色标（周期 3.2px）
BODY_BANDS = [
    (0.00, 0.85, hexrgb("#b59b6a")),
    (0.85, 1.70, hexrgb("#9d855a")),
    (1.70, 2.35, hexrgb("#74603c")),
    (2.35, 2.95, hexrgb("#46351c")),
    (2.95, 3.20, hexrgb("#6a5632")),
]
# 纤维比绳身略灰、略暗：拆开的股没了捻紧时的高光，不该发光
FIBERS = [
    hexrgb("#a68c5e"), hexrgb("#93794f"), hexrgb("#b09a6b"),
    hexrgb("#7d6742"), hexrgb("#8a7550"), hexrgb("#bca777"),
]
WHIP_DARK = hexrgb("#3d2d16")
WHIP_MID = hexrgb("#7c6237")
WHIP_LIGHT = hexrgb("#c4a870")


# ── 1) 绳身：不画 ────────────────────────────────────────────────
# CSS 的 .rope-seg 已经把绳身一直画到 tailEnd，且捻纹按页面绝对 y 对齐。
# 贴图顶部保持透明，只在下面压一个结；这样不可能出现「两截不一样的绳」。

# ── 2) 麻线结：6 圈绕圆柱的弧线，圈间留缝，两端随圆柱收窄 ──────
def draw_whipping():
    for i in range(6):
        base_y = 6.6 + i * 0.86
        for px in range(int((CX - 5.6) * SS), int((CX + 5.6) * SS) + 1):
            x = px / SS
            u = abs(x - CX) / 5.0
            if u > 1.0:
                continue
            # 绕圆柱：正面中段低、两侧向上弯，才不是一条平的横杠
            arc = 0.55 * (u * u)
            yc = base_y + 0.30 * (x - CX) / 5.0 - arc
            # 圆柱左右边缘入暗并收透明，避免方形轮廓
            edge = max(0.0, min(1.0, (1.0 - u) / 0.22))
            for py in range(int((yc - 0.8) * SS), int((yc + 0.8) * SS) + 1):
                y = py / SS
                d = abs(y - yc)
                cov = max(0.0, min(1.0, (0.26 + 0.30 - d) / 0.42))
                if cov <= 0:
                    continue
                if y < yc - 0.08:
                    r, g, b = WHIP_LIGHT
                elif y > yc + 0.10:
                    r, g, b = WHIP_DARK
                else:
                    r, g, b = WHIP_MID
                blend(px, py, r, g, b, cov * 0.90 * edge)

# ── 3) 三股解开，每股散出几根短而略弯的纤维 ────────────────────────
class Fiber:
    """一根纤维：按 y 建查找表，绘制时只遍历它附近的像素。"""

    def __init__(self, x0, x1, bend, length, width, color, y0, alpha):
        self.lut = [None] * PH
        self.color = color
        self.alpha = alpha
        self.width = width
        p0 = (x0, y0)
        p1 = (bend, y0 + length * 0.58)
        p2 = (x1, y0 + length)
        steps = 180
        for i in range(steps + 1):
            t = i / steps
            u = 1 - t
            x = u * u * p0[0] + 2 * u * t * p1[0] + t * t * p2[0]
            y = u * u * p0[1] + 2 * u * t * p1[1] + t * t * p2[1]
            py = int(y * SS)
            if py < 0 or py >= PH:
                continue
            w = width * ((1 - t) ** 0.8) + 0.10
            # 从 45% 处开始渐隐，尖端不能齐刷刷一刀切
            q = max(0.0, min(1.0, (t - 0.34) / 0.66))
            fade = 1 - q * q * (3 - 2 * q)
            rec = (x, w, fade)
            if self.lut[py] is None:
                self.lut[py] = rec
            else:
                ox, ow, of = self.lut[py]
                self.lut[py] = ((ox + x) / 2, (ow + w) / 2, (of + fade) / 2)
        known = [i for i, v in enumerate(self.lut) if v is not None]
        if len(known) < 2:
            return
        for a, b in zip(known, known[1:]):
            if b - a <= 1:
                continue
            xa, wa, fa = self.lut[a]
            xb, wb, fb = self.lut[b]
            for py in range(a + 1, b):
                t = (py - a) / (b - a)
                self.lut[py] = (xa + (xb - xa) * t,
                                wa + (wb - wa) * t,
                                fa + (fb - fa) * t)


def draw_fiber(f):
    cr, cg, cb = f.color
    for py, rec in enumerate(f.lut):
        if rec is None:
            continue
        x, w, fade = rec
        if fade <= 0.01 or w <= 0.04:
            continue
        half = w / 2
        p_lo = max(0, int((x - half - 0.6) * SS))
        p_hi = min(PW, int((x + half + 0.6) * SS) + 2)
        for px in range(p_lo, p_hi):
            d = abs(px / SS - x)
            cov = max(0.0, min(1.0, (half + 0.4 - d) / 0.8))
            if cov <= 0:
                continue
            lit = 1 - min(1.0, d / (half + 0.01))
            shade = 0.70 + 0.30 * lit
            blend(px, py,
                  int(min(255, cr * (0.82 + 0.26 * lit))),
                  int(min(255, cg * (0.82 + 0.26 * lit))),
                  int(min(255, cb * (0.82 + 0.26 * lit))),
                  cov * fade * shade * f.alpha)


def draw_unlay():
    """结下方三股刚松开的实体段：不是从一点爆开的线，而是三条渐细的股。"""
    for k in (-1, 0, 1):
        root = CX + k * 2.15
        for py in range(int(9.0 * SS), int(14.2 * SS)):
            y = py / SS
            t = (y - 9.0) / 5.2
            x = root + k * 0.85 * t + 0.35 * math.sin(t * 2.4 + k)
            w = 2.7 * (1 - t * 0.55)
            cr, cg, cb = FIBERS[1 if k == 0 else 0]
            for px in range(max(0, int((x - w) * SS)),
                            min(PW, int((x + w) * SS) + 1)):
                d = abs(px / SS - x)
                cov = max(0.0, min(1.0, (w * 0.55 + 0.35 - d) / 0.7))
                if cov <= 0:
                    continue
                lit = 1 - min(1.0, d / (w * 0.55 + 0.01))
                blend(px, py,
                      int(cr * (0.78 + 0.30 * lit)),
                      int(cg * (0.78 + 0.30 * lit)),
                      int(cb * (0.78 + 0.30 * lit)),
                      cov * (0.90 - 0.55 * t))


fibers = []
for k in range(3):
    root = CX + (k - 1) * 2.0
    for j in range(6):
        # 每股只微微外张，不做放射状；粗细、长短、弯向都不同
        drift = (j - 2.5) * 0.72 + random.uniform(-0.7, 0.7)
        endx = root + (k - 1) * 2.6 + drift + random.uniform(-0.8, 0.8)
        length = random.uniform(6.0, 20.0)
        bend = root + drift * 0.28 + random.uniform(-1.0, 1.0)
        width = random.uniform(0.42, 1.08)
        color = random.choice(FIBERS)
        fibers.append(Fiber(root + (k - 1) * 2.4 + random.uniform(-0.7, 0.7),
                            endx, bend, length, width, color,
                            y0=12.6 + random.uniform(-0.8, 2.0),
                            alpha=random.uniform(0.62, 0.92)))

# 少量飞出的单根短毛刺：极细、只向两侧偏一点
for _ in range(9):
    side = random.choice((-1, 1))
    root = CX + side * random.uniform(1.0, 2.8)
    fibers.append(Fiber(root,
                        root + side * random.uniform(1.8, 4.2),
                        root + side * random.uniform(0.6, 2.2),
                        random.uniform(5.0, 14.0),
                        random.uniform(0.20, 0.40),
                        random.choice(FIBERS[:3]),
                        y0=13.0 + random.uniform(0, 4),
                        alpha=0.60))

fibers.sort(key=lambda f: -f.width)   # 粗的先画在底层
for f in fibers:
    draw_fiber(f)
draw_unlay()                           # 三股实体压住纤维根部，不露出发射点
draw_whipping()                        # 结压住整段接缝


def write_png(path, w, h, rgba):
    raw = b"".join(b"\x00" + bytes(rgba[y * w * 4:(y + 1) * w * 4])
                   for y in range(h))

    def chunk(tag, data):
        return (struct.pack(">I", len(data)) + tag + data +
                struct.pack(">I", zlib.crc32(tag + data) & 0xffffffff))

    path.write_bytes(
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )


write_png(OUT, PW, PH, buf)
print(f"贴图已生成: {OUT}  {PW}x{PH}px (CSS {W:.0f}x{H:.0f} @4x)  {OUT.stat().st_size} bytes")
