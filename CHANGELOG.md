# 更新日志

记录 DSH 日历的发布变更，最新在上。各版本完整发行说明见 `dist/notes-*.md`。

---

## [未发布 · 本地] 半透明背景重做：去掉系统模糊，直接透出桌面 — 2026-11-11（build 39）

用户实测 build 37/38 的开关「完全不透明，重新搞」。复盘出两个根因，都在我这侧：

1. **运行时点开关根本没生效**。所有验证都是「启动前 `defaults write` 再启动」，
   而真实用法是在设置页点开关。上一版在设置页运行时才调
   `web.setValue(false, forKey:"drawsBackground")`（KVC 私有属性），页面已加载完，
   不会重新生效 —— 用户点完开关看到的仍是不透明 WebView。
2. **系统 `NSVisualEffectView` 把桌面糊成一片均匀色**。壁纸是纯色时，透出来就是
   一片浅灰，视觉上和「不透明的一块板」没有区别。`NSGlassEffectView` 作整窗背景
   更是直接采不到桌面（上一轮已实测）。

**重做**：不再依赖系统材质采样，也不在运行时碰 WebView 私有属性。

- WebView 创建时**一次性**设 `drawsBackground=false` / `underPageBackgroundColor=.clear`；
  开关只切 `underPageBackgroundColor`（公开属性）和网页 `html.liquid-bg` 类。
- 删掉 `NSVisualEffectView` 玻璃层，桌面内容**清晰可辨**地直接透出；网页
  `.plank-area` 只留一层极淡的白色玻璃高光 + 很淡的暗色，不再做 `backdrop-filter`。
- 金属上半部 `.chrome` 保持不透明（用户选的「只木板背后透明」）。
- 设置页第 2 行改名为「半透明背景」，默认关；`Info.plist` 38→39
  （短版本仍 1.3.2，`VERSION=1.3.2-39`）。

**自检**：网页新增 `.glass-probe` 彩色底层图案（只在探针注入时出现），
普通 `takeSnapshot` 就能拍到「木板缝隙里确实有东西」；
`DSH_CAL_SNAP_LIQUID_RUNTIME=1` 在 `didFinish` 后模拟「页面加载完再点开关」。
上一轮加的 `DSH_CAL_SNAP_COMPOSITE=1`（CGWindowListCreateImage）在这台机器当前
环境下拍出纯白图（`screencapture` 也报 could not create image from display），
**屏幕采集不可用，本轮不拿它当证据**；代码保留但不作为验证依据。

验证（亲手跑过）：双架构 `swiftc -typecheck` exit=0、拟物页 script 语法 OK、
`build.sh`、`codesign -v --deep --strict`、`x86_64 arm64`、包内 `skeuo.html`
与源码 sha256 一致；三时区 `npm test` 全绿
（202 解析 + 39 安全 + 13 账号/区域 + 31 CalDAV + 20 模型兜底 +
67 闭集策略 + 36 模型属性 + 386 蓝本），`--audit` 可疑 0/386。
三张普通快照：

```
关：      class=wood16 glass-probe       bodyBg=rgb(43,41,38)   backWindowDisplay=block
开：      class=liquid-bg wood16 glass-probe bodyBg=rgba(0,0,0,0) backWindowDisplay=none
运行时开：与「开」输出完全一致，PNG 字节数同为 1971807
```

关着时缝隙是均匀深灰；打开后是**清晰可辨的蓝/绿/橙/紫/红条纹**（测试图案，
真机换成你的桌面），一眼能看出后面有东西。运行时切换与启动时切换结果字节级一致，
说明第 1 个根因已修掉。

**帧率本轮没有重新测到**：rAF 探针这次 `n=0`（系统暂停了帧回调），不把上一轮数字
冒充本轮结果。上一轮已验证系统玻璃方案为关 17.3ms / 开 16.7ms；本轮去掉了
原生模糊层，理论上不会更慢，但**这一项标为未验证**。

**三层可回滚**：① 设置页关掉开关即回原样（默认关）；
② `zsh <会话工作区>/rollback/switch.sh 38` 整包退回你当前装机的
1.3.2 / build 38（`39` 可切回，脚本已补 38/39 两档）；
③ 本地提交未 push 可 `git revert --no-edit`。四条红线不变。

**未验证**：真机上桌面内容透出的实际观感（当前环境屏幕采集不可用，只能靠彩色
测试图案证明网页根层透明）、真人长时间滚动/拖窗口手感、不同壁纸与外接屏、
设置页真人鼠标点开关手感。**必须 ⌘Q 完全退出 App 再重开**才是 build 39。

---

## [1.3.2] — 2026-11-10（构建号 38）

外部反馈（中国大陆 iCloud 账号 + Apple Silicon）暴露了五个问题，全部核实并修掉。
其中前两个会让新用户**根本用不起来**，第三个会**弄丢能用的密码**。

### 1. 中国大陆 Apple ID 连不上（最严重）

现象：App 专用密码正确，固定 401；把 `baseUrl` 手动改成 `https://caldav.icloud.com.cn/` 就通。

- 根因一：默认地址写死 `caldav.icloud.com`，而中国区数据在 `caldav.icloud.com.cn`
  （云上贵州），是两个后端分区，设置页也没有任何地方能改服务器。
- 根因二：`isTrustedHop` 的 `SHARDED_ZONES` 白名单里**两个域名都写了**，但实现是
  「首尾必须落在同一条 zone 内」，跨条目一律拒绝。所以苹果把请求踢到
  `pXX-caldav.icloud.com.cn` 时，我们判成「重定向到不受信任的地址」并拒绝发送凭据 ——
  白名单写了、实现漏了，还没有用例。
- 修法：
  - `isTrustedHop` 把 Apple 自有 zone 当成一整组判断，跨区放行；
  - `CalDav.discover()` 遇到认证类失败（401/403）自动换另一个区重试一次，
    成功后回调 `onBaseUrlChange`，由上层写回 `config.json`，下次不再试第二遍；
  - 401 / 403 的文案改为带**服务器地址**，并提示中国区入口；两个区都拒绝时直接说
    「密码不对，这里只认 16 位 App 专用密码」。
- 实测（无凭据）：两个域名都存在且分区不同（`x-apple-user-partition` 54 vs 218/232）；
  本机假服务器上「主入口 401 → 换区 207」的路径跑通，回调只触发一次。

### 2. 钥匙串账号大小写不归一，产生重复条目

同一个 Apple ID 写成 `User@x.com` 和 `user@x.com`，会在钥匙串里留两条 `dsh-cal` 记录，
App 与 CLI 可能各读到一条 —— 症状是「命令行诊断正常、GUI 还是 401」。

- `normalizeAccount()`（去空白 + 小写）统一用在读、写、删和配置上；
- 读的时候**先归一化、再按原样兜一次**，老版本按原大小写写进去的记录仍然读得到；
- 写入归一化账号成功之后，顺手删掉「同一个邮箱但大小写不同」的旧条目。

### 3. 密码先落盘、后验证（会弄丢好密码）

`loginHeadless` 原来是 `savePassword()` 再 `listCalendars()`。密码打错时，错的已经
覆盖了钥匙串里原来正确的那个，用户从「能用」直接掉到 401，且旧密码找不回来。

- 改成：格式校验 → `verifyCredentials()` 真连一次 → 成功才写钥匙串。
  失败时明确告知「这次没有写入钥匙串，原来的密码仍然有效」。
- 对 iCloud 账号，保存前校验 **16 位**（`xxxx-xxxx-xxxx-xxxx`）。40 位那种多半是
  设备密码或主密码，直接拒绝并说清去哪生成。自定义 CalDAV 服务端不受这条限制。

### 4. 默认日历被静默改选

`names.includes('学习') ? '学习' : names[0]`：用户的「学习」不在 iCloud 可写列表里时，
默认日历会被静默改成列表第一个（反馈里是「哔哩哔哩HD」），之后每句话都写进那个日历，
界面上看不出任何变化。

- `pickDefaultCalendar()` 只接受三种来源：显式指定且存在 > 配置里那个（还在）> 「学习」；
  都没有就**留空**并返回可选列表，不替用户挑；
- `CalDav.findCalendar()` 在没给名字时**拒绝写入**（原来 `return calendars[0]`），
  写错日历比报错危险；
- App 侧：登录返回 `needsCalendar` 时留在设置页把可选日历列出来；启动时发现没有
  默认日历也停在设置页，不再用 `names.first` 顶上。

### 5. 零碎

- `cal-mcp/package.json` 的 `version` 从 1.3.0 补到 1.3.2（装机包里它一直落后于
  `Info.plist`，反馈是靠肉眼比对发现的）；
- `doctor` 的连接检查里带上实际使用的服务器地址，换过区会注明；
- 新增 `credentials-cases.mjs`（13 条：账号归一化、16 位格式、区域入口互换），
  CalDAV 用例 +7（跨区跳转、换区兜底、403 文案、默认日历拒绝写入），
  归因用例 +8（默认日历选择）；`npm test` 从 378 条涨到 386 条。

未做：公证（需要付费开发者账号），仍在「已知限制」里。

---

## [未发布 · 本地] 真半透明：木板背后换成系统玻璃，透出桌面 — 2026-11-10（build 37）

用户指出上一版「模糊背景」根本看不见后面的东西、和不透明没区别，并问 macOS 27.2
有没有液态玻璃系统预设。**两条都是对的，上一版是我做错了。**

- 系统确实有预设：SDK 里有 `NSGlassEffectView`（26.0+，`Style.regular/.clear`、
  `tintColor`、`cornerRadius`，27.0+ 还有交互响应），项目玻璃模式用的
  `NSVisualEffectView(.underWindowBackground, .behindWindow)` 是更早的系统预设。
  窗口本身也早就 `isOpaque=false` / `backgroundColor=.clear`。
- 上一版为什么不是半透明：拟物模式有三层把桌面挡死 —— `underPageBackgroundColor`
  是不透明深灰，网页 `html/body/.desktop/.plank-area` 也全是不透明深色；
  所谓「模糊」只是在糊网页自己画的那张假后窗。这次把三层一起让开。

**做法（用户选「只木板背后透明」）**：设置页第 2 行换成「液态玻璃背景」，默认关。

- 原生：`skeuoContainer` 里在 WebView 后面垫一层 `NSVisualEffectView`；
  开关开时关掉 WKWebView 的 `drawsBackground`（KVC）、`underPageBackgroundColor=.clear`，
  玻璃层显示。金属上半部 `.chrome` 保持不透明。
- 网页：`html.liquid-bg` 下 html/body/.desktop 全透明、假后窗 `display:none`、
  `.plank-area` 只留极淡暖色 tint 并去掉 `backdrop-filter`、底部雾层减弱。
- 状态仍走 `pushSkeuoState` payload 的 `liquidBackdrop` 字段，页面重载可重放。
  旧的 `blurBackdrop` 开关/键全部移除，废弃偏好也已在本机清理。
- `Info.plist` 36→37（短版本仍 1.3.1），`VERSION=1.3.1-37`。

**为什么最终没用 NSGlassEffectView**：实测它是「把 contentView 包进玻璃」的容器，
contentView 为空时当整窗背景采不到桌面，合成快照里木板缝隙仍是一片黑；
换成项目玻璃模式已验证的 `NSVisualEffectView(.behindWindow)` 后立刻透出明亮的
桌面柔光。它更适合小片玻璃控件，不适合整窗垫层。

**快照通道补了一条**：原 `renderSkeuoSnapshot` 用 `web.takeSnapshot()`，
只导 WKWebView、透明处显示为空，验证不了半透明。新增
`DSH_CAL_SNAP_COMPOSITE=1` 走 `CGWindowListCreateImage` 拍真实合成窗口（仅在
--snapshot 自检；编译有一条 macOS 14 deprecated warning，不影响产品）。
`DSH_CAL_SNAP_GLASS_BG=1` 在玻璃层下垫彩色测试底图并把 blending 改
`.withinWindow`，用来证明透明链路；产品运行永远采真实桌面。

验证（亲手跑过）：双架构 `swiftc -typecheck` exit=0、拟物页 script 语法 OK、
`build.sh`、`codesign -v --deep --strict`、`x86_64 arm64`、包内 HTML 与源码
sha256 一致、三时区 `npm test` 全绿（202+39+24+20+59+36+386）、audit 0/386。
合成快照探针：

```
关： class=wood16          bodyBg=rgb(43,41,38)  desktopBgImg=linear-gradient(…)
     plankAreaBg=rgba(58,55,51,.55)…  backWindowDisplay=block
开： class=liquid-bg wood16 bodyBg=rgba(0,0,0,0) desktopBgImg=none
     plankAreaBg=rgba(38,34,30,.1)…    backWindowDisplay=none
```

关着时缝隙是均匀深灰；打开后是明亮的浅灰白半透明，能看到桌面被系统玻璃柔化。
自检彩色底图那一版能直接看到彩色条纹被虚化，证明透明链路确实通了。
帧率（各自独立进程、激活窗口后 rAF 采样 10s）：

```
关  n=464 avg=17.3ms p95=19.0ms max=224.0ms >33=2
开  n=481 avg=16.7ms p95=18.0ms max=20.0ms  >33=0
```

系统原生玻璃比上一版网页 `backdrop-filter` 更省，没有性能退化。
所有临时 `defaults write` 验证跑完都已 `defaults delete`，默认仍是关。

**三层可回滚**：① 设置页关掉开关即回到原样（默认就是关）；
② `zsh <会话工作区>/rollback/switch.sh 36` 整包退回上一版（`37` 可切回）；
③ 本地提交未 push 可 `git revert --no-edit`。四条红线不变。

**未验证**：真人长时间滚动 / 拖窗口手感、不同壁纸与外接屏上的观感、
设置页真人鼠标点开关手感、玻璃外观模式下此开关的行为（设计上不生效）。

---

## [未发布 · 本地] 设置页新增「模糊背景」开关 — 2026-11-10（build 36）

**先看效果，默认关闭，随时可退。** 拟物木板背后的背景可以在设置页切成半透明高斯模糊。

- 基线里 `.plank-area` 原本有 `backdrop-filter:blur(20px)`，后来被一段带 `!important`
  的规则明确关掉，注释写着「滚动时不实时做整区高斯模糊 —— 那是卡顿的主因」，
  改成「预模糊后窗 + 静态暖灰」。这次不推翻那条取舍，只在 `html.blur-bg` 下
  恢复实时模糊（18px + saturate .88）、把底色从 `.55/.78` 压到 `.24/.38` 更透，
  并把后窗预模糊从 6px 降到 1.5px、透明度 .6→.82，让透上来的内容真被虚化。
- 设置页「外观」区从 3 行变 4 行：全拟物外观 / **模糊背景** / 输入框染色 / 输入框光圈；
  `buildSetup` 的 `lift` 136→172，窗口高 466→502，实测四行开关完整、无截断。
- 开关只写 `UserDefaults(blurBackdrop)`，状态放进 `pushSkeuoState` 的 payload，
  网页 `dshRender` 里 `toggle('blur-bg')`。放进 payload 而不是一次性 JS 注入，
  是为了页面重载 / 回到主界面后能重放；设置页里切换也会立刻 `evaluateJavaScript` 一次。
- 仅拟物外观生效；玻璃模式没有木板列表，开关留着但不产生视觉变化。
- `Info.plist` `CFBundleVersion` 35→36（短版本仍 `1.3.1`），`VERSION=1.3.1-36`。

**验证（亲手跑过）**：双架构 `swiftc -typecheck` exit=0、拟物页 script 语法 OK、
`build.sh` 成功、`codesign -v --deep --strict` 通过、`x86_64 arm64`、
包内 `skeuo.html` 与源码 sha256 一致。快照探针原始输出：

```
关： class=wood16                backdrop=none
     areaBg=rgba(58,55,51,.55)   backWindowFilter=blur(6px)  opacity=.6
开： class=wood16 blur-bg        backdrop=blur(18px) saturate(.88)
     areaBg=rgba(58,55,51,.24)   backWindowFilter=blur(1.5px) opacity=.82
```

关着时木板缝隙是均匀深灰；打开后透出被柔化的浅色后窗（连蓝色条带都被虚化）。
真实链路另验一次：临时 `defaults write app.dsh.calendar blurBackdrop -bool true`
后不注入任何 JS 跑快照，仍得到 `class=blur-bg wood16` / `backdrop=blur(18px)`；
**跑完已 `defaults delete` 恢复，默认仍是关**。

帧率对照（同一进程先关 4.2s 再开 4.8s，激活窗口后 rAF 采样）：

```
OFF  n=248 avg=17.0ms p95=19.0ms max=87.0ms  >33=1
ON   n=271 avg=17.7ms p95=19.8ms max=309.0ms >33=1
```

稳态基本持平（约 57–59fps），但**切换到开的那一瞬间有一次 309ms 长帧**，
是 backdrop-filter 首次建立合成层的开销，不是持续掉帧。三时区 `npm test`
全绿（202+39+24+20+59+36+386），`--audit` 可疑 0/386。

**三层可回滚**：① 设置页把「模糊背景」关掉即回到原样（本来默认就是关）；
② `zsh <会话工作区>/rollback/switch.sh 35` 整包退回 build 35（无此开关），
`switch.sh 36` 可再切回来；③ 本轮本地提交尚未 push，可 `git revert --no-edit`
或在未推送范围内 reset。四条红线不变：不 force、不动已发布 tag、不新建 tag/Release、不改 `dist/`。

**未验证**：真人连续滚动 / 拖动窗口时的长时间手感（探针是静止页面采 rAF）、
不同窗口尺寸与外接屏上的模糊观感、真机 Dock 观感；设置页真人点击开关的手感
（验证的是偏好链路与布局截图，不是真人鼠标）。

---

## [未发布 · 本地] 修拟物木板晃动延迟 — 2026-11-10（build 35）

用户报「拖动窗口时木板先不动、停了才开始晃」，进一步定位为
「滑到木板列表中间时，可见那一屏的晃动明显慢半拍」。

### 根因（与上一轮标签归属功能无关）

`skeuo.html` 的 `dshSwing` 按**列表绝对索引**排传导延迟：
`delay = i × (PH+GAP)/WAVE = i × 82/1.3 ≈ i × 63ms`。装机实测 25 块木板，
最后一块要等 **1514ms**；源码注释仍写着「最后一块比第一块晚约 0.4s」
（按 6 块左右写的，日程变多后已过时）。滚到中间时可见的第一块其实是第 3 块
（探针实测），它仍要等约 190ms，而真正的绳固定端早滚到屏幕外了。
短拖动结束后，队列里那些带 `at` 时间戳的迟到冲量才陆续兑现 ——
这就是「拖时不动、停了才晃」和「滑到中间有延迟」两个现象的共同来源。

`git diff 9952d4f` 证明上一轮只改了标签归属 / 白名单 / 自检，
没碰 `SkeuoDragView`、`dshSwing`、`frame()`/`paint()`；装机包 `skeuo.html`
与源码 sha256 一致。**不是改功能改坏的**，是既有 `WAVE` 参数被
「日程从 6 条涨到 25 条」放大了。

### 修法（用户选「起点对齐可见区」）

- 新增 `firstVisibleIndex()`：用 `getBoundingClientRect` 找当前可见的第一块，
  延迟改成 `max(0, i - base) × 63ms`。视野里第一块立刻响应，往下仍依次传导。
- 缓存键加入 `scrollTop`（100ms 缓存，滚动一变立即失效），避免刚滚完就拖窗口时
  头 100ms 还拿上一屏的起点。
- 给视野下方远处节点封顶 **480ms**，避免迟到冲量在短拖动结束后继续兑现；
  可见区手感不受影响。
- 每级 63ms 和 `WAVE=1.3` 一个字没动，保留「从上甩下去」的层次感。

### 验证（`DSH_CAL_SNAP_JS` 探针，滚动到 600 / 1200 两处取样）

```
VIS scroll=600  base=3  nodes=25 firstVisible=0ms next=63ms max=480ms
VIS scroll=1200 base=11 cacheInvalidated=true
paint n=126 avg=20.6 p95=18.0 >33=3
```
对照组（旧公式）同一批节点延迟为 `0,63,126,…,1514ms`。另跑了三组帧率探针：
纯渲染 57–60fps、`paint` 平均 0.08ms/帧、叠加本地模型归属后 0 帧 >33ms ——
排除了 IPC、模型占用和渲染瓶颈，才把嫌疑收敛到传导延迟本身。
JS 语法检查通过、`codesign -v --deep --strict`、`x86_64 arm64`、
包内 `skeuo.html` 与源码 sha256 一致、三时区 `npm test` 全绿
（202+39+24+20+59+36+386）。

装机 `1.3.1 / build 35`（`VERSION=1.3.1-35`）。**若 App 正在运行，需 ⌘Q 后重新打开**
才能加载新的 `skeuo.html`。未验证：真人长拖动手感、不同滚动位置的观感。

本地提交，未 push / 未打 tag / 未发 Release；`dist/` 未动。
图标第二轮设计稿仍放在会话工作区 `icon-preview/round2/`，按用户要求「先放着」，
未改任何图标代码。

---

## [未发布 · 本地] 自动标签归属 + 闭集约束 + 自举修复 — 2026-11-10（build 34）

### 新功能：自动识别对话框里日程的标签归属

对话里不打 `#标签` 时，输入停顿 **2 秒**后问一次**本地模型**，在「学习 / 生活」里二选一；
判不准（或超时、模型未就绪、乱答）一律回落默认日历。界面把模型判出的标签标成
「生活 · 模型」，和用户自己写的可区分。玻璃版与拟物版共用同一套调度。

**选型：模型管语义，规则管边界**（用户拍板用本地模型，本机 `ollama / qwen3:8b` 常驻，
不需要网络）。实测数据：

```
受限提示热态 280–470ms，冷启动 2867ms；同一句重复 5 次输出一致（temperature 0）
  明天晚上写作业 → 学习   明天晚上吃火锅 → 生活
  下周三交高数论文 → 学习   明天取快递 → 生活
自由提示（不给候选）→「饮食」「运动」「健康」「医疗」「作业」「休闲」全在库外
越界诱导「#临时」/「标签是不存在的标签」→ 模型仍判「学习」，会覆盖显式标签
```

所以提示词闭集**不能算保证**：模型返回值一律再过 `projectModelTag` 代码白名单。

### 两条硬约束

1. **标签库有限且闭合**：合法输出全集是运行时从 `cals` 拉到并缓存的库（本机实测 14 个：
   学习、生活、家庭、特别事件 + 10 个 `课表-*`）；自动归属候选集**只有 `{学习, 生活}` + 未指定**，
   其余日历仍靠显式 `#课表-数学` 或手动下拉精确命中，模型完全不介入。
2. **所有日程的标签一定在库内，不该出现库外标签**：这是独立于选型的正确性缺陷，四处一起修——
   - `src/calendar-policy.mjs`（新增纯函数层）：`exactCalendarMatch` 精确全等、`projectModelTag`
     白名单投影、`resolveCalendar` 优先级「显式 > 模型 > 默认」，输出恒 `∈ 库 ∪ {undefined}`。
     显式标签库外时**不让模型顶替**，只记 `rejected` 并回落默认。
   - `cli.mjs`：新增 `tag` 子命令；`parse` 的 `calendar` 输出过投影（库外名字不再被界面当成已选中），
     新加 `--tag` 供 2 秒停顿那次解析顺带问模型。
   - `tools.mjs addEvent`：写入前过决策层，返回 `tagSource` / `tagRejected`。
   - `caldav.mjs`：写入路径 `findCalendar(..., exactOnly:true)` 禁子串模糊；查询/删除/修改保留旧容错。
     旧行为下 `findCalendar('课表')` 会**静默投进「课表-数学」**，比报错更危险。
   - `App.swift selectCalendar` 拒绝库外名（旧实现把 `#临时` 直接显示为已选中，按回车才报错）。

刻意**不改 `nlp.mjs` / `parseEvent`**：那是忠实解析用户原文的纯解析层，输出被
`parse-corpus.snapshot.txt` 逐行冻住（只许追加）。独立成层后旧 378 行零变化，
决策层可以用 mock 模型输出写死断言，结果不随模型版本漂移。

### 顺带修掉一个更严重的部署 bug

`build.sh` 原来把 `engine/VERSION` 只写成短版本 `1.3.1`，而 `App.swift Bootstrap.ensure()`
只比这个字符串决定要不要重装 `~/.local/share/dsh-cal/`。**同一个 1.3.x 里升 build 号，
装机包换了、用户实际跑的后端副本却一直没换** —— 本次探针第一次跑出来
`TAG result calendar=<null>`，追下去才发现 `--tag` 在旧副本里根本不存在；
前几轮的后端解析修复很可能同样没真正进过运行中的 App。
现在 `VERSION` 写成 `1.3.1-34`（短版本-构建号），每次升 build 都会触发自举重装。
实测重打包后 stamp 从 `1.3.1` 变成 `1.3.1-34`，6 个后端文件与源码 sha256 逐字节一致。

### 回归体系（每次更新都跑）

- `calendar-policy-cases.mjs` **59 条确定性硬断言**（投影 / 优先级 / 回落 / 禁子串 / mock 模型脏值），
  加入 `npm test`；新增用例在旧代码上先以 `ERR_MODULE_NOT_FOUND` + 复现脚本证明失败。
- `calendar-model-cases.mjs` **36 条模型属性测试**（12 句 × 3 性质）：只断言
  「输出必 ∈ 闭集」，不断言具体标签；模型不可用会明确打印跳过，**不写进蓝本快照**，
  免得换模型版本就把「只许追加」闸门刷爆。
- 蓝本 378→**386**（Q 组 8 条归属输入，含用户报过的库外标签句子），旧 378 行 `diff` 零差异，
  `--audit` 可疑 0/386。

### 验证（亲手跑过的原始输出）

```
202/202 通过  ✓ 39 安全  ✓ 24 CalDAV  ✓ 20 模型兜底
59/59 闭集断言  ✓ 36/36 模型属性（ollama/qwen3:8b）  ✓ 386 条蓝本完全一致
```
本机 / `TZ=UTC` / `TZ=America/New_York` 三套全绿。双架构 `swiftc -typecheck` exit=0；
`build.sh` 成功、`codesign -v --deep --strict` 通过、`x86_64 arm64`、装机 `1.3.1 / build 34`。
端到端 mock（拦住写入、不碰真实日历）：`#临时` → 写「学习」`source=fallback rejected=["临时"]`、
`#学习` → `source=explicit`、`明天晚上吃火锅` → 写「生活」`source=model`、
`calendar:"课表"` → 回落并 `rejected=["课表"]`，全部 `在库内=true`。
包内 / 自举副本 CLI 冒烟：`tag` 三句全对、`parse --tag` 无标签→生活、
`#临时`→`calendar=null hasExplicitTag=true`、`#学习`→`source=explicit`。
两个外观模式的真实快照探针：拟物 `TAG-PROBE modelChip=true` 且界面显示「生活 · 模型」；
玻璃 `TAG result calendar=生活 source=model`。App 当前未运行，下次打开就是 build 34。

### 未验证（不拿编译/探针冒充）

真人连续打字时 2 秒防抖手感、玻璃模式真人 IME 与翻候选、真实 CalDAV 写入往返与失败回滚、
模型冷启动（2.9s）落在 2 秒停顿里的体验、换模型/换量化后的标签准确率。

本地提交，**未 push、未打 tag、未发 Release**；`dist/` 未动。
负责 push 的模型只需普通 `git push origin main`；领先笔数以 `git rev-list --count origin/main..main`
实测为准，别照抄文档里的数字。四条红线不变：不 force、不动已发布 tag（`v1.1.0` … `v1.3.1`）、
不新建 tag/Release、不改 `dist/`。非快进先 `git fetch` 并询问。

---

## [未发布 · 本地] 交互三修 + 装机 build 33 — 2026-11-10

用户实测报了三个问题，逐个追到根因；本轮**改了 App 并重新打包安装到本机**
（1.3.1 / build 33，App 当时未运行，下次打开就是修复版）。`dist/` 仍未动。

### ① 拼音输入法打「d」按回车选字，直接挂上了日程

两个入口都漏了组字态判断：

- 玻璃模式 `App.swift` 的 `textView(_:doCommandBy:)` 收到 `insertNewline` 就无条件
  `addEvent()`；现在先看 `hasMarkedText()`，组字态把回车吞掉（返回 true 但什么都不做），
  交给输入法上屏，选完字再按一次回车才提交。`addEvent()` 开头也加了同样的兜底，
  挡住「候选窗还开着就点添加按钮」和拟物页的 submit 消息。
- 拟物页 `skeuo.html` 的 `keydown` 原来只写 `if (e.key === 'Enter') submit()`。
  现在用 `compositionstart/end` 自维护标志 + `e.isComposing` + `keyCode 229` 三道拦截，
  并用 `justEnded`（0ms 定时器）跨过「compositionend 紧跟同一次 keydown」这个经典坑；
  `submit()` 本身也检查组字态，连点按钮也挡。

### ② 删除点确认后不立刻消失、要确认两次、非常卡顿

根因是 `deleteItem()` 只在 `rm` 网络成功后才 `refreshAgenda()`，而 `rm` + 那次 `ls`
（14 个日历逐个拉）实测要 5~8 秒；这段时间木板一动不动，用户以为没删成又确认一次。

- `skeuo.html` 的 `doDelete()` 改成**乐观摘板**：先从 `items` 移除并立刻 `render(-1)`，
  再发 `post({type:'delete'})`。
- `App.swift` 的 `deleteItem()` 同步乐观：先从 `agenda` 移除、立刻重绘并 `pushSkeuoState()`，
  网络请求在后台跑；失败整份回滚（保存删除前的数组快照），界面不骗人。
  另加 `deletingUids` 防止一次删除在飞时重复点击。CLI 的 `rm` 用精确 uid 时
  `ok` 正常返回，不存在「后端还要第二次 confirm」，已排除。

### ③ `#学习@大学` 报「不存在名为…的标签」写入失败

**源码级真 bug**（不只是装机旧后端）：`parseCalendarTag` 的 `#标签` 正则没排除 `@`，
把「学习@大学」整串当成日历名；日历列表里恰好有「学习」时会被上一轮的前缀切分碰巧救下，
换个名字就必现。`@大学#生活` 还会把后一个标签吞进地点，变成「大学#生活」。

- `parseCalendarTag` 的 `#标签`、`标签：X` 两处字符类排除 `@` / `＠`；
  `parseEvent` 的多标签循环同步；`parseLocation` 的 `@地点` 分支改用 `landmarkEnd()`
  切右边界（原来直接返回贪婪匹配到的整串）。
- 修后 `明天晚上写作业#学习@大学` → 标题「写作业」、地点「大学」、日历「学习」，
  且 `calendarNames` 为空或不含「学习」时结果一样。

### 回归与验证

- `parse-cases.mjs` 194 → **202**（+8 条硬断言，特意用不在日历表里的「临时」标签钉住）；
  示例库蓝本 369 → **378**（+9 条，P 组「回归·标签地点」），`--record` 的
  「只许追加」闸门照旧生效。旧 369 行输出 `diff` **零差异**。
- `npm test` 本机 / UTC / 纽约三套全绿：`202/202` + 39 + 24 + 20 + `378` 条蓝本；
  `--audit` 可疑 **0/378**。
- 双架构 `swiftc -typecheck` exit=0 无警告；拟物页 `<script>` 语法检查通过；
  `build.sh` 成功，`codesign -v --deep --strict` 通过、`x86_64 arm64`、build 33；
  包内 `engine/src/nlp.mjs` 与 `web/skeuo.html` 与源码 **sha256 逐字节一致**；
  用**包内**后端跑用户那句，输出 `写作业 / 大学 / 学习 / 19:00–20:00`。
- 网页侧两个行为用项目自带的 `DSH_CAL_SNAP_JS` 通道**亲手探针**（全程拦截
  `postMessage`，没有真写/真删任何日程）：
  - 组字态探针：`intercepted=true composingEnter=0 justEndedEnter=0 normalEnter=2`
    —— 组字态和刚结束组字的回车都不提交，正常回车才提交。
  - 删除探针：`before=24 after=23 opened=true closed=true removed=true calls=delete:…`
    —— 确认一次就立刻摘板并发出 delete。

### 未验证（如实列出，不能拿编译/探针冒充）

- 玻璃模式的 IME 回车是标准 `hasMarkedText()` 判断，只做了代码审查 + 编译，
  **真人打拼音 / 翻候选 / Esc 取消的手感未验证**（探针覆盖的是拟物网页侧）。
- 真实 CalDAV DELETE 往返、失败回滚在真机上的表现、删除后的滚动/动画手感，
  以及「点叉叉 → 点摘下」的真人鼠标手感，都未验证。
- 装机版已更新文件，但**没有重启 App**（当时未运行），请打开后亲自试这三个场景。

### 状态

本地提交，**未 push、未打 tag、未发 Release**；`dist/` 未动。
上一轮那 3 笔已经推到 `origin/main`（`f091b0c`）；本轮的本地提交
（解析修复 / 界面修复 / 更新日志 / 状态校正）都还没推。领先笔数一律以
`git rev-list --count origin/main..main` 实测为准，别拿本文数字对表。
负责 push 的模型仍只需普通 `git push origin main`，四条红线不变：
不 force、不动已发布 tag（`v1.1.0` … `v1.3.1`）、不新建 tag/Release、不改 `dist/`。

---

## [未发布 · 本地] 口语解析深度回归 — 2026-11-10

只改 `cal-mcp/` 后端解析与测试，**没有改 App、没有打包、没有升版本号**：
当前装机仍是 1.3.1（build 32），内嵌的 `src/nlp.mjs` 要等下次走
`scripts/make-release.sh` 打包才会带上这批修复。`dist/` 按约定没动。

### 用户实测报上来的三句

| 输入 | 修复前 | 修复后 |
|---|---|---|
| `明天晚八点四十到九点半做暑假作业五在图书馆。` | `08:40–09:30`（差 12 小时），标题「晚做暑假作业五」 | `20:40–21:30`，标题「做暑假作业五」，地点「图书馆」 |
| `中午在宿舍里睡觉#学习` | 标题「里睡觉」 | 标题「睡觉」，地点「宿舍」，日历「学习」 |
| `明天下午在图书馆里学习半个小时` | 标题「里学习」 | 标题「学习」，地点「图书馆」，`14:00–14:30` |

### 深挖出来的五类根因（不止这三句）

1. **单字时段词**：`PERIOD` 只收「晚上 / 早上 / 中午」等双字词，「晚八点」「早八点」
   「午十二点」「夜十点」的时段完全没生效 —— 差 12 小时，单字还烂在标题里。
   新增 `CLOCK_PERIOD`：单字**只在后面紧跟钟点时**才算时间词，再归一化成
   「晚上 / 早上 / 中午 / 夜里」复用既有 `applyPeriod` / `NIGHT_PERIOD`
   （「晚十二点」因此正确落到次日 00:00）。「晚饭 / 早点 / 夜宵」一个字都不会被削。
2. **地点后的方位词**：「在宿舍里睡觉」切出地点后「里」粘在标题上。新增 `PLACE_TAIL` +
   `refineLocation()`，把「里 / 里面 / 中 / 内 / 外面 / 旁边 / 上 / 下」并进地点片段一起删；
   「上课 / 内部 / 中文 / 下午」用负向断言挡住，不会削掉半个词。显式
   `地点：图书馆里自习` 还会把被吞进 `location` 的动作还给标题。
3. **冒号钟点被当介词**：`到9:30在图书馆` 的负向断言只写了 `[点时]`，漏了冒号，
   地点错成「9:30在图书馆」。断言补上 `:：`。
4. **钟点数字被当星期连写**：「下周三七点」的「七」既是钟点又是星期字符（七＝周日），
   `parseDate` / `parseRepeat` 把它连着「三」吞进日期 → 整句掉成全天日程、
   标题「下周看剧」，带时长时直接报错；「每周三七点」变成每周三 + 周日。
   三处正则统一加边界：星期字符后紧跟「点 / 时 / :」不算连写。
5. **标签吞时长**：`#生活半个小时` 的日历名被读成「生活半个小时」。
   `parseCalendarTag` 优先按已知日历名前缀切，未知名字按时长 / 时间词兜底切。

### 示例库与「永不再犯」

- `parse-corpus.mjs` 新增 **N. 回归错例 / O. 数字误吞** 两组共 **64 条**（蓝本 305 → **369**），
  用户三句原样收在 `回归·用户原句`；另含「晚饭 / 早点 / 内部 / 上海」等反例和
  「周一三五 / 周六十点」等对照组。
- `parse-cases.mjs` 新增 **26 条写死期望值的硬断言**（用例 168 → **194**），
  即使有人重刷快照也守得住；runner 现在会把「本该解析却抛错」记为失败，
  而不是崩掉整份用例表。
- `parse-corpus.mjs --record` 加了**只许追加闸门**：旧行一旦变化或条目被删就直接拒绝，
  必须先逐条看 `--show` 再显式 `--record-force`。亲手验过：故意改坏第 1 行后
  `--record` 报 `✗ 已有 1 条蓝本输出变了（行号：1）` 并退出 1。
- 这条链路每次更新都会跑：`npm test` 包含 `parse-cases` + `parse-corpus` 快照比对；
  `.git/hooks/pre-push`、CI 的 push/PR job、`scripts/make-release.sh`（源码与包内两处）
  全都跑 `npm test`。**回归示例只许追加，不许删、不许改来迁就解析器。**

### 验证（亲手跑过，原始输出）

- `npm test` 本机 / `TZ=UTC` / `TZ=America/New_York` 三套全绿，每套最后五行都是
  `194/194 通过`、`✓ 39 条安全用例全部通过`、`✓ 24 条 CalDAV 用例全部通过`、
  `✓ 20 条模型兜底用例全部通过`、`✓ 369 条口语解析与核验蓝本完全一致`。
- 新增用例在**旧代码**上精准失败：第一批 `170/188 通过`（18 条失败）、
  第二批 `188/194 通过`（6 条失败），逐条失败输出留在工作日志。
- 旧 305 行蓝本输出 `diff` **零差异**；306–360、362–369 行也零差异，
  唯一变化是新增第 361 行（本轮要修的日历名「生活半个小时」→「生活」）。
- 1200 组「日期 × 时段 × 钟点 × 动作 × 地点 × 标签 × 时长」组合模糊测试：
  修复前 3 条意外报错，修复后 **0 报错、0 可疑**。
- `node cli.mjs parse` 冒烟三句（真实时钟）：`20:40–21:30 / 12:00–13:00 / 14:00–14:30`，
  标题、地点、日历都对。

### 已知边界（不是 bug，别「修好」）

- 单字「晚 / 早 / 午 / 夜」**只在后面紧跟钟点时**才当时段词。单独一个「晚」字
  （「明天晚开会」）仍按没有钟点处理，因为「晚饭 / 早点 / 夜宵 / 夜跑」这类普通词
  无法可靠区分 —— 沿用「报错优于猜测」的取舍，不为它猜一个 19:00。
- LANDMARKS 词表之外的地点（「在树下面看书」）不识别为地点、整句当标题，行为未变。

### 状态与给负责 push 的模型

本地提交，**未 push、未打 tag、未发 Release、未重新打包**；`dist/` 未动。
负责 push 的模型只需：

```bash
cd /Users/unix/WorkBuddy/2026-11-03-19-34-56
git status                  # 应为空
git log --oneline -1        # 本次提交的短 hash
git push origin main        # 普通快进推送
```

四条红线：① 不要 `git push --force` / `--force-with-lease`；② 不要移动或重打已发布 tag
（`v1.1.0` … `v1.3.1`）；③ 不要新建 tag 或 Release（要发版就升版本号走 `make-release.sh`）；
④ 不要改 `dist/`。非快进时先 `git fetch` 并回来问，别自行处理。

---

## [1.3.1] — 2026-11-09（构建号 32）

已发布（tag `v1.3.1`）。完整发行说明见 `dist/notes-1.3.1.md`，界面层逐轮细节见
`docs/skeuo-webview-notes.md`。本版是拟物外观从「能用」到「可交付」的收口，
含 build 12–31 共 23 笔提交。已发布 tag（`v1.1.0` … `v1.3.0`）一个没动，没有 force push。

### 一、拟物外观（build 12–24）

- **木纹**：弃掉每块 200 个 DOM 节点的程序化噪声（上一版滚动卡顿的根因），改预烘焙贴图
  `wood-sprite.png`（760×216，四块）。之后按锯法分直纹 / 山纹 / 波纹三族，
  `kind = t % 3` 按槽位查表保证相邻两块不同族；每块单独画到临时 canvas 求平均亮度、
  与目标 96 的差用 `source-atop` 极淡白/黑罩补平，解决「第一块太黑」「四五块长得一样」。
- **绳子**：退回木板背面（叠到板前是物理错误）；`.rope-seg` 与孔内 `.rope-thru` 共用
  同一条材质规则。原来把 `--rope-bg` 定义在 `:root` 里，`var()` 在声明处就被算死，
  `:nth-child(even)` 的镜像捻向静默失效 —— 改成一条规则写两个选择器。弦角按两孔真实
  竖向距离 82px 算（不是板间缝隙 28px），`transform-origin` 定到上方孔。
- **铜件**：穿孔改成球面渐变（20→24px，孔径 12.8px）；挂杆的 `filter:url(#brassBrush)`
  在空 `::before` 上出不了图（放大 7 倍零噪点），改用四层互质周期
  `repeating-linear-gradient`（1.7 / 2.3 / 3.1 / 4.7）+ `overlay` 做金属拉丝。
- **滚动**：取证确认这台 `WKWebView` 的视图树里没有 `NSScrollView`、也不派发滚轮事件
  （`window.scrollTo` 有效、`web.scrollWheel()` 后 DOM 计数恒为 0）。改为
  `NSEvent.addLocalMonitorForEvents(matching: .scrollWheel)` 在事件分发前截取、
  8ms 合批后调页面 `dshScroll(dy)`。其间试过页面 `takeover` 与覆写容器 `scrollWheel`，
  两条路都会把滚动锁死（方向还不可逆），已整段删除 —— 别再往那两个方向改。
- **摆动物理**：冲量改成逐条排队派发。原来每个节点只存一个待发冲量和一个到达时间，
  而拖动每 40ms 来一次事件、每次都把到达时间往后推，靠下的节点（延迟 126–410ms）
  整个拖动期间一次都收不到 —— 峰值是 5.47 / 1.73 / 0.94 / 0.90 / 2.30 / 4.50 的 U 形。
  改成排队兑现后为 5.63 … 6.40 的近似平铺。拖窗纵向速度也参与（`dshSwing(vx, vy)`，
  走垂直驱动单摆的参数共振，系数约为横向的六成）；倾角上限 1.4° → 1.7°（修正派发后
  各块峰值都顶到 1.39°，等于一直被削平，摆到极限那一下是「停住」而不是自然过零）。
- **输入面板**：`input` 撑满整块绿屏（`padding:36px 0`），整个面板 `mousedown` 兜底聚焦；
  `acceptsFirstMouse` 让「非前台窗口的首次点击」一次生效（系统默认只用来激活窗口）；
  打开即聚焦，并给绿屏加亮绿描边 + 内发光，让「有没有点上」看得出来。
- **写入反馈**：拟物输入框是网页 `<input>`，不属于任何 `NSTextView`，
  `textDidChange` 永远不会响 —— 上一版整条识别链断在起点，小牌恒为空。
  现在页面 debounce 250ms 把话推给原生、跑与玻璃版同一个 `parse` 后端。
  写入成功后先用返回的 uid 本地插一条，`ls` 回来再整份替换（同 uid 不重复），
  新木板从 5.5s 缩到 3.3s 出现，并只在它不在视口里时自动滚过去。

### 二、界面细化（build 25–29）

- 关键词胶囊换成**六色呼吸 LED 灯阵**（事项 / 时间 / 地点 / 重复 / 标签 / 提醒），
  识别结果同时进 `SYS` 状态屏。
- 删除键 + 二次确认；修冲突误报；修底部白底与绳尾；木板收窄、logo 居中。
- 清掉 `SYS` 栏残留的解析报错；修标题栏 `hitTest` 吞掉窗口中下部点击（确认卡片点不了）。
- 删掉自定义 `hitTest` 改用几何 `frame`，加事件分发前焦点兜底，修点击失焦闪烁。
- 绳尾改预烘焙贴图 `rope-tail.png`（`cal-app/web/bake_rope_tail.py` 生成）；
  修玻璃模式组字态提示词重叠。

### 三、外观联动与设置页（build 30）

- **切换外观同步换 Dock 图标**：新增 `AppIconSkeuo.icns`，`applyAppearance()` 调
  `applyAppIcon()` 按 `appearanceStyle` 设 `NSApp.applicationIconImage`。
  图标源图 `cal-app/web/icon-skeuo-1024.png`，`make-skeuo-icon.sh` 生成 10 尺寸 iconset。
  `build.sh` 的 stage 打包**和** `install_file` 清单两处都要加（只加前者会报
  `sealed resource missing`）。
- 外观入口从「窗口」菜单移到「日历 → 设置…（⌘,）→ 外观」，新增「全拟物外观」开关；
  设置页高度 430 → 466。
- **拟物模式下设置页此前完全不可见**：`contentView` 是整屏 `WKWebView`，设置在玻璃
  `shell` 里被整个盖住。现在 `openSettings()` 临时挂回 `shell` 并恢复红绿灯，
  离开时再按当前外观复原。
- 拨开关只存偏好 + 换图标，界面改动等回主界面生效，避免填账号密码时设置页被替换。
- 自检开关：`DSH_CAL_ICONPROBE=1`（外观 / 图标资源 / 旧菜单项）、
  `DSH_CAL_APPEARANCE_FLIP=1`（只翻内存外观，不写偏好）。

### 四、绳尾与设置页关闭（build 31）

- **绳尾贴图不跟着绳子动**：`.rope-tail` 是 `position:absolute` 的静态 div，
  `paint()` 只驱动 `.plank` 和 `.rope-seg`，从没碰过它。现在两根尾巴收进 `tails[]`，
  `transform-origin` 设成 `50% -94px`（算出来正是最后一个穿孔的位置），逐帧写与末段
  完全相同的 `translate3d + rotate`。**右侧那根必须显式补 `scaleX(-1)`**：`.rope-tail.flip`
  的镜像写在类里，一旦有 inline transform 就整条被覆盖。
- **关掉设置页连日历一起退出**：设置页是同一窗口换 `contentView`，而 `window.delegate`
  从没设过、`applicationShouldTerminateAfterLastWindowClosed` 恒为 `true` —— 红绿灯一关
  就走「关窗即退出」。现在 `AppDelegate` 实现 `windowShouldClose`：还在设置页就
  `buildMain()` 并 `return false`，主界面才放行退出。
- 连带两处：关闭流程里 `setContentSize` 会被 AppKit 吞掉，必须等下一轮 runloop；
  拟物模式下 `slot` 不在视图树里、收不到 autoresize，尺寸要手动对齐到 `contentView.bounds`。

### 五、构建 / 安装

- **装完起不来**：`build.sh` 的 `install_file` 原来用 `cat >` 原地覆写已安装的二进制，
  签名的页哈希按 inode 缓存，同一 inode 内容变了就 `Invalid Page`，进程被 SIGKILL
  （exit 137），而 `codesign -v` 一切正常。改成写同目录临时文件再 `mv`（换 inode，
  不算删除，不触发删除保护）。

### 边界 / 已知限制

- **Finder 里的静态 `.app` 图标**由 `Info.plist` 的 `CFBundleIconFile` 决定（玻璃版），
  运行时改不了；随外观切换的是 Dock、⌘Tab、应用切换器里的运行时图标。
- 设置页拨开关后不点「保存」直接关窗口：图标已变、界面待下次回主界面生效。
- 点开设置时日历界面仍会被顶掉（同一窗口换视图）。本版只做「关掉能回来」。
- 真人用鼠标点 `SoftSwitch`、用红绿灯关设置页未做人工验证；自检走同一条代码路径。

---

## [1.3.0] — 2026-11-08

已发布（tag `v1.3.0`，构建号 9）。完整发行说明见 `dist/notes-1.3.0.md`。
build 10–31 的界面迭代记在 `docs/skeuo-webview-notes.md`，随 1.3.1 一并发布。

## [1.2.2] 及更早

见 `dist/notes-1.2.2.md`、`dist/notes-1.2.1.md`、`dist/notes-1.2.0.md`、
`dist/notes-1.1.1.md`。

---

## 给负责 push 的模型

1.3.1 的发布流程（本版已按此执行，后续版本照抄）：

```bash
cd /Users/unix/WorkBuddy/2026-11-03-19-34-56
git status                                  # 应为 clean
./scripts/make-release.sh 1.3.1             # 跑测试 + 编译通用包 + zip/dmg，要求工作区干净
git tag v1.3.1 && git push origin main v1.3.1
gh release create v1.3.1 dist/dsh-cal-1.3.1-macos.dmg dist/dsh-cal-1.3.1-macos.zip \
  --title "DSH 日历 v1.3.1" --notes-file dist/notes-1.3.1.md
```

红线：

- **不要** `git push --force` / `--force-with-lease`
- **不要** 移动或删除任何已发布 tag（`v1.1.0` … `v1.3.1`）
- **不要** 改 `dist/` 下历史版本的发行包；新版本另起 `dsh-cal-<版本>-macos.*`
- 若推送提示非快进，先 `git fetch` 查清远端状态再问用户，不要自行 rebase / force

**代理坑**：本机 `127.0.0.1:52961` 的 CONNECT 隧道约有四分之一概率 502。
HTTP/2 下会连续失败在同一句 `CONNECT tunnel failed, response 502`，
换成 `git -c http.version=HTTP/1.1 push` 一次就过。别去怀疑凭据 ——
钥匙串里 `zbeabr` 的 `gho_` token 是好的。
