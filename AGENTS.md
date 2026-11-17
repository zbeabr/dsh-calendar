# AGENTS.md — 接手本仓库的约定

> 给任何接手这个仓库的模型（Claude Code / Codex / Cursor / WorkBuddy，人或 AI）。
> **先读完本页再动手。** 这里只写「必须遵守」和「怎么验证」，不写历史；历史看 `git log` 和 `CHANGELOG.md`。

---

## 0. 三十秒了解

macOS 桌面日历 App：**用一句中文建日程**。规则解析（毫秒级、离线、零依赖）+ CalDAV 写进 iCloud。

- `cal-mcp/` —— 后端引擎。纯 ESM、**零依赖**、无构建步骤。CLI 与 MCP server 都挂在这套代码上。
- `cal-app/` —— Swift/AppKit 外壳 + `web/skeuo.html`（拟物外观由 WKWebView 承载）。与后端共用同一套逻辑，不重复实现。
- 解析器 `cal-mcp/src/nlp.mjs` 是 1000+ 行纯函数、零 import，**不要给它加时区参数**（见 `docs/decisions.md`）。

两套外观：Liquid Glass 与全拟物。切外观只换 `window.contentView`，数据与草稿不丢。

iOS 端**尚未开工**，产物统一放 `ios/`（规则见 `ios/README.md`），与 `cal-app/` 不共用工程；
拟物设计资料在 `research/ios-skeuomorphic/`。

## 1. 一条命令建基线

**新 clone / 新环境先做一次**（否则推送守卫不生效）：

```bash
git config core.hooksPath scripts/hooks      # 装 pre-push 守卫
```

然后：

```bash
cd cal-mcp
npm run verify          # 后端用例 + 界面用例 + 版本号一致性
```

`verify` = `npm test` + `test:ui` + `scripts/check-versions.mjs`。全绿时最后几行长这样：

```
21/21 通过
✓ 396 条口语解析与核验蓝本完全一致
9/9 通过
✓ 版本号一致：1.3.2（build 51）
```

**数字会随进度变化，不要拿它去对某份文档里的历史快照**：只要没有红、退出码是 0，就是好基线。
改了 `cal-app/App.swift` 还要额外跑编译：

```bash
cal-app/build.sh /tmp/check.app     # 通用二进制，双架构，失败会 write error
```

## 2. 代码地图

| 文件 | 职责 | 改它的风险 |
|---|---|---|
| `cal-mcp/src/nlp.mjs` | 中文解析，纯函数、零 import | 低，有蓝本兜底；**不许改语义换时区方案** |
| `cal-mcp/src/caldav.mjs` | CalDAV 协议、重定向凭据校验、VEVENT 改写 | 中。`rewriteVevent()` 只能动 VEVENT 块 |
| `cal-mcp/src/tools.mjs` | 业务层：增删改查、离线队列补发 | 中。队列是数据安全重灾区 |
| `cal-mcp/src/store.mjs` | 配置、钥匙串、队列落盘 | **高**。跨进程锁 + 原子写，改完要跑并发用例 |
| `cal-mcp/src/llm.mjs` | 本地模型兜底（默认关闭） | 低 |
| `cal-app/App.swift` | 全部界面，控件自绘 | **高**，见第 5 节 |
| `cal-app/web/skeuo.html` | 拟物外观（WKWebView 承载） | 中。无桥时会走 4 条演示数据，可离线截图验证 |
| `ios/` | iOS 端全部产物（独立 Xcode 工程） | 未开工。所有权与边界见 `ios/README.md`，**不要写进 `cal-app/`** |
| `research/ios-skeuomorphic/` | 拟物设计资料（只读） | 低。只放文档，不放代码与产物 |

## 3. 红线（一条都不能省）

1. **不 `git push --force` / `--force-with-lease`**。远端历史只增不改。
2. **不移动、不重打已发布的 tag**（`git tag -f`、删了重建都不行）。要改代码就升版本号。
3. **不 `--no-verify`**，不删推送守卫，不改 remote 地址。守卫在 `scripts/hooks/pre-push`（装了 `core.hooksPath` 才生效），它跑的就是 `npm run verify`。
4. **没亲手跑过的验证，不许说成「已验证」。** 编译通过 ≠ 界面正常；看到代码 =/ 跑过代码。
5. **不许改测试来迁就代码。** 用例是规格。确实规格错了，先说明理由。
6. **一次只做一条，一个 commit。** 三条混在一个 diff 里，出问题无法归因。commit message 用中文说清「修了什么现象」，不要 `fix bug`。
7. **不用 `git add -f` 加 `.git/info/exclude` 里的文件**（未授权公开的本地材料）。

## 4. 修 bug 的固定动作

```bash
# 1. 先写用例，让它对着旧代码跑
git stash push --  <产品代码>      # 只留用例在工作区
npm test                            # 确认新增用例失败，贴那一行失败输出
git stash pop
# 2. 再改产品代码，直到全绿
```

**新用例在旧代码上也过 = 它什么都没测到**，重写，不要留着凑数。
用例之间不要用 `deepStrictEqual` 比整个对象（现有用例是逐字段断言），否则加字段会误伤。

## 5. 改 `cal-app/App.swift` 的额外规则

- 4200 行 AppKit，**控件全是自绘**（连开关都是，因为 `NSSwitch` 在离屏渲染里永远画成「关」）。
- **GUI 行为无法自动验证。** 改完只能报「改完了，但没法自动验证」，不许拿编译通过冒充界面验证。
- 有离屏快照通道可看真实渲染（`--snapshot <path>`），但两个已知假象：
  1. `cacheDisplay` 拿到的是**模型值**，动画永远停在同一相位，两次截图 md5 会完全一样——判断动画要用 `DSH_CAL_GLOW_DEBUG=1` 打印 `presentation()`；
  2. 离屏快照**采不到 behind-window 模糊**，玻璃强度只能人眼在真机上核。
- 人工冒烟清单见 `docs/gui-smoke-checklist.md`。结果留空是常态，**不要替人打勾**。

## 6. 刻意的取舍 —— 这些不是 bug，不要「修好」

1. **`每周三次` 直接报错，不猜。** RRULE 只认 BYDAY。曾经的静默降级成「每周一次」才是 bug。
2. **队列落盘不做 `fsync`。** 靠「临时文件 + rename」，加 fsync 会让并发入队从 5.4s 退化到超时。
3. **越界输入一律报错**（`25点`、`3点75分`、`2月30号`）。报错优于猜测：写错的日程用户不会发现。
4. **重定向凭据走白名单**，不是「末两段域名相同」。公共后缀（`co.uk`/`com.cn`/`github.io`）下末两段相同不等于同一注册者。
5. **删除只认 `confirm === true`**，字符串 `"false"` 必须不删。两道闸门（业务层 + MCP 的 `asBool`）都是有意的。
6. **`dsh-cal`（产品名）与 `dsh-calendar`（仓库名）不一致**是历史遗留，功能无影响，**不要顺手改**。

## 7. 环境相关

- 本机特有的坑（shell 工具差异、权限、打包挂载点）写在 **`docs/local-env.md`**。换机器接手时先看它是否仍然成立。
- 平台：macOS + Node ≥ 18。后端零依赖，`npm install` 不是必需步骤。
- 真实配置在 `~/.config/dsh-cal/`，**绝不入库**；仓库里只有 `config.example.json`。
- 自检当前账号/连接：`node cal-mcp/cli.mjs doctor`（不发网络写操作）。

## 8. 并行协作：先认领，再动手

两个会话同时改同一批文件，git 事后区分不出谁写的。开工前在 `docs/inflight.md` 里
**加一行**（谁、改哪些文件、做什么），完事删掉。文件所有权互斥：`App.swift` 同一时刻只能有一个人在改。

并行时用独立 worktree + 独立分支，由一个人整合后跑全量 `verify` 再推。

## 9. 汇报格式（固定，不要自由发挥）

> 第 N 条做完了。改动文件：…；新增用例：…（在旧代码上失败，贴输出）；`npm run verify` 结果：（贴最后 2 行）；
> commit：`xxxxxxx`。下一条继续吗？

有未验证的部分必须单独写一句「未验证：…」。

## 10. 收尾：离开前要做的三件事

1. 写 `CHANGELOG.md`（用户能看懂的现象，不是文件清单）。
2. `docs/inflight.md` 删掉自己那行。
3. 确认 `npm run verify` 全绿、`git status` 干净，再推。

## 11. 发版

必须走脚本，不要手打包：

```bash
./scripts/make-release.sh 1.3.2     # 自带：工作区干净 + 测试全绿 + 版本一致 + 双架构 + 包内 sha256 比对
git tag -a v1.3.2 -m "…"
git push origin main v1.3.2
gh release create v1.3.2 dist/dsh-cal-1.3.2-macos.zip --notes-file dist/notes-1.3.2.md
```

`SKIP_TEST=1` / `ALLOW_DIRTY=1` 只用于「验证打包流程本身」，**不许用它们产出的包发版**。
