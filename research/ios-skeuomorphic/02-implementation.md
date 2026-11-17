# 从 UIKit 到 SwiftUI：拟物的技术实现对照

## 一、当年（UIKit）的四件套

### 1. 九宫格切片 —— 拟物控件的核心技能

一张很小的图（甚至 9×9）用 cap insets 切成九块，四个角不拉伸，边和中间拉伸：

```swift
// iOS 6 起
let bg = UIImage(named: "metal-button")?
  .resizableImage(withCapInsets: UIEdgeInsets(top: 6, left: 6, bottom: 6, right: 6),
                  resizingMode: .stretch)
// iOS 2–5 的旧 API
// image.stretchableImage(withLeftCapWidth: 6, topCapHeight: 6)
```

好处：按钮任意尺寸都保持圆角和高光不糊，圆角处的镜面反射不会被拉成一条。

### 2. 平铺纹理

```objc
view.backgroundColor = [UIColor colorWithPatternImage:[UIImage imageNamed:@"linen"]];
```

亚麻、木纹、皮革都用这个，不必为每种尺寸出图。缺点是纹理密度与屏幕缩放绑定，
到 @3x 时代必须重出。

### 3. UIAppearance 批量换肤

```swift
UISegmentedControl.appearance().setBackgroundImage(bg, for: .normal, barMetrics: .default)
UISlider.appearance().setThumbImage(thumb, for: .normal)
```

当年做「全局金属风」主要靠它，一次性替换系统控件皮肤。

### 4. 内阴影靠 mask，不靠 API

UIKit 也没有 inner shadow，做法是「画一个模糊的描边，再用渐变遮罩裁掉一半」：

```swift
Circle()
  .stroke(Color.black.opacity(0.5), lineWidth: 4)
  .blur(radius: 4)
  .offset(x: 2, y: 2)
  .mask(Circle().fill(LinearGradient(colors: [.black, .clear],
                                     startPoint: .top, endPoint: .bottom)))
```

这个思路到今天没变。

## 二、今天（SwiftUI）的对应表

| 当年手段 | SwiftUI 写法 | 备注 |
|---|---|---|
| `resizableImage(withCapInsets:)` | `Image(...).resizable(capInsets:resizingMode:)` | 行为一致，矢量图（PDF/SVG）更好 |
| `UIColor(patternImage:)` | `ImagePaint(image:scale:)` 当 ShapeStyle | 支持平铺 |
| `UIAppearance` | 自定义 `ButtonStyle` / `LabelStyle` + Environment | 比 UIAppearance 可控 |
| CALayer 内阴影 | `overlay` + `mask` + `LinearGradient` | 没有原生 inner shadow |
| `box-shadow` 多层 | 连续多个 `.shadow()` | 注意顺序与性能 |
| `backdrop-filter: blur()` | `UIVisualEffectView` / `.glassEffect()`（iOS 26+） | 大面积极贵，见下 |
| 木纹/色散 | `Canvas` 或 Metal shader（`.layerEffect`，iOS 17+） | 换肤与深色模式走这条路 |

## 三、性能红线

| 做法 | 代价 |
|---|---|
| 滚动列表里用 `backdrop-filter` / `glassEffect` | 离屏渲染，iPhone 上很容易掉到 30fps |
| 每个 cell 叠 3 层以上 shadow | 同上，建议预烘焙成一张位图 |
| 全屏 `blur(radius: 40)` | 一帧就是几十毫秒，只在静态页面用 |
| 用 `drawingGroup()` 合批 | 能救回一些，但会失去文本子像素渲染 |

经验值：装饰性材质**静态化**（画一次、缓存），只有被手指按住的那个控件才实时算高光。

## 四、深色模式：不是反色

拟物世界有光源，夜里应该是「关灯 + 屏幕更亮」，不是把所有像素取反：

- 底材换成暗色木/深色金属，纹理保留但降对比
- 磷光屏、LED 在暗环境里**提高**亮度与辉光（`shadow` 做 bloom）
- 缝线、铜条改为低饱和暖色，避免夜间刺眼

实现上把材质参数化：`Material(base: .wood, tone: .night, lightAngle: .top)`，
而不是准备两套图。

## 五、可访问性（拟物最容易翻车的地方）

- **对比度**：纹理底上的文字至少 4.5:1，必要时给文字加极淡的描边或压暗底衬
- **动态字体**：液晶/点阵字体不能缩放，正文必须走系统字体；仪表盘数字可以固定尺寸但要有 VoiceOver 读法
- **Reduce Motion**：关掉摆窗、惯性、翻页，只保留淡入淡出
- **命中区**：自绘的小灯、小旋钮，视觉 12pt，命中区必须补到 44pt

## 六、审核相关

- App Store 4.2「minimum functionality」：整包只有一个 WKWebView 会被拒
- 必须有原生面：日历权限、本地通知、Widget、快捷指令，至少占两项
- 拟物界面本身不违反任何规则，苹果近两年自己的 App 也在回潮

## 七、对本项目的具体映射

`cal-app/web/skeuo.html` 里的效果逐条对应：

| HTML/CSS | iOS 端做法 | 复用度 |
|---|---|---|
| 木纹 `background-image` + 渐变 | 高分辨率图 + `ImagePaint`，或 shader | 高，图可直接用 |
| 铜杆、麻绳（PNG 精灵） | 直接复用 PNG | 高 |
| 绿磷光屏 + 扫描线 | `Canvas` 画扫描线 + `.shadow` 做 bloom | 中，需重写 |
| LED 灯阵 | SwiftUI 小圆点 + 状态驱动 | 中 |
| 整窗玻璃 `backdrop-filter` | `glassEffect`（iOS 26+） | 低，手机上不建议整屏 |
| 拖窗摆动 | 上滑抽屉替代 | 需重设计 |
