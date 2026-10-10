# Pi Web (Bun)

[中文文档](./README.zh-CN.md) | [日本語](./README.ja.md) | [Русский](./README.ru.md)

> **This is a Bun-focused fork of [agegr/pi-web](https://github.com/agegr/pi-web).** It runs on [Bun](https://bun.sh) with no Node.js, `npm` or `npx` installed, and it has its own opinion about how a coding agent should read in a browser: a long command hands off instead of holding the turn open, a `read` call opens the exact slice it returned, the composer never changes what is under your finger, and a relay dropping its HTTP/2 stream no longer costs you the run. [Differences from upstream](#differences-from-upstream) says what still differs — and what upstream has since taken over; [Bun setup](#bun-setup) gets it running. Everything else below is upstream's documentation.

Local browser UI for the [pi coding agent](https://github.com/earendil-works/pi). Pi Web uses the same local configuration and session files as pi, so you can browse and resume conversations, run agent turns, configure models and resources, and inspect project files from a browser.

**[Try the interactive demo →](https://agegr.github.io/pi-web/)** The real Pi Web UI runs entirely in your browser, with sample sessions, files and models. There is nothing to install; replies are pre-written and no model is called. That demo is upstream's build — this fork publishes none, so it will not show the differences listed below.

![Pi Web displaying a pi session with structured Markdown, tool calls, and project navigation](https://raw.githubusercontent.com/agegr/pi-web/main/docs/screenshot2.png)

## Features

- **Session workspace**: browse, resume, rename, export, and delete conversations grouped by project, with running state, context usage, cost, and compaction details.
- **Two ways to branch**: **New session** creates an independent session file from an earlier message; **Edit from here** creates a branch inside the current session.
- **Background bash tasks** (off by default): a long-running command hands off to a background task and comes back as a settled card instead of holding the turn open.
- **Project file tools**: browse and upload files, inspect Git diffs, and preview source, Markdown, images, audio, PDFs, and DOCX files with automatic refresh.
- **Reads and tables in the side panel**: a `read` tool call opens the exact slice it returned — Markdown rendered, or source with line numbers continuing from the read's offset — and a `.csv` or `.tsv` slice opens as a table with the file's own line numbers in the gutter.
- **Highlighted commands**: a shell tool card colours the command's tokens instead of showing it as one dim string, and keeps its `timeout` and its background flag beside it.
- **A turn you can read in order**: the model's sentences stay on screen where it wrote them, each run of thinking and tool calls folds into its own "Process details" group, and the turn ends with one line of its own — its token counts, the files it changed, and a copy of everything it wrote.
- **Git worktrees**: switch checkouts from the sidebar while keeping sessions from the same repository grouped together.
- **Web-based configuration**: manage provider login and API keys, models, model tests, plugin packages, and skills without leaving Pi Web.
- **English, Simplified Chinese, and Traditional Chinese UI**: Pi Web follows the browser language initially and provides a language switcher in the top bar.

## Bun setup

This fork targets Bun and needs no Node.js toolchain. Requires [Bun](https://bun.sh) 1.4.2 or newer; check with `bun --version`.

```bash
git clone https://github.com/brynne8/pi-web-bun.git
cd pi-web-bun
bun install
bun run dev
```

The development server starts at [http://127.0.0.1:30141](http://127.0.0.1:30141).

There is no npm-published package for this fork; run it from a clone as above. `bun.lock` is gitignored, so `bun install` resolves fresh each time — and it stays out of the repository. The tracked `package-lock.json` is what upstream's CI installs from, so a dependency change is recorded with `bun x npm install --package-lock-only` and committed.

If no model provider is configured yet, open the **Models** panel to sign in or add an API key. `~/.pi/agent` is created on first use.

### Development commands

```bash
bun install                            # install dependencies
bun run dev                            # dev server on 127.0.0.1:30141
bun run dev:lan                        # dev server on 0.0.0.0:30141
bun test                               # run the test suite
bun x tsc --noEmit                     # typecheck
bun run lint                           # lint
```

Three notes on running the checks:

- `bun test` replaces `npm test`. The `test` script in `package.json` still calls Node's test runner, which Bun cannot expand the glob arguments for; `bun test` needs no arguments and picks up every test file itself. Likewise `bun x tsc --noEmit` replaces `node_modules/.bin/tsc --noEmit`, because the `.bin` shims carry a `#!/usr/bin/env node` shebang and fail without Node on `PATH`.
- **Both runners are supported here, and both are kept green.** `npm test` on a real Node.js 22.19.0+ is the second opinion, and the only one upstream has, so it is the runner to compare after a rebase onto upstream. The two do not count alike — Node counts subtests and suites of its own accord — so compare failures, never totals. [docs/agents/tests.md](./docs/agents/tests.md) records what behaves differently under Bun and what to write instead.
- The whole suite passes under `bun test` as well: every file under `app/`, `components/`, `hooks/`, `lib/` and `public/`. Where a behaviour can only be observed on one runtime the test says so and skips that half instead of failing — Bun's `fetch` ignores undici's global dispatcher, and Bun's `node:module` exports neither `stripTypeScriptTypes` nor `registerHooks`.

### Plugin installs on Bun

One setting, written to `~/.pi/agent/settings.json`:

```json
{ "npmCommand": ["bun"] }
```

The pi SDK reads it and adapts its install arguments per package manager (`npm`, `pnpm`, `bun`). Set it through the SDK (`SettingsManager.setNpmCommand(["bun"])`) or the **Settings** panel rather than by hand-editing the file, so the lock pi takes on that file is respected.

## Differences from upstream

Three kinds of difference. [Running on Bun](#running-on-bun) is what it takes to run without a Node.js toolchain. [Features this fork adds](#features-this-fork-adds) is the behaviour it ships on top of upstream, with one line on what upstream does where the two differ. [Not fork differences](#not-fork-differences) lists what upstream wrote and this checkout merely carries.

### Running on Bun

| Area | Upstream | Here |
| --- | --- | --- |
| Runtime | Node.js 22.19.0+ | Bun 1.4.2+ |
| Integrated terminal | Works via `node-pty` | Works via Bun's native PTY behind a small node-pty-compatible shim (see below, and [docs/terminal.md](./docs/terminal.md)) |
| SDK package resolution | `findPackageJSON()` from `node:module` | `findPackageManifest()` in `lib/pi-sdk-internals.ts` walks `node_modules` upward, because Bun implements none of `node:module`'s named exports |
| Home directory | `os.homedir()` | `$HOME` first (`homeDir()` in `lib/home-dir.ts`) — the agent directory, the default cwd, the browser's root, `~` in a path, and the agent directory the HTTP dispatcher reads its timeouts from |
| Skills install | `npx skills add …` | `bun x skills add …` |
| Plugin update check | `npm view … version --json` | `bun pm view … version --json` |
| Test suite | Node's runner (`npm test`) | Both runners, both green: `bun test` and `npm test` |
| Dev build output | The dev server and `next build` share `.next/` | `PI_WEB_DIST_DIR` points the dev script at `.next-dev/`, so a build or `next start` no longer pollutes the dev server's directory |
| Lockfiles | `package-lock.json` | `bun.lock` is gitignored; `bun-types` is recorded in the tracked `package-lock.json`, because CI's `npm ci` refuses a `package.json` the lock does not match |
| CI | `.github/workflows/ci.yml` on Node.js | the same `ci.yml`, untouched — this fork adds no Bun job, so the Bun checks above are run locally |

**Terminal.** node-pty's native addon cannot keep the pty master fd alive under Bun: the fd is closed right after `spawn()`, the child reads EOF on stdin and an interactive shell exits before it can print a prompt ([agegr/pi-web#745](https://github.com/agegr/pi-web/issues/745), cf. [oven-sh/bun#7362](https://github.com/oven-sh/bun/issues/7362)). Bun's own PTY support (`Bun.spawn({ terminal })`) holds the fd for the process's lifetime, so `lib/terminal-bun-pty.ts` implements the small node-pty-compatible surface `lib/terminal-manager.ts` drives — spawn, `onData`, `onExit`, `write`, `resize`, `kill` and `pid` — and node-pty keeps serving Node.js and Windows. No polling reader, no fd lifetime hack, no extra dependency.

**Skills and plugin checks.** `lib/node-cli.ts` maps the two read-only package-manager calls onto their Bun equivalents (`bun x` for npx; `bun pm view`, whose JSON matches npm's). Installs are left to the SDK's package-manager path, which the `npmCommand` setting above points at bun.

### Features this fork adds

Useful on the first run; none of it needs configuring unless the entry says otherwise. Each entry ends with what upstream does instead, for anyone comparing the two.

**Long-running commands in the background.** A shell command that passes two minutes hands off to a background task: the agent keeps working, and the command comes back as a finished card with its log file when it ends. Turn it on in **Settings → General → Background bash tasks**; it is off by default, and with the switch off the tool is upstream's bash tool exactly. The model is offered `run_in_background` only while the switch is on. Upstream would take background execution from pi itself rather than from the web wrapper ([#1132](https://github.com/agegr/pi-web/pull/1132)). ([How the hand-off works](./docs/agents/background-bash.md#two-ways-into-the-background))

**A run that survives a dropped stream.** Some relays cut the HTTP/2 stream in the middle of a response, which reaches pi as an error it treats as fatal: the answer stops half-written and nothing retries. This fork retries it, with pi's own attempt limit and backoff, and still treats a Stop you pressed, a quota refusal and a full context as fatal. Upstream's position is that the browser should retry exactly what pi in a terminal retries, and that the error text belongs in pi's retry table ([#1134](https://github.com/agegr/pi-web/pull/1134)); until pi lists it, the fork reads pi's classification from the outside, and a test fails the build if pi renames the method it reads, so the fix cannot die quietly. ([What is retried and what is not](./docs/agents/sessions.md#agentsession-lifecycle-librpc-managerts))

**Shell commands you can read at a glance.** The command in a bash tool card is highlighted as a shell command rather than shown as one dim string, and its expanded body shows the command with its timeout instead of the raw JSON — so `grep -rl "foo" src | xargs rm` reads as a pipeline. Commands running in the background carry a `(background)` marker. It adds no syntax-highlighting dependency: 245 lines of scanner plus a renderer, and the palette is six CSS variables. Upstream keeps tool cards unstyled ([#1135](https://github.com/agegr/pi-web/pull/1135)). ([Note](./docs/agents/sessions.md#tool-execution-events-on-the-sse-stream))

**Read a file's slice beside the conversation.** Click a completed `read` card and the panel on the right opens the exact slice that call returned: Markdown rendered as Markdown, source numbered from the line the read started on, CSV and TSV as a table with real file line numbers, even when the slice is cut from the middle of the file. It shows what the model was given, not the file as it stands now — nothing is fetched or re-read, so the panel and the transcript can be checked against each other. The card keeps its own output; the panel is one click away, not a detour. Upstream keeps a read's output inside the card and uses its delimited table in the file viewer ([#1136](https://github.com/agegr/pi-web/pull/1136), [#1150](https://github.com/agegr/pi-web/pull/1150)). ([Note](./docs/agents/sessions.md#a-read-card-opens-its-slice-in-the-right-panel-toolcallblock-componentsreadsnapshotviewertsx))

**Long source lines without losing their numbers.** Scrolling a wide line sideways in the right panel keeps the line-number gutter where it is, instead of watching the numbers slide off with the text and losing which line you were on. The code is also one step smaller — 12px on a 1.6 leading — because a file you are scanning reads at a glance, not at document size. The gutter repeats the code line's height, so the two columns stay on one line box, and the two sizes are one shared pair: the Source view, the Diff view and the read-snapshot panel move together, and a test fails if a later font change puts the numbers off their lines. Upstream scrolls its numbers away with the text at 13px.

**Controls that stay put during a run.** Stop sits in the composer beside Steer and Follow-up, and the row below the input has one layout whether a run is live or finished — nothing you are about to click turns into something else when the run ends. When the context is actually full, Compact is the button that aborts compaction, so the control you need is the one already under your hand. Upstream guards against a click made within 600 ms of a run ending ([#1131](https://github.com/agegr/pi-web/pull/1131), `0a38de9`); this fork keeps that guard, and on a desktop the button swap it guards against no longer exists. ([Note](./docs/agents/sessions.md#composer-action-row-nothing-moves-under-the-pointer-at-a-run-boundary))

**Tool arguments as rows, not as JSON.** A tool card whose arguments are all single values shows one row per argument — a write's path next to the text it wrote, a subagent's profile and prompt, an MCP tool's query and limit — and a value with lines of its own keeps them as a scrollable block. The rule is all of the arguments or none of them: one nested value, like an `edit` call's `edits[]` or an MCP argument holding a list, and the card shows the JSON as before, because a row that drops a subtree is an argument nobody sees. Upstream shows every tool's arguments as indented JSON.

**Every sentence the model wrote stays on screen, and the turn ends once.** A turn renders as segments: its text shows where it was written, and each run of thinking and tool calls between those words folds into a "Process details" group of its own. So a long turn is several groups with the sentences between them, rather than one fold holding everything up to its last tool call. What describes the turn then appears once, below the last group: the last response's token counts and its time, the files the turn changed, a Copy of everything it wrote, and, when the run stopped on a provider error or an output limit, that reason — which used to sit inside the group, so reading it meant opening the fold ([#906](https://github.com/agegr/pi-web/issues/906)). Attaching those to the parts instead repeated them, because Pi Web saves one assistant entry per tool call: the same row of numbers down the turn, and a timestamp that appeared under whichever entry had just finished and vanished when the next one arrived. Groups always start collapsed, and one you opened stays open. Upstream shows only the text after that call and files the rest inside the group. ([Note](./docs/agents/sessions.md#a-turn-shows-every-word-it-wrote-only-the-workings-fold-processdetailsgroup-componentschatwindowtsx))

**Subagents configured by profile, not by guess.** A subagent's thinking level, turn limit and whether it inherits the conversation come from its profile, so a run is reproducible from the profile that produced it. `model` is the one parameter a call can still set, because running once on a different model is a routine, deliberate request and the tool description lists each profile's model. Files a subagent should look at are named in the `prompt` and it opens them with its own `read`, which keeps a delegated session's context the size it needs to be; inlining whole files into the task is what pushed freshly opened subagents straight into compaction. Upstream also accepts an `input_files` list on the call ([#1138](https://github.com/agegr/pi-web/pull/1138), `fb6df88`). ([Note](./docs/agents/subagents.md#what-the-model-may-choose-when-spawning-a-subagent))

### Not fork differences

These came from upstream, and this checkout has them because upstream wrote them: keeping Stop clear of the slot compaction lands in after a stray double click (`0a38de9`, [#1131](https://github.com/agegr/pi-web/pull/1131)), collapsing a custom message from its header (`574cbba`, [#1133](https://github.com/agegr/pi-web/pull/1133)), answering a removed subagent worktree from the repository it branched from (`f9a370e`, [#1137](https://github.com/agegr/pi-web/pull/1137)), letting the profile decide a subagent's spawn parameters (`fb6df88`, [#1138](https://github.com/agegr/pi-web/pull/1138)), and the file viewer's delimited CSV/TSV table (`f87afbb`, [#1150](https://github.com/agegr/pi-web/pull/1150)). An earlier version of this README listed some of these as fork work; this one does not.

Everything else — sessions, files, Git, worktrees, models, MCP, extensions — is upstream code and behaves as upstream describes it.

## Quick Start (upstream, Node.js)

Pi Web requires Node.js 22.19.0 or newer. Check your version with `node --version`, then run:

```bash
npx @agegr/pi-web@latest
```

The CLI opens a browser after the server is ready. If it does not, open [http://127.0.0.1:30141](http://127.0.0.1:30141). Pi Web listens only on `127.0.0.1` by default.

To install the `pi-web` command globally:

```bash
npm install -g @agegr/pi-web@latest
pi-web
```

Commands:

```bash
pi-web version          # print the installed version
pi-web status           # list running servers
pi-web stop [--port N]  # stop a running server
pi-web open [--port N]  # open a running server in the browser
pi-web update [--check] # update a global npm install
```

To update, run `pi-web stop`, then `pi-web update` (or run the same install command again). To uninstall, run `npm uninstall -g @agegr/pi-web`.

## Configuration

For port and hostname, command-line options override the corresponding environment variables. Either `--no-open` or `PI_WEB_NO_OPEN=1` disables automatic browser opening. Run `pi-web --help` (or `-h`) to print startup options and exit without starting the server. Unknown options exit with an error.

| Option or environment variable | Purpose | Default |
| --- | --- | --- |
| `--help`, `-h` | Print startup options and exit | — |
| `--port <port>`, `-p <port>`, or `PORT` | Server port | `30141` |
| `--hostname <host>`, `-H <host>`, or `PI_WEB_HOSTNAME` | Bind hostname | `127.0.0.1` |
| `--no-open` or `PI_WEB_NO_OPEN=1` | Do not open a browser automatically | Browser opens |
| `PI_WEB_APP_NAME` | PWA manifest `name` and `short_name`; surrounding whitespace is trimmed, empty values use the default | `Pi Web` |
| `PI_WEB_SKIP_VERSION_CHECK=1` | Disable Pi Web update checks | Unset |
| `PI_WEB_ALLOWED_HOSTS` | Additional exact proxy or custom hostnames, comma-separated | Unset |
| `PI_WEB_PASSWORD` | Enable browser password login; API clients may use Basic Auth with username `pi` | Authentication disabled |
| `PI_WEB_IDLE_TIMEOUT_MS` | Session idle timeout in milliseconds, up to `2147483647`; `0` disables idle shutdown; invalid or out-of-range values use the default | `600000` (10 min) |
| `PI_WEB_SHUTDOWN_DEADLINE_MS` | How long extensions get to handle `session_shutdown` before a closing session is disposed anyway, in milliseconds up to `2147483647`; `0`, invalid or out-of-range values use the default | `5000` (5 s) |

Set `PI_WEB_APP_NAME` before starting the server (for example, `PI_WEB_APP_NAME='Work Pi' pi-web`). After changing it, restart the server to serve the new manifest; no rebuild is required. Updates to the name of an already installed PWA are managed by the browser and are not guaranteed to appear immediately. This does not change the page title or icons.

For example:

```bash
pi-web --help
pi-web -p 8080 -H 0.0.0.0 --no-open
```

### Remote Access

Binding to a non-loopback address exposes an agent that can execute high-privilege actions. On a trusted LAN, require a long random password:

```bash
PI_WEB_PASSWORD='a-long-random-password' pi-web --hostname 0.0.0.0
```

Password authentication does not encrypt the connection. Do not expose Pi Web over plain HTTP to the internet; use HTTPS through a trusted reverse proxy or a trusted VPN. If a reverse proxy sends an external hostname, add that exact name to `PI_WEB_ALLOWED_HOSTS`. This allow-list does not change the address Pi Web binds to.

### HTTP Proxy

Server-side model and API requests honor the standard `HTTP_PROXY`, `HTTPS_PROXY`, and `NO_PROXY` environment variables.

On macOS or Linux:

```bash
HTTP_PROXY=http://127.0.0.1:7890 \
HTTPS_PROXY=http://127.0.0.1:7890 \
NO_PROXY=localhost,127.0.0.1 \
npx @agegr/pi-web@latest
```

On Windows PowerShell:

```powershell
$env:HTTP_PROXY = "http://127.0.0.1:7890"
$env:HTTPS_PROXY = "http://127.0.0.1:7890"
$env:NO_PROXY = "localhost,127.0.0.1"
npx @agegr/pi-web@latest
```

## Notes

- **Agent data**: Pi Web reads pi data from `~/.pi/agent` by default, including session files under `sessions/<encoded-cwd>/<timestamp>_<uuid>.jsonl`. Set `PI_CODING_AGENT_DIR` to use another pi agent directory.
- **Filesystem access**: Pi Web must be able to read the agent data directory and the working directories recorded by its sessions. Run Pi Web in the same filesystem environment as pi when sharing existing sessions.
- **Shared configuration**: the Models panel uses pi's model, settings, and credential storage, so changes are visible to both interfaces.
- **File access boundary**: the file browser is limited to working directories selected in Pi Web and project or session roots it already knows about; it is not a general filesystem browser.
- **Git worktrees**: see [Worktrees in Pi Web](./docs/worktrees.md) for switcher visibility, worktree creation, and removal behavior.

### Downstream Session Context Menu

Electron wrappers and other downstream integrations can provide a session-row
context menu without patching `SessionSidebar`. Listen for the cancelable
`pi-web:session-row-contextmenu` browser event and call `preventDefault()`
synchronously when the integration will handle it:

```js
window.addEventListener("pi-web:session-row-contextmenu", (event) => {
  event.preventDefault();
  const { id, path, cwd, name, clientX, clientY, refresh } = event.detail;

  void openSessionMenu({ id, path, cwd, name, clientX, clientY }).then((changed) => {
    if (changed) refresh();
  });
});
```

The detail object contains `id`, `path`, `cwd`, optional `name`, pointer
coordinates, and a `refresh()` callback for actions that change the session
list. If no listener cancels the extension event, Pi Web opens its built-in
session menu (pin, rename, fork, mark read or unread, archive, delete) at the
pointer instead of the browser's native context menu. The row's `⋯` button
always opens the built-in menu and does not dispatch the event. Sessions not
yet saved to disk get no built-in menu, so the native one still appears for
them. This hook is browser-side and independent of Pi agent extensions.

### Extension Session Liveness

Server-side Pi extensions with detached work can prevent automatic idle
session eviction through the versioned global registry:

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

Register once per active extension session and call the returned idempotent
`release` function on session shutdown, replacement, or reload. `isActive`
must be synchronous, cheap, and scoped to the supplied exact session id or
file. Provider errors fail safe by preserving that session. This lease only
affects automatic idle eviction; explicit shutdown and Stop fallback cleanup
still take precedence.

## Development

This section is upstream's, for reference. On Bun use the commands in [Bun setup](#bun-setup) instead.

```bash
npm install
npm run dev
```

The development server runs at [http://127.0.0.1:30141](http://127.0.0.1:30141). Run the common checks with:

```bash
npm test
node_modules/.bin/tsc --noEmit
npm run lint
```

Do not run `next build` or `npm run build` during normal development. Upstream's dev server and build share `.next/`, so a build can interfere with a running dev server; leave builds for release work. Here the dev script sets `PI_WEB_DIST_DIR=.next-dev`, which parts them, so a build no longer disturbs the dev server — but builds still belong to release work.

Contributor guides: [Internationalization](./docs/i18n.md) and [Release process](./docs/release.md).

## Repository Layout

```text
app/             Next.js UI and API routes
components/      React UI components
hooks/           Client state and interaction hooks
lib/             Session, agent, model, file, Git, and security logic
public/          Static assets and PWA files
bin/             npm CLI entrypoint and launch option parsing
docs/            Focused user and contributor guides
demo/            Upstream's static browser demo, kept in sync; not published by this fork
```

See [AGENTS.md](./AGENTS.md) for the architecture notes and detailed file map.

## License

[MIT](./LICENSE)
