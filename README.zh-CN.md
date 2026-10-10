# Pi Web（Bun 版）

[English](./README.md) | [日本語](./README.ja.md) | [Русский](./README.ru.md)

> **这是 [agegr/pi-web](https://github.com/agegr/pi-web) 的 Bun 专用分支。** 无需安装 Node.js、`npm` 或 `npx`，用 [Bun](https://bun.sh) 就能跑。我们对「一个编码 agent 在浏览器里应该怎么读」有自己的判断：长命令自己移交后台，而不是把整个回合吊在半空；`read` 卡片直接打开它真正读到的那一段；输入框不会在你手指底下换人；中继掐断 HTTP/2 流也不再赔上一次运行。哪些仍然与原版不同、哪些上游已经自己实现，见[与原版的区别](#与原版的区别)；安装方式见 [Bun 安装](#bun-安装)。其余部分沿用原版文档。

[pi 编程智能体](https://github.com/earendil-works/pi)的本地浏览器界面。Pi Web 与 pi 共用本机配置和会话文件，可在浏览器中查找和继续对话、运行智能体、配置模型与资源，并查看项目文件。

**[在线体验演示 →](https://agegr.github.io/pi-web/)**：真实的 Pi Web 界面直接在浏览器里运行，带有示例会话、文件和模型。无需安装；回复都是预设内容，不会调用任何模型。

中文微信群：请查看 [GitHub Discussions 帖子](https://github.com/agegr/pi-web/discussions/271)。

![Pi Web 展示包含结构化 Markdown、工具调用和项目导航的 pi 会话](https://raw.githubusercontent.com/agegr/pi-web/main/docs/screenshot2.png)

## 功能

- **会话工作区**：按项目查找、继续、重命名、导出和删除对话，并查看运行状态、上下文占用、花费和压缩信息。
- **两种分支方式**：**新会话**会从较早的消息创建独立会话文件；**从此处编辑**会在当前会话内创建分支。
- **后台 bash 任务**（默认关闭）：长时间运行的命令会移交成后台任务，结束后以一张已结算的卡片回来，而不是一直占着这一轮。
- **项目文件工具**：浏览和上传文件、查看 Git Diff，并预览源码、Markdown、图片、音频、PDF 和 DOCX；文件变化后会自动刷新。
- **侧栏里的读取切片与表格**：点开 `read` 工具卡片会在侧栏打开它真正读到的那一段——Markdown 按 Markdown 渲染，源码行号从读取的偏移接着往下数；CSV 和 TSV 的切片以表格打开，行号沿用文件自己的行号。
- **命令高亮**：shell 工具卡片把命令按 token 着色，不再是一整条暗色字符串，并在旁边保留 `timeout` 与后台标记。
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
| 用户目录 | `os.homedir()` | 先看 `$HOME`（`lib/home-dir.ts` 的 `homeDir()`）——agent 目录、默认 cwd、目录浏览器的根、路径里的 `~`，以及 HTTP dispatcher 读超时所在的 agent 目录 |
| 技能安装 | `npx skills add …` | `bun x skills add …` |
| 插件更新检查 | `npm view … version --json` | `bun pm view … version --json` |
| 测试套件 | Node 运行器（`npm test`） | 两种运行器都跑、都绿：`bun test` 与 `npm test` |
| 开发构建产物 | 开发服务器和 `next build` 共用 `.next/` | `PI_WEB_DIST_DIR` 把开发脚本指向 `.next-dev/`，构建或 `next start` 不再污染开发服务器的目录 |
| 锁文件 | `package-lock.json` | `bun.lock` 已加入忽略列表；`bun-types` 则写进被跟踪的 `package-lock.json`，因为 CI 的 `npm ci` 不接受与它对不上的 `package.json` |
| CI | Node.js 上跑 `.github/workflows/ci.yml` | 同一个 `ci.yml`，一字未改——本分支不加 Bun 的 job，所以上面那些 Bun 检查在本地跑 |

**终端。** node-pty 的原生插件在 Bun 下无法维持 pty master fd 的生命周期：fd 在 `spawn()` 之后立即被关闭，子进程的 stdin 直接读到 EOF，交互式 shell 还没来得及打印提示符就退出了（[agegr/pi-web#745](https://github.com/agegr/pi-web/issues/745)，另见 [oven-sh/bun#7362](https://github.com/oven-sh/bun/issues/7362)）。Bun 原生的 PTY 支持（`Bun.spawn({ terminal })`）会为进程的整个生命周期持有该 fd，因此 `lib/terminal-bun-pty.ts` 实现了 `lib/terminal-manager.ts` 所需要的那一小部分 node-pty 兼容接口——spawn、`onData`、`onExit`、`write`、`resize`、`kill` 和 `pid`——Node.js 和 Windows 则继续使用 node-pty。没有轮询读取器，没有 fd 生命周期补丁，也没有额外依赖。

**技能与插件检查。** `lib/node-cli.ts` 把两个只读的包管理器调用映射到 Bun 的等价命令（npx 用 `bun x`，`bun pm view` 输出的 JSON 与 npm 一致）。安装仍走 SDK 自己的包管理器路径，由上面的 `npmCommand` 指向 bun。

### 这个分支新增的功能

装上第一次就能用，除非条目里另有说明，都不需要额外配置。每条末尾写明原版的处理，方便两边对照。

**长时间运行的命令转后台。** shell 命令跑过两分钟就移交成后台任务：agent 继续往下做，命令结束后带着日志文件以一张已完成的卡片回来。开关在**设置 → 常规 → 后台 bash 任务**，默认关闭；关着的时候就是原版那个 bash 工具，一模一样。只有开关打开时，模型才能看到 `run_in_background` 这个参数。原版的立场是：后台执行该由 pi 自己提供，而不是由网页包装层提供（[#1132](https://github.com/agegr/pi-web/pull/1132)）。（[移交是怎么发生的](./docs/agents/background-bash.md#two-ways-into-the-background)）

**断流不再赔上整次运行。** 有些中继会在响应中途掐断 HTTP/2 流，而 pi 把这归类为致命错误：回答写到一半就停下，也不会重试。这里会重试，沿用 pi 自己的重试次数与退避，同时仍然把你按下的「停止」、额度被拒、上下文装满当作致命错误处理。原版的立场是浏览器应当和终端里的 pi 重试得一模一样，而且那句错误文本该进 pi 的重试表（[#1134](https://github.com/agegr/pi-web/pull/1134)）；在 pi 收录它之前，本分支从外部读取 pi 的判定，并且有一条测试会在 pi 改名时把构建跑红，所以这个修复不可能无声消失。（[重试什么、不重试什么](./docs/agents/sessions.md#agentsession-lifecycle-librpc-managerts)）

**一眼能读懂的 shell 命令。** bash 工具卡片里的命令按 shell 语法高亮，不再是一整条灰字；展开后显示命令本身和它的超时，而不是原始 JSON——于是 `grep -rl "foo" src | xargs rm` 看起来就是一条管道。在后台跑的命令另有 `(background)` 标记。不引入任何语法高亮依赖：245 行扫描器加一个渲染组件，配色就是六个 CSS 变量。原版选择让工具卡片保持不带样式（[#1135](https://github.com/agegr/pi-web/pull/1135)）。（[说明](./docs/agents/sessions.md#tool-execution-events-on-the-sse-stream)）

**在对话旁边读文件的那一段。** 点一张已完成的 `read` 卡片，右侧面板就打开这次调用真正返回的那一段：Markdown 按 Markdown 渲染，源码行号从这次读取起始的那一行接着数，CSV 和 TSV 直接成表格、用的还是文件真实行号，即使切片是从文件中间截的。面板显示的是模型拿到的内容，不是文件此刻的样子——不重新请求、也不重新读盘，所以面板和记录可以互相对账。卡片保留自己的输出，面板只是伸手就到的一次点击。原版把 read 的输出留在卡片里，并把那张分隔符表格用在文件预览中（[#1136](https://github.com/agegr/pi-web/pull/1136)、[#1150](https://github.com/agegr/pi-web/pull/1150)）。（[说明](./docs/agents/sessions.md#a-read-card-opens-its-slice-in-the-right-panel-toolcallblock-componentsreadsnapshotviewertsx)）

**运行时按钮不挪位。** 「停止」放在输入框里，与「引导」和「后续消息」并排，输入框下方那一排在运行中和结束后只有一套摆法——你正要点的东西不会在这次运行结束的一瞬变成别的东西。上下文真的装满时，「压缩」那颗按钮就是「停止压缩」，所以你需要的操作就在手底下。原版的处理是挡住一次运行结束后 600 毫秒内的误点（[#1131](https://github.com/agegr/pi-web/pull/1131)、`0a38de9`）；本分支把这道守卫留着，而在桌面上，它所要防的那种按钮替换已经不存在了。（[说明](./docs/agents/sessions.md#composer-action-row-nothing-moves-under-the-pointer-at-a-run-boundary)）

**子代理由 profile 配置，不由模型猜。** 子代理的思考档位、轮次上限、是否继承这段对话，都由它的 profile 决定，于是一次运行可以从产出它的那份 profile 复现。`model` 是调用方唯一还能指定的参数，因为换某个模型跑一次是常见且明确的需求，而工具描述里列着每个 profile 自己的模型。要让子代理看哪些文件，就写在 `prompt` 里，它用自己的 `read` 去打开——被委派出去的会话因此只占它真正需要的上下文；把整份文件内联进任务里，正是让刚打开的子代理直接就去做压缩的原因。原版另外接受调用上的 `input_files` 列表（[#1138](https://github.com/agegr/pi-web/pull/1138)、`fb6df88`）。（[说明](./docs/agents/subagents.md#what-the-model-may-choose-when-spawning-a-subagent)）

### 不算 fork 差异的部分

下面这些来自上游，本仓库有它们只是因为上游写了它们：让「停止」不落在「压缩」接手的格子里、以免误双击（`0a38de9`，[#1131](https://github.com/agegr/pi-web/pull/1131)）；从标题折叠自定义消息（`574cbba`，[#1133](https://github.com/agegr/pi-web/pull/1133)）；已删除的子代理 worktree 改从它分叉出来的仓库回答（`f9a370e`，[#1137](https://github.com/agegr/pi-web/pull/1137)）；由 profile 决定子代理的启动参数（`fb6df88`，[#1138](https://github.com/agegr/pi-web/pull/1138)）；以及文件预览里的 CSV/TSV 表格（`f87afbb`，[#1150](https://github.com/agegr/pi-web/pull/1150)）。本 README 的早期版本把这些算成了 fork 的工作，现在不再这样写。

其余没有列出的部分——会话、文件、Git、worktree、模型、MCP、扩展——都是上游代码，行为与原版描述一致。

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
- **Git worktree**：切换器何时显示、如何创建 worktree，以及删除会产生什么影响，见 [Pi Web 里的 Worktree](./docs/worktrees.zh-CN.md)。

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

贡献者文档：[国际化](./docs/i18n.md)和[发布流程](./docs/release.md)。

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

架构说明和详细文件地图见 [AGENTS.md](./AGENTS.md)。

## 许可证

[MIT](./LICENSE)
