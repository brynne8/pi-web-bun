# Modern Web Guidance 前端审查报告

对 `modern-web-guidance` skill 的完整目录做了一次全量对照。`legacy-scan` 只覆盖 33 个指南、35 条确定性规则（约 20%），本报告覆盖其余部分。

生成方式：`modern-web-guidance list` 取全量目录（208 个）→ 按"本仓库是否有对应界面"分类 → 对 73 个有对应面的指南 `retrieve` 正文 → 逐条对照代码。

## 处置状态

审查之后动过手，也否掉了几个。这张表是当前的结论，细节在对应小节。

| 问题 | 状态 |
| --- | --- |
| composer 每敲一字两次强制重排 | 已修（`afed4369`）：改成一次测量，行为不变，测试钉住读写配对次数 |
| Google Fonts 的 `@import` | 有意保留：新设计要能整个文件搬走。改为在 head 里 preconnect 两个源（`afed4369`） |
| 时长手拼、两套格式不一致 | 已修（`c0c4461b`）：统一到 `Intl.DurationFormat`，缺失时按原样手拼 |
| URL 字段没有 URL 键盘、API key 没有 done 键 | 已修（`a4fc6ee2`）。原先"全应用 0 处 inputMode"的说法是错的，两个数字字段早就有了 |
| 折叠的 turn 内容 Cmd+F 搜不到 | 已否决：折叠内容没有人会去搜索，场景不成立 |
| composer 改 `field-sizing: content` | 已调查并否决：placeholder 在窄屏会折行，见 C9 |
| A1 自建模态框没有焦点 containment | 按决定降级：属键盘/读屏类，暂缓。技术严重度仍是全书第一 |
| E2 没有 forced-colors 处理 | 同上降级；且实际影响是"无边框表面掉边"，不是"层级全灭" |

## 浏览器策略：两轮判定

第一轮按 `AGENTS.md` 的 *Old Safari (iOS 16.2)* 判定。本轮起改用 `last 2 versions`（browserslist 标准查询，即每个浏览器的最新两个大版本）。按 2026-11 推算，新下限约为 Chrome/Edge 153+、Firefox 156+、Safari 26+、iOS Safari 26+。

代价必须先说清楚：这把下限从 iOS 16.2 一举推到 iOS 26，等于放弃 iOS 16 至 25 的用户。连带要改的有 `AGENTS.md` 的 *Old Safari (iOS 16.2)* 一节、`vite.config.ts` 的 `build.target: "safari16.2"`、`package.json` 的 `browserslist`，以及 `lib/markdown.ts` 里那套为绕开 lookbehind 而写的 `replaceNotPrecededBy()`（Safari 16.4 起原生支持）。这是产品决策，不是技术优化——本轮只做技术判定，采纳与否另说。

判定分三档：

- **可行动**：所需 API 在新下限之前就有，或纯 HTML/CSS 写法。
- **仍然阻塞**：Safari 或 Firefox 至今没有该 API，提基线也无用，只有上 polyfill 或放弃这两个浏览器才能解。
- polyfill 只在指南明确要求"特性检测后按需加载"时才算一条路；本项目 `vite.config.ts` 已有 pre-bundle 陷阱记录，新增依赖要先评估。

两轮之间解锁的内容集中在：`popover`、Invoker commands、`@starting-style`、`transition-behavior`、`light-dark()`、`text-wrap: balance`、`font-size-adjust`、`:user-invalid`、`Intl.DurationFormat`、`scrollbar-gutter`、`contrast-color()`、容器样式查询。仍卡死的是 Safari 或 Firefox 从未发布的那些（见 K 节）。

指南自带的浏览器支持表个别条目与事实不符（`accent-color` 实际 Safari 15.4 起就有，表里写 26.2；Anchor positioning 表里写"仅 Safari 27"也是反的）。报告以事实为准，并在涉及处注明；版本下限由指南表格加今日日期推断，未逐一与 caniuse 对账。

## A. 对话框与顶层层级

### A1 自建 modal 没有焦点 containment，背后页面也没 inert（可行动，影响大）

`role="dialog"` 共 7 处：`SettingsPanel.tsx:799`、`ProjectTrustDialog.tsx:220`、`DirectoryPicker.tsx`（2）、`ChatWindow.tsx`（2，扩展 UI 对话框）、`SidebarMenu.tsx`。配套的 `lib/stacked-dialog.ts` 手写了一整套平台本免费提供的能力：

| 手写实现 | 原生 `<dialog>` 提供的 |
| --- | --- |
| `listenForStackedDialogEscape` / `listenForPanelEscape` | Esc 与移动端返回手势 |
| `openStackedDialog` / `focusModalPanel` | 焦点移入与归还 invoker |
| `focusIfLost` / `focusAfterChange` | 焦点 containment 兜底 |
| `SettingsPanel` 的 pointerdown/click 配对 | `closedby="any"` 灯箱关闭 |

缺的两样：**没有 Tab 焦点陷阱**（全仓搜 `"Tab"` 只有菜单内导航，没有任何 containment），焦点可以 Tab 出"模态框"落到背后的应用里——`SettingsPanel` 是内联渲染在 `AppShell.tsx:3161`、没有 portal 到 body 末尾，所以背后界面就在同一个 Tab 序列里；**背后页面没有 inert**，键盘事件能送到背后的控件上（`AGENTS.md` 自己记着"composer 里的 `/mcp` 打开 Settings 后 Escape 会 reach the chat composer"，他们是用 `defaultPrevented` 把这个症状绕掉的，根因就在这里）。指针点击另说：`.settings-dialog-backdrop` 是 `position: fixed; inset: 0` 的全屏遮罩，点在主界面上实际落在遮罩上并触发关闭，所以这条的伤害集中在键盘与屏幕阅读器用户。

指南原文（`dialog` Rule 1）：原生 modal 提供 "inert page, focus containment, top layer, `::backdrop`, `Esc` and back-gesture dismissal, and focus return to the invoker"，并且 **"DON'T add `role="dialog"`, `aria-modal`, a focus trap, `inert` toggling or an `Esc` handler"**。`accessibility` 指南同结论："browsers set outside content as inert which is sufficient"。

原生 `<dialog>` 自 Safari 15.4 起可用，**可行动**。改用 `last 2 versions` 后迁移阻力更小：`command="show-modal"` + `commandfor`（Safari 26.2）、`popover`（Safari 17 / iOS 18.3）都已进下限，声明式开合和非模态面板都能走原生方案。迁移后可删掉 `stacked-dialog.ts` 的 Esc/焦点手工代码，只剩两处要留：

- `closedby`（灯箱关闭）Safari 至今没有，提基线也无用。`SettingsPanel` 现有的 pointerdown + click 配对写法与指南给的 fallback 片段一致，保留即可。
- IME 判定要留下：`lib/stacked-dialog.ts` 的 `cancelsComposition()` 是对的，原生 dialog 的 Esc 不管 IME，需要 `cancel` 事件里自己挡。

### A2 原生 dialog 上的 body overflow 锁是无操作（不构成缺陷，记录备查）

`MermaidBlock.tsx:217-222` 和 `ImagePreview.tsx:29-35` 用了原生 `<dialog>` + `showModal()`，紧接着又 `document.body.style.overflow = "hidden"`，关闭时恢复原值。

指南（`prevent-page-scroll-under-modal-dialog`）禁止这么做：**"DO NOT apply `overflow: hidden` or `position: fixed` to `<html>` or `<body>` to lock background scrolling… Mutating root overflow removes the page scrollbar (causing horizontal layout shift), can reset or jump the page scroll position, and can break `position: sticky`"**。

但在本仓库它不产生任何效果：`app/globals.css:349-356` 已经声明 `html, body { height: 100dvh; overflow: hidden }`，文档本身不滚动，没有根滚动条可移除，内联赋值只是写了一个与样式表相同的值，恢复时又写回空串。真正该做的是删掉这四行死代码——不是因为它有 bug，而是因为它让人误以为这里需要锁滚动。

指南要求的替换 CSS（`dialog:modal { overscroll-behavior: contain }` 加 `dialog::backdrop { overflow: hidden; overscroll-behavior: contain }`）在本应用同样没有必要，理由同 A3。

### A3 自建 modal 没有滚动 containment（当前不构成缺陷，记录备查）

`app/settings.css:1453` 的 `.settings-dialog-backdrop` 没有 `overscroll-behavior`。指南要求在 `dialog:modal` 与 `dialog::backdrop` 上设 `overscroll-behavior: contain`，否则对话框内滚到边界会把滚动手势链给背后页面。

本应用没有可链的目标：`html, body` 是 `overflow: hidden` 的固定视口，`.settings-dialog-backdrop` 是 `position: fixed; inset: 0`，其祖先链上没有任何可滚动容器。所以这条现在不产生用户可见问题。

保留记录是因为前提会变：哪天文档变成可滚动的（长会话、打印样式、内嵌模式），或者设置面板自己变成可滚动且背后出现滚动容器，这条就会立刻变成真问题。`app/globals.css` 里已有 6 处 `overscroll-behavior: contain`，写法在本仓库有先例。

### A4 焦点指示被关掉且无替代（可行动，需逐个确认）

`app/settings.css:1463-1466`：

```css
.settings-dialog-backdrop:focus { outline: none; }
```

`accessibility` 指南：**"Mandatory - Don't disable browser native focus indicators without providing a replacement custom focus indicator"**（对比度至少 3:1）。全仓 `outline: none` 25 处，同时 `:focus-visible` 73 处——大部分控件有替代样式，但这处对话框容器没有。该容器 `tabIndex={-1}`、不是交互控件，属于"焦点环噪音"的合理权衡，但与指南字面冲突，记为待确认。

### A5 查找栏用 role="search" 而不用 search 元素（可行动，一行）

`FileViewer.tsx:2292`：`<div className="file-find" role="search">`。

`html` 指南：**"DO use `<search>` to enclose search and filtering mechanisms (eliminates the need for `role="search"`)"**。`<search>` 无兼容性问题。

### A6 全屏 dialog 用 100vw（冗余，当前无害）

`app/globals.css:1766`（`.image-preview-dialog`）和 `1839`（`.mermaid-zoom-dialog`）：`width: 100vw`。

`css-layout` 指南：**"Don't use `100vw` for full-width layout — it ignores scrollbar width and causes horizontal overflow. Use `100%`, `100dvw`, or `100svw` instead."** 这两个元素已经是 `position: fixed; inset: 0`，`width: 100vw` 是冗余的；而由于文档不滚动（`html, body { overflow: hidden }`），没有滚动条宽度可撞，所以现在不会溢出。改 `100%` 是与 `inset: 0` 一致的正确写法，属清理而非修 bug。其余 5 处 `calc(100vw - 16px)` 是 max-width 用法，不在此列。

### A7 可滚动代码块缺 tabindex 与 role="region"（可行动，低优先）

`MessageView.tsx:151`、`1466` 的 `<pre>` 既没有 `tabindex="0"` 也没有 `role="region"`/可访问名；全仓 `role="region"` 0 处。

`html` 指南：**"DO ensure that code blocks are accessible by adding `tabindex="0"` to the `<pre>` element if it becomes scrollable"** 并配 `role="region"` + `aria-labelledby`/`aria-label`。这两个 `<pre>` 用 `white-space: pre-wrap` 不横向滚动，但长内容仍会纵向溢出；`MarkdownBody` 渲染的围栏代码块同理，需要一并核对。

### A8 行号是用 CSS content 传递的有意义文本（可行动）

`app/globals.css:1632-1634`：

```css
.markdown-code-line-number::before {
  content: attr(data-line-number);
}
```

代码块的可见行号完全来自生成内容，DOM 里没有对应文本节点——注释说明了这是故意的（`user-select: none` 仍会让浏览器在跨行选中时画出数字，所以改成生成内容）。

`accessible-generated-content` 指南：**"DON'T use `content` to convey meaningful text (labels, state, instructions) — keep that in the DOM (WCAG F87)"**，并说明 alt 文本参数只是"意外承载了意义的装饰内容"的降害手段，不是许可证。行号属于有意义文本，屏幕阅读器读不到。

指南给的补救是给生成内容加 alt 文本参数（`content: … / "替代文本"`），Baseline 2024-07-09、Safari 17.4 起可用，`last 2 versions` 下已进下限。要么补 alt，要么把数字放回 DOM 再用别的方式避开选中绘制。

## B. 折叠内容可查找性

### B1 折叠的 turn 段落不在 DOM 里，Cmd+F 搜不到（已否决）

`MessageView.tsx` 的折叠是 `{expanded && (...)}`（思考段 1188 行、工具卡 1278 行等），折叠后整段被卸载，所以浏览器的页内查找找不到它。

**否决理由：折叠内容没有人会去搜索。** 用户先在会话里读到一段思考或工具调用，才会想去里面找字；会去 Cmd+F 的是自己打过的话和模型的回答，那些始终在 DOM 里。为一个不存在的使用场景去重做整个 fold 的头部 UI（`<details>` + `summary` 重构）不划算。

记录保留，是因为这个结论依赖"没人搜折叠内容"这个判断；哪天真有人这么用，指南给的路线（`<details>` 的 `name` 属性做互斥折叠组，Baseline 2020、Safari 6 起就有）仍然有效。

## C. 表单与校验

### C1 :user-invalid 未使用（可行动）

`aria-invalid` 5 处，`:user-invalid` / `:user-valid` 0 处。

`forms` 指南：**"DO use CSS pseudo-classes `:user-invalid` for non-intrusive styling"**、**"DON'T use the raw `:invalid` CSS pseudo-class alone for error styling"**。`:user-invalid` 需 Safari 16.5，在 iOS 16.2 基线下差 0.3 个版本；`last 2 versions` 下已进下限，可以直接上 CSS，不必走 class 兜底。

### C2 原生 switch 属性不可用（不是问题）

指南自己写明 `<input type="checkbox" switch>` 只有 Safari 17.4，Chrome/Edge/Firefox 都不支持。项目用 `type="checkbox"` + 样式化（8 处）是当前唯一跨浏览器做法。可做的是按 `checkbox` 指南补齐：`:focus-visible` 而非 `:focus`、焦点指示 3:1 对比度、44px 命中区、`:disabled` 变体。

### C3 accent-color 只用了 1 处（可行动，低优先）

`app/settings.css` 1 处，而全仓有 8 个 `type="checkbox"`。`brand-consistent-forms` 指南：**"DO use `accent-color` to easily theme form controls to match your brand"**，并提醒 Safari/Android Chrome 有对比度反转 bug，别用贴近背景的颜色。注意指南的支持表写 Safari 26.2 与事实不符（实际 15.4 起），以事实为准可用。

### C4 inputmode 与 enterKeyHint（原断言有误，残留已修）

原报告写"全应用 0 处 `inputMode`"，这是错的——那次检索用了小写 `inputmode`，漏了驼峰写法。实际情况：`ToolsConfig.tsx:406` 和 `ModelContextWindow.tsx:29` 早就给两个数字字段设了 `inputMode="numeric"`，真正缺的只有两样：

- URL 字段（`ModelsConfig.tsx` 的提供商 Base URL 与自定义模型的 Base URL）没有 `inputMode="url"`，手机上拿不到带 `.`、`/`、`.com` 的键盘。已补。
- `enterKeyHint` 全应用 0 处。API key 字段的 Enter 就是保存，已补 `enterKeyHint="done"`。

提交 `a4fc6ee2`。只动了值类型明确的字段，没有全面铺开。

### C5 autocomplete="off" 用在 API key 字段（可行动，低优先）

`ModelsConfig.tsx` 的 API key 字段 `autoComplete="off"`。`forms` 指南：**"DON'T use `autocomplete="off"` on credential, address, payment, or contact fields… Use a specific token instead"**。API key 属凭证类。登录页本身是对的（`type="password"` + `autoComplete="current-password"`），符合 `autofill-sign-in-form` 指南。

### C6 校验时机基本符合

抽核 `ModelsConfig`（Save 时校验，符合"validate on submit"）、`McpAddServer`（粘贴即时解析属于解析而非错误提示）。未发现"每次按键都报错"的模式。`required-field-feedback` 要求的"必填项留空只在交互后提示"没有统一机制，记为待确认而非确证。

### C7 上传进度用 live region 播报而不是 progress 元素（可行动）

`components/FileExplorer.tsx:1568`：上传阶段用 `role="status" aria-live="polite"` 播报 "checking" / "uploading"，且带数值进度（`uploadProgress`）。全仓 `<progress>` 0 处。

`accessibility` 指南：**"Don't use live regions for interstitial states like 'Loading…' or 'Updating…' unless they're meaningfully informative — they usually just create noise. Use the HTML `<progress>` element or the ARIA `progressbar` role for this purpose instead."** `progress` 指南同样要求用 `<progress>`，并强调**不要**给 `<progress>` 加 `tabindex` 或调 `.focus()`。带数值的进度正是 `<progress>` 的场景，元素本身无兼容问题。

### C8 autofill 高亮缺失（可行动，低优先）

`:autofill` 0 处。`autofill-highlight-inputs` 指南要求给自动填充的字段一个可见状态，并提醒**不要**在该状态改布局属性（`border-width`、`padding`），也不要为它去掉焦点环。`:autofill` 按指南是 Chrome 110 / Edge 110 / Safari 15，Firefox 没有——作为纯 CSS 增强加上无害，Firefox 用户只是看不到高亮。

### C9 composer 的自动增高仍是 JS（已调查并否决）

`components/ChatInput.tsx` 的 `autoGrowTextarea()` 用 `scrollHeight` imperative 撑高输入框，上限 200px，CSS 侧（`.chat-input-textarea`）只设了字号，没有 `field-sizing`。这是 `legacy-scan` 最早报出的 4 条之一，当时以"Safari 16.2 没有 `field-sizing`"搁置；`last 2 versions` 下 `field-sizing` 的 Baseline 是 2026-06-16、Safari 26.2 起可用，按理可以动了。

**否决理由：placeholder 在窄屏会折行，迁移会改变空框高度。** 指南说 `field-sizing` 的尺寸计算**包括 placeholder**（"to fit their content (including placeholders)"），而现有 JS 是刻意把 placeholder 排除在测量之外的——`autoGrowTextarea` 的注释写了理由：否则空框会涨到提示行数。本项目的 placeholder 确实会折行：

- `chat.messagePlaceholder`："Message… Type / for commands, @ for files" / "消息…输入 / 使用命令，输入 @ 查找文件"
- `chat.compactingPlaceholder`："正在压缩…消息会排队，压缩结束后发送"

在 360px 宽的手机上这些是两行。直接换上 `field-sizing: content`，空着的 composer 就会变成两三层高——正是现在这段 JS 花功夫避免的行为，而这个项目对移动端投入很大。

已经做的是另一件事：`autoGrowTextarea` 原来每次敲键强制两次重排，已改成一次测量（`afed4369`），行为不变。

将来的路线（需要真机验证后再动）：`field-sizing` 只作用于非空状态，空框保持 CSS 高度——

```css
@supports (field-sizing: content) {
  .chat-input-textarea:not(:placeholder-shown) { field-sizing: content; }
}
```

空框时 `:placeholder-shown` 成立，规则不生效，高度可证明不变；有字时原生撑高，JS 整个删掉。没有直接采用，是因为"`rows={1}` 与 `field-sizing: content` 如何互相作用"这一点无法在此环境用真浏览器验证，而 composer 是全应用最重要的输入框，不值得为一个nice-to-have赌它。

## D. 动效

### D1 没有 @starting-style / transition-behavior（可行动）

0 处。侧栏折叠（`useSidebarMotion`）和对话框出现都是瞬切。

`animate-to-from-top-layer` 指南要求入场用 `@starting-style`、退场用 `transition-behavior: allow-discrete` + `overlay`。`last 2 versions` 下 `@starting-style`（Safari 17.5）和 `transition-behavior`（Safari 17.4）都已进下限，入场和退场都能做；只有 `overlay` 属性 Firefox/Safari 仍没有，退场要按指南的 `data-closing` 兜底：设属性触发退场过渡，`getAnimations()` 尘埃落定后再 `.close()`。

指南另外要求把 transform 类动效放进 `@media (prefers-reduced-motion: no-preference)`、在 `reduce` 里缩短时长——这条与基线无关，现在就该遵守。

### D2 prefers-reduced-motion 只用了 reduce（可行动，低优先）

7 处 `prefers-reduced-motion: reduce`，0 处 `no-preference`。`motion` 指南要求把 transform 类动效放进 `@media (prefers-reduced-motion: no-preference)` 门控。现状"默认有 + reduce 时关"语义等价，但指南的写法能防止未来新增动效忘记 reduce。

## E. 颜色与主题

### E1 color-scheme 没有 light dark 基础声明（可行动，低优先）

17 处取值全是 `dark` / `light`（按 `html.dark`、`[data-theme="..."]` 分主题设），没有一处 `color-scheme: light dark`。

`dark-mode` 指南：**"DO NOT hardcode `color-scheme: light` or `color-scheme: dark` as the root default; the base declaration MUST stay `light dark`"**。项目在 `<html>` 上挂 `data-theme`（`useTheme`），首帧前由 JS 决定，实际风险低于指南担心的场景，但字面相悖。

### E2 没有 forced-colors 处理（可行动，影响 Windows 高对比度用户）

0 处。`color` 指南的 Forced Colors Mode 段：**"Don't rely on `background-image`, `box-shadow`, or `border-image` to convey borders, separators, or state"**。

实查之后影响比初判小：选中态和悬停态主要靠背景色表达，而背景色在高对比度下会映射成系统色、仍然可见，丢的只是渐变叠加。真正丢的是**只靠阴影定义边缘**的表面——`app/new_design.css:316-318` 那种 `border: 0` + `--nd-mat` 阴影的玻璃面，高对比度下阴影被擦掉，卡片没有任何可见边缘。

forced-colors 在 Chrome/Edge/Firefox 都是 Widely available，与基线无关。按决定归入读屏/可读性类暂缓；真要动的时候，给那几处补一条 `@media (forced-colors: active)` 的真边框（用 `CanvasText` 等系统色关键字）即可。

### E3 scrollbar-width: thin 4 处（可行动，低优先）

`browser-ui-theming` 指南：**"DON'T use the `scrollbar-width` with any value other than `auto`, unless another accessible option is provided to scroll content… the target size of the thumb will be too small for some users to operate"**。

`adapt-scrollbar-to-contrast-preferences` 指南还要求响应 `prefers-contrast` 提高滚动条可辨性——`prefers-contrast` 0 处。

符合的部分：`scrollbar-color` 用了（15 处 scrollbar-* 相关）但没有任何 transition，避开指南点名的 WebKit bug 311752（滚动条闪烁）。

### E4 light-dark() 未使用（可行动）

0 处。`last 2 versions` 下 Safari 17.5 已进下限，可用。`dark-mode` 指南的完整方案是 `:root`/`html` 基础声明保持 `color-scheme: light dark`、按主题覆盖、颜色用 `light-dark()` 成对书写。项目现在全靠 `data-theme` + CSS 变量（`app/globals.css` 17 处 `color-scheme`），能工作但不是指南的写法。

### E5 dark-mode-toggle：一处符合，一处无场景

符合：`hooks/useTheme.ts` 的 `syncAutoThemeFromSystem()` 只在 `preference === "auto"` 时行动，且以 `persist: false` 写状态——不清 `localStorage` 里用户存的值。`dark-mode-toggle` 指南：**"DO NOT use `matchMedia()` to remove the stored value when the system preference changes to match it"**，这条做到了。

无场景：`contrast-color()`（Chrome 147 / Edge 147 / Firefox 146 / Safari 26）与容器样式查询（Safari 18 起）在 `last 2 versions` 下都可用，但本项目没有对应场景——没有放在动态背景上的文字，密度与主题变化走 `data-theme` + CSS 变量。列为已解锁但不需要，不算欠账。

## F. 性能

### F1 Google Fonts 用 CSS @import（可行动）

`app/new_design.css:1`：`@import url("https://fonts.googleapis.com/css2?family=…")`。

`performance` 指南：**"DON'T use `@import` in CSS: This creates sequential request chains that delay the CSS Object Model (CSSOM) construction."** 同时 `preconnect`/`dns-prefetch` 0 处。改成 HTML 里的 `<link rel="preconnect">` + `<link rel="stylesheet">`。另两处 `@import`（`tailwindcss`、`@xterm/xterm/css/xterm.css`）是构建期入口，由 Vite 处理，不是运行期请求链，不算问题。

### F2 content-visibility 用得完全正确（符合）

`app/globals.css:1648-1650`：

```css
.markdown-code-stream-chunk.is-frozen {
  content-visibility: auto;
  contain-intrinsic-block-size: auto calc(64 * 1.62em);
}
```

指南要求"DO pair `content-visibility` with `contain-intrinsic-size`"并且"use the `auto` keyword and a value derived from the content, preferably `rem`/`lh`/`em`/`ch`"——三条全中。

### F3 其余

`scheduler.yield()` 0 处，用 `requestIdleCallback`（`lib/highlight-queue.ts` 3 处，延迟语法高亮）。`performance` 指南建议 `scheduler.yield()` + `setTimeout` 兜底，但 `scheduler.yield` 目前只有 Chromium 系有，Firefox 和 Safari 都没有——属仍然阻塞，见 K 节。`fetchpriority` 0 处，但本应用 LCP 是文本不是图片，不适用。动态 `import()` 24 处，代码分割充分。

## G. 安全与隐私

### G1 CSP 只覆盖文件路由，没有站点级策略（可行动，工作量大）

现有：`X-Content-Type-Options: nosniff`（5 处）、`frame-ancestors` / `X-Frame-Options`（4 处）、`Referrer-Policy`（2 处）——都只在 `app/api/files/**`、`app/api/sessions/[id]/export`、`tool-result-image` 三个路由上。

`security` 指南的 Phase 3 要求的是站点级完整 CSP：先 report-only 再 enforce，`require-trusted-types-for 'script'`、COOP、CORP、`Permissions-Policy`、HSTS、`__Host-` cookie 前缀、logout 时 `Clear-Site-Data`。`app/api/web-auth` 的 DELETE logout 路由没有 `Clear-Site-Data`。这一条是本报告里工程量最大的一条。

### G2 dangerouslySetInnerHTML 4 处（待核对）

`app/layout.tsx`、`MermaidBlock.tsx`（2）、`AnsiText.tsx`。前两者是 mermaid 渲染出的 SVG（库生成）与 ANSI 文本上色，需要确认输入链路。Sanitizer API（`setHTML()`）按指南是 Chrome 146 / Firefox 148、Safari 不支持 → 仍然阻塞，DOMPurify 仍是正解，项目也已经在用。

### G3 localStorage 62 处（符合）

`privacy` 指南：**"DON'T store sensitive tokens or PII in `localStorage`"**。项目存的是 UI 偏好（侧栏固定、草稿、主题、文件页签），不含凭证。

## H. 日期与时间（已修）

`new Date()` 52 处、`toLocaleString` 30 处、`Intl.RelativeTimeFormat` 3 处；`Temporal` 0 处、`Intl.DurationFormat` 0 处。

### H1 时长格式化是手拼字符串（已修，`c0c4461b`）

原有**两个**各自为政的手写格式化函数：`lib/turn-duration.ts:67-71` 出 `1h 2m 5s`，`lib/session-stats-format.ts:32-36` 出 `1h 2m`（有小时就丢秒）。同一个"会话活跃了多久"在回合页脚和统计行里给出不同精度，而且两者都硬编码英文字母，藏在全中文的界面里。

`calculate-event-differentials` 指南：**"DO format durations for user display using `duration.toLocaleString()` or `new Intl.DurationFormat(locale, { style })` … instead of manually interpolating `${duration.years}y ${duration.months}m...`"**。

现在统一到 `lib/i18n/format.ts` 的 `formatDuration(ms, locale)`，`style: "narrow"`——这个样式的英文输出与原来手拼的完全一致（`14s`/`3m 5s`/`1h 5m 3s`，零值单位自动省略），所以英文用户看不到变化，其他语言立刻本地化（中文 `3分钟5秒`）。`Intl.DurationFormat` 缺失时（Safari 16.4 之前）按原样手拼，那条路径有测试钉住。

副作用：统计行的精度变了——一小时以上的活跃时间现在保留秒，与回合页脚一致。

测试原先没传 locale，靠机器默认语言蒙对；已改为分别钉住英文、中文和降级路径。

### H2 Temporal 仍然阻塞

`sort-high-precision-timestamps` 指南要求 `Temporal.Instant`。Temporal 按指南数据是 Chrome 144 / Edge 144 / Firefox 139，Safari 至今没有，提基线也无用。解析与排序继续用 `Date`；这条只能等 Safari 或上 polyfill。

## I. 布局、CSS 与排版

### I1 font-size 用 px 244 处（可行动，属设计系统决策）

`typography` 指南：**"DON'T use `px` for font-size. Prefer `rem` to honor the user's browser font-size preferences"**。

抗辩：项目有一套自己的字号体系（`--chat-content-font-size` + `--chat-font-size-offset`，用户在 Settings 里可调，`FontSettings`）。但 244 处里大量是 11px/12px 的固定 UI 说明文字，不跟随浏览器根字号。改造量大，属设计系统决策而非疏漏。

### I2 text-overflow: ellipsis 41 处（基本符合）

`form-factor-adaptation` 指南：**"DO NOT truncate headings with `text-overflow: ellipsis`"**。抽样看到的是会话行、模型名、文件名（非标题），可接受；若有标题被省略需单独处理。`-webkit-line-clamp` 三件套 2 处，指南明确说这个 pattern 是 fully specified、未废弃，用法正确。

### I3 title 属性做提示 291 处（可行动，面广）

`accessibility` 指南：**"Don't use `title` as a naming mechanism"**（键盘取不到）；`html` 指南：**"DON'T use the `title` attribute to create tooltip effects, as these cannot be accessed using a keyboard"**。

全仓 `title={` 291 处。多数挂在有可见文本或 `aria-label` 的按钮上（所以不是命名问题），但作为提示它们键盘不可达。`interest-triggered-tooltips` 指南讲的 Interest invokers 只有 Chromium 系有（Chrome 149），Firefox 和 Safari 都没有 → 仍然阻塞；可行动的部分是给关键提示补一个键盘可达的 `aria-describedby` 目标（项目已有 24 处 `aria-describedby` 的先例）。

### I4 无 skip link、无 visually-hidden 类（低优先）

`accessibility` 指南提到 skip link；全仓 0 处，也没有 `.sr-only` 类（`clip-path: inset(50%)` 0 处）。这是 SPA 应用外壳而非文档流，skip link 价值低；缺 `.sr-only` 意味着将来要加屏幕阅读器专用文本时没有现成手法。

### I5 text-wrap: balance 与 font-size-adjust 可用而未用（可行动）

`text-wrap` 0 处、`font-size-adjust` 0 处。`improve-text-layout-and-legibility` 指南：`text-wrap: balance` 用于短标题，但 **"DO NOT apply `text-wrap: balance` globally"**（浏览器用的是代价高的二分查找）；`text-wrap: pretty` 更贵且 Firefox 没有，只用 balance。`visually-stable-font-fallbacks` 与 `visually-stable-mixed-fonts` 要求 `font-size-adjust` 并配 `@supports` 兜底（指南 MANDATORY：不支持的浏览器会按自然字号渲染）。两者在 `last 2 versions` 下都已进下限（Safari 17.5 / 17）。

### I6 已符合的现代 CSS

`:has()` 27 处、`color-mix()` 103 处、`subgrid` 2 处、`container-type` + `@container` 各 1 处、`overscroll-behavior` 8 处、`scrollbar-gutter`（Safari 18.2 起，降级无害）、`prefers-reduced-motion` 16 处、`inert` 16 处（`html` 指南明确要求用 inert 隔离隐藏区）、`@property` 2 处、`clamp()` 3 处、`aspect-ratio`、CSS 逻辑属性、`env(safe-area-inset-*)` 36 处。`oklch` 0 处但也没直接生成 tint，`color` 指南警告的"只调 oklch 亮度"没有踩。

## J. 菜单

`SidebarMenu` 与 ChatInput 的命令面板是自建菜单（`role="menu"` 2 处）。`menu` 指南的键盘规则与 API 无关、现在就能核对：**"Tab. Leaves the menu system. Do not trap focus or step through every command. Closing must not leave focus inside hidden content."** 项目有 `focusIfLost` 等处理，基本符合。

指南推荐的实现路径部分仍然阻塞：focusgroup 只有 Chromium 系有（Chrome 150），Firefox 和 Safari 都没有；`popover`（Safari 17 / iOS 18.3）在 `last 2 versions` 下已进下限，可以用于菜单容器，但锚定定位（anchor positioning）按指南数据 Safari 27 起、且该表与实际不符，暂不计入。

## K. 逐指南结论表

73 个有对应面的指南分四类。"有发现"指正文 A–J 里有对应小节；"符合"指逐条对过指南规则（依据见 M 节）。

| 结论 | 指南 |
| --- | --- |
| 有发现、可行动 | dialog、light-dismiss-a-dialog、accessibility、accessible-generated-content、html、search-hidden-content、forms、required-field-feedback、accessible-error-announcement、validate-input-after-interaction、style-parent-with-has、brand-consistent-forms、checkbox、switch、autofill-highlight-inputs、motion、animate-element-entry-exit、animate-to-from-top-layer、color、dark-mode、component-specific-light-dark-theme、adapt-scrollbar-to-contrast-preferences、browser-ui-theming、customize-scrollbar-color-and-thickness、performance、security、privacy、typography、improve-text-layout-and-legibility、form-factor-adaptation、progress、custom-button-actions、declarative-dialog-popover-control、visually-stable-font-fallbacks、visually-stable-mixed-fonts、calculate-event-differentials（仅时长格式化）、form-fields-automatically-fit-contents |
| 已核实符合 | ime-safe-enter-submit、autofill-sign-in-form、child-state-based-styling、content-based-styling、css、css-layout、fluid-scaling、size-aware-styling、responsive-design、single-line-overflow、overflow-clipping-control、sanitize-untrusted-html、dynamic-sort、drag-and-drop、scroll-target-on-load、scroll-position-aware-elements、scroll-completion-effects、defer-rendering-heavy-content、respect-os-text-scale、natural-interactions、content-first-noise-reduction、dark-mode-toggle |
| 已解锁但无对应场景 | contrast-color、selector-atrule-combinations、design-token-reactivity、usage-aware-component-variations |
| 仍然阻塞 | `Temporal`（Safari 无）、`hidden="until-found"`（Safari 无）、`closedby`（Safari 无）、`overlay` 属性（Firefox/Safari 无）、focusgroup（Firefox/Safari 无）、Interest invokers（Firefox/Safari 无）、`scheduler.yield`（Firefox/Safari 无）、`@function`（Firefox/Safari 无）、`text-wrap: pretty`（Firefox 无）、`interpolate-size`/`calc-size()`（Firefox/Safari 无）、`at-rule()`（Safari 无）、`moveBefore()`（Safari 无）、Sanitizer API（Safari 无）、`scroll-initial-target`（Firefox/Safari 无）、容器滚动状态查询（Firefox/Safari 无）、滚动方法 promise（Firefox/Safari 无） |
| 无对应界面 | 135，见下 |

仍然阻塞的 API 对应 6 个整条指南加 6 个指南的一部分：整条阻塞的是 `animate-to-intrinsic-sizes`、`persistent-top-layer-ui`、`sort-high-precision-timestamps`、`interest-triggered-action-previews`、`reduce-style-repetition`、`atrule-support-conditionals`；部分阻塞的是 `menu`（focusgroup）、`interest-triggered-tooltips`（Interest invokers）、`calculate-event-differentials`（Temporal）、`search-hidden-content`（`hidden="until-found"`）、`animate-to-from-top-layer`（`overlay`）、`dialog`（`closedby`）、`performance`（`scheduler.yield`）、`sanitize-untrusted-html`（Sanitizer API）、`scroll-target-on-load`（`scroll-initial-target`）、`scroll-position-aware-elements`（容器滚动状态查询）、`scroll-completion-effects`（滚动方法 promise）。这些要么上 polyfill，要么放弃 Safari/Firefox，要么继续手写——提基线解决不了。

## L. 无对应界面的 135 个指南

按"本仓库有没有这个界面或这条链路"排除，共 135 个。其中 `defer-rendering-heavy-content` 的规则实际已在 F2/F3 判定（结论符合），因此不列入下表；下表是其余 134 个确实没有对应界面的。每条理由在分类时逐条记录，按类归并。

| 类别 | 数 | 指南 |
| --- | --- | --- |
| 3D / WebGL / canvas | 10 | apply-webgl-shaders、interactive-content-in-3d-scenes、export-html-media-from-canvas、expose-canvas-content-to-browser-features、complex-shapes、shaped-cutouts、visual-effects、visually-texture-content、calculate-with-intrinsic-sizes、scroll-entry-exit-effects |
| 媒体与轮播 | 13 | lazy-load-video-and-audio、carousel、carousel-slide-effects、carousel-snap-highlights、scroll-snap-realtime-feedback、scroll-snap-state-sync、parallax-scroll-effects、scrollytelling、interactive-content-reveal、pull-to-reveal、swipe-to-remove、swipe-to-reveal、2d-panning |
| 认证 | 12 | passkeys、passkey-authentication、passkey-conditional-create、passkey-management、passkey-reauthentication、passkey-registration、quick-sign-ins、verify-email-ownership、sms-otp-form、autofill-payment-form、autofill-sign-up-form、autofill-address-form |
| 密码与网络 | 9 | client-side-encryption、digital-signatures、local-network-access、restrict-outbound-connections、validate-origins、secure-external-subresources、trusted-types、install-web-app、migrate-web-app-origin |
| 分析与实验 | 9 | batch-analytics-events、full-session-analytics、calculate-total-foreground-time、flicker-free-client-side-ab-testing、deprioritize-background-fetches、detect-initial-visibility-state、identify-heavy-scripts、identify-inp-causes、interaction-paint-timing |
| 端侧 AI 与 agent | 8 | language-model、summarizer、translator、language-detection、agentic-forms、agentic-javascript-tools、webmcp、cpp-on-the-web |
| Web Components | 7 | web-components、custom-elements、accessible-web-components、form-associated-custom-elements、shadow-dom、styling-web-components、prerendering-custom-elements |
| 组件形态（无此控件） | 25 | accordion、app-menus、breadcrumbs、copy-button、hovercard、navbar、navigation-drawer、persistent-app-tours、persistent-toast-notifications、progress-ring、scrollspy、spinner、stack-drill-down、tabs、toolbar、animated-select-picker、branded-select-styling、custom-select-picker-layouts、rich-media-picker、select-menu-interaction、slider、drag、sortable-table、responsive-table、spatial-navigation |
| 动效形态（无此效果） | 14 | custom-text-decorations、equal-width-text-lines、precise-text-alignment、soft-edge-content-fade、dynamic-sibling-styling、individual-transform-properties、dynamic-sibling-animations、group-element-transitions、physics-based-easing、scoped-component-transitions、directional-navigation-transitions、highlight-text-ranges、move-dom-element-without-losing-state、anchor-positioning-tab-underline |
| 导航与过渡（无此模式） | 4 | cross-document-transitions、consistent-cross-document-transitions、faster-spa-view-transitions、same-document-transitions |
| 滚动与浮层（无此形态） | 6 | position-aware-tooltips、scroll-progress-indicator、scrollability-affordance-hints、shrinking-header-on-scroll、state-aware-sticky-headers、viewport-aware-dropdowns |
| 性能与资源（无此链路） | 14 | break-up-long-tasks、conditional-async-dependencies、defer-work-until-scroll-ends、deliver-optimized-decorative-images、efficient-background-processing、improve-next-page-load-performance、interactions-in-complex-layouts、optimize-image-priority、optimize-preload-priority、optimize-script-priority、out-of-order-html-streaming、resolution-optimized-pseudo-elements、schedule-tasks-by-priority、icons |
| 日期（无此场景） | 3 | capture-location-agnostic-data、coordinate-global-events、support-global-calendar-systems |

## M. "已核实符合"的依据

一条一行，指代码里的证据。没有单独小节的是因为结论就是"做了且无需改动"。

- **ime-safe-enter-submit**：`components/ChatInput.tsx:1507-1512` 用 `isComposing || keyCode === 229` 加 `recentlyComposed` 时间窗；本轮已补上 `FileViewer.tsx:2299`、`ModelsConfig.tsx:1755` 两处遗漏（提交 `a7cbf96d`）。
- **autofill-sign-in-form**：`app/login/page.tsx` 是 `type="password"` + `autoComplete="current-password"`。
- **child-state-based-styling / content-based-styling**：`:has()` 27 处，用于按子元素状态或存在性样式化父级。
- **css**：没有全局 `*` reset；用 `:not()` / `:is()` 而非堆覆盖规则；没有嵌套 `:has()`。
- **css-layout**：没有 `overflow: scroll`、没有 `grid-auto-flow: dense`、没有用 `order` 或 `*-reverse` 重排交互内容、没有同时设 `flex-basis` 与 `width`。
- **fluid-scaling / size-aware-styling / responsive-design**：`clamp()` 3 处、容器查询单位 2 处、`container-type` + `@container` 各 1 处、dvh 单位 17 处、`env(safe-area-inset-*)` 36 处。
- **single-line-overflow**：ellipsis 41 处抽看均为非标题文本；多行截断用指南认可的三件套。
- **overflow-clipping-control**：没有 `overflow-clip-margin` 的使用需求，也没有把 `overflow: clip` 用在需要编程滚动的容器上。
- **sanitize-untrusted-html**：DOMPurify 已在用；全仓 `innerHTML` 直写 0 处。
- **dynamic-sort**：模型重排保持 React key（`docs/agents/models.md` 记着 `modelKeysRef` 正是为此存在），不重建节点。
- **drag-and-drop**：HTML5 拖放加键盘路径（Alt+↑/↓），符合指南"必须支持键盘重排"。
- **scroll-target-on-load**：聊天落底用 JS 实现；`scroll-initial-target` 阻塞但此处不需要。
- **scroll-position-aware-elements**：minimap 的滚动箭头用 JS；容器滚动状态查询阻塞但此处不需要。
- **scroll-completion-effects**：没有用 `setTimeout` 猜滚动时长。
- **defer-rendering-heavy-content**：`content-visibility` 与 `contain-intrinsic-size` 配对正确，见 F2。
- **respect-os-text-scale**：项目自带字号设置，且 `font-size: max(16px, …)` 防 iOS 输入缩放；`text-scale` meta 只有 Chromium 有，不需要。
- **natural-interactions**：`linear()` easing 阻塞，其余交互反馈（hover/press/focus）已有。
- **content-first-noise-reduction**：没有插页弹窗或横幅；次要内容用折叠——折叠的实现见 B1。
- **dark-mode-toggle**：`matchMedia` 不清用户存储的值，见 E5。

## 方法与局限

- 判定基于静态检索与抽样阅读，不是运行时验证。凡是写"基本符合"的，都没有在真实浏览器里逐项操作过。
- `title` 属性（291 处）、`text-overflow: ellipsis`（41 处）、`outline: none`（25 处）这类高计数项是抽样判断，逐个人工核对需要专门一轮。
- 报告跑过两轮浏览器策略：第一轮 `AGENTS.md` 的 iOS 16.2，第二轮 `last 2 versions`。第二轮的下限由指南表格加今日日期推断，未与 caniuse 对账；`last 2 versions` 与仓库现行策略冲突，采纳前需要先改 `AGENTS.md`、`vite.config.ts` 的 `build.target` 和 `package.json` 的 `browserslist`。
- "符合"一档的依据逐条列在 M 节；其中一部分（`dynamic-sort`、`drag-and-drop`、`scroll-target-on-load`、`scroll-position-aware-elements`、`scroll-completion-effects`、`respect-os-text-scale`、`natural-interactions`、`content-first-noise-reduction`）只有一行证据，没有展开核对指南的全部细则。
- 本轮没有修改任何产品代码。已修复并推送的只有 `legacy-scan` 报出的那 4 处里的 2 处真问题（IME 守卫，提交 `a7cbf96d`）；`form-fields-automatically-fit-contents` 的处置见 C9，`ime-safe-enter-submit` 的第四处（`SessionTree.tsx:768`）经核实为误报——该处已有 `isImeKey()` 守卫。
