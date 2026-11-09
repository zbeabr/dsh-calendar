# 更新日志

记录 DSH 日历的发布变更，最新在上。各版本完整发行说明见 `dist/notes-*.md`。

---

## [未发布] 1.3.0 (build 30) — 外观联动图标 / 设置页整合

本轮只在本地提交，**尚未 push、未打 tag、未发 Release**；已发布 tag 一个没动，`dist/` 历史发行包未动。

### 新增

- **切换外观时同步更换 Dock 图标**：新增全拟物专用 `AppIconSkeuo.icns`，与玻璃版
  `AppIcon.icns` 两套资源同时随包发布。`applyAppearance()` 调 `applyAppIcon()`，
  按 `appearanceStyle` 设置 `NSApp.applicationIconImage`，启动与切换都覆盖。
- **拟物版图标资产**：`cal-app/web/icon-skeuo-1024.png`（预烘焙 1024×1024 RGBA 位图），
  `cal-app/make-skeuo-icon.sh` 从它生成标准 10 尺寸 iconset → icns。
  `build.sh` 在 stage 打包 **和** 后半段逐文件 `install_file` 清单两处都加了
  （只加前者会签名清单里有、装机包里没有，报 `sealed resource missing`）。
  图标几何沿用 `Icon.swift` 原框架，材质取自 `skeuo.html` 的
  `.chrome` / `.well` / `.lampcell.on .bulb`，设计源见会话目录
  `icon-preview/gen_icon_reframe.py`。
- **自检开关**：`DSH_CAL_ICONPROBE=1` 输出当前外观、加载的图标资源与尺寸、
  旧菜单项是否已移除；`DSH_CAL_APPEARANCE_FLIP=1` 只翻转内存外观（不写偏好），
  验证「切换外观 → 图标同步换」链路。

### 变更

- 外观切换入口从「窗口」菜单移到「日历 → 设置…（⌘,）→ 外观」，
  新增「全拟物外观」开关（与「输入框染色」「输入框光圈」并列）。
  窗口菜单不再有该项；设置页高度 430 → 466。
- **拟物模式下设置页此前完全不可见**：`contentView` 是整屏 `WKWebView`，
  设置页挂在玻璃 `shell` 里被整个盖住（真机截图为证）。现在 `openSettings()`
  临时挂回 `shell` 并恢复系统红绿灯，离开设置页（`buildMain()`）再按当前外观复原。
  不修这处，把切换挪进设置页后用户切到拟物就再也打不开设置页。
- 设置页拨外观开关只存偏好 + 换 Dock 图标，界面改动等回主界面生效，
  避免用户填账号密码时设置页被替换掉；状态栏给出「回到主界面生效」提示。
- 帮助文本补一句外观入口说明。
- `--snapshot` 在设置页开着时改走原生视图快照（WebView 不在视图树里拍不出图）。

### 边界 / 已知限制

- **Finder 里的静态 `.app` 图标**由 `Info.plist` 的 `CFBundleIconFile` 决定
  （玻璃版 `AppIcon.icns`），运行时改不了 —— 改 bundle 内资源会破坏签名。
  随外观切换的是 Dock、⌘Tab、应用切换器里的运行时图标。
- 设置页拨开关后若不点「保存」直接关窗口，图标已变、界面待下次回主界面生效。
- 真人用鼠标点击 `SoftSwitch` 的手感、以及「拨开关 → 保存 → 界面切换」端到端链路
  未做人工验证；自检覆盖的是同一条代码路径与合成事件。

### 验证（本机实测）

- 双架构 `swiftc -typecheck` 通过；`build.sh` 装机 **1.3.0 / build 30**；
  `codesign -v --deep --strict` 通过；`x86_64 arm64`；
  源码与装机 `skeuo.html` / `wood-sprite.png` / `rope-tail.png` /
  `AppIcon.icns` / `AppIconSkeuo.icns` 五组 md5 逐字节一致。
- 三时区 `npm test` 全绿（168 + 39 + 24 + 20 + 305）。
- 图标探针：拟物 `skeuoMode=true → AppIconSkeuo.icns applied=true`；
  玻璃 `skeuoMode=false → AppIcon.icns applied=true`；两者
  `legacyMenuItem=false`（旧菜单项确已移除）。
- 切换探针：同一进程内 `DSH_CAL_APPEARANCE_FLIP=1` 使
  `AppIcon.icns → AppIconSkeuo.icns`，`appearanceStyle` 未被写入。
- 设置页真机快照：拟物 / 玻璃两种模式下设置页均可见，三行开关齐全，
  「全拟物外观」分别为开 / 关，布局无截断。

---

## [1.3.0] — 2026-11-08

已发布（tag `v1.3.0`）。完整发行说明见 `dist/notes-1.3.0.md`。
build 25–30 的界面修复与本轮功能增量另见 `docs/skeuo-webview-notes.md`。

## [1.2.2] 及更早

见 `dist/notes-1.2.2.md`、`dist/notes-1.2.1.md`、`dist/notes-1.2.0.md`、
`dist/notes-1.1.1.md`。

---

## 给负责 push 的模型

提交后 `main` 领先 `origin/main` **22 笔**，工作区应为 clean。
`cal-app/icon/` 与 `cal-app/.build/` 是生成物、被 `.gitignore` 忽略，不会进仓库。

```bash
cd /Users/unix/WorkBuddy/2026-11-03-19-34-56
git status                       # 应为 clean
git log --oneline -1             # 本轮 commit
git push origin main             # 普通快进推送
```

红线：

- **不要** `git push --force` / `--force-with-lease`
- **不要** 移动或删除任何已发布 tag（`v1.1.0` … `v1.3.0`）
- **不要** 打新 tag、发 GitHub Release、改 `dist/` 下的历史发行包
- 若推送提示非快进，先 `git fetch` 查清远端状态再问用户，不要自行 rebase / force
