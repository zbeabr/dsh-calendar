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

---

## 第九轮：删除确认 / 输入命中 / 底部白底 / 绳尾 / 冲突误报（2026-11-09，build 26）

只动 `cal-app/web/skeuo.html`、`cal-app/App.swift`、`cal-app/Info.plist`。
玻璃模式绘制、产品写入/删除链路、窗口菜单外观切换均未改。

| 反馈 | 做法 |
|---|---|
| 按删除键没反应 | 点木板选中（黄铜描边 + 「已选中」铭牌 + SYS 提示），`Backspace` / `Delete` 触发摘下；没选中也回一句 SYS 提示。叉叉按钮改为常驻半亮（`opacity:.62`），不再只靠 hover 才出现 |
| 要二次确认 | 弹层全在页面内（`#confirm`，金属铭牌 + 绿屏 + 金属钮），叉叉与键盘删除共用；`Enter` 摘下、`Esc` / 点遮罩 / 「取消」反悔。**确认之后才 `post({type:'delete'})`**，桥接契约不变 |
| 对话框整块点不进输入 | `.well input` 改成 `position:absolute;inset:0` 铺满整块绿屏（每个像素都是 input）；点击接管范围从 `.compose` 扩到整个 `.chrome`，并补 `click` 兜底窗口未激活时的首点 |
| 滑到底出现白底 | `html/body` 画布改成 `#2b2926`（原来是 `#d6d2c9` 浅米白），Swift 侧同步设 `WKWebView.underPageBackgroundColor` —— 回弹露出的两层一起压暗 |
| 最后一块木板绳子要露尾巴 | `buildRopes()` 末段改为只垂到末板下方 76px 收口（原来一直拖到文档底部），末端加 `.rope-tail`：缠紧的麻线结 + 三色散纤维 |
| SYS 把首尾相接说成重复 | 根子是拟物模式的输入框在 WebView 里，原生 `input.string` 恒空 → `checkConflict()` 无命中时提前 `return`，上一句的「这个时间和…重叠」永远不清除。改为进函数先按前缀精确清、清空输入时 `resetPreview()`；判定改半开区间并给 30 秒容差吃掉 CalDAV 秒级抖动 |
| 木板比窗口窄一点 | `--plank-inset:16px`；`.plank` 用 `left/right` 内收，绳子 x 与铆钉位置读同一个变量（孔、绳、板不错位） |
| logo 放大下移居中 | 铭牌从 `.titlebar` 提出来做 `.chrome` 的直接子元素，在「窗口顶边 → 绿屏上沿」64px 金属带里 flex 居中，字号 19 → 24 |

### 自检开关（只在 `--snapshot` 下生效，不改产品状态）

- `DSH_CAL_SNAP_SCROLL_BOTTOM=1`：快照前 `window.dshScrollTo(1e9)` 滚到最底，核对绳尾与底色
- `DSH_CAL_SNAP_JS="<js>"`：快照前跑一段 JS，用来把交互态（选中 / 确认弹层 / 命中测试）拍出来

### 验证边界

- 真机快照逐项核对：常态、滚到底、选中、二次确认、点击命中探针；
  探针实测绿屏 5 个取样点全部命中 `phrase`，SYS 条 / 「新建日程」标签 / 灯阵点击后 `activeElement` 均为输入框（`true/true/true`）；
  叉叉弹确认 `true`、取消后关闭 `true`、木板数 `10->10`（没有误删）
- 冲突判定把 `App.swift` 里 `overlaps()` 的函数体原样抽出编成 Swift 小程序，
  5 组用例（首尾相接正反向 / 真重叠 / 秒级抖动 / 完全包含）全 PASS。
  **「先造一个真冲突、再改成不冲突」的端到端场景未在真实日历上复现**，别当已验证
- 仍未人工验证：真实鼠标点击菜单、真实键盘按键手感、滚动手感、呼吸动感、减少动态效果开关

---

## 第十轮：SYS 误报解析错误 / 确认卡片点不了（2026-11-09，build 27）

只改 `cal-app/App.swift`、`cal-app/Info.plist`。`skeuo.html`、后端、玻璃模式、产品功能全部未动。

### 一、SYS 栏「明明认出了时间却报『没能从这句话里找到时间』」

**不是「没有地点」**。灯阵里地点/重复/提醒灭着是对的，句子里本来就没写。

根子在 Swift：`applyPreview()` 的**成功分支完全没碰 `hintLabel`**，而失败分支
`resetPreview(message:error, isError:true)` 会把错误写进 `hintLabel`。打字过程中
某一中间态（例如只写了「吃麻辣烫」）解析失败 → 错误留在 `hintLabel`；随后补上时间、
解析成功 → 灯阵和 SYS 的识别文字更新了，但那条错误还在。`pushSkeuoState()` 取
`[agendaNote, statusLabel, hintLabel]` 里第一个非空值当 `sys` 推给 WebView，
JS 的 `updateSys()` 又把它接在识别文字后面 —— 就成了「`> 吃麻辣烫 · 11:35–12:05 ·
学习 · 没能从这句话里找到时间…`」。上一轮加的 `clearStaleConflictHint()` 只清
「这个时间和…」前缀的冲突告警，管不到解析错误。

修法：新增 `parseErrorText` 记住最近一次失败文案；`resetPreview` 只在 `isError` 时记；
`applyPreview` 成功分支先调 `clearStaleParseHint()` 精确撤掉（按文案相等匹配，
不误伤「已删除 / 美化已开 / 冲突告警」），再走 `checkConflict()`。

### 二、确认卡片「根本无法点击」

DOM 层完全正常：真机探针 `elementFromPoint` 在「取消」/「摘下」中心分别命中
`confirmNo` / `confirmYes`，`pointer-events` 都是 `auto`，z-index 200 在最上层。

真正元凶是原生 `SkeuoDragView.hitTest`：

```swift
// 旧
if point.x > 100 && point.x < bounds.width - 160 { return self }
```

重写 `hitTest` 会跳过系统自带的 bounds 检查，而这里**只判 x、完全不判 y**。
drag 的 frame 明明只有顶部 34px，却把窗口中下部 x∈(100, 600) 的点击全吞了：

- 木板叉叉 x≈674 > 600 → 放行，所以「点叉叉能弹出确认卡片」
- 确认卡片按钮 x≈416 / 508 落在区间内 → 被吞，所以「卡片点不了」
- 输入框中部 x≈380 也在区间内 → 这正是更早那轮「对话框只有部分区域能点」的同源问题

修法：`hitTest` 补上 y / bounds 判断。AppKit 传进来的 point 在不同调用路径下可能是
父视图坐标系或自身坐标系，两种都换算一遍，只有确实落在这条 34px 标题带内才认领；
标题栏左右两端（红绿灯 / 状态灯）仍按原来的 x 区间放行。

### 三、自检开关补齐（仅 `--snapshot` 生效）

- `DSH_CAL_SNAP_CLICK="x,y"`：用 `NSWindow.sendEvent` 发一次真实鼠标事件
  （CSS 坐标，左上原点），走完整原生命中测试；日志输出 `hitView` 和点击后的 DOM 状态。
  注意 `NSApp.postEvent` 从 CGEvent 转出的事件 `window` 为 nil，实测会被队列丢掉，测不出来。
- `DSH_CAL_SNAP_WAIT=<秒>`：JS 之后多等一会再拍，给「连续两次解析」这类时序留时间。

### 四、验证（亲手跑过）

- 真机 `--hitprobe` 视图树确认没有别的原生覆盖层；DOM 探针确认按钮命中正确
- `DSH_CAL_SNAP_CLICK="416,418"` 日志：
  `hitView=ClickThroughWebView`、`CLICK AFTER {"clicks":["del","confirmNo"],"on":false}`
  —— 命中测试落到 WebView，真实事件命中「取消」并关闭弹层
- `DSH_CAL_SNAP_CLICK="380,17"`（标题栏中部）：确认拖拽区仍归 `SkeuoDragView`
- 时序复现：先输入「吃麻辣烫」（CLI 实测返回该报错），2.6s 后改成
  「中午十一点三十五吃麻辣烫，半小时」（实测 11:35–12:05）。`DSH_CAL_SNAP_WAIT=6`
  截图里 FINAL 只含识别文字 + 当前真实冲突提示，**不再含「没能从这句话里找到时间」**；
  SYS 变化日志显示报错出现后被成功解析覆盖
- 三时区 `npm test` 全绿（168+39+24+20+305）；`build.sh` 成功、签名校验通过

**未验证**：真实人手用鼠标/触控板点按钮、拖窗手感（自检用的是合成事件走同一条
`sendEvent → hitTest` 链路）、滚动手感、呼吸动感、减少动态效果开关。

---

## 第十一轮：对话框「中间一大块点不了、只能点左边」（2026-11-09，build 28）

只改 `cal-app/App.swift`、`cal-app/web/skeuo.html`、`cal-app/Info.plist`。
后端、玻璃模式、产品写入/删除链路、UI 切换均未改。**`dist/` 下历史发行包一个没动。**

### 一、先取证：DOM 层完全正常

- 真机 `--hitprobe`：绿屏 1590 个采样点全部命中 `input`，`bad:[]`，`wellRefocus:true`
- 扩展到 12×5 网格再拍一张：整块绿屏全是 input
- 11 点真实点击探针（x = 30/80/150/280/380/500/620/660，y=111，外加 y=50/200/300）：
  **每个点 `hitView=ClickThroughWebView`**，页面收到 mousedown/mouseup/click，`active=phrase`

也就是说 build 27 在当前装机版里是好的。用户看到「只能点左边、中间一大块点不了」
与更早那版 `x∈(100,600)` 被吞的特征完全吻合；本机上还有 `dist/` 里 build 1–9 的
历史 `.app`，macOS 可能把启动请求转给已运行旧进程 / 打开旧副本。
**但不管是不是旧进程，本轮把根子彻底拆掉，不再靠坐标系换算。**

### 二、根因：重写 `hitTest` 这件事本身就是错的

`SkeuoDragView` 之前重写 `hitTest` 是为了让标题栏左右两端（红绿灯 / 状态灯）
的点击放行给 WebView。重写会**跳过 AppKit 自带的 bounds 检查**，于是必须自己把
`point` 换算成正确坐标系；而不同调用路径下 point 可能是父视图坐标、也可能是自身
坐标。一旦换算错，一条 34px 的标题带就能把窗口中下部整片点击吞掉。
上一轮补了 y 判断，但仍在「猜坐标系」，这类问题会反复回来。

**改法：删掉整个自定义 `hitTest`，让 frame 自己说清楚边界。**

```swift
// 旧：frame 全宽 760，靠 hitTest 判 x 放行两端
frame = (0, 686, 760, 34) + 自定义 hitTest
// 新：frame 只占「中间可拖」那一段，两端天然归 WebView，没有任何坐标系换算
frame = (100, 686, 500, 34) + AppKit 自带 hitTest
```

`--hitprobe` 视图树复核：`SkeuoDragView frame=(100.0, 686.0, 500.0, 34.0)`。
标题栏中部 `CLICK css=380,17 → hitView=SkeuoDragView`（拖窗区没被破坏）。

### 三、再加一层与命中测试完全解耦的兜底

`installSkeuoFocusGuard()`：本地 `leftMouseDown` 监视器，在**事件分发之前**执行，
不与任何 hitTest 结果挂钩。点击落在上半部金属板（CSS y < 254，x 在实时窗口宽度内）
时，用 JS 补一记 `input.focus()`（确认弹层打开 / 点按钮 / 状态灯时跳过）。
不吞事件、不动响应链、不写死窗口尺寸。这样即使将来别的原生层又挡住点击，
输入框照样能拿到焦点。

顺带修掉探针暴露的一个小毛病：点「新建日程」标签、SYS 屏、灯阵这类不可聚焦
元素时，浏览器默认会先让 input 失焦、等 click 阶段再补回来，光标闪一下 ——
看起来就像「点中间没进去」。现在 `focusFrom()` 在已聚焦时也 `preventDefault()`，
焦点一帧都不丢。

### 四、自检开关（仅 `--snapshot` 生效）

- `DSH_CAL_SNAP_CLICK="x,y|x,y|..."`：连点多个 CSS 坐标，逐点打印 `hitView` 与页面事件
- `DSH_CAL_SNAP_CLICK_APP=1`：改走 `NSApp.sendEvent`（本地监视器只在这条链上执行），
  用来验证分发前兜底；直接 `win.sendEvent` 会绕过它，测不到那半边
- `DSH_CAL_SNAP_JS`、`DSH_CAL_SNAP_WAIT`、`DSH_CAL_SNAP_SCROLL_BOTTOM` 沿用

### 五、验证（亲手跑过）

- **A** `win.sendEvent` 11 点：全 `ClickThroughWebView`；绿屏 8 点全 `focus=phrase`
- **B** `NSApp.sendEvent` 5 点：`guardLog` 逐点累积 `[[150,111],[380,111],[500,111],[380,50],[380,200]]`，
  `active=phrase` —— 分发前兜底确实在跑
- **F** `--hitprobe`：drag frame 收窄正确，DOM 1590 点全 input，`HIT CLICK {"target":"phrase","focused":true}`
- **G** 确认弹层按钮 `css=416,418`：`click:confirmNo`，弹层被真实点击关闭，截图核对
- **H** 点标签 `380,50`：mousedown / mouseup / click 三阶段 `focus=phrase` 全程不掉，闪烁消失
- **D** 标题栏中部 `hitView=SkeuoDragView`（拖窗区保留）
- **I** 常态真机快照：金属板 / logo / 绿屏 / SYS / 六色灯 / 木板 / 绳尾均正常，无白底错位
- 双架构 `swiftc -typecheck` 通过；三时区 `npm test` 全绿（168+39+24+20+305）；
  `build.sh` 成功；`codesign -v --deep --strict` 通过；`x86_64 arm64`；
  源码与装机 HTML/PNG md5 逐字节一致

### 六、验证边界

- 自检用的是走 `NSWindow.sendEvent` / `NSApp.sendEvent` 的合成事件，与真人手用
  鼠标/触控板点按钮、拖窗手感仍有差别，**未当成人手验证**
- 滚动手感、呼吸动感、减少动态效果开关仍未人工验证
- 用户当前实际打开的是哪一份 `.app` 无法从进程侧确认（沙箱内 `ps` 不可用，
  `pgrep` 无常驻进程）。本机 `~/Applications/DSH 日历.app` 为 build 28；
  `dist/` 下另有 build 1–9 历史包，按红线未动
