import Foundation
import CoreGraphics
import ImageIO

// 只读像素比较：两张 PNG 同一矩形内的平均绝对差。
// y=0 是图片顶部（翻转过坐标系），坐标单位是像素，Retina 截图要 ×2。
func loadRGBA(_ path: String) -> (Int, Int, [UInt8])? {
    guard let src = CGImageSourceCreateWithURL(URL(fileURLWithPath: path) as CFURL, nil),
          let cg = CGImageSourceCreateImageAtIndex(src, 0, nil) else { return nil }
    let w = cg.width, h = cg.height
    var buf = [UInt8](repeating: 0, count: w * h * 4)
    guard let ctx = buf.withUnsafeMutableBytes({ raw in
        CGContext(data: raw.baseAddress, width: w, height: h, bitsPerComponent: 8,
                  bytesPerRow: w * 4, space: CGColorSpaceCreateDeviceRGB(),
                  bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
    }) else { return nil }
    // 不要翻转：CGBitmapContext 左下原点，CGImage 倒立绘制后，
    // buffer 第一行恰好是图片顶部。加 translate/scale 反而会把 y 轴翻过来
    // （实测 y=0 变成图片底部，下半部灰→黑的差被误算成上半部 63/255）。
    ctx.draw(cg, in: CGRect(x: 0, y: 0, width: w, height: h))
    return (w, h, buf)
}

let a = CommandLine.arguments
guard a.count >= 7,
      let (aw, ah, abuf) = loadRGBA(a[1]),
      let (bw, bh, bbuf) = loadRGBA(a[2]),
      let x = Int(a[3]), let y = Int(a[4]),
      let w = Int(a[5]), let h = Int(a[6]) else {
    print("usage: glass-pixel a.png b.png x y w h"); exit(2)
}
guard aw == bw, ah == bh else { print("size mismatch"); exit(2) }

var sum = 0.0, maxDiff = 0.0, n = 0
var aLuma = 0.0, bLuma = 0.0
for yy in y..<(y + h) {
    for xx in x..<(x + w) {
        guard xx >= 0, yy >= 0, xx < aw, yy < ah else { continue }
        let i = (yy * aw + xx) * 4
        let ar: Int = Int(abuf[i]), ag: Int = Int(abuf[i + 1]), ab: Int = Int(abuf[i + 2])
        let br: Int = Int(bbuf[i]), bg: Int = Int(bbuf[i + 1]), bb: Int = Int(bbuf[i + 2])
        aLuma += 0.2126 * Double(ar) + 0.7152 * Double(ag) + 0.0722 * Double(ab)
        bLuma += 0.2126 * Double(br) + 0.7152 * Double(bg) + 0.0722 * Double(bb)
        let dr: Int = abs(ar - br)
        let dg: Int = abs(ag - bg)
        let db: Int = abs(ab - bb)
        let d: Double = Double(dr + dg + db) / 3.0
        sum += d
        if d > maxDiff { maxDiff = d }
        n += 1
    }
}
guard n > 0 else { print("empty region"); exit(2) }
print(String(format: "DIFF=%.3f MAX=%.0f ALUMA=%.1f BLUMA=%.1f N=%d SIZE=%dx%d",
             sum / Double(n), maxDiff, aLuma / Double(n), bLuma / Double(n), n, aw, ah))
