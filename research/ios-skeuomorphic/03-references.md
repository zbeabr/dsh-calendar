# 来源清单

检索日期：2026-11-17。均为公开网页，未在真机或当前 SDK 上验证。

## 设计与历史

| 链接 | 支撑了什么 | 可信度 |
|---|---|---|
| [iOS design history: iPhone interface 2007 → iOS 27](https://www.appetiteui.com/blog/ios-design-history) | iOS 6 的材质清单（Find My Friends 皮革缝线、Game Center 绿毡与木、Podcasts 开盘机、Newsstand 木架、通知中心亚麻）；2012-10-29 Forstall 离职、Ive 接管；「纹理烘进位图 → 不能换肤」的判断 | 中高，叙述与公开史实一致 |
| [什么是 Skeuomorphic iOS?](https://designbycurio.com/zh/learn/skeuomorphism-ios6-2007) | 中文版设计系统梳理：桌毡/皮革/金线/金属/漆木的分工；高光与斜面用于表达「如何被触碰」 | 中高，偏设计教学 |
| [Screens Updated for iOS 6](https://www.techsos.blog/screens-updated-ios-6-guide) | Passbook 的碎纸机动画与卡片材质、iOS 6 银色拨号盘的凹面按钮、金属搜索栏 | 中，博客整理，细节生动但未标注一手来源 |
| [Remembering the Classic Interface of iOS 6](https://eathealthy365.com/remembering-the-classic-interface-of-ios-6) | 顶部中央固定光源这一条规则；Helvetica Neue Ultra Light；声音作为反馈的一部分 | 中，观点文，但「光源统一」与设计常识吻合 |

## 技术实现

| 链接 | 支撑了什么 | 可信度 |
|---|---|---|
| [UIAppearance Tutorial（raywenderlich）](https://www.raywenderlich.com/652-uiappearance-tutorial-getting-started/page/3) | `resizableImage(withCapInsets:)` 九宫格切片的实际用法；用 `UIAppearance` 批量替换分段控件/滑块/步进器皮肤 | 高，老牌教程，代码可考 |
| [九切片（CSDN）](https://blog.csdn.net/sinat_36521092/article/details/81350794) | 九宫格的中文原理说明与 Xcode 里切片的操作方式 | 中，入门向 |
| [How to make inner shadow in SwiftUI](https://stackoverflow.com/questions/60196081/how-to-make-inner-shadow-in-swiftui) | SwiftUI 没有原生 inner shadow，用「渐变 overlay + 遮罩」模拟 | 高，方案被广泛复用 |
| [Guide to Skeuomorphism Design（SkillUI）](https://skillui.com/en/skill/show/sickn33/agentic-awesome-skills/skeuomorphism) | 拟物按钮的 SwiftUI 写法：线性渐变底 + 顶部内高光 + 底部内暗 + 外投影；按下时切换为内凹 | 中，AI 生成的技能文档，代码结构合理但未编译验证 |
| [How to build neumorphic designs with SwiftUI](https://hackingwithswift.com/articles/213/how-to-build-neumorphic-designs-with-swiftui) | 内阴影的 mask 技巧、双层高光/暗影的偏移方式 | 高 |

## 趋势（判断「现在做还来不来得及」）

| 链接 | 支撑了什么 | 可信度 |
|---|---|---|
| [Design for Nostalgia（2025）](https://www.newsletter.designproject.io/p/design-for-nostalgia-why-pixel-art-and-retro-ui-are-dominating-2025) | 拟物回潮是「设计同质化 + 触感需求」的结果；今天的做法是「subtle、strategic」而非 2012 年那种全写实 | 中，趋势文，无硬数据 |
| [Skeuomorphic Design is Making a Comeback（2025）](https://felixitsolutions.com/?p=28/) | 回潮出现的位置：财务/效率类 dashboard、音视频控件、日历与任务类 app | 低，SEO 文章，仅作旁证 |

## 使用提醒

- 上表「中」「低」可信度的一律**只当设计语感参考**，不要作为技术依据。
- 涉及 API 签名的（`capInsets`、`glassEffect`、`.layerEffect`）以 Xcode 里的实际补全为准。
- 如果实测与本资料冲突，以实测为准，并在对应文件顶部标注。
