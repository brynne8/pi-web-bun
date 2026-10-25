# CI and browser regression tests

Adapted from @Nuctori's CI/E2E proposal in #617 and #599. The performance
scanner, reverse reader, sidebar changes, and timing benchmarks are not included.

```sh
npm ci
npm run test:e2e:install   # downloads the WebKit build only; never Chromium
npm run test:e2e
```

These tests drive Apple WebKit (`playwright`'s `webkit` build) through `launchBrowser`
in `e2e/browser.mjs`; Chromium is not used and must not be reintroduced.

On Linux the browser needs system libraries too, so run
`sudo npx playwright install --with-deps webkit` once. Windows (win64), WSL and the
Ubuntu x64/arm64 builds all exist; nothing here is macOS-only.

The script starts and stops its own Vite dev server (through the vinext CLI) on
an available loopback port. Run it in a checkout without an active dev server;
vinext shares `.vinext/dev/lock.json` within a checkout. All fixtures are created
before startup in a temporary `PI_CODING_AGENT_DIR` and removed on completion.
No model credentials or existing Pi sessions are needed. Git is required for
the linked-worktree fixture.

CI runs lint, type checking, and unit tests in one job. A separate job builds
the application in a clean checkout and runs the same browser tests with
`E2E_SERVER_MODE=start` against `vinext start`. Do not build in a checkout used
for development.

`test-results/e2e/` is emptied before the first navigation, so the
`e2e-failure` artifact CI uploads on a failure carries this run's evidence and
not a previous job's leftovers in a reused runner workspace.

No check waits for `networkidle`. With a session selected the page keeps that
session's event stream open and polls `/api/agent/running` every 2.5 s, so the
network going quiet says more about the runner's load than about the interface:
a reload waits for the document and then for the element the check reads. A
`BrowserContext.waitForEvent("page")` carries its own timeout for the same
reason — `page.setDefaultTimeout` does not reach a context wait.

Coverage:

- A 5,000-message session opens with exactly the last 50 entries, bounded
  detail/context responses, and no browser errors.
- Desktop and mobile scrolling load two consecutive older pages. Each response
  has the expected IDs, no gaps or duplicates, and the messages appear once in
  the chat. A small session checks pagination through the root.
- Branch context follows the selected leaf and excludes the other branch.
- Markdown, code blocks, and real tool-call/tool-result blocks render.
- Chat width and font size persist, existing drafts resize, and short settings
  panels keep every language option reachable on desktop and mobile.
- Interface/chat and monospace font lists and weights apply live, survive
  refresh, sync between tabs and reset independently without changing width or
  font size. Headings and Markdown emphasis retain their weights.
- On a desktop the sidebar shows the files below the sessions; Settings ›
  General › File browser brings back the Sessions | Files tabs and returns,
  without remounting the file tree (its file search keeps its query).
- Unknown sessions and paths outside the fixture project are rejected.
- Sidebar sessions open in browser tabs (`session-navigation.mjs`, desktop
  WebKit, one context so tabs share storage): a plain click and Enter
  select in place without a page load; Ctrl+click and the row
  menu's Open in new tab (right-click, ⋯, T; just before Delete) open the clicked row's session in
  a new tab while the original keeps its own; both tabs keep their session
  through reloads; pinned and archived rows link the same way; nothing
  creates, copies or prompts a session; a missing session's link selects none
  in a fresh profile; a keyboard Fork puts focus on the copy row's link.
- Project groups offer Open in new tab (`project-navigation.mjs`, desktop
  and mobile Chromium): the current linked worktree, another project's root,
  and a pinned project without sessions open as fresh composers. Reload keeps
  that destination, not a remembered session. The original tab keeps its
  session, directory, draft, files and group expansion; + still opens in the
  same tab, and no session is created, copied, prompted or stopped. An
  unavailable directory shows the validation error instead of another session.
- The model picker, with a synthetic catalog: on a phone, a simulated keyboard
  (visual viewport shrink, pan, a late height with no event) keeps the same
  filter focused and the list in the visible viewport. Native phone keyboards
  still need real-device verification.
- A local extension checks dialog keyboard navigation, Esc cancellation,
  collapse/expand draft preservation, countdown display, and server-side expiry.

Model prompts, live model streaming, and agent execution are outside this suite.
Failures save a screenshot, Playwright trace, and server log under
`test-results/e2e/`; CI uploads that directory. Open a trace with
`npx playwright show-trace test-results/e2e/trace.zip`.
