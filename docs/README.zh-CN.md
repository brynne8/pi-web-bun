# Pi Web（Bun 版）

[English](../README.md) | [日本語](./README.ja.md) | [Русский](./README.ru.md)

> **这是 [agegr/pi-web](https://github.com/agegr/pi-web) 的 Bun 专用分支。** 无需安装 Node.js、`npm` 或 `npx`，用 [Bun](https://bun.sh) 就能跑。我们对「一个编码 agent 在浏览器里应该怎么读」有自己的判断：长命令自己移交后台，而不是把整个回合吊在半空；`read` 卡片直接打开它真正读到的那一段；输入框不会在你手指底下换人；中继掐断 HTTP/2 流也不再赔上一次运行。哪些仍然与原版不同、哪些上游已经自己实现，见[与原版的区别](#与原版的区别)；安装方式见 [Bun 安装](#bun-安装)。其余部分沿用原版文档。

[pi 编程智能体](https://github.com/earendil-works/pi)的本地浏览器界面。Pi Web 与 pi 共用本机配置和会话文件，可在浏览器中查找和继续对话、运行智能体、配置模型与资源，并查看项目文件。

**[在线体验演示 →](https://agegr.github.io/pi-web/)**：真实的 Pi Web 界面直接在浏览器里运行，带有示例会话、文件和模型。无需安装；回复都是预设内容，不会调用任何模型。那个演示是原版构建的——本分支不发布自己的演示，所以它不会展示下面列出的那些差异。

中文微信群：请查看 [GitHub Discussions 帖子](https://github.com/agegr/pi-web/discussions/271)。

![Pi Web 展示包含结构化 Markdown、工具调用和项目导航的 pi 会话](https://raw.githubusercontent.com/agegr/pi-web/main/docs/screenshot2.png)

## 功能

- **属于自己的一套外观**：全应用共用一个琥珀强调色和一种玻璃材质，控制台就是页面本身而不是浮在上面的一张卡片，品牌用衬线体，等宽体只留给数据。
- **会话工作区**：按项目查找、继续、重命名、导出和删除对话，并查看运行状态、上下文占用、花费和压缩信息。
- **两种分支方式**：**新会话**会从较早的消息创建独立会话文件；**从此处编辑**会在当前会话内创建分支。
- **后台 bash 任务**（默认关闭）：长时间运行、或者输出长过头的命令会移交成后台任务，结束后以一张已结算的卡片回来，而不是一直占着这一轮。
- **不会错过的后台结果**：已结算的报告汇成一批、只把模型唤醒一次，每份保留自己那张卡片；`await_notifications` 在还没有结果时会一直等到下一份。
- **项目文件工具**：浏览和上传文件、查看 Git Diff，并预览源码、Markdown、图片、音频、PDF 和 DOCX；文件变化后会自动刷新。
- **文件行自己的右键菜单**：在项目文件树里右键某一行，可以把路径插入聊天、下载文件、撤销它未提交的改动，或者在系统文件管理器里看到这个文件（选中它本身）；悬停时不会再有东西盖在文件名上面。
- **侧栏里的读取切片与表格**：点开 `read` 工具卡片会在侧栏打开它真正读到的那一段——Markdown 按 Markdown 渲染，源码行号从读取的偏移接着往下数；CSV 和 TSV 的切片以表格打开，行号沿用文件自己的行号。
- **长文件也能顺畅阅读**：源码视图只渲染视口附近的行，大文件滚动不卡，屏幕上的行无论文件多长都保持语法高亮，文件内查找搜索每一行而不只是渲染出来的窗口。
- **命令高亮**：shell 工具卡片把命令按 token 着色，不再是一整条暗色字符串，并在旁边保留 `timeout` 与后台标记。
- **`powershell` 卡片保留自己的颜色**：红色和绿色以颜色到来，而不是 `[7mError:[0m` 这样的字母；移动光标或清除整行的转义什么都不显示。
- **工具卡片上的参数按行排**：参数全是普通值的工具调用，会一行一个参数地排成表格，而不是一整块 JSON——不必数引号、也不必展开嵌套。只要有一个值是对象或数组，这张卡片就退回 JSON，因为藏掉一棵子树的表格等于让你看不到那个参数。
- **放得下的 diff**：edit 和 apply_patch 的改动两栏并排——左边改动前、右边改动后；在手机上改为单栏，因为两个代码栏并排时哪一栏都没法读，删掉的那一行就排在替换它的那一行上面。
- **按顺序读下来的运行**：模型写的句子留在它写下的位置，中间连着的思考和工具调用各自折进自己那一组「处理详情」，这次运行最后由单独一行收尾——token 数、这一轮改过的文件，和一个把写下的全部内容交出去的「复制」按钮。
- **思考过程按 Markdown 渲染**：展开的思考卡片会把标题、列表、表格和围栏代码渲染出来，而不是露出一堆标记符号。
- **文中的 shell 变量不会变成公式**：句子里的 `$HOME`、`$PATH`，还有夹在两个美元符号中间的中文句子，都按原样显示，不再被渲染成数学公式。
- **Git worktree**：从侧边栏切换 checkout，同时把同一仓库不同 worktree 的会话归在一起。
- **网页配置**：无需离开 Pi Web，即可管理 Provider 登录和 API Key、模型、模型测试、插件包及技能。
- **Code mode 默认开着，设置单占一页**：Code mode 的选项、模式、工具列表预算和沙箱都在「设置 › 工具」里，旁边就是当前会话可用的工具名。
- **英文、简体中文和繁体中文界面**：Pi Web 首次打开时跟随浏览器语言，也可在**设置 › 常规**里切换语言。

## Bun 安装

本分支面向 Bun，不需要任何 Node.js 工具链。要求 [Bun](https://bun.sh) 1.4.2 或更高版本，可用 `bun --version` 检查。

```bash
git clone https://github.com/brynne8/pi-web-bun.git
cd pi-web-bun
bun install
bun run dev
```

开发服务器启动在 [http://127.0.0.1:30141](http://127.0.0.1:30141)。生产服务器（`bun run start`）和构建（`bun run build`）在 Bun 与 Node.js 上都能跑；开发服务器目前还不行：`bun run dev` 让 Vite 跑在 Bun 上，而 Bun 1.4.4 在那里会丢掉写请求的方法（[oven-sh/bun#42759](https://github.com/oven-sh/bun/issues/42759)），每个 `POST` 到达时都成了 `GET`。在带修复的 Bun 发布之前，请用 Node.js 跑 `npm run dev`，或者用 `bunx bun-pr 46528` 装上修复后的构建。

本分支不发布 npm 包，按上面的方式从仓库运行即可。`bun.lock` 已加入忽略列表，每次 `bun install` 都会重新解析依赖，也不要把它提交。真正被跟踪的是 `package-lock.json`：CI 靠它 `npm ci`，以改依赖后用 `bun x npm install --package-lock-only` 记录并提交结果。

如果尚未配置模型 Provider，请打开**模型面板**（Models）登录或添加 API Key。`~/.pi/agent` 会在首次使用时自动创建。

### 常用命令

```bash
bun install                            # 安装依赖
bun run dev                            # 开发服务器，监听 127.0.0.1:30141
bun run dev:lan                        # 开发服务器，监听 0.0.0.0:30141
bun run build                          # 生产构建，输出到 dist/
bun run start                          # 在 127.0.0.1:30141 上提供 dist/
bun test                               # 运行测试
bun x tsc --noEmit                     # 类型检查
bun run lint                           # 代码检查
```

在 Bun 下运行检查命令有三点说明：

- 用 `bun test` 代替 `npm test`。`package.json` 里的 `test` 脚本仍调用 Node 的测试运行器，Bun 无法展开它传入的 glob；`bun test` 不需要任何参数，会自己找出全部测试文件。同理用 `bun x tsc --noEmit` 代替 `node_modules/.bin/tsc --noEmit`，因为 `.bin` 下的启动脚本带 `#!/usr/bin/env node` shebang，没有 Node 时会执行失败。
- **两种运行器在本分支都受支持，并且都必须保持全绿**：真实的 Node.js 22.19.0+ 上跑 `npm test` 是第二意见，也是上游唯一有的那个，所以 rebase 上游后要靠它对比。两边计数方式不同——Node 会自己统计 subtest 与 suite——所以只比失败项，不比总数。Bun 下哪里行为不同、该怎么写，记在 [docs/agents/tests.md](./agents/tests.md)。
- 整个测试套件在 `bun test` 下也全部通过——`app/`、`components/`、`hooks/`、`lib/`、`public/` 下的每个文件。只有在某个运行时才能观察到的行为，测试会说明并跳过不适用的那一半，而不是失败：Bun 的 `fetch` 不使用 undici 的全局 dispatcher，Bun 的 `node:module` 既不导出 `stripTypeScriptTypes` 也不导出 `registerHooks`。

### Bun 下的插件安装

需要一项设置，写在 `~/.pi/agent/settings.json`：

```json
{ "npmCommand": ["bun"] }
```

pi SDK 会读取该设置，并按包管理器（`npm`、`pnpm`、`bun`）调整安装参数。请通过 SDK（`SettingsManager.setNpmCommand(["bun"])`）设置，而不是手动改文件，以便遵守它自己的锁。Pi Web 只为自己的插件更新检查读这个键，界面上没有它的开关。

## 与原版的区别

两类差异。[在 Bun 上运行](#在-bun-上运行)是不装 Node.js 工具链所必需的改造。[这个分支新增的功能](#这个分支新增的功能)是在原版之上多做的那部分，两边做法不同的地方各附一句原版的处理。

### 在 Bun 上运行

| 部分 | 原版 | 本分支 |
| --- | --- | --- |
| 运行时 | Node.js 22.19.0+ | Bun 1.4.2+ |
| 内置终端 | 通过 `node-pty` 正常工作 | 通过一层薄薄的 node-pty 兼容封装使用 Bun 原生 PTY（见下，另见 [docs/terminal.md](./terminal.md)） |
| SDK 包解析 | `node:module` 的 `findPackageJSON()` | `lib/pi-sdk-internals.ts` 里的 `findPackageManifest()` 向上遍历 `node_modules`，因为 Bun 不实现 `node:module` 的任何具名导出 |
| 用户目录 | `os.homedir()` | 先看 `$HOME`，再回落到用户数据库（`lib/home-dir.ts` 的 `homeDir()`），因为 Bun 的 `os.homedir()` 会忽略 `$HOME`——agent 目录、默认 cwd、目录浏览器的根、路径里的 `~`，以及 HTTP dispatcher 读超时所在的 agent 目录。Windows 上通常没有 `$HOME`，所以那里同样走用户数据库 |
| 技能安装 | `npx skills add …` | `bun x skills add …` |
| 插件更新检查 | `npm view … version --json` | `bun pm view … version --json` |
| 测试套件 | Node 运行器（`npm test`） | 两种运行器都跑、都绿：`bun test` 与 `npm test` |
| 浏览器回归测试 | Playwright Chromium（`npx playwright install --with-deps chromium`） | 用 Playwright 自带的 Apple WebKit：`npm run test:e2e:install` 拉取，CI 装 `--with-deps webkit`；本分支不安装也不启动任何 Chromium 二进制（见 [docs/agents/tests.md](./agents/tests.md#e2e-playwright)） |
| 构建工具链 | Next.js 16（Turbopack；开发状态与构建产物都在 `.next/`） | vinext 跑在 Vite 8/Rolldown 上，由 `vite.config.ts` 与 `next-config.ts` 配置：`bun run dev` 的状态在 `.vinext/`，`bun run build` 输出到 `dist/`，`bun run start` 提供 `dist/` |
| 停止服务器 | `next start` 用 `server.close()` 应答 SIGINT/SIGTERM，并等连接结束 | `vinext start` 不应答任何信号，所以收尾改为显式退出：清理动作一跑完就退出（`lib/server-shutdown.ts`；[说明](./agents/sessions.md#stopping-the-server-libserver-shutdownts)） |
| 锁文件 | `package-lock.json` | `bun.lock` 已加入忽略列表；`bun-types` 则写进被跟踪的 `package-lock.json`，因为 CI 的 `npm ci` 不接受与它对不上的 `package.json` |
| CI | Node.js 上跑 `.github/workflows/ci.yml` | 同一个 `ci.yml`，只把它要装的浏览器换成 `--with-deps webkit`——本分支不加 Bun 的 job，所以上面那些 Bun 检查在本地跑 |

**终端。** node-pty 的原生插件在 Bun 下无法维持 pty master fd 的生命周期：fd 在 `spawn()` 之后立即被关闭，子进程的 stdin 直接读到 EOF，交互式 shell 还没来得及打印提示符就退出了（[agegr/pi-web#745](https://github.com/agegr/pi-web/issues/745)，另见 [oven-sh/bun#7362](https://github.com/oven-sh/bun/issues/7362)）。Bun 原生的 PTY 支持（`Bun.spawn({ terminal })`）会为进程的整个生命周期持有该 fd，因此 `lib/terminal-bun-pty.ts` 实现了 `lib/terminal-manager.ts` 所需要的那一小部分 node-pty 兼容接口——spawn、`onData`、`onExit`、`write`、`resize`、`kill` 和 `pid`——Node.js 和 Windows 则继续使用 node-pty。没有轮询读取器，没有 fd 生命周期补丁，也没有额外依赖。

**技能与插件检查。** `lib/node-cli.ts` 把两个只读的包管理器调用映射到 Bun 的等价命令（npx 用 `bun x`，`bun pm view` 输出的 JSON 与 npm 一致）。安装仍走 SDK 自己的包管理器路径，由上面的 `npmCommand` 指向 bun。

### 这个分支新增的功能

装上第一次就能用，除非条目里另有说明，都不需要额外配置。每条末尾写明原版的处理，方便两边对照。

**属于自己的一套外观，在每套配色之下。** Pi Web 打开就是一套统一的视觉：黑曜石底上的琥珀，所有浮起来的东西共用一种玻璃材质，衬线体写品牌、无衬线体写界面、等宽体只留给数据。控制台就是页面，工具调用读起来像一行带状态点的日志，你自己的发言是暖色渐变气泡，设置的各个分区收进左侧导航。明、暗两套主题属于这套设计；其余配色保留自己的强调色、自己的气泡和语法配色，只共用它的表面与字体。字体取自 Google Fonts。原版提供的是原生界面，由每套配色重新上色。（[说明](./agents/design.md)）

**长时间运行的命令转后台。** shell 命令跑过两分钟就移交成后台任务：agent 继续往下做，命令结束后带着日志文件以一张已完成的卡片回来。它打印的行数超过模型用 `max_output_lines` 设的上限时也会移交，所以一条会把上下文灌爆的命令，不必靠砍短输出来躲。开关在**设置 → 常规 → 后台 bash 任务**，默认关闭；关着的时候就是原版那个 bash 工具，一模一样。原版的立场是：后台执行该由 pi 自己提供，而不是由网页包装层提供（[#1132](https://github.com/agegr/pi-web/pull/1132)）。（[移交是怎么发生的](./agents/background-bash.md#two-ways-into-the-background)）

**这次会话在做的一切，收在右侧面板里。** 活动视图按你能动手的东西排序：看着不对的、这次对话委派出去的 subagent、它的后台命令，以及服务器还为它留着 wrapper 或事件流的会话；而支撑这些说法的那些数字（这个页面的连接数和轮询往返、服务器的总计、哪些页面连着）单独收进一个折叠里，合上就把它们清出视线。一张任务的卡片打开它的输出；一个 subagent 的行可以把对话切到它，或者读它的 transcript。原版只把正在跑的命令留在它自己的工具卡片里。（[说明](./agents/background-bash.md#the-rails-activity-view)）

**跑完的东西不会再看不见。** 后台命令或子代理没法在父会话运行途中报告自己。已结算的报告汇成一批送达，只把父会话唤醒一次，每份仍保留自己的卡片；在还没有结果、而后台仍在跑的时候，`await_notifications` 会等到下一份报告；等待期间每个轮次都会收到一次提醒。模型已经用 `get_subagent_result` 读过的结果会从这一批里撤下。原版是一份发一条消息，而且要等父会话空闲。（[说明](./agents/pending-notifications.md)）

**断流不再赔上整次运行。** 有些中继会在响应中途掐断 HTTP/2 流，运行就连同写到一半的回答一起停下。pi 自己的重试表从 1.4.0 起收录了常见的措辞，本分支再补上它还没收的那些，沿用 pi 自己的重试次数与退避，同时仍然把你按下的「停止」、额度被拒、上下文装满当作致命错误处理。原版的立场是浏览器应当和终端里的 pi 重试得一模一样（[#1134](https://github.com/agegr/pi-web/pull/1134)）。（[重试什么、不重试什么](./agents/sessions.md#agentsession-lifecycle-librpc-managerts)）

**一眼能读懂的 shell 命令。** bash 工具卡片里的命令按 shell 语法高亮，不再是一整条灰字；展开后显示命令本身和它的超时，而不是原始 JSON——于是 `grep -rl "foo" src | xargs rm` 看起来就是一条管道。模型主动要求放到后台跑的命令另有 `(background)` 标记。原版会在参数行里随着流量显示出命令的文字（[#1396](https://github.com/agegr/pi-web/pull/1396)），其余部分仍选择不带样式（[#1135](https://github.com/agegr/pi-web/pull/1135)）。（[说明](./agents/sessions.md#tool-execution-events-on-the-sse-stream)）

**`powershell` 卡片显示自己的颜色。** 不管有没有终端在看，PowerShell 都会给自己的输出上色，而这张卡片会把那些转义显示成字母——`SQLite[7mError:[0m no such column`——因为开启一次转义的那个字符本身什么都不画。现在是红色和绿色告诉你哪一条测试失败了，而反相视频（`bun test` 打印 `(fail)` 用的就是它）变成一块底色。移动光标或清除整行的转义什么都不显示。基本颜色跟随你选的那套主题。原版把工具的输出显示成纯文本，和终端里的 pi 一样。（[说明](./agents/sessions.md#a-powershell-card-draws-its-outputs-colours-libansi-textts-componentspowershelloutputtsx)）

**在对话旁边读文件的那一段。** 点开一张已完成的 `read` 卡片，右侧面板就打开这次调用真正返回的那一段：Markdown 按 Markdown 渲染、一键就能切回它的源码，源码行号从这次读取起始的那一行接着数，CSV 和 TSV 直接成表格、用的还是文件真实行号。面板显示的是模型拿到的内容，不是文件此刻的样子——不重新请求、也不重新读盘。卡片保留自己的表头，把文字交给面板。原版把 read 的输出留在卡片里，并把那张分隔符表格用在文件预览中（[#1136](https://github.com/agegr/pi-web/pull/1136)、[#1150](https://github.com/agegr/pi-web/pull/1150)）。（[说明](./agents/sessions.md#a-read-card-opens-its-slice-in-the-right-panel-toolcallblock-componentsreadsnapshotviewertsx)）

**行号在代码的滚动区之外。** 在右侧面板里把一行宽代码横向挪动时，行号那一栏钉在原地。在源码视图里，横向滚动条只走在代码下面，不会横穿行号。代码字号比原版小一号，源码视图、Diff 视图和读取快照面板一起跟着这一套字号走。原版也在 [#1200](https://github.com/agegr/pi-web/pull/1200) 里把行号钉住了，只是钉在代码自己的滚动容器里，于是横向滚动条仍然从行号下面穿过去。（[说明](./agents/files-and-access.md#the-line-number-gutter-beside-the-code)）

**再长的文件也能滚动，并且一直有颜色。** 源码视图只渲染视口附近的那些行，不再一次渲染全部，于是多大的文件滚动起来标签页都不会卡，屏幕上的行无论文件多长都保持语法高亮。文件内查找——工具栏的放大镜，或指针在查看器内时按 ⌘/Ctrl+F——搜索全部已加载的行，而不只是渲染出来的窗口，匹配落在很靠下时也会滚动到眼前。原版渲染每一行，并在一千行之后停止高亮。（[说明](./agents/files-and-access.md#long-files-a-window-of-lines-and-find-across-all-of-them)）

**运行时按钮不挪位。** 「停止」放在输入框里，与「引导」和「后续消息」并排，输入框下方那一排在运行中和结束后只有一套摆法——你正要点的东西不会在这次运行结束的一瞬变成别的东西。模型选择器也在这一排里，运行进行途中照样能用：换上去的模型从这次运行的下一个请求起生效，每条回答的标签写的就是写出它的那个模型。原版的处理是挡住一次运行刚结束时的误点（[#1131](https://github.com/agegr/pi-web/pull/1131)）；本分支把这道守卫留着，而在桌面上，它所要防的那种按钮替换已经不存在了。原版的模型选择器在一次运行的整个过程里是禁用的，到 [#1527](https://github.com/agegr/pi-web/pull/1527) 才放开。（[说明](./agents/sessions.md#composer-action-row-nothing-moves-under-the-pointer-at-a-run-boundary)）

**「停止」会回答你排下的消息。** 按下「停止」结束这次运行，还在排队等引导的消息会送进属于它自己的那次运行：模型照着你写下的内容回答，而不是压在它下面一声不响。队列在运行停下之前清空，所以不会有消息被送进一个正在死去的运行、留在那里没有人回答。带着附件的那条消息会连图片一起回到输入框，而不是丢了附件被发出去。队列空了之后再按一次「停止」，结束一切。原版的「停止」只收回它自己的召回覆盖的那一段：挡在压缩后面的提示词（[#1426](https://github.com/agegr/pi-web/pull/1426)）和服务端根本没收到的发送（[#1457](https://github.com/agegr/pi-web/pull/1457)）；队列里剩下的仍交给 pi，那条消息就继续等一个永远不会来的运行。（[说明](./agents/sessions.md#stop-and-the-messages-still-queued-librpc-managerts-hooksuseagentsessionts)）

**模型没回答的消息，「停止」把它还给你。** 在一次什么都没产出的运行上按「停止」——没有一个字、没有一段思考、没有启动过工具——那条消息就回到输入框里，对话也退回到它之前：记录里不会留着一条没有人回答的消息，再试一次也不需要开分支。已经开始思考的运行算已经有了回答，在那里按「停止」只是停下它。被放弃的提示词仍留在会话文件里，所以分支切换器还能把它显示出来。原版把那条消息连同一条空回复留在原处，而从那条消息编辑就会在你旁边另开一个分支。（[说明](./agents/sessions.md#stop-and-the-prompt-that-got-no-reply-librpc-managerts-hooksuseagentsessionts)）

**`write` 卡片把路径和它写下的正文并排显示。** 参数都是单个值的工具卡片会一个参数一行地列出来，本身带换行的值保留成一块可以滚动的文本；这里连 `write` 也上表，它给出的两行就是文件路径和写下的正文。规则是全部参数都上表，否则一个也不上：只要有一个值是嵌套的，比如 MCP 参数里装着列表，这张卡片就照旧显示 JSON。行表本身是上游从本分支收走的（[#1324](https://github.com/agegr/pi-web/pull/1324)），而原版把 `write` 排除在外：那张卡片只显示文件正文，路径不跟在旁边。（[说明](./agents/sessions.md#tool-execution-events-on-the-sse-stream)）

**模型写下的文字留在屏幕上，只折叠中间的过程。** 一次运行按片段渲染：它写的文字就在写下的位置显示，中间连着的思考块和工具调用各自折进自己那一组「处理详情」。最后一组下面只有一个结尾，写着这次运行的事：token 数与耗时、这一轮改过的文件、交出全部文字的「复制」；运行停在 Provider 报错或输出上限上时，那句原因就写在它上面一行（[#906](https://github.com/agegr/pi-web/issues/906)）。原版只保留最后一次工具调用之后的文字，并把数字、改动文件清单和失败原因挂到那条回复消息上。（[说明](./agents/sessions.md#a-turn-shows-every-word-it-wrote-only-the-workings-fold-processdetailsgroup-componentschatwindowtsx)）

**子代理的报告按 Markdown 渲染。** `Agent` 或 `get_subagent_result` 的结果会把标题、列表、表格和围栏代码真的渲染出来，字号仍是这张卡片自己那一号，不再把子代理写下的标记符号直接摆给你看。其他工具的输出仍是原始文本——在那里 `*` 和 `#` 只是字符，不是标题。后台运行的通知和子代理自己的标签页本来就已经按 Markdown 渲染，这一份报告在两处读起来是同一个样子。原版是把报告原样打印。（[说明](./agents/subagents.md#the-report-on-screen)）

**思考过程按 Markdown 渲染。** 展开的思考块走的是和回复同一套 Markdown 流水线：标题、列表、表格和围栏代码都渲染出来，不再把标记符号直接摆给你看，写成链接的路径也能在应用里打开。字号仍是这张卡片一贯的那一号。原版的处理是把整段思考当成一串保留换行的纯文本，长了就切成好几段（[#1196](https://github.com/agegr/pi-web/pull/1196)）。（[说明](./agents/sessions.md#thinking-renders-as-markdown-at-the-cards-own-size-thinkingblock-componentsmessageviewtsx)）

**一次子代理调用不带文件清单。** `Agent` 收的参数只有 `subagent_type`、`prompt`、`description`、`run_in_background`、`resume`、`model` 和 `isolation`：要让子代理看哪些文件，就写在 `prompt` 里，它用自己的 `read` 去打开。思考档位、轮次上限、是否继承这段对话都由 profile 决定，思考档位跟着模型引用一起写（写成 `x:high`）。原版在调用上保留 `input_files` 列表，和它从同一个 PR 拿到的 profile 参数并列（[#1138](https://github.com/agegr/pi-web/pull/1138)）。（[说明](./agents/subagents.md#what-the-model-may-choose-when-spawning-a-subagent)）

**调用了工具没有的字段，这次调用会被拦下。** 模型给某个工具传了它的 schema 里没有的参数，这次调用就被停掉，回答里指出它编出来的那个字段，以及这个工具真正收哪些字段，好让它重新发一次。只查字段名：已经声明的字段值仍交给 pi 自己的校验，schema 不限定字段的工具照原样调用。原版让多出来的字段原样通过，调用照跑，那个字段什么也不做。（[说明](./agents/tools.md#tool-selection-and-built-in-extensions)）

**子代理的最后一轮不能再干活。** profile 里的 `max_turns` 给的那最后一轮，工具全被收走，这一次请求只能写答案；这一轮一个字都没交出来，就再给一次同样的机会，之后这次运行才算失败——报错里点出轮次上限，孩子已经写下的部分照样留着。运行一结束工具就还回来，resume 起来的孩子也会被告知这件事，用的是一条只有模型读得到、界面不显示的消息。resume 会把这个预算从零开始重算，所以每一次运行拿到的都是 profile 给的那一整套。原版的收尾轮保留全部工具。（[说明](./agents/subagents.md#built-in-subagents)）

**没有工具时就不声明工具。** chat completions 上游会把没有 `tools` 字段读作「没有工具」，严格一点的直接拒掉空数组：`400: tools must not be an empty array`。pi 的客户端只要这一次请求不声明工具、而对话里已经有工具调用，就会发出那个空数组，于是子代理不收工具的最后一轮、或者用过工具之后切到 **No tools** 的聊天都死在请求上，而不是交出回答。本分支干脆不带这个字段。原版对每一个上游都发那个空数组。（[说明](./agents/tools.md#tool-selection-and-built-in-extensions)）

**委派规则自己成块。** 目标一清楚就该委派——这句话现在单独成块，作为 `<delegation>` 出现在系统提示的末尾，读起来是 `Agent` 自己的策略。它给 `explore` 和 `plan` 各写了规则——面对陌生的代码库要建立理解，或一处改动波及尚未摸清、必须小心处理的代码，就用 `explore`；需要先想清楚步骤的大型复杂任务，就用 `plan`，而且绝不和它所规划的工作同时进行，plan 也应该始终在前台运行——其余启用的子代理只列名字。它随每一次运行的提示发出，**系统提示**面板也能看到，包括被插件改写了提示的会话。原版把委派建议放在工具的 prompt guidelines 里，由 Pi 追加到扁平的 `<rules>` 列表。（[说明](./agents/subagents.md#delegation-policy)）

**模型可以停掉它委派出去的运行。** `abort_subagent` 让发起子代理的 agent 结束一个它不再想要的运行。后台运行不受父会话上「停止」的影响。这次运行进行到哪儿都留在它自己的记录里，事后可以读，也可以用 `resume` 接着往下跑；被模型停掉的运行不会再额外报一条说自己被停了。原版把同样的停止写成一个没有界面入口的服务端调用，而且给模型的是三个子代理工具，不是五个。（[说明](./agents/subagents.md#stopping-a-run)）

**模型能重新查到自己的子代理。** 一次 `list_subagent_runs` 调用就把本会话委派出去的子代理列成 TSV——id、profile、状态、最后活动时间和标签，正在运行的在最前面。它不会等待、启动或抓取结果，所以查一个忘了的运行不会把它唤醒。默认给的是真正需要看的那张进程表：正在运行的全部，加上最近一小时里失败、被停止或被中断的；更早的退出和成功完成的只用一行计数带过、不占篇幅，想看它们或看全部就传 `status`。原版不让模型列出本会话的子代理。（[说明](./agents/subagents.md#listing-delegated-runs)）

**子代理用短 id 称呼。** 每份报告、每次停止和转向的回答、每一行运行列表，用的都是会话 id 的最后八位，`Agent` 的 `resume`、`get_subagent_result`、`steer_subagent`、`abort_subagent` 也都认这个写法，完整 id 仍然可用。会话 id 的尾部才是区分两次运行的唯一部分，也是唯一值得在调用之间抄下来的部分。两次运行尾部相同时会被拒绝，不会替你猜。原版打印完整 UUID，也只接受完整 UUID。（[说明](./agents/subagents.md#short-subagent-ids)）

**内置子代理跟随会话的 Code mode。** Explore、Plan 和 General purpose 启动时沿用父会话正在用的 Code mode，不再永远直接调用工具；于是开着 Code mode 的会话不会在一委派出去就把它丢掉。工具权限不变，这三个配置也仍然只读——但在磁盘上放一个同名文件照样可以整体替换其中一个。原版把这三个的 Code mode 默认关着，而「设置 › 子代理」早就能按配置单独改它（[#1097](https://github.com/agegr/pi-web/pull/1097)），只是你不改就一直是关。（[说明](./agents/subagents.md)）

**只读的那两个内置子代理会停下来汇报。** Explore 和 Plan 自带轮次预算，于是一个还在到处翻的委派运行会停下，把已经查到的东西写成报告交出来，而不是一直跑到上下文被塞满；General purpose 要改文件、要跑检查，所以给它的是更大的那个数。新建 agent 时面板填的也是同一个数，磁盘上的同名文件则照样能改掉内置的那个。原版这三个都不带预算。（[说明](./agents/subagents.md#built-in-subagents)）

**子代理的报告不会被它自己摘要掉。** 子会话以一段回答结束那次运行时不会被压缩：报告与父会话之间不隔一次生成摘要的请求。在子代理自己的对话里 `/compact`、以及上下文溢出之后的恢复仍旧会压缩，发给它的下一条提示词也会先压缩再开始那次运行。原版每条消息之后都会像检查任何会话一样检查子代理的上下文，所以填满上下文的子代理在把报告交出去之前，要先为刚刚作答的那次运行付一次摘要。（[说明](./agents/subagents.md#compaction-held-while-the-child-writes-its-report)）

**你自己回答的子代理也算一次运行。** 在子代理自己的对话里输入内容，它的运行会像任何一次 `resume` 那样被记录下来：agent 切换器显示它正在运行，`get_subagent_result` 会等它，结果落进它自己的记录，父会话收到完成报告。这是重启把子代理切断之后的回来之路：给它发一行，状态就不再撒谎。原版把输入到子代理里的提示词留在子代理记录之外，于是没有状态、没有结果，也没有报告跟着来。（[说明](./agents/subagents.md#built-in-subagents)）

**side chat 是一条命令，不是一个按钮。** 输入 `/btw`，这次会话就分叉成一个 side chat，在右侧面板打开，命令后面跟着的东西成为它的第一条消息；单独一个 `/btw` 打开一个空的。它在一轮正在流式输出的时候也能开，因为分叉是文件的一份拷贝，agent 从来看不见它。原版还会从输入框里的 Side chat 图标、Agents 弹出层里的 New side chat，以及选中文字弹出的弹出层开一个（[#1469](https://github.com/agegr/pi-web/pull/1469)）。（[说明](./agents/side-sessions.md#creation)）

**文中的 shell 变量不再被当成公式。** 一个单独的 `$`，只要后面还有另一个 `$`，就会开一个公式，所以一句讲 `$HOME` 和 `$PATH` 的话会以数学斜体显示出来，夹在两个美元符号中间的中文句子也一样。这个分支会看两个定界符中间是什么——shell 变量名、只有 CJK 文本才有的标点、若干个汉字——并把那段文字原样留下，而 `$E=mc^2$`、`$PV=nRT$` 和一个短汉字量名仍按公式渲染。原版照 remark-math 本来的样子运行：任意两个 `$` 就开一个公式，中间是什么它都不读（[remark-math](https://github.com/remarkjs/remark-math)）。（[说明](./agents/sessions.md#math-delimiters-and-prose-that-only-looks-like-a-formula)）

**文件行自己的右键菜单。** 在项目文件树里右键某一行——在 Git 改动清单里右键也一样——这一行会给出这个文件自己的操作：把路径插入聊天、下载这个文件、撤销它未提交的改动（已暂存的一并取消暂存并还原内容），在访达 / 文件资源管理器 / 文件管理器里看到它，而且是选中这个文件本身，不只是打开它所在的目录。只有 Git 能还原的改动才有这一项——新增的文件、重命名、冲突都不算——而且它会先问一句再动手。原版的处理是把前两项做成悬停时浮在文件名上的按钮；它通往文件管理器的入口只打开工作区所在目录，没有按文件的入口（[#907](https://github.com/agegr/pi-web/pull/907)）。（[说明](./agents/files-and-access.md#a-rows-own-actions)）

**删除会带走会话在别处留下的东西。** 隔离运行的 subagent 在自己的 git worktree 里工作，它的会话文件因此记在那个 worktree 路径下，自成目录。删除父会话时会通读整个 sessions 根目录去找这样的子会话，连它一起删，并把留下来的重新挂到最近一个仍然存在的祖先。被删空的东西也跟着走：它清空的目录，还有你在应用外删掉某个项目目录之后侧栏仍替它保有的位置和名称。原版寻找子会话、也寻找该改挂谁，只看被删文件所在的那些目录。（[说明](./agents/sessions.md#session-sidebar-project-groups-pins-and-archive)）

**你自己取的名字，撑得过「生成标题」。** 在侧边栏里、或者用 `/name` 给会话取过名字之后，再按「生成标题」，你的名字原样不动：按钮会说明它保留了你取的名字。应用归不到自己名下的名字同样保留——pi TUI 取的、扩展取的、旧版本取的，都一样。只有没有名字的会话，或者名字本来就是「生成标题」自己取的，才会得到一个新名字。原版用模型写下的标题盖掉这个会话原本被叫做什么。（[说明](./agents/sessions.md#auto-naming-never-replaces-a-name-a-person-set-post-apisessionsidauto-name)）

**Code mode 默认开着，设置自成一页。** 会话一开始就能用 Code mode——模型写一小段脚本来调用工具——除非你的设置另有说法；它的设置都在同一页：始终开启或自动、内置工具是否同时声明给模型、工具列表能花多少 token、沙箱自检，以及当前会话可用的工具名。每个服务器自己的工具公开方式仍然留在那个服务器旁边。原版要等 MCP 服务器连上才打开 Code mode，设置也放在 MCP 那一页。（[说明](./agents/tools.md#settings--tools)）

**Git 清单三个问题一起问。** 侧边栏的 Git 清单每次刷新都重新从 Git 读，所以它显示的就是此刻的目录树。仓库根目录、状态清单、改动行数这三个问题是一起发出的，不是一个接一个；未跟踪文件的行数只数一遍，只要它的字节数、时间戳和 inode 说明没变，就沿用这个结果。原版先等仓库根目录答复，再问另外两个，并且每次刷新都把所有未跟踪文件重数一遍。（[说明](./agents/files-and-access.md#when-the-file-tree-reloads)）

**「系统」面板显示模型拿到的那份提示词。** 「系统」面板列出完整的系统提示词，改写过它的插件也属于这份文本：插件自己写的那段话会出现在模型读到它的地方，而不是只留在插件的文件里。原版从记录里重放 pi 自己的那些段落，插件强制的那份提示词在那里从不出现——pi 在这次运行里送出它，记录里仍留着 pi 自己的段落。（[说明](./agents/sessions.md#the-system-panel-shows-the-prompt-the-model-receives)）

**右侧那一栏里不管是什么标签页，都能拖到你想要的位置。** 把一个标签页拖到另一个上面，这一栏就照这个次序排到这一页结束——文件排在打开它的那个终端旁边，你正在读的 side chat 排在已经跑完的 sub-agent 前面。这一栏在本分支承载的每一类标签页都算数：文件、终端、sub-agent 和 side chat、一次 `read` 返回的那一段、任务清单，以及某个任务的日志。活动视图也是一个标签页，而且它没有关闭按钮。原版的文件、终端和 sub-agent 标签页也是这样重排的（[#1511](https://github.com/agegr/pi-web/pull/1511)）；它那一栏里没有另外这三类。（[说明](./agents/background-bash.md#the-rails-activity-view)）

**side chat 会跟着它的会话一起回来；右侧那一栏的临时标签页不会。** 切到另一个对话，这一栏就只显示那个会话的 side chat；切回来或者刷新，同一批又都回来了，你原先看的那一个还在最前面。你已经切到别的会话之后分出来的那个 side chat 会存到自己那个父会话名下，不会开在你此刻看着的东西旁边。一次 `read` 的那一段和某个任务的日志从不参加这次恢复，而活动视图就是关掉一个 side 标签页之后你落脚的那一页。原版给它自己的面板恢复 side 标签页（[#1512](https://github.com/agegr/pi-web/pull/1512)），那边既没有活动视图可落，也没有 read 切片要排除在外。（[说明](./agents/side-sessions.md#panel-and-switcher)）

**扩展的颜色和命令的颜色是两套。** 扩展打印出来的东西按 pi 自己的配色主题来画，用的是终端的亮色和暗色取值，于是一条带颜色的状态、一个小部件、一个自定义面板，在这套设计上和换了一套配色时读起来一样，两种主题下都看得清。shell 命令的输出保留它自己那一套颜色，朝主题的墨色调配，好让它们待在卡片里面而不是压在卡片上面。原版也给同样的那些扩展调用上色（[一样是这个做法](https://github.com/agegr/pi-web/commit/da6d538a)），而它只有一套，因为它根本不用颜色来打印命令的输出。（[说明](./agents/design.md#one-stylesheet-imported-last-appnew_designcss-applayouttsx)）

## 快速开始（原版，Node.js）

Pi Web 要求 Node.js 22.19.0 或更高版本。先用 `node --version` 检查版本，然后运行：

```bash
npx @agegr/pi-web@latest
```

服务就绪后，命令行会尝试自动打开浏览器。如果没有打开，请访问 [http://127.0.0.1:30141](http://127.0.0.1:30141)。Pi Web 默认仅监听 `127.0.0.1`。

如需全局安装 `pi-web` 命令：

```bash
npm install -g @agegr/pi-web@latest
pi-web
```

命令：

```bash
pi-web version          # 打印已安装的版本
pi-web status           # 列出正在运行的服务
pi-web stop [--port N]  # 停止正在运行的服务
pi-web open [--port N]  # 在浏览器中打开正在运行的服务
pi-web update [--check] # 更新全局 npm 安装
```

更新时先运行 `pi-web stop`，再运行 `pi-web update`（也可以再次执行同一条安装命令）。卸载时运行 `npm uninstall -g @agegr/pi-web`。

## 配置

端口和主机名以命令行参数为准，优先于对应的环境变量。`--no-open` 与 `PI_WEB_NO_OPEN=1` 中任意一个都会关闭自动打开浏览器。运行 `pi-web --help`（或 `-h`）可打印启动选项并以退出码 0 结束，不会启动服务；未知参数会报错并以退出码 1 结束。

| 参数或环境变量 | 用途 | 默认值 |
| --- | --- | --- |
| `--help`、`-h` | 打印启动选项并退出 | — |
| `--port <端口>`、`-p <端口>` 或 `PORT` | 服务端口 | `30141` |
| `--hostname <主机>`、`-H <主机>` 或 `PI_WEB_HOSTNAME` | 监听主机名 | `127.0.0.1` |
| `--no-open` 或 `PI_WEB_NO_OPEN=1` | 不自动打开浏览器 | 自动打开 |
| `PI_WEB_APP_NAME` | PWA manifest 的 `name` 和 `short_name`；去除首尾空白，空值使用默认值 | `Pi Web` |
| `PI_WEB_ALLOWED_HOSTS` | 额外允许的代理或自定义主机名，多个值用逗号分隔，必须精确匹配 | 未设置 |
| `PI_WEB_PASSWORD` | 启用浏览器密码登录；API 客户端可使用用户名为 `pi` 的 Basic Auth | 不启用认证 |

在启动服务前设置 `PI_WEB_APP_NAME`，例如 `PI_WEB_APP_NAME='工作 Pi' pi-web`。修改后重启服务即可提供新的 manifest，无需重新构建。已安装 PWA 的名称更新由浏览器管理，不保证立即生效；此设置不改变页面标题或图标。

例如：

```bash
pi-web --help
pi-web -p 8080 -H 0.0.0.0 --no-open
```

### 远程访问

监听非回环地址会暴露一个可执行高权限操作的智能体。在可信局域网中使用时，请设置足够长的随机密码：

```bash
PI_WEB_PASSWORD='足够长的随机密码' pi-web --hostname 0.0.0.0
```

密码认证不会加密连接。不要通过明文 HTTP 将 Pi Web 暴露到互联网；远程访问应使用可信反向代理提供 HTTPS，或通过可信 VPN。如果反向代理传递外部主机名，请把该名称精确加入 `PI_WEB_ALLOWED_HOSTS`。这个白名单不会改变 Pi Web 的监听地址。

### Docker

每次发布都会把镜像推到 `ghcr.io/agegr/pi-web`。镜像本身、Compose 示例和该保留哪些卷，见 [在 Docker 里运行 Pi Web](./docker.md)。

### HTTP 代理

服务端的模型和 API 请求会读取标准的 `HTTP_PROXY`、`HTTPS_PROXY` 和 `NO_PROXY` 环境变量。下面几条跑的是本分支从仓库启动的那个启动器；原版用的是 `npx @agegr/pi-web@latest`。

macOS 或 Linux：

```bash
HTTP_PROXY=http://127.0.0.1:7890 \
HTTPS_PROXY=http://127.0.0.1:7890 \
NO_PROXY=localhost,127.0.0.1 \
pi-web
```

Windows PowerShell：

```powershell
$env:HTTP_PROXY = "http://127.0.0.1:7890"
$env:HTTPS_PROXY = "http://127.0.0.1:7890"
$env:NO_PROXY = "localhost,127.0.0.1"
pi-web
```

## 注意事项

- **智能体数据**：Pi Web 默认读取 `~/.pi/agent` 下的 pi 数据，包括 `sessions/<编码后的工作目录>/<时间戳>_<uuid>.jsonl` 中的会话文件。可通过 `PI_CODING_AGENT_DIR` 指定其他 pi agent 目录。
- **文件系统访问**：Pi Web 必须能读取智能体数据目录及会话记录中的工作目录。与现有 pi 会话共用数据时，请让 Pi Web 运行在与 pi 相同的文件系统环境中。
- **共享配置**：模型面板使用 pi 的模型、设置和凭据存储，因此两种界面都能看到相关更改。
- **文件访问边界**：文件浏览器仅能访问在 Pi Web 中选择过的工作目录，以及它已识别的项目或会话根目录；它不是通用的文件系统浏览器。
- **Git worktree**：切换器何时显示、如何创建 worktree，以及删除会产生什么影响，见 [Pi Web 里的 Worktree](./worktrees.zh-CN.md)。

### 下游的会话行右键菜单

Electron 封装和其他下游集成可以不改 `SessionSidebar` 就提供会话行的右键菜单。监听可取消的 `pi-web:session-row-contextmenu` 浏览器事件，集成方要自己接管时同步调用 `preventDefault()`：

```js
window.addEventListener("pi-web:session-row-contextmenu", (event) => {
  event.preventDefault();
  const { id, path, cwd, name, clientX, clientY, refresh } = event.detail;

  void openSessionMenu({ id, path, cwd, name, clientX, clientY }).then((changed) => {
    if (changed) refresh();
  });
});
```

detail 对象里有 `id`、`path`、`cwd`、可选的 `name`、指针坐标，以及一个 `refresh()` 回调，给那些会改动会话列表的动作。没有监听者取消这个事件时，Pi Web 就在指针处打开自己内置的会话菜单（置顶、重命名、分叉、标为已读或未读、归档、在新标签页打开、删除），而不是浏览器的原生右键菜单。行上的 `⋯` 按钮永远打开内置菜单，也不派发这个事件。还没写进磁盘的会话没有内置菜单，因此它们仍然会出现原生菜单。这个钩子在浏览器一侧，和 Pi 的 agent 扩展无关。

### 扩展的会话存活

服务端的 Pi 扩展如果有脱离会话自己在跑的工作，可以通过带版本号的全局注册表阻止会话被自动闲置回收：

```js
const liveness = globalThis[Symbol.for("@agegr/pi-web/session-liveness/v1")];
const release = liveness?.version === 1
  ? liveness.register({
      name: "my-extension",
      sessionId,
      sessionFile: sessionFile || undefined,
      isActive: () => detachedJobs.size > 0,
    })
  : () => {};
```

每个活跃的扩展会话注册一次，并在会话关闭、被替换或重载时调用返回的那个幂等 `release`。`isActive` 必须同步、开销很小，并且只针对传给它的精确会话 id 或文件。提供商错误按保住该会话处理。这份租约只影响自动闲置回收；显式关闭和 Stop 的兜底清理仍然优先。

## 开发

本节沿用原版，仅供参考。在本仓库里请改用 [Bun 安装](#bun-安装) 中的命令：那里的 `npm install` 会重写被跟踪的 `package-lock.json`，而本分支只用 `npm install --package-lock-only` 记录它。

```bash
npm install
npm run dev
```

开发服务器运行在 [http://127.0.0.1:30141](http://127.0.0.1:30141)。常用检查命令：

```bash
npm test
node_modules/.bin/tsc --noEmit
npm run lint
```

日常开发时不要运行 `npm run build`；构建属于发布流程。构建写入 `dist/`，开发服务器只用 `.vinext/dev/` 里的状态，两者不再互相打扰——但构建仍属于发布流程。

开始做新功能之前，请先阅读[参与贡献](./CONTRIBUTING.zh-CN.md)，了解哪些改动在范围内以及提交 PR 前的检查项。

贡献者文档：[国际化](./i18n.md)和[发布流程](./release.md)。

## 仓库结构

```text
app/             App Router 界面和 API 路由，由 vinext 跑在 Vite 上
components/      React 界面组件
hooks/           客户端状态和交互 hooks
lib/             会话、智能体、模型、文件、Git 和安全逻辑
public/          静态资源和 PWA 文件
bin/             `pi-web` 启动器及其 CLI：CommonJS，在任何构建之前被加载
                 （`pi-web.cjs`、`pi-web-options.cjs`、`pi-web-commands.cjs`、
                 `pi-web-update.cjs`，以及旁边的进程、浏览器、网络、node 参数、
                 vinext 和终端辅助模块）
docs/            面向用户和贡献者的专题文档
e2e/             跑在 Apple WebKit 上的 Playwright 回归检查及其框架
demo/            上游的静态演示站，为同步上游而保留；本 fork 不发布
```

架构说明和详细文件地图见 [AGENTS.md](../AGENTS.md)。

## 许可证

[MIT](../LICENSE)
