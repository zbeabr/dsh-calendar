# ios/ —— iOS 端专用目录

> **这个目录只放 iOS 端的东西。** macOS 端仍在 `cal-app/`，两端不共用工程文件。
> 接手前请先读完本文件；这里的规则和根目录 `AGENTS.md` 同等效力。

- 建立：2026-11-17
- 状态：**尚未开工**，目前只有这份说明
- 目标产物：`DSHCalendar` iOS App（SwiftUI，最低版本待定）
- 设计依据：`../research/ios-skeuomorphic/`

## 一、为什么单独一个目录

macOS 版是 AppKit + WKWebView 自绘控件，iOS 版大概率是 SwiftUI + 复用同一套视觉资产。
两者**共享设计语言，不共享工程结构**：同一个 `project.pbxproj` 放两平台会互相拖累编译、
也无法分别设置部署目标。

所以边界画在这里：

| | macOS（现有） | iOS（本目录） |
|---|---|---|
| 工程 | `cal-app/`（`build.sh` 直接调 swiftc） | `ios/`（Xcode 工程） |
| 界面 | `cal-app/App.swift` + `web/skeuo.html` | `ios/DSHCalendar/`（SwiftUI） |
| 视觉资产 | `cal-app/web/*.png` | `ios/Shared/`（从 cal-app 拷贝，见下） |
| 引擎/协议 | `cal-mcp/`，两端共用，不复制 | 同左 |

**禁止**把 iOS 代码写进 `cal-app/`，也禁止在 `ios/` 里再放一份 `skeuo.html` 改着玩：
要改拟物外观，改 `cal-app/web/skeuo.html`，再同步到 `ios/Shared/`，否则两份会分叉。

## 二、目录规划

```
ios/
├── README.md            ← 本文件：目录契约，先读这个
├── DSHCalendar/         Xcode 工程（SwiftUI App）
│   ├── App/             入口、路由、依赖注入
│   ├── Features/        日历 / 自然语言输入 / 设置
│   ├── DesignSystem/    材质、光源、控件（拟物的公共层）
│   └── Resources/       资产目录
├── Shared/              与 macOS 共用的视觉资产（PNG/纹理），单向拷贝
└── docs/                iOS 专项决策（部署目标、手势、Widget 取舍）
```

现在这些都还不存在，等确定方案后再建。**不要提前建空目录占位。**

## 三、命名与标识

| 项 | 值 |
|---|---|
| 产品名 | DSH 日历（iOS） |
| 工程名 | `DSHCalendar` |
| Bundle ID | 待定，倾向 `com.dsh.calendar.ios`（与 macOS 的 `com.dsh.calendar` 区分） |
| 最低系统 | 待定。若要用 `glassEffect` 需 iOS 26+，会砍掉大量机型 |

## 四、产物管理（重要，别把仓库搞脏）

必须入库：`*.xcodeproj`、`*.swift`、`Assets.xcassets`、`Package.swift`、本目录文档。

绝不入库：

- `DerivedData/`、`build/`、`*.xcuserstate`、`xcuserdata/`
- 真机截图（可能带真实日程）——要放截图走 `docs/screenshots/` 并裁掉个人信息
- 任何 `.app` / `.ipa`（`.gitignore` 已有 `*.app`，ipa 另加）
- 本地签名文件、Provisioning Profile、`*.mobileprovision`

`.gitignore` 已补 iOS 规则；发现新的产物类型，补规则而不是 `git add -f`。

## 五、与其他 agent 协作的规则

工作区是多模型共享的，这个目录按下面的方式分配所有权：

1. **动 `ios/` 之前先在 `docs/inflight.md` 认领**，写清 agent 名、分支、要改的文件。
   同一时刻 `ios/` 只允许一个 agent 写入。
2. **一个 worktree 一个分支**，不要在主工作区直接改；合并由整合者跑全量测试后再做。
3. **不要跨目录搬文件**：需要 macOS 端的某个资产，拷贝到 `ios/Shared/` 并在
   `ios/docs/assets-provenance.md` 记一行来源与日期，不要软链到 `cal-app/`（worktree 会断）。
4. **改 `skeuo.html` 属于 macOS 端任务**，iOS 端只消费它的产物；如果为了 iOS 必须改，
   先认领 `cal-app/web/skeuo.html`，并同时回归 macOS 的截图。
5. **不要在 `ios/` 里跑 `cal-mcp` 的测试**：引擎改动走 `cal-mcp/`，两端共用一份。

## 六、开工前必须先定的三件事

这三条不定，写代码就是白写：

1. **竖屏的隐喻是什么？** macOS 版是「桌上的木板」，手机没有桌子。选项：
   一块随身携带的仪表（推荐）、一个皮质日程本、继续做桌面但只露一角。
2. **信息架构**：一屏放今天的时间轴，还是放「一句话输入 + 近期三条」？
   macOS 版把输入条放在顶部，手机拇指够不到。
3. **WKWebView 还是原生**？复用 HTML 最快，但纯壳过不了审核 4.2，且手势要重做。

结论写进 `ios/docs/decisions.md`，不要只留在对话里。

## 七、资料在哪

- 设计与实现参考：`../research/ios-skeuomorphic/`（五条规则、UIKit/SwiftUI 对照、来源清单）
- 仓库通用约定：`../AGENTS.md`（红线、汇报格式、验收命令）
- 现有拟物实现：`../cal-app/web/skeuo.html`（2720 行，只读参考）
- 本机环境坑：`../docs/local-env.md`

## 八、提交前自检

- [ ] 没有把 `DerivedData/`、`.app`、真机截图带进 diff
- [ ] 新增的共享资产已在 `ios/docs/assets-provenance.md` 记来源
- [ ] 若改了 `cal-app/` 里的东西，说明理由并回归了 macOS 端
- [ ] commit message 用中文说清现象，一个 commit 一件事
- [ ] `cd cal-mcp && npm run verify` 仍然全绿（引擎没被碰坏）
