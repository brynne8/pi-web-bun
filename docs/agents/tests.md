# Tests

`bun test` is the target; `npm test` (Node's runner, the `test` script) is the second opinion, and upstream only has that one — so a rebase onto upstream always brings the work in this note. Compare failures, never totals: Node counts subtests and suites of its own accord, so the same tree reads roughly 2,885 tests on Bun and 2,925 on Node — 322 files and one skip either way.

## What behaves differently under Bun, and what to use instead

| Node | Bun | Use |
| --- | --- | --- |
| One process, one `globalThis`, one module registry **per test file**. | One of each for the **whole suite**, files in sequence. | Whatever a file puts on `globalThis` or into the registry, it hands back in `after()` (`node:test`). A file that never restores is the next file's failure. |
| jiti `tryNative` off, so jiti resolves every import. | jiti detects Bun and turns `tryNative` on: the module is imported natively, its `import`s answered by Bun — an `alias` never applies, and jiti hands back Bun's sealed ESM namespace. | `createJiti(url, { tryNative: false })`; add `interopDefault: false` to write into a module's exports. |
| A module two files load: each gets its own copy. | The same instance, with whatever the first file left on it. | `delete createRequire(import.meta.url).cache[realpathSync(fileURLToPath(...))]` for each module the file stubs, before jiti loads it. |
| `import { readFile } from "node:fs"` reads a live property, so `t.mock.method(fs, "readFile")` reaches it. | A named builtin import is bound to a frozen snapshot: the mock never lands. | Import the builtin's default and read `fs.readFile` at call time. |
| `module.stripTypeScriptTypes()`. | Not exported, and not a global. | `runStripped(code, context)` from `lib/__fixtures__/strip-types.mjs` — jiti's transform, one path on both runtimes, and unlike Bun's own transpiler it keeps a top-level function expression as the completion value. |
| `module.registerHooks()` to answer a `.module.css` import. | Not exported; Bun loads CSS modules itself. | Install the hook only `typeof registerHooks === "function"`. |
| `fetch` goes through undici's global dispatcher, and jiti's CJS interop finds `undici.install` so `configureHttpDispatcher()` can point fetch at it. | Bun's own `fetch`: it installs no dispatcher (`configureHttpDispatcher()` is a no-op here), takes its proxy from the request or `$HTTP_PROXY` / `$HTTPS_PROXY` — for `127.0.0.1` too — and resolves no `install` out of `undici`, so `undici.install?.()` would skip silently. | Prove a port is closed with `connect()` from `node:net`, never with `fetch`. Assert the dispatcher's contract on Node only, and say so in the test. Never let an optional call be the only thing that makes a branch work on one runtime. |
| No per-test timeout by default. | 5 s. | `{ timeout: … }` where a test waits on something genuinely slow. |
| A keep-alive connection a proxy recycles just ends the request. | `node:http` errors the request stream, so a fixture server that reads `req.body` unguarded raises an unhandled rejection — attributed to whichever test is running. | Guard the body read in the fixture (`lib/__fixtures__/mcp-oauth-server.mjs`). |
| The product state a module keeps on `globalThis` (`__piWebScanIndex`, `__piWebProviderModelCatalog`, `__piWebTerminals`, …) is that file's alone. | It is the suite's. Entries an earlier file left answer a later file's listing: remembered extension providers show up in `/api/models`, and session rows the next scan calls stale make it persist the index into *that* file's agent dir, which is how a test that counts a folder ends up with a file in it. | Start and end the way a process of your own would: call the module's own reset helper (`lib/__fixtures__/session-scan-index.mjs`) at the top of the file and in `after()`, or `delete` the leftover before and after. |
| Queued microtask work lands before the file's process ends. | It lands during a later file, resolving `process.env` at that moment — so a write aimed at `getAgentDir()` goes wherever the env points then. | Let it land (`await new Promise(setImmediate)`) before resetting the global or restoring `PI_CODING_AGENT_DIR`. The scan-index fixture does the two in that order. |

## Reading a failure

- Red when the file runs alone (`bun test path/to/x.test.mjs`) → that file is not Bun-ready: a `node:module` export that is not there, or real React because an alias was bypassed.
- Red only in a full run → an earlier file left something behind, or this one did. The usual signature is a scripted fetch answering the next file's real request: a server that should be reached reads `failed` with `no answer scripted for POST http://127.0.0.1:<port>/mcp`, `url.startsWith is not a function` coming from a hook test's stub, or a folder holding one file more than it was written.
- Before fixing anything, check whether it is upstream's: `git worktree add --detach /tmp/x origin/main`, symlink this `node_modules` in, run the same command there. Upstream's own tree is nowhere near green under Bun, which is the point of this fork, not a reason to copy it.

## Writing one

One `*.test.mjs` per area beside its file, the `.ts` under test loaded through jiti with `tsconfigPaths: true`. Never write to `globalThis` at module scope without the matching `after()`, and never assume the file has the process to itself.

## Documentation is under test

`lib/markdown-emphasis.test.mjs` renders every `*.md` in the repository with CommonMark and fails the suite if a `**` survives into the prose: `**…全绿。**下面` is neither left- nor right-flanking, so GitHub prints the asterisks. The rules are quoted in `lib/markdown-emphasis.ts`.

Two things make this more than a grep for `**`. The app forgives this shape — `lib/markdown.ts` loads `remark-cjk-friendly`, pinned by `components/MarkdownBody.test.mjs` — so the gate renders with no remark plugins. And a pairing heuristic misfires in both directions: `**Two ways to branch**: **New session** … **Edit from here** …` is ordinary Markdown, while `请打开**（模型）**面板登录。` refuses both roles and has no partner to name. So the parser judges and the rules only say which role was refused.

Ask git for the file list with `execFileSync("git", ["ls-files", "-z", "--", "*.md"])`: through a shell the glob expands in the repository root first, and the scan shrinks to six files without failing anything.
