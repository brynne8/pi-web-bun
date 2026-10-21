# Pi Web（Bun 版）

[English](../README.md) | [日本語](./README.ja.md) | [Русский](./README.ru.md)

> **这是 [agegr/pi-web](https://github.com/agegr/pi-web) 的 Bun 专用分支。** 无需安装 Node.js、`npm` 或 `npx`，用 [Bun](https://bun.sh) 就能跑。我们对「一个编码 agent 在浏览器里应该怎么读」有自己的判断：长命令自己移交后台，而不是把整个回合吊在半空；`read` 卡片直接打开它真正读到的那一段；输入框不会在你手指底下换人；中继掐断 HTTP/2 流也不再赔上一次运行。哪些仍然与原版不同、哪些上游已经自己实现，见[与原版的区别](#与原版的区别)；安装方式见 [Bun 安装](#bun-安装)。其余部分沿用原版文档。

[pi 编程智能体](https://github.com/earendil-works/pi)的本地浏览器界面。Pi Web 与 pi 共用本机配置和会话文件，可在浏览器中查找和继续对话、运行智能体、配置模型与资源，并查看项目文件。

**[在线体验演示 →](https://agegr.github.io/pi-web/)**：真实的 Pi Web 界面直接在浏览器里运行，带有示例会话、文件和模型。无需安装；回复都是预设内容，不会调用任何模型。那个演示是原版构建的——本分支不发布自己的演示，所以它不会展示下面列出的那些差异。

中文微信群：请查看 [GitHub Discussions 帖子](https://github.com/agegr/pi-web/discussions/271)。

![Pi Web 展示包含结构化 Markdown、工具调用和项目导航的 pi 会话](https://raw.githubusercontent.com/agegr/pi-web/main/docs/screenshot2.png)

## 功能

- **会话工作区**：按项目查找、继续、重命名、导出和删除对话，并查看运行状态、上下文占用、花费和压缩信息。
- **两种分支方式**：**新会话**会从较早的消息创建独立会话文件；**从此处编辑**会在当前会话内创建分支。
- **后台 bash 任务**（默认关闭）：长时间运行、或者输出长过头的命令会移交成后台任务，结束后以一张已结算的卡片回来，而不是一直占着这一轮。
- **不会错过的后台结果**：已结算的报告汇成一批、只把模型唤醒一次，每份保留自己那张卡片；模型还能问一句 `pending_notifications` 还有什么在等。
- **项目文件工具**：浏览和上传文件、查看 Git Diff，并预览源码、Markdown、图片、音频、PDF 和 DOCX；文件变化后会自动刷新。
- **文件行自己的右键菜单**：在项目文件树里右键某一行，可以把路径插入聊天、下载文件、撤销它未提交的改动，或者在系统文件管理器里看到这个文件（选中它本身）；悬停时不会再有东西盖在文件名上面。
- **侧栏里的读取切片与表格**：点开 `read` 工具卡片会在侧栏打开它真正读到的那一段——Markdown 按 Markdown 渲染，源码行号从读取的偏移接着往下数；CSV 和 TSV 的切片以表格打开，行号沿用文件自己的行号。
- **命令高亮**：shell 工具卡片把命令按 token 着色，不再是一整条暗色字符串，并在旁边保留 `timeout` 与后台标记。
- **工具卡片上的参数按行排**：参数全是普通值的工具调用，会一行一个参数地排成表格，而不是一整块 JSON——不必数引号、也不必展开嵌套。只要有一个值是对象或数组，这张卡片就退回 JSON，因为藏掉一棵子树的表格等于让你看不到那个参数。
- **放得下的 diff**：edit 和 apply_patch 的改动两栏并排——左边改动前、右边改动后；在手机上改为单栏，因为两个代码栏并排时哪一栏都没法读，删掉的那一行就排在替换它的那一行上面。
- **按顺序读下来的运行**：模型写的句子留在它写下的位置，中间连着的思考和工具调用各自折进自己那一组「处理详情」，这次运行最后由单独一行收尾——token 数、这一轮改过的文件，和一个把写下的全部内容交出去的「复制」按钮。
- **思考过程按 Markdown 渲染**：展开的思考卡片会把标题、列表、表格和围栏代码渲染出来，而不是露出一堆标记符号。
- **文中的 shell 变量不会变成公式**：句子里的 `$HOME`、`$PATH`，还有夹在两个美元符号中间的中文句子，都按原样显示，不再被渲染成数学公式。
- **Git worktree**：从侧边栏切换 checkout，同时把同一仓库不同 worktree 的会话归在一起。
- **网页配置**：无需离开 Pi Web，即可管理 Provider 登录和 API Key、模型、模型测试、插件包及技能。
- **英文、简体中文和繁体中文界面**：Pi Web 首次打开时跟随浏览器语言，也可从顶部栏切换语言。

## Bun 安装

本分支面向 Bun，不需要任何 Node.js 工具链。要求 [Bun](https://bun.sh) 1.4.2 或更高版本，可用 `bun --version` 检查。

```bash
git clone https://github.com/brynne8/pi-web-bun.git
cd pi-web-bun
bun install
bun run dev
```

开发服务器启动在 [http://127.0.0.1:30141](http://127.0.0.1:30141)。

本分支不发布 npm 包，按上面的方式从仓库运行即可。`bun.lock` 已加入忽略列表，每次 `bun install` 都会重新解析依赖，也不要把它提交。真正被跟踪的是 `package-lock.json`：上游 CI 靠它 `npm ci`，以改依赖后用 `bun x npm install --package-lock-only` 记录并提交结果。

如果尚未配置模型 Provider，请打开**模型面板**（Models）登录或添加 API Key。`~/.pi/agent` 会在首次使用时自动创建。

### 常用命令

```bash
bun install                            # 安装依赖
bun run dev                            # 开发服务器，监听 127.0.0.1:30141
bun run dev:lan                        # 开发服务器，监听 0.0.0.0:30141
bun test                               # 运行测试
bun x tsc --noEmit                     # 类型检查
bun run lint                           # 代码检查
```

在 Bun 下运行检查命令有三点说明：

- 用 `bun test` 代替 `npm test`。`package.json` 里的 `test` 脚本仍调用 Node 的测试运行器，Bun 无法展开它传入的 glob；`bun test` 不需要任何参数，会自己找出全部测试文件。同理用 `bun x tsc --noEmit` 代替 `node_modules/.bin/tsc --noEmit`，因为 `.bin` 下的启动脚本带 `#!/usr/bin/env node` shebang，没有 Node 时会执行失败。
- **两种运行器在本分支都受支持，并且都必须保持全绿**：真实的 Node.js 22.19.0+ 上跑 `npm test` 是第二意见，也是上游唯一有的那个，所以 rebase 上游后要靠它对比。两边计数方式不同——Node 会自己统计 subtest 与 suite——所以只比失败项，不比总数。Bun 下哪里行为不同、该怎么写，记在 [docs/agents/tests.md](./docs/agents/tests.md)。
- 整个测试套件在 `bun test` 下也全部通过——`app/`、`components/`、`hooks/`、`lib/`、`public/` 下的每个文件。只有在某个运行时才能观察到的行为，测试会说明并跳过不适用的那一半，而不是失败：Bun 的 `fetch` 不使用 undici 的全局 dispatcher，Bun 的 `node:module` 既不导出 `stripTypeScriptTypes` 也不导出 `registerHooks`。

### Bun 下的插件安装

需要一项设置，写在 `~/.pi/agent/settings.json`：

```json
{ "npmCommand": ["bun"] }
```

pi SDK 会读取该设置，并按包管理器（`npm`、`pnpm`、`bun`）调整安装参数。请通过 SDK（`SettingsManager.setNpmCommand(["bun"])`）或**设置面板**（Settings）设置，而不是手动改文件，以便遵守它自己的锁。

## 与原版的区别

三类差异。[在 Bun 上运行](#在-bun-上运行)是不装 Node.js 工具链所必需的改造。[这个分支新增的功能](#这个分支新增的功能)是在原版之上多做的那部分，两边做法不同的地方各附一句原版的处理。[不算 fork 差异的部分](#不算-fork-差异的部分)是上游自己写的、本仓库只是跟着拿到的改动。

### 在 Bun 上运行

| 部分 | 原版 | 本分支 |
| --- | --- | --- |
| 运行时 | Node.js 22.19.0+ | Bun 1.4.2+ |
| 内置终端 | 通过 `node-pty` 正常工作 | 通过一层薄薄的 node-pty 兼容封装使用 Bun 原生 PTY（见下，另见 [docs/terminal.md](./docs/terminal.md)） |
| SDK 包解析 | `node:module` 的 `findPackageJSON()` | `lib/pi-sdk-internals.ts` 里的 `findPackageManifest()` 向上遍历 `node_modules`，因为 Bun 不实现 `node:module` 的任何具名导出 |
| 用户目录 | `os.homedir()` | 先看 `$HOME`，再回落到用户数据库（`lib/home-dir.ts` 的 `homeDir()`），因为 Bun 的 `os.homedir()` 会忽略 `$HOME`——agent 目录、默认 cwd、目录浏览器的根、路径里的 `~`，以及 HTTP dispatcher 读超时所在的 agent 目录。Windows 上通常没有 `$HOME`，所以那里同样走用户数据库 |
| 技能安装 | `npx skills add …` | `bun x skills add …` |
| 插件更新检查 | `npm view … version --json` | `bun pm view … version --json` |
| 测试套件 | Node 运行器（`npm test`） | 两种运行器都跑、都绿：`bun test` 与 `npm test` |
| 浏览器回归测试 | Playwright Chromium（`npx playwright install --with-deps chromium`） | 用 Playwright 自带的 Apple WebKit：`npm run test:e2e:install` 拉取，CI 装 `--with-deps webkit`；本分支不安装也不启动任何 Chromium 二进制（见 [docs/agents/tests.md](./docs/agents/tests.md#e2e-playwright)） |
| 开发构建产物 | 开发服务器和 `next build` 共用 `.next/` | `PI_WEB_DIST_DIR` 把开发脚本指向 `.next-dev/`，构建或 `next start` 不再污染开发服务器的目录 |
| 锁文件 | `package-lock.json` | `bun.lock` 已加入忽略列表；`bun-types` 则写进被跟踪的 `package-lock.json`，因为 CI 的 `npm ci` 不接受与它对不上的 `package.json` |
| CI | Node.js 上跑 `.github/workflows/ci.yml` | 同一个 `ci.yml`，只把它要装的浏览器换成 `--with-deps webkit`——本分支不加 Bun 的 job，所以上面那些 Bun 检查在本地跑 |

**终端。** node-pty 的原生插件在 Bun 下无法维持 pty master fd 的生命周期：fd 在 `spawn()` 之后立即被关闭，子进程的 stdin 直接读到 EOF，交互式 shell 还没来得及打印提示符就退出了（[agegr/pi-web#745](https://github.com/agegr/pi-web/issues/745)，另见 [oven-sh/bun#7362](https://github.com/oven-sh/bun/issues/7362)）。Bun 原生的 PTY 支持（`Bun.spawn({ terminal })`）会为进程的整个生命周期持有该 fd，因此 `lib/terminal-bun-pty.ts` 实现了 `lib/terminal-manager.ts` 所需要的那一小部分 node-pty 兼容接口——spawn、`onData`、`onExit`、`write`、`resize`、`kill` 和 `pid`——Node.js 和 Windows 则继续使用 node-pty。没有轮询读取器，没有 fd 生命周期补丁，也没有额外依赖。

**技能与插件检查。** `lib/node-cli.ts` 把两个只读的包管理器调用映射到 Bun 的等价命令（npx 用 `bun x`，`bun pm view` 输出的 JSON 与 npm 一致）。安装仍走 SDK 自己的包管理器路径，由上面的 `npmCommand` 指向 bun。

### 这个分支新增的功能

装上第一次就能用，除非条目里另有说明，都不需要额外配置。每条末尾写明原版的处理，方便两边对照。

**长时间运行的命令转后台。** shell 命令跑过两分钟就移交成后台任务：agent 继续往下做，命令结束后带着日志文件以一张已完成的卡片回来。它打印的行数超过模型用 `max_output_lines` 设的上限时也会移交，所以一条会把上下文灌爆的命令，不必靠砍短输出来躲。开关在**设置 → 常规 → 后台 bash 任务**，默认关闭；关着的时候就是原版那个 bash 工具，一模一样。只有开关打开时，模型才能看到 `run_in_background` 和 `max_output_lines` 这两个参数。原版的立场是：后台执行该由 pi 自己提供，而不是由网页包装层提供（[#1132](https://github.com/agegr/pi-web/pull/1132)）。（[移交是怎么发生的](./docs/agents/background-bash.md#two-ways-into-the-background)）

**跑完的东西不会再看不见。** 后台命令或子代理没法在父会话运行途中报告自己，而在过去也没有任何东西说明有结果在等。已结算的报告汇成一批送达，只把父会话唤醒一次，每份仍保留自己的卡片；模型可以问一句 `pending_notifications` 还有什么在等，等待期间每个轮次都会收到一次提醒。原版是一份发一条消息，而且要等父会话空闲。（[说明](./docs/agents/pending-notifications.md)）

**断流不再赔上整次运行。** 有些中继会在响应中途掐断 HTTP/2 流，而 pi 把这归类为致命错误：回答写到一半就停下，也不会重试。这里会重试，沿用 pi 自己的重试次数与退避，同时仍然把你按下的「停止」、额度被拒、上下文装满当作致命错误处理。原版的立场是浏览器应当和终端里的 pi 重试得一模一样，而且那句错误文本该进 pi 的重试表（[#1134](https://github.com/agegr/pi-web/pull/1134)）；在 pi 收录它之前，本分支从外部读取 pi 的判定，并由一条测试在 pi 改名时把构建跑红。（[重试什么、不重试什么](./docs/agents/sessions.md#agentsession-lifecycle-librpc-managerts)）

**一眼能读懂的 shell 命令。** bash 工具卡片里的命令按 shell 语法高亮，不再是一整条灰字；展开后显示命令本身和它的超时，而不是原始 JSON——于是 `grep -rl "foo" src | xargs rm` 看起来就是一条管道。在后台跑的命令另有 `(background)` 标记。原版选择让工具卡片保持不带样式（[#1135](https://github.com/agegr/pi-web/pull/1135)）。（[说明](./docs/agents/sessions.md#tool-execution-events-on-the-sse-stream)）

**在对话旁边读文件的那一段。** 点开一张已完成的 `read` 卡片，右侧面板就打开这次调用真正返回的那一段：Markdown 按 Markdown 渲染、一键就能切回它的源码，源码行号从这次读取起始的那一行接着数，CSV 和 TSV 直接成表格、用的还是文件真实行号。面板显示的是模型拿到的内容，不是文件此刻的样子——不重新请求、也不重新读盘，所以面板和记录可以互相对账。卡片保留自己的输出。原版把 read 的输出留在卡片里，并把那张分隔符表格用在文件预览中（[#1136](https://github.com/agegr/pi-web/pull/1136)、[#1150](https://github.com/agegr/pi-web/pull/1150)）。（[说明](./docs/agents/sessions.md#a-read-card-opens-its-slice-in-the-right-panel-toolcallblock-componentsreadsnapshotviewertsx)）

**再长的源码行也不会把行号带走。** 在右侧面板里把一行宽代码横向挪动时，行号那一栏钉在原地，不再跟着文字一起滑出去、让你重新找自己刚才停在哪一行。代码字号比原版小一号，源码视图、Diff 视图和读取快照面板一起跟着这一套字号走。原版是行号和文字一起滚走。

**散文默认折行，代码不折。** Markdown 和纯文本文件的源码视图和 Diff 视图打开时就按面板宽度折行，长句子能一口气读到底，不必拖动横向滚动条去找后半句。源代码则默认不折行，一行一行铺开、横向滚动——和编辑器一致，因为读代码靠的是缩进和列对齐，日志也按这条走。折行按钮仍然可以随手翻转任意一种文件，这个选择会在标签页里保留。原版所有文件都默认不折行。（[说明](./docs/agents/files-and-access.md#which-lines-wrap))

**运行时按钮不挪位。** 「停止」放在输入框里，与「引导」和「后续消息」并排，输入框下方那一排在运行中和结束后只有一套摆法——你正要点的东西不会在这次运行结束的一瞬变成别的东西。上下文真的装满时，「压缩」那颗按钮就是「停止压缩」，所以你需要的操作就在手底下。原版的处理是挡住一次运行刚结束时的误点（[#1131](https://github.com/agegr/pi-web/pull/1131)）；本分支把这道守卫留着，而在桌面上，它所要防的那种按钮替换已经不存在了。（[说明](./docs/agents/sessions.md#composer-action-row-nothing-moves-under-the-pointer-at-a-run-boundary)）

**工具参数按行显示，不再是一段 JSON。** 参数都是单个值的工具卡片，会一个参数一行地列出来——`write` 写下的路径和正文、子代理的 profile 和 prompt、MCP 工具的 query 和 limit——本身带换行的值保留成一块可以滚动的文本。规则是全部参数都上表，否则一个也不上：只要有一个值是嵌套的，比如 `edit` 的 `edits[]`、或者 MCP 参数里装着列表，这张卡片就照旧显示 JSON，因为一行漏掉子树就等于一个谁也看不见的参数。原版的处理同样是单个值的参数按行显示，但 `write` 保留自己那套看法：只显示文件正文，路径不跟在旁边。

**模型写下的文字留在屏幕上，只折叠中间的过程。** 一次运行按片段渲染：它写的文字就在写下的位置显示，中间连着的思考块和工具调用各自折进自己那一组「处理详情」。最后一组下面只有一个结尾，写着这次运行的事：token 数与耗时、这一轮改过的文件、交出全部文字的「复制」，还有运行停在 Provider 报错或输出上限上时的那句原因（[#906](https://github.com/agegr/pi-web/issues/906)）。各组一律从折叠开始，运行中的一轮边走边折、下一步一出现就把上一步折起来，你亲手展开的那一组会一直开着。原版把最后一次工具调用之前的东西全折进同一个框，只显示它之后的文字，并把数字、改动文件清单和失败原因挂到那条回复消息上。（[说明](./docs/agents/sessions.md#a-turn-shows-every-word-it-wrote-only-the-workings-fold-processdetailsgroup-componentschatwindowtsx)）

**子代理的报告按 Markdown 渲染。** `Agent` 或 `get_subagent_result` 的结果会把标题、列表、表格和围栏代码真的渲染出来，字号仍是这张卡片自己那一号，不再把子代理写下的标记符号直接摆给你看。其他工具的输出仍是原始文本——在那里 `*` 和 `#` 只是字符，不是标题。原版是把报告原样打印。（[说明](./docs/agents/subagents.md#the-report-on-screen)）

**思考过程按 Markdown 渲染。** 展开的思考块走的是和回复同一套 Markdown 流水线：标题、列表、表格和围栏代码都渲染出来，不再把标记符号直接摆给你看，写成链接的路径也能在应用里打开。字号仍是这张卡片一贯的那一号。原版的处理是把整段思考当成一串保留换行的纯文本。（[说明](./docs/agents/sessions.md#thinking-renders-as-markdown-at-the-cards-own-size-thinkingblock-componentsmessageviewtsx)）

**委派规则自己成块。** 目标一清楚就该委派——这句话现在单独成块，作为 `<delegation>` 出现在系统提示的末尾，不再混在所有工具共用的那一串规则里，于是它读起来是 `Agent` 的策略，不是又一条泛泛的建议。它给 `explore` 和 `plan` 各写了规则——要了解现有代码就交给 `explore`，它只读不改；要改好几处就先让 `plan` 给出步骤、文件、风险和验证方式——其余启用的子代理只列名字。它随每一次运行的提示发出，**系统提示**面板也能看到，包括被插件改写了提示的会话。原版把委派建议放在工具的 prompt guidelines 里，由 Pi 追加到扁平的 `<rules>` 列表。（[说明](./docs/agents/subagents.md#delegation-policy)）

**子代理由 profile 配置，不由模型猜。** 子代理的思考档位、轮次上限、是否继承这段对话，都由它的 profile 决定，于是一次运行可以从产出它的那份 profile 复现。`model` 是调用方唯一还能指定的参数，因为换某个模型跑一次是常见且明确的需求，而工具描述里列着每个 profile 自己的模型。要让子代理看哪些文件，就写在 `prompt` 里，它用自己的 `read` 去打开，被委派出去的会话因此只占它真正需要的上下文。原版另外接受调用上的 `input_files` 列表（[#1138](https://github.com/agegr/pi-web/pull/1138)）。（[说明](./docs/agents/subagents.md#what-the-model-may-choose-when-spawning-a-subagent)）

**文中的 shell 变量不再被当成公式。** 一个单独的 `$`，只要后面还有另一个 `$`，就会开一个公式，所以一句讲 `$HOME` 和 `$PATH` 的话会以数学斜体显示出来，夹在两个美元符号中间的中文句子也一样。这个分支会看两个定界符中间是什么——shell 变量名、只有 CJK 文本才有的标点、若干个汉字——并把那段文字原样留下，而 `$E=mc^2$`、`$PV=nRT$` 和一个短汉字量名仍按公式渲染。原版的数学解析只看定界符，它唯一的开关是把行内公式整个关掉，而不是只关掉那些其实是文字的一对（[remark-math](https://github.com/remarkjs/remark-math)）。（[说明](./docs/agents/sessions.md#math-delimiters-and-prose-that-only-looks-like-a-formula)）

**文件行自己的右键菜单。** 在项目文件树里右键某一行——在 Git 改动清单里右键也一样——这一行会给出这个文件自己的操作：把路径插入聊天、下载这个文件、撤销它未提交的改动（已暂存的一并取消暂存并还原内容），在访达 / 文件资源管理器 / 文件管理器里看到它，而且是选中这个文件本身，不只是打开它所在的目录。只有 Git 能还原的改动才有这一项——新增的文件、重命名、冲突都不算——而且它会先问一句再动手，因为它丢弃的内容不会保留。原版的处理是把前两项做成悬停时浮在文件名上的按钮；它通往文件管理器的入口只打开工作区所在目录，没有按文件的入口（[#907](https://github.com/agegr/pi-web/pull/907)）。（[说明](./docs/agents/files-and-access.md#a-rows-own-actions)）

**删除会带走会话在别处留下的东西。** 隔离运行的 subagent 在自己的 git worktree 里工作，它的会话文件因此记在那个 worktree 路径下，自成目录。删除父会话时会通读整个 sessions 根目录去找这样的子会话，连它一起删，并把留下来的重新挂到最近一个仍然存在的祖先。被删空的东西也跟着走：它清空的目录，还有你在应用外删掉某个项目目录之后侧栏仍替它保有的位置和名称。原版寻找子会话、也寻找该改挂谁，只看被删文件所在的那些目录。（[说明](./docs/agents/sessions.md#session-sidebar-project-groups-pins-and-archive)）

**解析不了的 settings 文件会报出自己的路径。** 读取全局 `settings.json` 的那些面板在报错时把文件路径一并带上，于是这条诊断直接指向要修的文件，而不是只把解析器的话重复一遍。文件原地不动：pi 读的是同一个文件，它继续报同一个错，并且拒绝一切写入，直到你手动把它修好。原版同样拒绝这些写入、同样把文件留在原地，只是它的报错里没有文件名。（[说明](./docs/agents/tools.md)）

**改动清单不用再看一遍目录树。** 侧边栏的 Git 清单每次刷新都重新从 Git 读，所以它显示的就是此刻的目录树。问 Git 的三个问题——仓库根目录、状态、改动行数——是一起发出的，不是一个接一个；未跟踪文件的行数只数一遍，文件没变就留着这个结果，所以未跟踪文件很多的仓库也能很快作答。原版把同样的问题一个接一个地问，并且每次刷新都把所有未跟踪文件重数一遍。（[说明](./docs/agents/files-and-access.md#when-the-file-tree-reloads)）

**「系统」面板显示模型拿到的那份提示词。** 「系统」面板列出完整的系统提示词，改写过它的插件也属于这份文本：插件自己写的那段话会出现在模型读到它的地方，而不是只留在插件的文件里。原版从记录里重放 pi 自己的那些段落，插件强制的那份提示词在那里从不出现——pi 在这次运行里送出它，记录里仍留着 pi 自己的段落。（[说明](./docs/agents/sessions.md#the-system-panel-shows-the-prompt-the-model-receives)）

### 不算 fork 差异的部分

下面这些来自上游，本仓库有它们只是因为上游写了它们：让「停止」不落在「压缩」接手的格子里、以免误双击（`0a38de9`，[#1131](https://github.com/agegr/pi-web/pull/1131)）；从标题折叠自定义消息（`574cbba`，[#1133](https://github.com/agegr/pi-web/pull/1133)）；已删除的子代理 worktree 改从它分叉出来的仓库回答（`f9a370e`，[#1137](https://github.com/agegr/pi-web/pull/1137)）；由 profile 决定子代理的启动参数（`fb6df88`，[#1138](https://github.com/agegr/pi-web/pull/1138)）；以及文件预览里的 CSV/TSV 表格（`f87afbb`，[#1150](https://github.com/agegr/pi-web/pull/1150)）。本 README 的早期版本把这些算成了 fork 的工作，现在不再这样写。

上游后来又收走了这个分支的三项：手机上以单栏打开的 patch（`408230c`，[#1325](https://github.com/agegr/pi-web/pull/1325)）、按行显示的工具参数（`083fd11`，[#1324](https://github.com/agegr/pi-web/pull/1324)），以及落在自己文档里的页内片段链接（`2cefb72`，[#1323](https://github.com/agegr/pi-web/pull/1323)）。上一次同步之后上游写的其余部分同样照单全收：浏览器测试在断点变化后等侧栏开关稳定（`a26d85f`，[#1326](https://github.com/agegr/pi-web/pull/1326)）、会话搜索覆盖改名与自动生成的标题（`7c0778a`，[#1318](https://github.com/agegr/pi-web/pull/1318)）、手机上「引导」与「后续消息」各占一行（`628d6ac`，[#1330](https://github.com/agegr/pi-web/pull/1330)）、引用末尾保留光标（`bc762a3`，[#1319](https://github.com/agegr/pi-web/pull/1319)），以及桌面上新建会话后输入框直接拿到焦点（`12b157d`，[#1313](https://github.com/agegr/pi-web/pull/1313)）。

其余没有列出的部分——会话、文件、Git、worktree、模型、MCP、扩展——都是上游代码，行为与原版描述一致。侧边栏的整体摆法也一样是上游的，而且是在本分支存在期间改掉的：桌面上文件栏放在会话列表下面、或者单独占一个标签页，项目分组用分区式标题，文件栏可折叠也可拖动，28px 行高、文件键按标签页的顺序排（`3fe257f`、`4fa6799`、`02532c3`、`0066d5f`、`51dda7c`、`cae6201`）；空白新会话页上，品牌字样位于项目与 worktree 选择器之上（`e2fe4fb`）。

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

### HTTP 代理

服务端的模型和 API 请求会读取标准的 `HTTP_PROXY`、`HTTPS_PROXY` 和 `NO_PROXY` 环境变量。

macOS 或 Linux：

```bash
HTTP_PROXY=http://127.0.0.1:7890 \
HTTPS_PROXY=http://127.0.0.1:7890 \
NO_PROXY=localhost,127.0.0.1 \
npx @agegr/pi-web@latest
```

Windows PowerShell：

```powershell
$env:HTTP_PROXY = "http://127.0.0.1:7890"
$env:HTTPS_PROXY = "http://127.0.0.1:7890"
$env:NO_PROXY = "localhost,127.0.0.1"
npx @agegr/pi-web@latest
```

## 注意事项

- **智能体数据**：Pi Web 默认读取 `~/.pi/agent` 下的 pi 数据，包括 `sessions/<编码后的工作目录>/<时间戳>_<uuid>.jsonl` 中的会话文件。可通过 `PI_CODING_AGENT_DIR` 指定其他 pi agent 目录。
- **文件系统访问**：Pi Web 必须能读取智能体数据目录及会话记录中的工作目录。与现有 pi 会话共用数据时，请让 Pi Web 运行在与 pi 相同的文件系统环境中。
- **共享配置**：模型面板使用 pi 的模型、设置和凭据存储，因此两种界面都能看到相关更改。
- **文件访问边界**：文件浏览器仅能访问在 Pi Web 中选择过的工作目录，以及它已识别的项目或会话根目录；它不是通用的文件系统浏览器。
- **Git worktree**：切换器何时显示、如何创建 worktree，以及删除会产生什么影响，见 [Pi Web 里的 Worktree](./worktrees.zh-CN.md)。

## 开发

本节沿用原版，仅供参考。在 Bun 下请改用 [Bun 安装](#bun-安装) 中的命令。

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

日常开发时不要运行 `next build` 或 `npm run build`。原版的开发服务器与构建共用 `.next/`，构建可能干扰开发服务器；仅在发布流程中执行构建。本分支的开发脚本设了 `PI_WEB_DIST_DIR=.next-dev`，两者已经分开，构建不再打扰开发服务器——但构建仍属于发布流程。

开始做新功能之前，请先阅读[参与贡献](./CONTRIBUTING.zh-CN.md)，了解哪些改动在范围内以及提交 PR 前的检查项。

贡献者文档：[国际化](./i18n.md)和[发布流程](./release.md)。

## 仓库结构

```text
app/             Next.js 界面和 API 路由
components/      React 界面组件
hooks/           客户端状态和交互 hooks
lib/             会话、智能体、模型、文件、Git 和安全逻辑
public/          静态资源和 PWA 文件
bin/             npm CLI 入口及启动参数解析
docs/            面向用户和贡献者的专题文档
demo/            上游的静态演示站，为同步上游而保留；本 fork 不发布
```

架构说明和详细文件地图见 [AGENTS.md](../AGENTS.md)。

## 许可证

[MIT](../LICENSE)
