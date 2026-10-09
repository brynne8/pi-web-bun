# Tests

`bun test` is the target; `npm test` (Node's runner, the `test` script) is the second opinion, and upstream only has that one — so a rebase onto upstream always brings the work in this note. Compare failures, never totals: Node counts subtests, so the same tree reads 2699 tests on Bun and 2715 on Node.

## What behaves differently under Bun, and what to use instead

| Node | Bun | Use |
| --- | --- | --- |
| One process, one `globalThis`, one module registry **per test file**. | One of each for the **whole suite**, files in sequence. | Whatever a file puts on `globalThis` or into the registry, it hands back in `after()` (`node:test`). A file that never restores is the next file's failure. |
| jiti `tryNative` off, so jiti resolves every import. | jiti detects Bun and turns `tryNative` on: the module is imported natively, its `import`s answered by Bun — an `alias` never applies, and jiti hands back Bun's sealed ESM namespace. | `createJiti(url, { tryNative: false })`; add `interopDefault: false` to write into a module's exports. |
| A module two files load: each gets its own copy. | The same instance, with whatever the first file left on it. | `delete createRequire(import.meta.url).cache[realpathSync(fileURLToPath(...))]` for each module the file stubs, before jiti loads it. |
| `import { readFile } from "node:fs"` reads a live property, so `t.mock.method(fs, "readFile")` reaches it. | A named builtin import is bound to a frozen snapshot: the mock never lands. | Import the builtin's default and read `fs.readFile` at call time. |
| `module.stripTypeScriptTypes()`. | Not exported, and not a global. | `runStripped(code, context)` from `lib/__fixtures__/strip-types.mjs` — jiti's transform, one path on both runtimes, and unlike Bun's own transpiler it keeps a top-level function expression as the completion value. |
| `module.registerHooks()` to answer a `.module.css` import. | Not exported; Bun loads CSS modules itself. | Install the hook only `typeof registerHooks === "function"`. |
| `fetch` goes through undici's global dispatcher. | Bun's own `fetch`: installs no dispatcher (`configureHttpDispatcher()` is a no-op here), and takes its proxy from the request or `$HTTP_PROXY` / `$HTTPS_PROXY` — for `127.0.0.1` too. | Prove a port is closed with `connect()` from `node:net`, never with `fetch`. Assert the dispatcher's contract on Node only, and say so in the test. |
| No per-test timeout by default. | 5 s. | `{ timeout: … }` where a test waits on something genuinely slow. |
| A keep-alive connection a proxy recycles just ends the request. | `node:http` errors the request stream, so a fixture server that reads `req.body` unguarded raises an unhandled rejection — attributed to whichever test is running. | Guard the body read in the fixture (`lib/__fixtures__/mcp-oauth-server.mjs`). |

## Reading a failure

- Red when the file runs alone (`bun test path/to/x.test.mjs`) → that file is not Bun-ready: a `node:module` export that is not there, or real React because an alias was bypassed.
- Red only in a full run → an earlier file left something behind, or this one did. The usual signature is a scripted fetch answering the next file's real request: a server that should be reached reads `failed` with `no answer scripted for POST http://127.0.0.1:<port>/mcp`.
- Before fixing anything, check whether it is upstream's: `git worktree add --detach /tmp/x origin/main`, symlink this `node_modules` in, run the same command there. Upstream's own tree is nowhere near green under Bun, which is the point of this fork, not a reason to copy it.

## Writing one

One `*.test.mjs` per area beside its file, the `.ts` under test loaded through jiti with `tsconfigPaths: true`. Never write to `globalThis` at module scope without the matching `after()`, and never assume the file has the process to itself.
