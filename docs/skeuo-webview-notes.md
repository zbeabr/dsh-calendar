# 全拟物外观（WebView 版）· 交接说明

> 版本：1.2.3 / build 8。这一版只加外观层，**Liquid Glass 的绘制代码与所有产品功能未改动**。

## 为什么换成 WebView

上一轮的做法是「拿 AppKit 的 CGContext 照着 HTML 参考稿逐笔重画」，结果木纹、拉丝金属、
阴影始终对不上。查过拟物时代的做法后确认：**当年的真实感来自美术预先烘焙的位图资产，
不是运行时算噪声**。两套渲染引擎（浏览器 CSS/SVG `feTurbulence` vs AppKit Quartz）
永远不可能输出同一份材质。

所以这一版直接用 `WKWebView` 承载参考稿本身：渲染引擎一致，材质、木纹、旧版立体红绿灯、
LCD 双屏、黄铜挂杆、刻字、呼吸灯全部与 `dist/ui-skeuo-beta.html` 相同。

## 文件清单

| 文件 | 作用 |
|---|---|
| `cal-app/web/skeuo.html` | App 内嵌版界面。由 `dist/ui-skeuo-beta.html` 只读派生：保留全部 CSS 材质与 SVG 纹理函数，只改页面骨架（铺满窗口）、加 JS 桥、加红绿灯 hover 反馈、去掉演示桌面/说明文字 |
| `cal-app/web/wood-sprite.png` | 预烘焙木纹贴图（760×216，4 块 × 54px）。运行时只贴图、不再算 `feTurbulence`，用于根治滚动卡顿 |
| `cal-app/App.swift` | 新增 `import WebKit`、若干属性、窗口菜单切换项、快照分支，以及文件末尾的 `SkeuoDragView` + `AppDelegate` 的 WebView 扩展。**现有玻璃绘制与产品逻辑一行未删改** |
| `cal-app/build.sh` | `swiftc` 加 `-framework WebKit`；`skeuo.html` 打进 `Contents/Resources` 并覆写到已安装 App |
| `cal-app/Info.plist` | build 7 → 8（短版本仍 1.2.3，未发布、未移动任何 tag） |

`dist/` 下的参考稿、beta 说明、staging 目录按约定**原样未动**（生成内嵌版时只读）。

## 外观切换

- 菜单：**窗口 → 切换到全拟物外观 / 切换到 Liquid Glass 外观**
- 偏好：`app.dsh.calendar appearanceStyle` = `skeuo` / `glass`，`UserDefaults` 持久化
- 自检覆盖：环境变量 `DSH_CAL_SKEUO=1` / `0`
- 切换只做 `window.contentView` 换壳 + 系统红绿灯显隐 + 同步轮询启停。
  玻璃界面始终留在 `shell.slot` 里继续跑，草稿、解析、写入、离线队列都不重建。
  **两个外观都保留，可来回切。**

## JS ↔ 原生桥（全部映射到既有动作，不新增产品功能）

| 方向 | 消息 | 落到哪 |
|---|---|---|
| JS → Swift | `submit {text}` | 写进既有 `input` 后调既有 `addEvent()`，解析/写入/冲突检查全复用 |
| JS → Swift | `delete {uid}` | 既有 `deleteItem(_:)` |
| JS → Swift | `shift {uid, seconds}` | 既有 `shiftItem(_:by:)` |
| JS → Swift | `window {close/mini/zoom}` | `NSWindow` 标准动作 |
| Swift → JS | `dshRender({events, sys, status})` | 真实日程、系统提示、已连接 / 模型已接入 |
| Swift → JS | `dshSys(text)` / `dshSwing()` | 提示条 / 拖动时木板轻摆 |

Swift 侧每 0.6 秒**只读** `agenda` / `agendaNote` / `statusLabel` / `hintLabel` / `offline` /
`modelEnabled` 等既有状态，内容变了才推给 WebView。因此不需要在任何产品逻辑函数里插钩子。

## 验证记录（分清「亲手跑过」和「没跑过」）

**亲手跑过**
- `swiftc` arm64 / x86_64 双架构，链接 AppKit + WebKit，exit=0、无警告
- `build.sh` 成功，`codesign -v --deep --strict` 通过，通用二进制 `x86_64 arm64`
- 装机副本内嵌 HTML 与源码 `cal-app/web/skeuo.html` **md5 一致**
- `--snapshot` 导出两种外观真机画面：拟物版是完整金属机身 + 真实课表日程 + SYS 真实告警；
  玻璃版是原样的日期大字 / 粉色下拉 / 玻璃输入卡 / 按日期分组日程，**没有任何拟物元素渗入**
- 用 `UserDefaults` 驱动两种外观各自截图，与 env 强制的对照组一致（两个分支都验证过）
- `--dump-menu` 确认菜单项存在且 `target=App` → `toggleAppearance`
- `npm test` 本机 / `TZ=UTC` / `TZ=America/New_York` 三套全绿（168 + 39 + 23 + 20 + 305）

**没跑过（不要当成已验证）**
- **鼠标真实点击菜单项**：用系统事件模拟点击被辅助功能权限拒绝（-10004）。
  菜单绑定、切换方法、两个分支的渲染都验证过，但「点下去 → AppKit 派发 selector」这一下需人工点一次。
- 输入框回车 / 「挂上」、木板删除钮、右键顺延、红绿灯点击的**实际 GUI 交互**没跑过自动化；
  桥接代码已编译通过且映射到既有方法，行为要人工试。
- 呼吸灯动画、拖动窗口木板轻摆、窗口拖动手感、以及「把别的窗口放到日历后面看间隙模糊」。
  离屏快照只能拍到静态帧，且 `backdrop-filter` 在 WebView 里只能模糊页面内那个模拟后窗，
  **不会模糊后面的真实应用窗口**（这是 WebView 方案与原生 `NSVisualEffectView` 的差别）。

## 人工冒烟清单

| # | 检查点 | 期望 | 结果 |
|---|---|---|---|
| 1 | 窗口菜单点「切换到全拟物外观」 | 整窗变成金属老电脑，系统红绿灯消失，只剩自绘旧版立体灯 |  |
| 2 | 再点一次切回 Liquid Glass | 原界面完整回来，日期/下拉/输入卡/日程/清空都在 |  |
| 3 | 两种外观各输入一句并回车 | 走同一套解析写入，日历里只多**一条** |  |
| 4 | 拟物输入框悬停/回车 | 荧光绿等宽字、「挂上」按钮可点、SYS 小屏显示真实提示 |  |
| 5 | 木板悬停 | 右侧出现黄铜删除钮，与日历标签不重叠 |  |
| 6 | 木板右键 | 出「推迟 30 分钟 / 1 小时 / 明天」菜单，选完真的改期 |  |
| 7 | 鼠标移到左上角三颗灯 | 亮起并浮出 × / − / +，点击分别关窗 / 最小化 / 缩放 |  |
| 8 | 右上角两颗 LED | 「已连接」「模型已接入」文字在，缓慢呼吸；开「减少动态效果」时静止 |  |
| 9 | 重启 App | 外观记住上次选择；草稿与离线队列不丢 |  |
| 10 | 关于面板 | 版本 1.2.3（8） |  |

## 快照复现命令

```sh
BIN="$HOME/Applications/DSH 日历.app/Contents/MacOS/DSHCalendar"
DSH_CAL_SKEUO=1 DSH_CAL_SNAPSHOT_DELAY=9 "$BIN" --snapshot /tmp/skeuo.png
DSH_CAL_SKEUO=0 DSH_CAL_SNAPSHOT_DELAY=9 "$BIN" --snapshot /tmp/glass.png
```

## 发版状态

本轮**未 push、未打 tag、未发 Release**，已发布 tag 一个没动。

## 第二轮修复（2026-11-08，按所有者反馈）

| 反馈 | 做法 |
|---|---|
| 木板右边标签看不清 | 标签字号 10.5 → 12、提亮到 `#f5dcab`、加粗，加深色底衬与刻痕阴影 |
| 上下滑动卡、出现滚动条 | 见下「卡顿的根治」 |
| 没网络 / 模型没接入要亮红灯 | `status` 增加 `modelOnline`；两颗 LED 各自在离线 / 未接入时切 `.led.red`（仍按 2.6s 呼吸），文案变「离线」「模型未接入」。`DSH_CAL_SNAP_OFFLINE=1` 可导出红灯自检快照 |
| 间隙没有高斯模糊 | 所有者确认「现在挺好的，就这么搞」，**保持无模糊**，不加回去 |

### 卡顿的根治：把纹理烘焙成资产

上一版每块木板运行时要算 4 层 `feTurbulence`（木纹噪声、色斑、年轮、结疤）外加
200 多条 SVG 路径，8 块木板就是 30+ 次噪声运算，滚动时逐帧重绘必然卡。
按拟物时代「美术先出位图资产、代码只贴图」的做法，用 headless Chrome 把 4 种木纹
**预烘焙**成 `wood-sprite.png`，运行时每块木板只用一张 `background-image` 贴图：
DOM 从约 200 个节点降到 7 个，运行时噪声运算降到 0。

同时：
- 去掉 `.plank-area` 的 `backdrop-filter`（滚动时整区实时高斯模糊是第二个重绘源）；
  后方模拟窗口本身已预模糊，间隙仍是柔光，按所有者决定不恢复模糊
- 隐藏滚动条：`::-webkit-scrollbar` + `scrollbar-width:none`
- 每块木板独立合成层（`translateZ(0)` / `will-change`），滚动只移动图层
- `dshRender` 按日程签名比对：SYS 文案变化时**不再重建木板**，并保留 `scrollTop`
  （此前状态推送会连带重建全部木板、把滚动位置重置，手感一顿一顿）

> 贴图是静态资产，滚动是否真的顺滑**离屏快照验证不了**，仍需人工滚动确认。

### 本轮真机验证补充

- `--snapshot` 三张：正常拟物（贴图木纹 + 绿/琥珀灯 + 真实课表）、
  `DSH_CAL_SNAP_OFFLINE=1` 红灯（两颗 LED 变红、文字「离线 / 模型未接入」）、玻璃对照（原界面完好）
- 装机副本 `codesign -v --deep --strict` 通过；源码与装机资源、二进制 md5 一致
- `npm test` 本机 / UTC / 纽约三套全绿（168+39+23+20+305）
- 构建曾被环境安全策略拦在签名处，留下 `DSHCalendar.cstemp` 幽灵条目导致 seal 失效；
  已用「移走坏签名清单 → 干净重签 stage → 同步 7 个明确路径 → 复校」修复，**未绕过策略**
