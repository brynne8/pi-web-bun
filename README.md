# Pi Web (Bun)

[中文文档](./docs/README.zh-CN.md) | [日本語](./docs/README.ja.md) | [Русский](./docs/README.ru.md)

> **This is a Bun-focused fork of [agegr/pi-web](https://github.com/agegr/pi-web).** It runs on [Bun](https://bun.sh) with no Node.js, `npm` or `npx` installed, and it has its own opinion about how a coding agent should read in a browser: a long command hands off instead of holding the turn open, a `read` call opens the exact slice it returned, the composer never changes what is under your finger, and a relay dropping its HTTP/2 stream no longer costs you the run. [Differences from upstream](#differences-from-upstream) says what still differs; [Bun setup](#bun-setup) gets it running. Everything else below is upstream's documentation.

Local browser UI for the [pi coding agent](https://github.com/earendil-works/pi). Pi Web uses the same local configuration and session files as pi, so you can browse and resume conversations, run agent turns, configure models and resources, and inspect project files from a browser.

**[Try the interactive demo →](https://agegr.github.io/pi-web/)** The real Pi Web UI runs entirely in your browser, with sample sessions, files and models. There is nothing to install; replies are pre-written and no model is called. That demo is upstream's build — this fork publishes none, so it will not show the differences listed below.

![Pi Web displaying a pi session with structured Markdown, tool calls, and project navigation](https://raw.githubusercontent.com/agegr/pi-web/main/docs/screenshot2.png)

## Features

- **A look of its own**: one amber accent and one glass material across the app, a full-bleed console instead of a card on one, and a serif wordmark with the mono kept for data.
- **Session workspace**: browse, resume, rename, export, and delete conversations grouped by project, with running state, context usage, cost, and compaction details.
- **Two ways to branch**: **New session** creates an independent session file from an earlier message; **Edit from here** creates a branch inside the current session.
- **Background bash tasks** (off by default): a long-running or over-long-output command hands off to a background task and comes back as a settled card instead of holding the turn open.
- **Background results that cannot be missed**: settled reports arrive as one batch that wakes the agent once, each keeping its own card, and `await_notifications` waits for the next one when nothing is waiting yet.
- **Project file tools**: browse and upload files, inspect Git diffs, and preview source, Markdown, images, audio, PDFs, and DOCX files with automatic refresh.
- **A file row's own menu**: right-click a row of the project tree to put its path in the chat, download the file, undo its uncommitted changes, or show it in the OS file manager with the file itself selected — nothing is drawn over the name while you hover it.
- **Reads and tables in the side panel**: a `read` tool call opens the exact slice it returned — Markdown rendered, or source with line numbers continuing from the read's offset — and a `.csv` or `.tsv` slice opens as a table with the file's own line numbers in the gutter.
- **Long files that stay readable**: the source view renders the lines around the viewport, so a large file scrolls without stalling, and Find searches every line rather than only what is on screen.
- **Highlighted commands**: a shell tool card colours the command's tokens instead of showing it as one dim string, and keeps its `timeout` and its background flag beside it.
- **Flat arguments on tool cards**: a tool call whose arguments are all plain values shows them as one row per argument instead of a block of JSON — nothing to count quotes through. One nested value takes the card back to JSON, because a row that hides a subtree is an argument you never see.
- **A diff that fits the screen**: an edit or applied patch opens as two columns, before and after — and on a phone, where two code columns leave no room to read either, as one column with each removed line above the line that replaces it.
- **A turn you can read in order**: the model's sentences stay on screen where it wrote them, each run of thinking and tool calls folds into its own "Process details" group, and the turn ends with one line of its own — its token counts, the files it changed, and a copy of everything it wrote.
- **Thinking in Markdown**: an opened reasoning block shows its headings, lists, tables and fenced code instead of the markup around them.
- **Shell variables that stay out of the math**: `$HOME` and `$PATH` in a sentence, and a Chinese sentence between two dollar signs, read as typed instead of turning into a formula.
- **Git worktrees**: switch checkouts from the sidebar while keeping sessions from the same repository grouped together.
- **Web-based configuration**: manage provider login and API keys, models, model tests, plugin packages, and skills without leaving Pi Web.
- **Code mode on, and a Tools page**: Code mode's choice, mode, tool-list budget and sandbox live under Settings › Tools, beside the names of the tools the open session offers.
- **English, Simplified Chinese, and Traditional Chinese UI**: Pi Web follows the browser language initially and provides a language switcher in the top bar.

## Bun setup

This fork targets Bun and needs no Node.js toolchain. Requires [Bun](https://bun.sh) 1.4.2 or newer; check with `bun --version`.

```bash
git clone https://github.com/brynne8/pi-web-bun.git
cd pi-web-bun
bun install
bun run dev
```

The development server starts at [http://127.0.0.1:30141](http://127.0.0.1:30141). The production server (`bun run start`) and the build (`bun run build`) run on Bun or Node.js alike. The dev server does not, yet: `bun run dev` puts Bun under Vite, and Bun 1.4.4 drops the method of a write request there ([oven-sh/bun#42759](https://github.com/oven-sh/bun/issues/42759)), so every `POST` arrives as a `GET`. Until a Bun release carries the fix, run `npm run dev` on Node.js, or install the fixed build with `bunx bun-pr 46528`.

There is no npm-published package for this fork; run it from a clone as above. `bun.lock` is gitignored, so `bun install` resolves fresh each time — and it stays out of the repository. The tracked `package-lock.json` is what upstream's CI installs from, so a dependency change is recorded with `bun x npm install --package-lock-only` and committed.

If no model provider is configured yet, open the **Models** panel to sign in or add an API key. `~/.pi/agent` is created on first use.

### Development commands

```bash
bun install                            # install dependencies
bun run dev                            # dev server on 127.0.0.1:30141
bun run dev:lan                        # dev server on 0.0.0.0:30141
bun run build                          # production build into dist/
bun run start                          # serve dist/ on 127.0.0.1:30141
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

Two kinds of difference. [Running on Bun](#running-on-bun) is what it takes to run without a Node.js toolchain. [Features this fork adds](#features-this-fork-adds) is the behaviour it ships on top of upstream, with one line on what upstream does where the two differ.

### Running on Bun

| Area | Upstream | Here |
| --- | --- | --- |
| Runtime | Node.js 22.19.0+ | Bun 1.4.2+ |
| Integrated terminal | Works via `node-pty` | Works via Bun's native PTY behind a small node-pty-compatible shim (see below, and [docs/terminal.md](./docs/terminal.md)) |
| SDK package resolution | `findPackageJSON()` from `node:module` | `findPackageManifest()` in `lib/pi-sdk-internals.ts` walks `node_modules` upward, because Bun implements none of `node:module`'s named exports |
| Home directory | `os.homedir()` | `$HOME` first, then the user database (`homeDir()` in `lib/home-dir.ts`), because Bun's `os.homedir()` ignores `$HOME` — the agent directory, the default cwd, the browser's root, `~` in a path, and the agent directory the HTTP dispatcher reads its timeouts from. On Windows `$HOME` is normally unset, so the database is what applies |
| Skills install | `npx skills add …` | `bun x skills add …` |
| Plugin update check | `npm view … version --json` | `bun pm view … version --json` |
| Test suite | Node's runner (`npm test`) | Both runners, both green: `bun test` and `npm test` |
| Browser regression tests | Playwright Chromium (`npx playwright install --with-deps chromium`) | Playwright's Apple WebKit build: `npm run test:e2e:install` fetches it and CI installs `--with-deps webkit`; no Chromium binary is installed or launched here ([docs/agents/tests.md](./docs/agents/tests.md#e2e-playwright)) |
| Build toolchain | Next.js 16 (Turbopack; dev state and build output in `.next/`) | vinext on Vite 8/Rolldown, configured by `vite.config.ts` and `next-config.ts`: `bun run dev` keeps state in `.vinext/`, `bun run build` writes `dist/`, and `bun run start` serves it |
| Stopping the server | `next start` answers SIGINT/SIGTERM with `server.close()` and waits for the connections to end | `vinext start` answers no signal, so the shutdown exits explicitly once its cleanups settle (`lib/server-shutdown.ts`; [note](./docs/agents/sessions.md#stopping-the-server-libserver-shutdownts)) |
| Lockfiles | `package-lock.json` | `bun.lock` is gitignored; `bun-types` is recorded in the tracked `package-lock.json`, because CI's `npm ci` refuses a `package.json` the lock does not match |
| CI | `.github/workflows/ci.yml` on Node.js | the same `ci.yml`, with the browser it installs switched to `--with-deps webkit` — this fork adds no Bun job, so the Bun checks above are run locally |

**Terminal.** node-pty's native addon cannot keep the pty master fd alive under Bun: the fd is closed right after `spawn()`, the child reads EOF on stdin and an interactive shell exits before it can print a prompt ([agegr/pi-web#745](https://github.com/agegr/pi-web/issues/745), cf. [oven-sh/bun#7362](https://github.com/oven-sh/bun/issues/7362)). Bun's own PTY support (`Bun.spawn({ terminal })`) holds the fd for the process's lifetime, so `lib/terminal-bun-pty.ts` implements the small node-pty-compatible surface `lib/terminal-manager.ts` drives — spawn, `onData`, `onExit`, `write`, `resize`, `kill` and `pid` — and node-pty keeps serving Node.js and Windows. No polling reader, no fd lifetime hack, no extra dependency.

**Skills and plugin checks.** `lib/node-cli.ts` maps the two read-only package-manager calls onto their Bun equivalents (`bun x` for npx; `bun pm view`, whose JSON matches npm's). Installs are left to the SDK's package-manager path, which the `npmCommand` setting above points at bun.

### Features this fork adds

Useful on the first run; none of it needs configuring unless the entry says otherwise. Each entry ends with what upstream does instead, for anyone comparing the two.

**A look of its own, under every palette.** Pi Web opens in one world: amber on obsidian, one glass material for whatever floats, a serif wordmark, a grotesk interface and a mono for data. The console is the page, a tool call is a ruled log row with a status dot, your own turn is a warm gradient bubble, and Settings' sections sit in a left rail. The light and dark themes are this design's own; the other palettes keep their accent, their bubble and their syntax colours, and share its surfaces and type. Type comes from Google Fonts. Upstream ships stock chrome that every palette repaints. ([Note](./docs/agents/design.md))

**Long-running commands in the background.** A shell command that passes two minutes hands off to a background task: the agent keeps working, and the command comes back as a finished card with its log file when it ends. It also hands off when it prints more lines than the model allowed for. Turn it on in **Settings → General → Background bash tasks**; it is off by default, and with the switch off the tool is upstream's bash tool exactly. The model is offered both controls only while the switch is on. Upstream would take background execution from pi itself rather than from the web wrapper ([#1132](https://github.com/agegr/pi-web/pull/1132)). ([How the hand-off works](./docs/agents/background-bash.md#two-ways-into-the-background))

**Nothing that finished is invisible.** A background command or subagent run cannot report itself while the parent is mid-run, and until now nothing said a result was waiting. Settled reports arrive as one batch that wakes the parent once, each keeping its own card, and `await_notifications` waits for the next report when nothing is waiting yet while background work is still running. While results wait, it is reminded each turn. A result the model has already read with `get_subagent_result` leaves the batch as well, so it is never announced twice. Upstream delivers one message per report, and only once the parent is idle. ([Note](./docs/agents/pending-notifications.md))

**A run that survives a dropped stream.** Some relays cut the HTTP/2 stream mid-response, and pi treats that as fatal: the answer stops half-written and nothing retries. This fork retries it with pi's own attempt limit and backoff, and still treats a Stop you pressed, a quota refusal and a full context as fatal. Upstream would rather the browser retry exactly what pi in a terminal retries, with the error text living in pi's retry table ([#1134](https://github.com/agegr/pi-web/pull/1134)); until then the fork reads pi's classification from the outside, pinned by a test that fails if pi renames the method. ([What is retried and what is not](./docs/agents/sessions.md#agentsession-lifecycle-librpc-managerts))

**Shell commands you can read at a glance.** The command in a bash tool card is highlighted as a shell command rather than shown as one dim string, and its expanded body shows the command with its timeout instead of the raw JSON — so `grep -rl "foo" src | xargs rm` reads as a pipeline. Commands running in the background carry a `(background)` marker. Upstream keeps tool cards unstyled ([#1135](https://github.com/agegr/pi-web/pull/1135)). ([Note](./docs/agents/sessions.md#tool-execution-events-on-the-sse-stream))

**Read a file's slice beside the conversation.** Click a completed `read` card and the right panel opens the exact slice that call returned: Markdown rendered as Markdown with its Source one click away, source numbered from the line the read started on, CSV and TSV as a table with the file's own line numbers. It shows what the model was given, not the file as it stands now — nothing is fetched or re-read, so panel and transcript can be checked against each other. The card keeps its own output. Upstream keeps a read's output inside the card and uses its delimited table in the file viewer ([#1136](https://github.com/agegr/pi-web/pull/1136), [#1150](https://github.com/agegr/pi-web/pull/1150)). ([Note](./docs/agents/sessions.md#a-read-card-opens-its-slice-in-the-right-panel-toolcallblock-componentsreadsnapshotviewertsx))

**Long source lines without losing their numbers.** Scrolling a wide line sideways in the right panel keeps the line-number gutter where it is, so the numbers no longer slide off with the text and cost you your place. The sideways scrollbar itself runs under the code only, never across the numbers. The code is a step smaller than upstream's, and the Source view, the Diff view and the read-snapshot panel all move with it. Upstream scrolls its numbers away with the text.

**Prose opens wrapped; code does not.** A Markdown or plain-text file opens with its lines wrapped to the panel in both the Source view and the Diff view, so a long sentence runs to its end instead of waiting off-screen behind a horizontal scrollbar. Source code opens unwrapped, one line per row, scrolled sideways — the way an editor has it, where indentation and columns are what you read, and a log keeps the same rule. The wrap button still flips either kind either way, and that choice holds for the tab. Upstream opens every file unwrapped. ([Note](./docs/agents/files-and-access.md#which-lines-wrap))

**A long file scrolls and stays colored.** The source view renders the lines around the viewport instead of all of them, so a file of any size scrolls without the tab stalling, and the lines on screen stay syntax-highlighted however long the file is. Find in file — the toolbar's magnifier or ⌘/Ctrl+F with the viewer under the pointer — searches every loaded line, not only the rendered window, and scrolls a match into view even when it sits far below. Upstream renders every line and stops highlighting past a thousand lines. ([Note](./docs/agents/files-and-access.md#long-files-a-window-of-lines-and-find-across-all-of-them))

**Controls that stay put during a run.** Stop sits in the composer beside Steer and Follow-up, and the row below the input has one layout whether a run is live or finished — nothing you are about to click turns into something else when the run ends. When the context is actually full, Compact is the button that aborts compaction, so the control you need is the one already under your hand. Upstream guards against a click made just after a run ends ([#1131](https://github.com/agegr/pi-web/pull/1131)); this fork keeps that guard, and on a desktop the button swap it guards against no longer exists. ([Note](./docs/agents/sessions.md#composer-action-row-nothing-moves-under-the-pointer-at-a-run-boundary))

**A stop answers what you queued.** Stop ends the run, and a message still waiting to be steered is then sent to a run of its own: the model replies to what you wrote instead of falling silent under it. The queue empties before the run stops, so nothing is delivered into a run that is dying and left there without an answer. A second Stop, with the queue now empty, ends everything. Upstream leaves the queue to pi, so the message either keeps waiting for a run that never comes or lands at the run's last breath with nothing under it. ([Note](./docs/agents/sessions.md#stop-and-the-messages-still-queued-librpc-managerts-hooksuseagentsessionts))

**A stop takes back a message the model never answered.** Press Stop on a run that produced nothing at all — no word, no reasoning, no tool started — and the message comes back to the input box with the conversation put back to before it: nothing sits in the transcript unanswered, and trying again needs no branch. A run that had begun thinking is an answer that started, and Stop there only stops it. The abandoned prompt stays in the session file, so the branch switcher can still show it. Upstream leaves the message there with an empty reply under it, and editing from that message starts a branch beside the one you are on. ([Note](./docs/agents/sessions.md#stop-and-the-prompt-that-got-no-reply-librpc-managerts-hooksuseagentsessionts))

**Tool arguments as rows, not as JSON.** A tool card whose arguments are all single values shows one row per argument — a write's path next to the text it wrote, a subagent's profile and prompt — and a value with lines of its own keeps them as a scrollable block. The rule is all of the arguments or none: one nested value, like an `edit`'s `edits[]`, and the card shows the JSON as before, because a row that drops a subtree hides an argument. Upstream shows flat arguments as rows too, but a write keeps its own view there: the file's text alone, without the path beside it. ([Note](./docs/agents/sessions.md#tool-execution-events-on-the-sse-stream))

**What the model wrote stays on screen; only the workings fold.** A turn renders as segments: its sentences show where they were written, and each run of thinking and tool calls between them folds into a "Process details" group of its own. One footer below the last group describes the turn: token counts and time, the files it changed, a Copy of everything it wrote, and, if the run stopped on a provider error or an output limit, the reason why ([#906](https://github.com/agegr/pi-web/issues/906)). Groups start collapsed, a running turn folds each step as the next one arrives, and one you opened stays open. Upstream folds everything before the last tool call, shows only the text after it, and attaches the counts, the changed-file list and the failure notice to the answer message itself. ([Note](./docs/agents/sessions.md#a-turn-shows-every-word-it-wrote-only-the-workings-fold-processdetailsgroup-componentschatwindowtsx))

**A subagent's report reads as Markdown.** The result of an `Agent` or `get_subagent_result` call renders its headings, lists, tables and fenced code as such, at the card's own size, instead of showing the markup the child wrote. Every other tool's output stays raw text, where a `*` or a `#` is a character and not a heading. Upstream prints the report verbatim. ([Note](./docs/agents/subagents.md#the-report-on-screen))

**Thinking reads as Markdown.** An opened reasoning block runs through the same Markdown pipeline as an answer: its headings, lists, tables and fenced code render instead of showing their markup, and a path written as a link opens in the app. It stays at the card's own compact size. Upstream prints the block as plain text, cut into pieces once it grows long ([#1196](https://github.com/agegr/pi-web/pull/1196)). ([Note](./docs/agents/sessions.md#thinking-renders-as-markdown-at-the-cards-own-size-thinkingblock-componentsmessageviewtsx))

**Subagents configured by profile, not by guess.** A subagent's thinking level, turn limit and whether it inherits the conversation come from its profile, so a run is reproducible from the profile that produced it. `model` is the one parameter a call can still set, because running once on a different model is a routine, deliberate request and the tool description lists each profile's model. Files to look at are named in the `prompt` and opened with the subagent's own `read`, which keeps a delegated session's context the size it needs to be. Upstream also accepts an `input_files` list on the call ([#1138](https://github.com/agegr/pi-web/pull/1138)). ([Note](./docs/agents/subagents.md#what-the-model-may-choose-when-spawning-a-subagent))

**Delegation rules stand on their own.** The instruction to delegate as soon as the goal is clear ends the system prompt as a `<delegation>` block of its own instead of one bullet among the rules every tool shares, so it reads as a policy about `Agent`. It gives `explore` and `plan` rules — `explore` when an unfamiliar codebase needs mapping or a change ripples through code not yet understood; `plan` for a large, complex task whose steps need thought before work starts, never alongside that work and always in the foreground — and lists any other enabled subagents by name. It rides on every prompt and the **System** panel shows it, forced prompts included. Upstream ships delegation advice as the tool's prompt guidelines, which Pi appends to its flat `<rules>` list. ([Note](./docs/agents/subagents.md#delegation-policy))

**A delegated run the model can stop.** `abort_subagent` lets the agent that started a subagent end one it no longer wants. A background run is left alone by a Stop on the parent, and until now nothing else ended it short of deleting the session. What the run got to stays in its own transcript, readable afterwards or continuable with `resume`, and a run the model stopped does not also report back that it was stopped. Upstream writes the same stop as a server-side call no screen makes, and gives the model three subagent tools rather than five. ([Note](./docs/agents/subagents.md#stopping-a-run))

**The model can look up its own subagents.** A tool call lists what this session delegated as TSV — id, profile, status, last activity and label — with running ones first. It never waits, starts or fetches a result, so finding a forgotten run does not wake it. The default is the process list that matters: live runs plus the ones that failed, were stopped or were interrupted in the last hour; older exits and successful runs are counted in one line and left out, and `status` asks for them or for everything. Upstream gives the model no way to list a session's subagents. ([Note](./docs/agents/subagents.md#listing-delegated-runs))

**A subagent answers to its short id.** Every report, stop answer, steering answer and run row names a subagent by the last eight characters of its session id, and `Agent`'s `resume`, `get_subagent_result`, `steer_subagent` and `abort_subagent` take that form as well as the full one. A session id is a UUIDv7 whose head is the time it started, so the tail is the only part that tells two runs apart and the only part worth copying between calls. Two runs sharing a tail are refused, never guessed between. Upstream prints the full UUID and accepts only that. ([Note](./docs/agents/subagents.md#short-subagent-ids))

**Built-in subagents follow the session's Code mode.** Explore, Plan and General purpose spawn with the Code mode the parent session is running under, instead of always calling tools directly, so a session that has Code mode on does not lose it the moment it delegates. Their tool permissions are unchanged and the profiles stay read-only, though a same-name file on disk still replaces one. Upstream ships all three with Code mode off and no way to change it. ([Note](./docs/agents/subagents.md))

**A subagent you answer yourself is still a run.** Type into a subagent's own chat and its run is recorded like any `resume`: the agent switcher shows it running, `get_subagent_result` waits on it, the result lands in its transcript, and its parent gets the completion report. This is the way back after a restart cut a child off: send it a line, and the state stops lying. Upstream leaves a prompt typed into a child outside the subagent record, so no status, result, or report follows. ([Note](./docs/agents/subagents.md#built-in-subagents))

**Shell variables stay out of the formulas.** A single `$` needs nothing but a matching `$` further along to open a formula, so a message about `$HOME` and `$PATH` came out in math italics, and a Chinese sentence between two dollars did too. This fork reads what sits between the delimiters — a shell variable's name, punctuation only CJK text has, several CJK letters — and leaves that text as written, while `$E=mc^2$`, `$PV=nRT$` and a short CJK variable name stay formulas. Upstream's math parser reads nothing but the delimiters; its one setting switches off all inline math rather than the pairs that are prose ([remark-math](https://github.com/remarkjs/remark-math)). ([Note](./docs/agents/sessions.md#math-delimiters-and-prose-that-only-looks-like-a-formula))

**A file row's own menu.** Right-click a row of the project tree or the Git changes list: put its path in the chat, download the file, undo its uncommitted changes — staged ones included — or show it selected in Finder, File Explorer or the file manager. The undo appears only where Git can undo — not for a new file, a rename or a conflict — and it asks before it runs, since nothing is kept of what it discards. Upstream offers the first two as buttons that appear over the name on hover; its route to the file manager opens the workspace folder and has no per-file entry ([#907](https://github.com/agegr/pi-web/pull/907)). ([Note](./docs/agents/files-and-access.md#a-rows-own-actions))

**A delete takes what the session filed elsewhere.** A subagent that ran isolated works in a git worktree, so its transcript is filed under that worktree's path, in a session folder of its own. Deleting the parent reads the whole session root for such a child, takes it with the parent, and re-points what stays at the nearest ancestor still there. What the delete leaves empty goes too: the folder it emptied, and the sidebar's place and name for a project folder you removed outside the app. Upstream searches for a session's children, and for what to re-parent, only in the folders the deleted files sat in. ([Note](./docs/agents/sessions.md#session-sidebar-project-groups-pins-and-archive))

**A name you set survives the Generate title button.** Naming a session yourself — in the sidebar, or with `/name` — and then pressing Generate title leaves your name alone: the button says it kept your name. A name the app cannot attribute to itself is kept the same way, so one the pi TUI set, an extension set, or one an older build named is kept too. Only a session with no name, or one Generate title named itself, gets a new one. Upstream writes the model's title over whatever the session was called. ([Note](./docs/agents/sessions.md#auto-naming-never-replaces-a-name-a-person-set-post-apisessionsidauto-name))

**A settings file that does not parse says which file it is.** The panels that read the global `settings.json` report the failure with the file's path in the message, so the diagnostic points at the file to repair instead of quoting the parser's text alone. The file is left exactly where it is: pi reads the same file, keeps reporting the failure, and refuses every write until it is repaired by hand. Upstream refuses the same writes and leaves the file alone too, but its message names no file. ([Note](./docs/agents/tools.md))

**Code mode is on, with a Tools page of its own.** A session starts with Code mode available — the model writes a short script that calls tools — unless your settings say otherwise, and one page owns it: Always on or Automatic, whether the built-in tools stay declared beside it, how many tokens its tool list may spend, the sandbox self-test, and the names of the tools the open session offers. A server's own exposure stays beside that server. Upstream keeps Code mode off until an MCP server turns it on, and its settings sit on the MCP page. ([Note](./docs/agents/tools.md#settings--tools))

**The changed-file list arrives without a second look at the tree.** The sidebar's Git list is read from Git on every reload, so it shows the tree as it is now. The three questions Git is asked — the repository root, the status, and the line counts — go out together rather than one after the other, and an untracked file's lines are counted once and kept while the file is unchanged, so a repository with many untracked files answers in a fraction of the time. Upstream asks the same questions one after the other, and counts every untracked file's lines again on every reload. ([Note](./docs/agents/files-and-access.md#when-the-file-tree-reloads))

**The System panel shows the prompt the model gets.** The **System** panel lists the whole system prompt, and a plugin that rewrites it is part of that text: the plugin's own words show up where the model reads them, not only in the plugin's file. Upstream replays Pi's own sections from the transcript, where a plugin's forced prompt never appears — pi sends it for the run and keeps its own sections in the transcript. ([Note](./docs/agents/sessions.md#the-system-panel-shows-the-prompt-the-model-receives))

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
- **Shared configuration**: the Models panel uses pi's model, settings, and credential storage, so changes are visible to both interfaces. An open session applies a saved edit of its model when you select the model again.
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
session menu (pin, rename, fork, mark read or unread, archive, open in new
tab, delete) at the pointer instead of the browser's native context menu.
The row's `⋯` button always opens the built-in menu and does not dispatch the
event. Sessions not yet saved to disk get no built-in menu, so the native one
still appears for them. This hook is browser-side and independent of Pi agent
extensions.

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

Do not run `npm run build` during normal development; leave builds for release work. A build writes `dist/` and leaves the dev server's `.vinext/dev/` state alone, so a build no longer disturbs a running dev server — but it still belongs to release work.

Before starting on a feature, read [Contributing](./CONTRIBUTING.md) for what is in scope and the pull request checklist.

Contributor guides: [Internationalization](./docs/i18n.md) and [Release process](./docs/release.md).

## Repository Layout

```text
app/             App Router UI and API routes, served by vinext on Vite
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
