// Icon.swift — 生成「DSH 日历」应用图标（Liquid Glass 版）
//
// 设计语言：macOS 26 起的 Liquid Glass —— 不是「彩色底 + 白色贴纸」，
// 而是几层半透明玻璃叠在发光底板上：底板有色、玻璃有厚度、边缘有一圈
// 高光（rim light）、表面有斜向反光、层与层之间有带色的投影。
//
// 三个关键做法：
//   1. 外轮廓用超椭圆（连续曲率），指数按系统图标实测轮廓拟合，不是正圆弧；
//   2. 每块玻璃都走「投影 → 半透明填充 → 顶部内高光 → 底部内暗部 → 边缘环光」五步；
//   3. 小尺寸单独降级：去掉大面积反光与细节层，只留下辨识度最高的形状与对比。
//
// 用法：swift Icon.swift <输出目录>
// 产出：icon-1024.png 与 AppIcon.iconset/ 全套尺寸（每个尺寸独立矢量渲染，不是缩放）

import AppKit
import CoreGraphics

// MARK: - 基础工具

func color(_ hex: UInt32, _ alpha: CGFloat = 1) -> CGColor {
    CGColor(
        red: CGFloat((hex >> 16) & 0xFF) / 255,
        green: CGFloat((hex >> 8) & 0xFF) / 255,
        blue: CGFloat(hex & 0xFF) / 255,
        alpha: alpha
    )
}

extension CGContext {
    func linear(_ colors: [CGColor], _ stops: [CGFloat], from: CGPoint, to: CGPoint) {
        let space = CGColorSpaceCreateDeviceRGB()
        guard let gradient = CGGradient(colorsSpace: space, colors: colors as CFArray, locations: stops) else { return }
        drawLinearGradient(gradient, start: from, end: to, options: [.drawsBeforeStartLocation, .drawsAfterEndLocation])
    }

    func radial(_ colors: [CGColor], _ stops: [CGFloat], center: CGPoint, radius: CGFloat) {
        let space = CGColorSpaceCreateDeviceRGB()
        guard let gradient = CGGradient(colorsSpace: space, colors: colors as CFArray, locations: stops) else { return }
        // 关键：半径之外要延伸。否则渐变在 endRadius 处戛然而止，
        // 那条「圆弧边界」在大半径下看起来就是一道斜向硬边。
        drawRadialGradient(gradient, startCenter: center, startRadius: 0, endCenter: center, endRadius: radius,
                           options: [.drawsBeforeStartLocation, .drawsAfterEndLocation])
    }

    func roundedPath(_ rect: CGRect, _ radius: CGFloat) -> CGPath {
        CGPath(roundedRect: rect, cornerWidth: radius, cornerHeight: radius, transform: nil)
    }

    /// 连续曲率方圆形（superellipse）：|x/a|^n + |y/b|^n = 1。
    /// n 越大越接近正方形；5.4 是对系统图标轮廓做边缘采样后拟合出来的值 ——
    /// 比「正圆角矩形」更贴近 Apple 图标的方圆形，转角不会显得突然变硬。
    func squircle(_ rect: CGRect, _ n: CGFloat = 5.4) -> CGPath {
        let a = rect.width / 2, b = rect.height / 2
        let cx = rect.midX, cy = rect.midY
        let e = 2 / n
        let steps = 512
        let p = CGMutablePath()
        for i in 0...steps {
            let t = CGFloat(i) / CGFloat(steps) * 2 * .pi
            let ct = cos(t), st = sin(t)
            let x = cx + a * (ct < 0 ? -1 : 1) * pow(abs(ct), e)
            let y = cy + b * (st < 0 ? -1 : 1) * pow(abs(st), e)
            if i == 0 { p.move(to: CGPoint(x: x, y: y)) } else { p.addLine(to: CGPoint(x: x, y: y)) }
        }
        p.closeSubpath()
        return p
    }

    /// 沿路径描一条渐变色的边：玻璃边缘的 rim light。
    /// inset = true 时先裁进形状内部再描（线宽加倍），亮边只出现在内侧，
    /// 不会在轮廓外面留一圈「贴纸白边」。
    func rim(_ path: CGPath, width: CGFloat, _ colors: [CGColor], _ stops: [CGFloat],
             from: CGPoint, to: CGPoint, inset: Bool = false) {
        guard width > 0.05 else { return }
        saveGState()
        if inset {
            addPath(path)
            clip()
        }
        addPath(path)
        setLineWidth(inset ? width * 2 : width)
        replacePathWithStrokedPath()
        clip()
        linear(colors, stops, from: from, to: to)
        restoreGState()
    }

    /// 内阴影 / 内高光：把「路径外部」的投影裁进内部，只让贴着边缘的一圈暗部（或亮部）显形。
    /// 这是玻璃有厚度、有内凹感的关键，比单纯描边自然得多。
    func innerShadow(_ path: CGPath, _ shade: CGColor, blur: CGFloat, offset: CGSize, bounds: CGRect) {
        saveGState()
        addPath(path)
        clip()
        setShadow(offset: offset, blur: blur, color: shade)
        let inverse = CGMutablePath()
        inverse.addRect(bounds.insetBy(dx: -bounds.width, dy: -bounds.height))
        inverse.addPath(path)
        addPath(inverse)
        setFillColor(CGColor(gray: 0, alpha: 1))
        fillPath(using: .evenOdd)
        restoreGState()
    }

    /// 镜面高光条：贴着某条边的一小段极亮细线，两头淡出。
    /// 玻璃质感里最「高频」的一笔 —— 少了它，再透的层也只是一片柔雾。
    func streak(_ clipPath: CGPath, from a: CGPoint, to b: CGPoint, width: CGFloat,
                _ colors: [CGColor], _ stops: [CGFloat]) {
        guard width > 0.05 else { return }
        saveGState()
        addPath(clipPath)
        clip()
        let line = CGMutablePath()
        line.move(to: a)
        line.addLine(to: b)
        addPath(line)
        setLineWidth(width)
        setLineCap(.round)
        replacePathWithStrokedPath()
        clip()
        linear(colors, stops, from: a, to: b)
        restoreGState()
    }
}

// MARK: - 主绘制

/// 在 0…1 的归一化空间里描述，再按尺寸放大，保证任意尺寸都是矢量级清晰。
func drawIcon(in ctx: CGContext, size S: CGFloat) {
    ctx.setShouldAntialias(true)
    ctx.interpolationQuality = .high

    // 尺寸分级：≤40 只剩骨架（点阵降为四宫格、去掉装订环与内阴影）
    let isTiny = S <= 40
    let full = CGRect(x: 0, y: 0, width: S, height: S)
    let hair = max(1.0, 0.0050 * S)   // 最细的线：小尺寸下强制 1px，否则会消失

    // ── 底板几何：macOS 图标网格，内容区 824/1024
    let margin: CGFloat = 0.098
    let side = S * (1 - margin * 2)
    let body = CGRect(x: S * margin, y: S * margin, width: side, height: side)
    let plate = ctx.squircle(body)

    // ── 1. 落地投影：整块玻璃浮在桌面上（小尺寸省掉，否则 32px 全被阴影吃掉）
    if S > 64 {
        ctx.saveGState()
        ctx.setShadow(offset: CGSize(width: 0, height: -0.013 * S), blur: 0.055 * S, color: color(0x140936, 0.24))
        ctx.addPath(plate)
        ctx.setFillColor(color(0x4A31C4))
        ctx.fillPath()
        ctx.restoreGState()
    }

    // ── 2. 底板：液体本身
    ctx.saveGState()
    ctx.addPath(plate)
    ctx.clip()
    ctx.linear(
        [color(0x2A189C), color(0x5731E4), color(0xA06BFF)],
        [0, 0.52, 1],
        from: CGPoint(x: body.minX, y: body.minY + side * 0.10),
        to: CGPoint(x: body.maxX, y: body.maxY)
    )
    // 左上角的光源：越靠角越亮，玻璃才有「被照亮」的感觉
    ctx.radial(
        [color(0xFFFFFF, 0.17), color(0xFFFFFF, 0.03), color(0xFFFFFF, 0)],
        [0, 0.26, 1],
        center: CGPoint(x: body.minX + side * 0.04, y: body.maxY - side * 0.01),
        radius: side * 0.52
    )
    // 右下压暗，制造体积
    ctx.radial(
        [color(0x160744, 0), color(0x160744, 0.38)],
        [0.20, 1],
        center: CGPoint(x: body.maxX - side * 0.10, y: body.minY + side * 0.10),
        radius: side * 1.05
    )
    ctx.restoreGState()

    // ── 3. 边缘：外侧一圈柔光（光在玻璃里全反射）+ 内侧一道硬高光
    // 亮边只留给左上角那一段：整圈都亮会在深紫上变成一圈发灰的边。
    // 渐变轴也缩短到左上四分之一，让亮线在左边中部之前就淡干净。
    if !isTiny {
        ctx.rim(plate, width: hair * 1.1,
                [color(0xFFFFFF, 0.85), color(0xFFFFFF, 0.0)],
                [0, 0.6],
                from: CGPoint(x: body.minX, y: body.maxY),
                to: CGPoint(x: body.minX + side * 0.3, y: body.maxY - side * 0.3),
                inset: true)
    }

    // ── 4. 日历玻璃板
    let page = CGRect(x: S * 0.246, y: S * 0.392, width: S * 0.402, height: S * 0.402)
    let pagePath = ctx.roundedPath(page, page.width * 0.206)
    let pageLightTop = CGPoint(x: page.minX, y: page.maxY)
    let pageLightBottom = CGPoint(x: page.maxX, y: page.minY)

    // 装订环：画在纸前面，下半截被纸盖住，只露出圆环头
    let tabW = S * 0.036
    let tabLow = S * 0.770
    let tabHigh = S * 0.822
    for cx in (S > 32 ? [0.3405, 0.5535] : [CGFloat]()) {
        let tab = CGRect(x: S * cx - tabW / 2, y: tabLow, width: tabW, height: tabHigh - tabLow)
        let tabPath = ctx.roundedPath(tab, tabW / 2)
        if !isTiny {
            ctx.saveGState()
            ctx.setShadow(offset: CGSize(width: 0, height: -0.008 * S), blur: 0.026 * S, color: color(0x280E60, 0.38))
            ctx.addPath(tabPath)
            ctx.setFillColor(color(0xFFFFFF, 0.88))
            ctx.fillPath()
            ctx.restoreGState()
        } else {
            ctx.addPath(tabPath)
            ctx.setFillColor(color(0xFFFFFF, 0.96))
            ctx.fillPath()
        }
        // 圆柱感：横向明暗，中间最亮两侧偏冷紫
        ctx.saveGState()
        ctx.addPath(tabPath)
        ctx.clip()
        ctx.linear(
            [color(0xDFD2FF, 0.92), color(0xFFFFFF, 1.0), color(0xFFF3E9, 0.94)],
            [0, 0.42, 1],
            from: CGPoint(x: tab.minX, y: tab.midY),
            to: CGPoint(x: tab.maxX, y: tab.midY)
        )
        ctx.restoreGState()
    }

    // 板子的投影：先铺一层不透明的白，投影才有形状
    if !isTiny {
        ctx.saveGState()
        ctx.setShadow(offset: CGSize(width: 0, height: -0.013 * S), blur: 0.050 * S, color: color(0x270B5E, 0.60))
        ctx.addPath(pagePath)
        ctx.setFillColor(color(0xFFFFFF))
        ctx.fillPath()
        ctx.restoreGState()
    } else {
        ctx.addPath(pagePath)
        ctx.setFillColor(color(0xFFFFFF))
        ctx.fillPath()
    }

    // 板面本体：从纯白到极淡的紫，靠这一点点色偏把「一块白卡」变成「一片乳白玻璃」
    ctx.saveGState()
    ctx.addPath(pagePath)
    ctx.clip()
    ctx.linear(
        [color(0xFFFFFF), color(0xFAF6FF), color(0xE6DCFF)],
        [0, 0.55, 1],
        from: CGPoint(x: page.midX, y: page.maxY),
        to: CGPoint(x: page.midX, y: page.minY)
    )
    ctx.restoreGState()

    if !isTiny {
        // 顶部内高光（贴着上沿的一条窄亮带）
        ctx.innerShadow(pagePath, color(0xFFFFFF, 0.75),
                        blur: 0.006 * S, offset: CGSize(width: 0, height: 0.004 * S), bounds: full)
        // 底部内暗部：玻璃厚度的投影，也是白板「立起来」的关键
        ctx.innerShadow(pagePath, color(0x3E1F8C, 0.30),
                        blur: 0.024 * S, offset: CGSize(width: 0, height: -0.007 * S), bounds: full)
    }
    // 顶沿的镜面高光条：从左端淡入、到中段偏右淡出
    if !isTiny {
        ctx.streak(pagePath,
                   from: CGPoint(x: page.minX + page.width * 0.07, y: page.maxY - hair * 1.3),
                   to: CGPoint(x: page.minX + page.width * 0.64, y: page.maxY - hair * 1.3),
                   width: hair * 1.1,
                   [color(0xFFFFFF, 0), color(0xFFFFFF, 1.0), color(0xFFFFFF, 0)],
                   [0, 0.26, 1])
    }
    // 板子边缘：上亮下暗的环光，压在轮廓内侧
    ctx.rim(pagePath, width: hair * 1.1,
            [color(0xFFFFFF, 1.0), color(0xFFFFFF, 0.40), color(0xA98BF0, 0.22)],
            [0, 0.5, 1], from: pageLightTop, to: pageLightBottom, inset: true)

    // ── 5. 日期点阵：玻璃上的小凸点
    let accentIndex = 4
    let dots: [(CGFloat, CGFloat)] = isTiny
        ? [(0.320, 0.660), (0.574, 0.660), (0.320, 0.528), (0.574, 0.528)]
        : [(0.318, 0.696), (0.447, 0.696), (0.576, 0.696),
           (0.318, 0.606), (0.447, 0.606), (0.576, 0.606),
           (0.318, 0.516), (0.447, 0.516), (0.576, 0.516)]
    let dotR = (isTiny ? 0.032 : 0.0215) * S
    for (i, d) in dots.enumerated() {
        let c = CGPoint(x: S * d.0, y: S * d.1)
        let disc = CGPath(ellipseIn: CGRect(x: c.x - dotR, y: c.y - dotR,
                                            width: dotR * 2, height: dotR * 2), transform: nil)
        if i == accentIndex {
            // 今天：橙色的那颗，带一圈柔和光晕，是整枚图标的视觉焦点
            ctx.radial([color(0xFF7A45, 0.30), color(0xFF7A45, 0.0)], [0, 1],
                       center: c, radius: dotR * 2.2)
            ctx.addPath(disc)
            ctx.setFillColor(color(0xFF5F33))
            ctx.fillPath()
            ctx.radial([color(0xFFC182, 0.95), color(0xFF7A3F, 0.0)], [0, 1],
                       center: CGPoint(x: c.x - dotR * 0.20, y: c.y + dotR * 0.24), radius: dotR * 1.2)
            if !isTiny {
                ctx.addPath(CGPath(ellipseIn: CGRect(x: c.x - dotR * 0.48, y: c.y + dotR * 0.12,
                                                     width: dotR * 0.62, height: dotR * 0.46), transform: nil))
                ctx.setFillColor(color(0xFFFFFF, 0.62))
                ctx.fillPath()
            }
        } else {
            // 普通日：磨砂凸点 —— 平涂为主，只在上沿留一条窄高光，别做成发光珠子
            ctx.addPath(disc)
            ctx.setFillColor(color(0xB6A0EE, 0.96))
            ctx.fillPath()
            if !isTiny {
                ctx.addPath(CGPath(ellipseIn: CGRect(x: c.x - dotR * 0.40, y: c.y + dotR * 0.10,
                                                     width: dotR * 0.52, height: dotR * 0.36), transform: nil))
                ctx.setFillColor(color(0xFFFFFF, 0.52))
                ctx.fillPath()
            }
        }
    }

    // ── 6. 橙色对话气泡：压在板子上，是第二层玻璃
    let bub = CGRect(x: S * 0.468, y: S * 0.203, width: S * 0.376, height: S * 0.210)
    let bubR = bub.height * 0.42
    let bubBody = CGPath(roundedRect: bub, cornerWidth: bubR, cornerHeight: bubR, transform: nil)
    // 尾巴：从左下角伸出去，尖端朝左下。
    // 注意：必须和圆角矩形做并集，不能简单 addPath —— 两条轮廓重叠时，
    // 后面 used even-odd 的内阴影会把重叠区当成「外面」，直接糊出一块黑三角。
    let tail = CGMutablePath()
    let t0 = CGPoint(x: bub.minX + bub.width * 0.075, y: bub.minY + bub.height * 0.180)
    let tip = CGPoint(x: bub.minX + bub.width * 0.058, y: bub.minY - bub.height * 0.272)
    let t2 = CGPoint(x: bub.minX + bub.width * 0.342, y: bub.minY + bub.height * 0.019)
    tail.move(to: t0)
    tail.addCurve(to: tip,
                  control1: CGPoint(x: t0.x - bub.width * 0.010, y: t0.y - bub.height * 0.112),
                  control2: CGPoint(x: tip.x - bub.width * 0.048, y: tip.y + bub.height * 0.104))
    tail.addCurve(to: t2,
                  control1: CGPoint(x: tip.x + bub.width * 0.104, y: tip.y + bub.height * 0.128),
                  control2: CGPoint(x: t2.x - bub.width * 0.083, y: t2.y - bub.height * 0.008))
    tail.closeSubpath()
    let bubPath = bubBody.union(tail)

    // 橙色透过玻璃：气泡下方先晕一圈暖光，玻璃才是「透光的」而不是贴上去的
    if !isTiny {
        ctx.saveGState()
        ctx.addPath(plate)
        ctx.clip()
        ctx.radial([color(0xFF7A45, 0.20), color(0xFF7A45, 0.06), color(0xFF7A45, 0)],
                   [0, 0.55, 1],
                   center: CGPoint(x: bub.midX, y: bub.midY),
                   radius: bub.width * 0.92)
        ctx.restoreGState()
    }

    if !isTiny {
        ctx.saveGState()
        ctx.setShadow(offset: CGSize(width: 0, height: -0.018 * S), blur: 0.052 * S, color: color(0x5E1800, 0.56))
        ctx.addPath(bubPath)
        ctx.setFillColor(color(0xFF7A45))
        ctx.fillPath()
        ctx.restoreGState()
    }

    // 气泡本体：上暖亮、下橙深，半透一点让底下的板子透出来
    ctx.saveGState()
    ctx.addPath(bubPath)
    ctx.clip()
    ctx.linear(
        [color(0xFFAE6E, 0.96), color(0xFF7A40, 0.96), color(0xEC4F22, 0.95)],
        [0, 0.55, 1],
        from: CGPoint(x: bub.minX + bub.width * 0.15, y: bub.maxY),
        to: CGPoint(x: bub.maxX, y: bub.minY)
    )
    ctx.restoreGState()

    if !isTiny {
        // 顶部内反光（玻璃被照亮的那条边）
        ctx.innerShadow(bubPath, color(0xFFF6EA, 0.66),
                        blur: 0.016 * S, offset: CGSize(width: 0, height: 0.008 * S), bounds: full)
        // 底部内暗部（厚度）
        ctx.innerShadow(bubPath, color(0x7A2800, 0.30),
                        blur: 0.020 * S, offset: CGSize(width: 0, height: -0.006 * S), bounds: full)
        // 左上角一道小而锐的高光：玻璃反光的「点」，不是整片的雾
        ctx.saveGState()
        ctx.addPath(bubPath)
        ctx.clip()
        ctx.radial([color(0xFFFFFF, 0.30), color(0xFFFFFF, 0)], [0, 1],
                   center: CGPoint(x: bub.minX + bub.width * 0.22, y: bub.maxY - bub.height * 0.16),
                   radius: bub.height * 0.50)
        ctx.restoreGState()
    }
    if !isTiny {
        ctx.streak(bubPath,
                   from: CGPoint(x: bub.minX + bub.width * 0.10, y: bub.maxY - hair * 1.4),
                   to: CGPoint(x: bub.minX + bub.width * 0.72, y: bub.maxY - hair * 1.4),
                   width: hair * 1.4,
                   [color(0xFFFFFF, 0), color(0xFFF2E2, 0.85), color(0xFFFFFF, 0)],
                   [0, 0.30, 1])
    }
    ctx.rim(bubPath, width: hair * 1.2,
            [color(0xFFF0DC, 0.98), color(0xFFD8B0, 0.30), color(0xFF9C6A, 0.02)],
            [0, 0.45, 1],
            from: CGPoint(x: bub.minX, y: bub.maxY),
            to: CGPoint(x: bub.maxX, y: bub.minY),
            inset: true)

    // 气泡里的说话点（小尺寸降到两点，三点会糊成一条白杠）
    let innerR = (isTiny ? 0.029 : 0.0195) * S
    let dotY = bub.midY - bub.height * 0.02
    let dotXs: [CGFloat] = isTiny
        ? [bub.midX - bub.width * 0.115, bub.midX + bub.width * 0.115]
        : [bub.midX - bub.width * 0.20, bub.midX, bub.midX + bub.width * 0.20]
    for dx in dotXs {
        if !isTiny {
            ctx.radial([color(0xFFFFFF, 0.34), color(0xFFFFFF, 0.0)], [0, 1],
                       center: CGPoint(x: dx, y: dotY), radius: innerR * 2.4)
        }
        ctx.addPath(CGPath(ellipseIn: CGRect(x: dx - innerR, y: dotY - innerR,
                                             width: innerR * 2, height: innerR * 2), transform: nil))
        ctx.setFillColor(color(0xFFFFFF, 0.97))
        ctx.fillPath()
    }
}

// MARK: - 渲染

func render(size: CGFloat) -> Data {
    let pixels = Int(size)
    guard let ctx = CGContext(
        data: nil,
        width: pixels,
        height: pixels,
        bitsPerComponent: 8,
        bytesPerRow: 0,
        space: CGColorSpaceCreateDeviceRGB(),
        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
    ) else { fatalError("无法创建绘图上下文") }

    drawIcon(in: ctx, size: CGFloat(pixels))

    guard let image = ctx.makeImage() else { fatalError("无法生成图像") }
    let rep = NSBitmapImageRep(cgImage: image)
    rep.size = NSSize(width: pixels, height: pixels)
    guard let data = rep.representation(using: .png, properties: [:]) else { fatalError("无法编码 PNG") }
    return data
}

// MARK: - 入口

let args = CommandLine.arguments
let outDir = URL(fileURLWithPath: args.count > 1 ? args[1] : ".")
let fm = FileManager.default
try? fm.createDirectory(at: outDir, withIntermediateDirectories: true)

let iconset = outDir.appendingPathComponent("AppIcon.iconset")
try? fm.removeItem(at: iconset)
try fm.createDirectory(at: iconset, withIntermediateDirectories: true)

// iconutil 要求的固定文件名 → 像素尺寸
let jobs: [(String, Int)] = [
    ("icon_16x16.png", 16),
    ("icon_16x16@2x.png", 32),
    ("icon_32x32.png", 32),
    ("icon_32x32@2x.png", 64),
    ("icon_128x128.png", 128),
    ("icon_128x128@2x.png", 256),
    ("icon_256x256.png", 256),
    ("icon_256x256@2x.png", 512),
    ("icon_512x512.png", 512),
    ("icon_512x512@2x.png", 1024),
]

for (name, px) in jobs {
    let data = render(size: CGFloat(px))
    try data.write(to: iconset.appendingPathComponent(name))
}

let big = render(size: 1024)
try big.write(to: outDir.appendingPathComponent("icon-1024.png"))

// MARK: - 多尺寸对照表（浅色 / 深色底，检查小尺寸辨识度）

func makeSheet(to url: URL) {
    let W: CGFloat = 1240
    let H: CGFloat = 900
    guard let ctx = CGContext(
        data: nil, width: Int(W), height: Int(H), bitsPerComponent: 8, bytesPerRow: 0,
        space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
    ) else { return }

    // 三段背景：浅色 / 深色 / 彩色（模拟壁纸，看玻璃在彩色背景上的表现）
    let band = H / 3
    ctx.setFillColor(color(0xF2F2F5))
    ctx.fill(CGRect(x: 0, y: band * 2, width: W, height: band))
    ctx.setFillColor(color(0x1C1A22))
    ctx.fill(CGRect(x: 0, y: band, width: W, height: band))
    ctx.saveGState()
    ctx.addRect(CGRect(x: 0, y: 0, width: W, height: band))
    ctx.clip()
    ctx.linear([color(0x2B6CFF), color(0xB14BFF), color(0xFF8A3D)], [0, 0.55, 1],
               from: CGPoint(x: 0, y: 0), to: CGPoint(x: W, y: band))
    ctx.restoreGState()

    let sizes: [CGFloat] = [256, 128, 64, 32, 16]
    let centers: [CGFloat] = [190, 470, 680, 840, 960]

    for row in 0..<3 {
        let rowCenterY = H - band * CGFloat(row) - band / 2
        for (i, s) in sizes.enumerated() {
            ctx.saveGState()
            ctx.translateBy(x: centers[i] - s / 2, y: rowCenterY - s / 2)
            drawIcon(in: ctx, size: s)
            ctx.restoreGState()
        }
    }

    guard let image = ctx.makeImage() else { return }
    let rep = NSBitmapImageRep(cgImage: image)
    if let data = rep.representation(using: .png, properties: [:]) {
        try? data.write(to: url)
    }
}

makeSheet(to: outDir.appendingPathComponent("preview-sheet.png"))

print("✓ 图标已渲染：\(outDir.path)")
