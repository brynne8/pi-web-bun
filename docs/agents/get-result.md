# Fetching a background result: `get_result`

One tool fetches whatever finished in the background: a background command's output, or a subagent's report. It is `get_result`, registered by `lib/get-result-extension.ts`, and it exists so a result is paid for once.

## Why the tool is its own extension

Background bash and built-in subagents are two independent switches, and the subagent extension registers nothing at all when its switch is off. A fetch tool living inside it would take a background command's only way to its output down with the subagent switch. So the tool has its own extension, and what it offers is decided per backend at session start:

- only background bash on → `id`, `offset`, `limit`; the description never mentions subagents;
- only subagents on → `id`, `wait`, `wait_timeout`;
- both on → all five, dispatched by the shape of `id`;
- neither on → no tool at all, because nothing can produce a result.

`bgTasks` is passed as `isBgTasksEnabled` (a getter), unlike the bash tool's own switch, so a person who turns background bash on gets a working `get_result` in the sessions already running instead of "switched off". A handle reaching the half that is off answers which switch is off and that it is read at session start — never "not found".

## The handle, not the log's path

A background command's result is named by a handle: `bash-3f2a9b1c`, the 8 random characters its log file already carries (`lib/bg-task-handle.ts`). The log's **path** never reaches the model — not in the start text, not in the report, not in the pending index. A path is an invitation to `read` the file directly, and a model that takes it still receives the report afterwards: the same result, twice, once of them paid in tool output and once in a delivered message.

The handle is resolved against the session's own log directory (`resolveBgTaskLogPath()`), so nothing has to be registered and a result survives a server restart. A handle from another session does not resolve: one session does not read another's log.

## Reading pages like `read`, from the top

`offset` is a 1-based line and `limit` caps the lines, exactly as `read` does, and a read with neither starts at line 1 — one rule, no "the interesting part is the end" special case to remember. The head says where the page sits (`lines 1-2000 of 5312`) and, while lines are left, the offset that reads on; a page cut at 50 KB says the same. `DEFAULT_SLICE_LINES` is 2000 and `DEFAULT_SLICE_BYTES` 50 KB, pi's own bash truncation. The reader (`readBgTaskLogSlice()`, `lib/bg-task-log.ts`) streams the file once, so numbering stays right on a large log.

A command still running answers that it is still running and that the result arrives on its own. This is not a poll: it is the model being told what it would learn by waiting anyway.

## Fetching consumes the report

A fetched result is a seen result, and the pending report is withdrawn so it never arrives as well:

- `withdraw(sessionId, "bash", "bash-3f2a9b1c")` on the settled-report sink takes the report out of the batched message in pi's queue and out of the pending index (the same path a subagent's collected result takes).
- `recordBgTaskResultConsumed(handle)` is the second net: a report already on its way past that point is skipped by the notifier (`takeBgTaskResultConsumed()`), because the parent holds what it would say.
- The subagent half needs nothing new here: `lookupSubagentResult()` marks the run collected, which is what marks its notification consumed.

The mark names one task's handle and is bounded (500 entries, oldest dropped), since a handle is never reused the way a resumed subagent's session id is.

## One lookup, two cards on screen

`lookupSubagentResult()` (`lib/subagent-extension.ts`) holds the report answer the tool used to give, so the subagent switch owns subagent behaviour while the tool owns fetching. On screen, a background command's card prints the handle in its `Result` row, parsed out of the report's own `fetchHint`.

## Files

`lib/get-result-extension.ts`, `lib/get-result-tool.ts` (the tool name and the hints four call sites spell), `lib/bg-task-log.ts`, `lib/bg-task-handle.ts`, `lookupSubagentResult()` in `lib/subagent-extension.ts`, the mark in `lib/bash-bg-tasks.ts`, `components/BgTaskNotificationView.tsx`, and `lib/get-result-extension.test.mjs`, `lib/bg-task-log.test.mjs`.
