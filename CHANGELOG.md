# 更新日志

记录 DSH 日历的发布变更，最新在上。各版本完整发行说明见 `dist/notes-*.md`。

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
