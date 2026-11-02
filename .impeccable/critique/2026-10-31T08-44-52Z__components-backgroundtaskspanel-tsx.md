---
target: background bash Tasks panel
total_score: 23
max_score: 40
na_heuristics: 
p0_count: 0
p1_count: 4
target_identity: "file:/Users/julian/develop/pi-web/components/BackgroundTasksPanel.tsx"
target_fingerprint: "sha256:2d556b04c011544b6cf708c156644ab4d1160cf2321800376d85f02d59ee9f78"
target_path: /Users/julian/develop/pi-web/components/BackgroundTasksPanel.tsx
timestamp: 2026-10-31T08-44-52Z
slug: components-backgroundtaskspanel-tsx
---
⚠️ DEGRADED: single-context (no sub-agent/Task tool exposed in this session)

## Design Health Score

| # | Heuristic | Score | Key Issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 3 | Counts, elapsed, idle and live output are clear; finished success/failure and a broken output poll are not. |
| 2 | Match Between System and Real World | 2 | The owning session is an 8-character UUID fragment, not a session title or project. |
| 3 | User Control and Freedom | 3 | Stop exists, but no follow/pause, jump-to-latest, copy, or open-log control. |
| 4 | Consistency and Standards | 2 | `window.confirm` breaks the app's own dialog language; inline styles skip shared buttons/focus states. |
| 5 | Error Prevention | 2 | The destructive action is confirmed, but there is no undo and no clear stopping state. |
| 6 | Recognition Rather Than Recall | 2 | Failed, completed and killed tasks differ only by a gray dot and a short word; output truncation is invisible. |
| 7 | Flexibility and Efficiency | 2 | No keyboard path for row selection/stop, no bulk stop, no session grouping or filter. |
| 8 | Aesthetic and Minimalist Design | 3 | Dense and panel-appropriate, but duplicated labels and wrapped metadata add noise. |
| 9 | Error Recovery | 2 | One failed output fetch freezes the stream silently; a failed stop lands in the wrong visual place. |
| 10 | Help and Documentation | 2 | The empty state says nothing about how tasks appear or where background bash is switched on. |
| **Total** | | **23/40** | **Acceptable — significant improvements needed** |

## Design Specificity Verdict

**LLM assessment**: This reads as a competent generic activity monitor dropped into pi-web's right rail. The structure — tabs, count, rows, output pane, stop button — is category-interchangeable with a CI runner or a process manager. What makes it pi-web is not the composition but the data: task logs, session ids and a stop note. The design has not yet turned that data into pi-web's own vocabulary. A turn-scoped task card, the owning chat's title, and the existing file viewer as the log destination would make it unmistakably this product.

**Deterministic scan**: `impeccable detect` on `components/BackgroundTasksPanel.tsx`, `components/AppShell.tsx` and `components/TabBar.tsx` returned `[]`, no findings.

**Visual overlays**: Not attempted. No browser automation is exposed in this session, so there is no reliable live overlay or rendered screenshot evidence.

## Overall Impression

The feature closes the real loop: you can see work, watch it, and end it. The weak point is that the panel is optimized for "a list of processes" rather than "work my agent started". The single biggest opportunity is to make each row answer three questions at a glance: which chat owns it, did it succeed, and can I open its result.

## What's Working

- The right-rail placement is correct. It removes pressure from the top bar and keeps monitoring beside the conversation without stealing the chat.
- Live byte-offset output plus elapsed/idle clocks give a real sense of a process's health, not just a spinner.
- Stopping a task closes the loop in both places: the process ends and the model gets a visible note. That is the hardest part of the feature and it is present.

## Priority Issues

### [P1] A button row contains a button, and the destructive target is tiny

**Why it matters**: Each task row is a `div role="button"` with a Stop `button` nested inside it. Screen readers and keyboard users meet two overlapping controls; a Stop click must also stop propagation. The Stop target is roughly 20px tall, far below a comfortable touch target. Sam cannot reliably operate it, and Casey will miss it on a phone.

**Fix**: Make the row a plain container. Put a real button around the command/select area and keep Stop as a sibling button. Give both a visible `:focus-visible` ring. Raise Stop to at least 32px desktop and 44px touch.

**Suggested command**: `$impeccable adapt`

### [P1] Finished tasks do not say whether they succeeded

**Why it matters**: `exitCode` and `error` are already in the task data, but every finished row shows the same gray dot and the word "finished". A failed build and a clean build look identical. The user must open the log to learn the one thing they most need.

**Fix**: Render three finished states with text and color: succeeded, failed (`exit N` plus the first error line), stopped by you. Keep the status word visible; never rely on the dot alone. Show the failure reason in the row, with the full error on hover.

**Suggested command**: `$impeccable clarify`

### [P1] Live output steals the reader's scroll position and dies silently

**Why it matters**: Every chunk forces the output pane to the bottom. A user who scrolls up to inspect an earlier error is dragged back within a second. If one output poll fails, the loop stops and the pane keeps the stale "Reading output…" state with no explanation.

**Fix**: Auto-follow only while the pane is near the bottom; otherwise show a "Jump to latest" button with the unseen-byte count. Retry a failed poll with backoff and show "Output paused — retrying"; stop only when the task is finished or gone.

**Suggested command**: `$impeccable harden`

### [P1] The owning session is not recognizable or reachable

**Why it matters**: The row shows `session 1a2b3c4d`. That is not a session title, a project, or anything the user can match to the chat they were in. There is also no way to jump from a running task to its session. The panel is global, so this is exactly when recognition matters.

**Fix**: Show the session title (falling back to the folder name), and make the session label a link that selects that session. If the session is gone, say "session closed" instead of showing an id nobody can use.

**Suggested command**: `$impeccable clarify`

### [P2] Native confirm breaks the product's language and hides the result

**Why it matters**: `window.confirm` is an unstyled browser modal in an otherwise authored interface. It interrupts monitoring and gives no product-specific context beyond the first command line. After the kill, the UI ignores `notified: false`, so a missing context note is invisible to the user.

**Fix**: Use an inline confirmation row or the app's existing dialog pattern, naming the command and session. After stopping, show a short status: "Stopped. Session notified" or "Stopped. Session no longer open, so no note was delivered."

**Suggested command**: `$impeccable polish`

## Persona Red Flags

**Alex (Power User)**: Cannot select a row or stop it from the keyboard without tabbing through the Stop button of every row. No bulk stop, no copied log path, no open-in-file-viewer path. With ten running tasks, stopping three is a mouse hunt.

**Sam (Accessibility-Dependent)**: The nested interactive row is announced as a button that contains another button. Focus order is ambiguous. Status is carried by a 7px dot plus color; the row's metadata is 10px text. No live region announces that a task stopped or failed.

**Casey (Distracted Mobile)**: The Stop target is about 20px tall and sits at the row's right edge inside a narrow rail. The list is capped at 42% of the panel, so with several tasks the output area becomes a sliver. `window.confirm` blocks the page and may be missed after an interruption.

## Minor Observations

- The header repeats "Background bash tasks" and "N running"; the tab already says Tasks. One title is enough.
- The top-bar file-panel button now carries a task badge. It is useful, but the icon means "files"; the count needs a title/aria label that names background tasks.
- A long command is truncated in the row and only recoverable through a native tooltip. There is no copy affordance.
- Output is capped at 200,000 characters with no "earlier output dropped" marker.
- Finished tasks disappear after ten minutes with no hint that they are temporary.
- There is no grouping by session when tasks from several chats run at once.

## Questions to Consider

- Should this be "Tasks" at all, or "Activity" — one rail that also owns running subagents and pending reports?
- What if the log opened in the existing file viewer instead of a bespoke `<pre>`? You would inherit search, wrap, line numbers and copy for free.
- Does the panel need a persistent tab when nothing is running, or should the badge summon it only when there is work?
- Would a turn-scoped view ("this chat's background work") be more useful than a global process list?

## Run Notes

- Target: `components/BackgroundTasksPanel.tsx`; slug `components-backgroundtaskspanel-tsx`.
- Ignore list: none.
- Assessment independence: degraded single-context; no sub-agent tool in this session.
- CLI detector: ran on the panel, `AppShell.tsx` and `TabBar.tsx`; `[]` findings.
- Browser visibility: not available in this session; no screenshots or overlay.
- Live server / overlay injection: skipped because browser automation is unavailable.
- Temp files: report body written for persistence, then removed.
