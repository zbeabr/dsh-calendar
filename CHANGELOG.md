# 更新日志

记录 DSH 日历的发布变更，最新在上。各版本完整发行说明见 `dist/notes-*.md`。

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
