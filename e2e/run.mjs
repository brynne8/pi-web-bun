// Adapted from @Nuctori's script-style CI/E2E fixtures in PR #617 (issue #599).
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { appendFileSync, createWriteStream, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { launchBrowser, newTestContext } from "./browser.mjs";
import { checkFilePanel, filePanelFixture } from "./file-panel.mjs";
import { checkFileRowMenu } from "./file-row-menu.mjs";
import { checkExtensionDialogSizing, checkExtensionDialogs, extensionSource } from "./extension-dialog.mjs";
import { checkChatAppearance } from "./chat-appearance.mjs";
import { checkCodeBackground } from "./code-background.mjs";
import { checkModelDiscovery, installModelDiscoveryStub } from "./model-discovery.mjs";
import { checkFilesPlacement, showSidebarSessions } from "./sidebar.mjs";
import { checkSessionNavigation } from "./session-navigation.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const mode = process.env.E2E_SERVER_MODE || "dev";
assert.ok(mode === "dev" || mode === "start", "E2E_SERVER_MODE must be dev or start");
assert.ok(mode !== "dev" || !existsSync(join(root, ".next/dev/lock")), "Use a checkout without an active dev server");
const artifacts = join(root, "test-results/e2e");
mkdirSync(artifacts, { recursive: true });
const agentDir = mkdtempSync(join(tmpdir(), "pi-web-e2e-"));
const project = join(agentDir, "project");
const sessionDir = join(agentDir, "sessions", "e2e");
mkdirSync(project);
const previewFile = join(project, "preview.html");
writeFileSync(previewFile, filePanelFixture);
// A directory of its own for the file-row menu (e2e/file-row-menu.mjs): a folder row has
// nothing to download, and the fixture project would otherwise hold one file and no folders.
const nestedDir = join(project, "nested");
mkdirSync(nestedDir, { recursive: true });
writeFileSync(join(nestedDir, "inner.html"), "<!doctype html><html><body>nested</body></html>\n");
mkdirSync(sessionDir, { recursive: true });
const timestamp = "2026-08-23T00:00:00.000Z";
const LONG = "e2e-long-session";
const BRANCH = "e2e-branch-session";
const RICH = "e2e-rich-session";
const COMPACTED = "e2e-compacted-session";
const APPEND = "e2e-external-append-session";
const CODE_BACKGROUND = "e2e-code-background";
const text = (i) => `E2E message ${String(i).padStart(4, "0")}`;
const ids = (start, end) => Array.from({ length: end - start }, (_, i) => `e${start + i}`);

function message(id, parentId, role, content) {
  return { type: "message", id, parentId, timestamp, message: { role, content } };
}

function writeSession(id, entries) {
  const header = { type: "session", version: 3, id, timestamp, cwd: project };
  writeFileSync(join(sessionDir, `2026-08-23T00-00-00-000Z_${id}.jsonl`),
    [header, ...entries].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
}

let server;
let serverExited;
let browser;
let page;
let context;
let serverError;
const serverLog = createWriteStream(join(artifacts, "server.log"));
const interrupt = () => {
  process.exitCode = 1;
  server?.kill("SIGTERM");
  void browser?.close().catch(() => {});
};
process.once("SIGINT", interrupt);
process.once("SIGTERM", interrupt);

try {
  // Seed before startup so the first catalogue scan sees every fixture.
  mkdirSync(join(agentDir, "extensions"));
  writeFileSync(join(agentDir, "extensions", "e2e-dialog.js"), extensionSource);
  const longEntries = Array.from({ length: 5000 }, (_, i) =>
    message(`e${i}`, i ? `e${i - 1}` : null, i % 2 ? "assistant" : "user", text(i)));
  longEntries.splice(1, 0, message("alternate", "e0", "user", "E2E alternate history branch"));
  writeSession(LONG, longEntries);
  writeSession(BRANCH, [
    message("root", null, "user", "Branch root"),
    message("old", "root", "assistant", "Inactive branch answer"),
    message("new", "root", "assistant", "Active branch answer"),
  ]);
  const toolResult = message("result", "call", "toolResult", [{ type: "text", text: "E2E tool output" }]);
  Object.assign(toolResult.message, { toolCallId: "t1", toolName: "bash", isError: false });
  const richEntries = [
    message("user", null, "user", "Render **E2E markdown**"),
    message("call", "user", "assistant", [
      { type: "thinking", thinking: "" },
      { type: "thinking", thinking: "E2E intermediate reasoning\nIntermediate thinking details." },
      { type: "text", text: "E2E process paragraph.\n\n".repeat(20) },
      { type: "toolCall", id: "t1", name: "bash", arguments: { command: "echo E2E tool output" } },
    ]),
    toolResult,
    message("answer", "result", "assistant", [
      { type: "thinking", thinking: "" },
      { type: "thinking", thinking: "E2E follow-up reasoning\nFollow-up thinking details." },
      { type: "text", text: "E2E process note" },
      { type: "thinking", thinking: "E2E final reasoning\nFinal thinking details." },
      { type: "text", text:
        "E2E final answer\n```js\nconsole.log('E2E code');\n```\n\n"
        + "| Kind | " + "Long headings should wrap without stretching the table. ".repeat(8) + " |\n| --- | --- |\n"
        + "| Text | " + "Long sentences should wrap while wide tables keep their natural column widths. ".repeat(8) + " |\n"
        + "| 中文 | " + "表格中的长句应该自然换行，多列表格仍然可以横向滚动。".repeat(12) + " |\n"
        + "| URL | https://example.invalid/" + "long-path-segment".repeat(24) + " |\n"
        + "| Code | `" + "long_identifier_".repeat(24) + "` |\n\n"
        + "| " + Array.from({ length: 8 }, (_, i) => `Column ${i + 1}`).join(" | ") + " |\n"
        + "| " + Array(8).fill("---").join(" | ") + " |\n"
        + "| " + Array.from({ length: 8 }, (_, i) => `release-20260901-${String(i + 1).padStart(6, "0")}`).join(" | ") + " |\n\n"
        + "E2E answer paragraph.\n\n".repeat(20)
        + "## E2E reading position\n\n"
        + "E2E answer paragraph.\n\n".repeat(20),
      },
    ]),
  ];
  Object.assign(richEntries.at(-1).message, { provider: "test", model: "E2E Model" });
  writeSession(RICH, richEntries);
  writeSession(CODE_BACKGROUND, [
    message("user", null, "user", "E2E code background"),
    message("answer", "user", "assistant", [{ type: "text", text:
      "```js\nconst x = 1;\n```\n\n```mermaid\ngraph TD\n A --> B\n```",
    }]),
  ]);
  // The default page is 50 *visible* messages (user / assistant / compaction).
  // toolResults ride along free after #810, so 48 tool-call assistants + the
  // final answer + the divider fill that window; the user prompt is the 51st
  // visible entry and must stay outside the first page.
  const compactedEntries = [
    message("user", null, "user", "E2E prompt outside the compacted page"),
    { type: "compaction", id: "compact", parentId: "user", timestamp, summary: "E2E compaction anchor", firstKeptEntryId: "user", tokensBefore: 100 },
  ];
  for (let i = 0; i < 48; i++) {
    compactedEntries.push(message(`call${i}`, compactedEntries.at(-1).id, "assistant", [
      { type: "toolCall", id: `t${i}`, name: "bash", arguments: { command: `echo step${i}` } },
    ]));
    const result = message(`result${i}`, `call${i}`, "toolResult", [{ type: "text", text: `step${i}` }]);
    Object.assign(result.message, { toolCallId: `t${i}`, toolName: "bash", isError: false });
    compactedEntries.push(result);
  }
  compactedEntries.push(message("answer", "result47", "assistant", [{ type: "text", text:
    "E2E compacted answer paragraph.\n\n".repeat(20)
    + "## E2E compacted heading\n\n"
    + "E2E compacted answer paragraph.\n\n".repeat(20),
  }]));
  writeSession(COMPACTED, compactedEntries);
  writeSession(APPEND, [
    message("root", null, "user", "E2E wrapper root"),
    message("reply", "root", "assistant", "E2E wrapper reply"),
  ]);

  const probe = createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const port = probe.address().port;
  await new Promise((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
  const base = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, [join(root, "node_modules/next/dist/bin/next"), mode, "-H", "127.0.0.1", "-p", String(port)], {
    cwd: root,
    env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_WEB_PASSWORD: "", NEXT_TELEMETRY_DISABLED: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.once("error", (error) => { serverError = error; });
  serverExited = once(server, "exit");
  server.stdout.pipe(serverLog, { end: false });
  server.stderr.pipe(serverLog, { end: false });

  async function api(path, status = 200) {
    const response = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(30_000) });
    assert.equal(response.status, status, path);
    return response.json();
  }

  async function post(path, body) {
    const response = await fetch(`${base}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });
    assert.ok(response.ok, `POST ${path} -> ${response.status}`);
    return response.json();
  }

  const deadline = Date.now() + 120_000;
  while (true) {
    if (serverError) throw serverError;
    assert.equal(server.exitCode, null, "Server exited before readiness; see server.log");
    const response = await fetch(`${base}/api/sessions`, { signal: AbortSignal.timeout(5000) }).catch(() => null);
    if (response?.ok) {
      const { sessions } = await response.json();
      assert.deepEqual(sessions.map((session) => session.id).sort(), [LONG, BRANCH, RICH, COMPACTED, APPEND, CODE_BACKGROUND].sort());
      break;
    }
    assert.ok(Date.now() < deadline, "Server readiness timed out; see server.log");
    await delay(250);
  }

  const detail = await api(`/api/sessions/${LONG}?deferThinking=1&deferMedia=1`);
  assert.deepEqual(detail.context.entryIds, ids(4950, 5000));
  assert.equal(detail.context.messages.length, 50);
  assert.equal(detail.context.hasMore, true);
  assert.ok(JSON.stringify(detail).length < 100_000, "Detail transferred unbounded history");
  const tail = await api(`/api/sessions/${LONG}/context?tail=50`);
  assert.deepEqual(tail.context.entryIds, ids(4950, 5000));
  assert.equal(tail.context.messages.length, 50);
  const selectedBranch = await api(`/api/sessions/${BRANCH}/context?leafId=old`);
  assert.deepEqual(selectedBranch.context.entryIds, ["root", "old"]);
  const rootPage = await api(`/api/sessions/${BRANCH}/context?before=old&tail=1`);
  assert.deepEqual(rootPage.context.entryIds, ["root"]);
  assert.equal(rootPage.context.hasMore, false);
  const beforeRoot = await api(`/api/sessions/${BRANCH}/context?before=root`);
  assert.deepEqual(beforeRoot.context.entryIds, []);
  assert.equal(beforeRoot.context.hasMore, false);
  await api("/api/sessions/e2e-does-not-exist", 404);
  await api("/api/files/..%2F..%2Fetc%2Fpasswd?type=read", 403);
  const compacted = await api(`/api/sessions/${COMPACTED}`);
  assert.equal(compacted.context.entryIds[0], "compact");
  assert.equal(compacted.context.messages.some((entry) => entry.role === "user"), false);
  console.log("PASS: bounded history, branch context, pagination root, and API errors");

  // #632 regression: a live wrapper shadows the session file. Ordinary reads
  // keep that snapshot (two processes writing one JSONL is unsupported). A
  // mount/refresh GET (?force=1) must see the external append and stay stable.
  {
    const file = join(sessionDir, `2026-08-23T00-00-00-000Z_${APPEND}.jsonl`);
    await post(`/api/agent/${APPEND}`, { type: "get_state" });
    const beforeAppend = await api(`/api/sessions/${APPEND}`);
    assert.deepEqual(beforeAppend.context.entryIds, ["root", "reply"], "the wrapper must serve its own snapshot first");
    appendFileSync(file, `${JSON.stringify(message("external", "reply", "assistant", "E2E external append"))}\n`);
    const ordinaryRead = await api(`/api/sessions/${APPEND}`);
    assert.deepEqual(ordinaryRead.context.entryIds, ["root", "reply"], "post-turn reads must not probe disk");
    assert.equal(ordinaryRead.wrapperRebuilt, undefined);
    const afterForce = await api(`/api/sessions/${APPEND}?force=1`);
    assert.deepEqual(afterForce.context.entryIds, ["root", "reply", "external"], "a mount/refresh read must see the external append");
    assert.equal(afterForce.wrapperRebuilt, true);
    const again = await api(`/api/sessions/${APPEND}`);
    assert.deepEqual(again.context.entryIds, ["root", "reply", "external"], "repeated reads must stay stable");
    const appended = await api(`/api/sessions/${APPEND}/context?tail=1`);
    assert.deepEqual(appended.context.entryIds, ["external"], "the appended entry must be readable on its own");
    console.log("PASS: external session-file appends are visible on force/mount reads");
  }

  browser = await launchBrowser();
  for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
    // acceptDownloads for the file row's Download item (e2e/file-row-menu.mjs); nothing else
    // in the suite downloads, so accepting is inert for every other check.
    context = await newTestContext(browser, { viewport, locale: "en-US", acceptDownloads: true });
    await context.tracing.start({ screenshots: true, snapshots: true });
    page = await context.newPage();
    page.setDefaultTimeout(30_000);
    // ModelsConfig reads /api/models-config once on mount, so the fixture has to be
    // in place before the first navigation. See e2e/model-discovery.mjs.
    const modelDiscoveryStub = await installModelDiscoveryStub(page);
    const errors = [];
    const olderResponses = [];
    // Errors the harness itself causes, or that a browser reports only during teardown.
    // Narrow on purpose: a real app error must not match any of these.
    const IGNORED_CONSOLE_ERRORS = [
      /Service Worker is disabled because the context is sandboxed/, // browser.mjs blocks workers
      /ResizeObserver loop completed with undelivered notifications/,
      /^Failed to load context: TypeError: Load failed$/, // a fetch a navigation cancelled
      // The viewport meta carries `interactive-widget=resizes-content` on purpose (app/layout.tsx:
      // the Chromium-only virtual-keyboard key an Android reader needs). WebKit on the Linux CI
      // image reads the meta and prints this at error level, once per parse; the macOS WebKit
      // build reads the same tag and says nothing at any level. Nothing is broken either way, so
      // the pattern stays pinned to this one key and this one sentence.
      /^Viewport argument key "interactive-widget" not recognized and ignored\.$/,
    ];
    const noteError = (text) => { if (!IGNORED_CONSOLE_ERRORS.some((pattern) => pattern.test(text))) errors.push(text); };
    page.on("pageerror", (error) => noteError(error.message));
    page.on("console", (event) => { if (event.type() === "error") noteError(event.text()); });
    page.on("response", (response) => {
      if (response.url().startsWith(base) && response.status() >= 500) errors.push(`${response.status()} ${response.url()}`);
      const url = new URL(response.url());
      if (url.pathname === `/api/sessions/${LONG}/context` && url.searchParams.has("before")) olderResponses.push(response);
    });
    const stateReady = page.waitForResponse((response) => new URL(response.url()).pathname === `/api/sessions/${LONG}/state`);
    await page.goto(`${base}/?session=${LONG}`, { waitUntil: "domcontentloaded" });
    assert.equal((await stateReady).status(), 200);
    await page.getByText(text(4999), { exact: true }).waitFor();
    const latestUser = await page.getByText(text(4998), { exact: true }).elementHandle();
    assert.ok(latestUser, "Latest user message must be mounted before pagination");
    const sentinel = page.getByText("Scroll up to load earlier messages", { exact: true });
    await sentinel.waitFor({ state: "attached" });
    assert.equal(await page.getByText(text(4949), { exact: true }).count(), 0);
    // The minimap numbers turns from the session's first, not the loaded page's (#791):
    // e0..e4949 hold 2475 user messages, so the turn asking text(4998) is 2500.
    const readMinimapTurn = async (screenshot) => {
      const node = page.locator("[data-minimap-node-index='0']");
      await node.waitFor();
      const rect = await node.boundingBox();
      assert.ok(rect);
      await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2);
      const preview = page.locator("[data-minimap-preview-box]");
      const turn = preview.locator("[data-minimap-preview-index]").filter({ hasText: text(4998) });
      const read = async () => ({
        number: await turn.locator("span[aria-hidden='true']").first().textContent(),
        earlier: await preview.locator("[data-minimap-preview-earlier]").textContent(),
      });
      // The preview counts rendered turns, so a read can land before the last page is
      // counted. Sample until three consecutive reads agree.
      let result = await read();
      for (let attempt = 0, same = 0; attempt < 25 && same < 2; attempt++) {
        await delay(100);
        const next = await read();
        same = next.number === result.number && next.earlier === result.earlier ? same + 1 : 0;
        result = next;
      }
      await page.screenshot({ path: join(artifacts, screenshot) });
      await page.mouse.move(0, 0);
      await preview.waitFor({ state: "detached" });
      return result;
    };
    if (viewport.width > 600) {
      assert.deepEqual(await readMinimapTurn("minimap-turns-first-page.png"), { number: "2500", earlier: "Earlier turns not loaded: 2475. Click to load" });
    }

    // Exercise the real IntersectionObserver and prepend path, twice.
    for (let turn = 0; turn < 2; turn++) {
      const responsePromise = page.waitForResponse((response) =>
        new URL(response.url()).pathname === `/api/sessions/${LONG}/context`);
      await sentinel.evaluate((element) => element.scrollIntoView({ block: "start", behavior: "instant" }));
      const response = await responsePromise;
      const older = (await response.json()).context;
      const firstMessage = older.messages.find((message) => message.role === "user")?.content;
      assert.equal(typeof firstMessage, "string", "Older page must contain user messages");
      await page.getByText(firstMessage, { exact: true }).waitFor({ state: "attached" });
      await page.getByText(text(4999), { exact: true }).evaluate((element) => element.scrollIntoView({ block: "end", behavior: "instant" }));
    }
    assert.deepEqual(await latestUser.evaluate((element) => ({
      connected: element.isConnected,
      text: element.textContent,
    })), { connected: true, text: text(4998) }, "Prepending history must preserve existing message nodes");
    await latestUser.dispose();
    assert.ok(olderResponses.length >= 2, "Scrolling must fetch consecutive older pages");
    let oldest = Number(new URL(olderResponses[0].url()).searchParams.get("before")?.slice(1));
    assert.ok(Number.isInteger(oldest), "Older page must include a numeric before cursor");
    for (const response of olderResponses) {
      assert.equal(response.status(), 200);
      assert.equal(new URL(response.url()).searchParams.get("before"), `e${oldest}`);
      const older = (await response.json()).context;
      assert.deepEqual(older.entryIds, ids(oldest - 50, oldest));
      assert.equal(older.messages.length, 50);
      oldest -= 50;
      assert.equal(older.oldestEntryId, `e${oldest}`);
      assert.equal(older.hasMore, true);
    }
    const rendered = await page.getByText(/^E2E message \d{4}$/).allTextContents();
    // The sidebar also displays the first message as the session title.
    assert.deepEqual(rendered.filter((value) => value !== text(0)),
      Array.from({ length: 5000 - oldest }, (_, i) => text(oldest + i)), "Missing, reordered, or duplicate chat messages");
    if (viewport.width > 600) {
      assert.deepEqual(await readMinimapTurn("minimap-turns-paged.png"), {
        number: "2500",
        earlier: `Earlier turns not loaded: ${oldest / 2}. Click to load`,
      }, "Loading older pages must not renumber minimap turns");
    }
    await page.screenshot({ path: join(artifacts, `history-${viewport.width}.png`) });

    await page.goto(`${base}/?session=${BRANCH}`, { waitUntil: "domcontentloaded" });
    await page.getByText("Active branch answer", { exact: true }).waitFor();
    assert.equal(await page.getByText("Inactive branch answer", { exact: true }).count(), 0);
    await page.goto(`${base}/?session=${RICH}`, { waitUntil: "domcontentloaded" });
    await page.locator("strong").filter({ hasText: "E2E markdown" }).waitFor();
    await page.locator("pre").filter({ hasText: "console.log('E2E code');" }).waitFor();
    await page.getByText("E2E final answer", { exact: true }).waitFor();
    const thinking = page.getByRole("button", { name: /^Thinking/ });
    // How many groups a turn has is this fork's own design (one per run of thinking and tool
    // calls, where upstream keeps one per turn), so it is not asserted here. What is asserted
    // is that thinking never stands on its own outside a fold.
    assert.equal(await thinking.count(), 0, "All thinking stays inside process details");
    const finalMessage = page.locator("[data-entry-id='answer']");
    const tables = finalMessage.last().locator(".markdown-table-wrap");
    assert.equal(await tables.count(), 2);
    await tables.first().scrollIntoViewIfNeeded();
    await page.evaluate(() => document.fonts.ready);
    const tableLayout = await tables.evaluateAll(([prose, wide]) => {
      const wraps = (cell) => {
        const range = document.createRange();
        range.selectNodeContents(cell);
        return range.getBoundingClientRect().height > parseFloat(getComputedStyle(cell).lineHeight);
      };
      return {
        proseFits: prose.scrollWidth <= prose.clientWidth + 1,
        longCellsWrap: [...prose.querySelectorAll("tr > :last-child")].every(wraps),
        wideScrolls: wide.scrollWidth > wide.clientWidth + 1,
        wideCellsStayOnOneLine: [...wide.querySelectorAll("tbody td")].every((cell) => !wraps(cell)),
      };
    });
    assert.ok(tableLayout.proseFits, "Long table cells must not stretch a two-column table beyond the chat");
    assert.ok(tableLayout.longCellsWrap, "Long headings, sentences, URLs, and inline code must wrap");
    assert.ok(tableLayout.wideScrolls, "Wide tables must retain horizontal scrolling");
    assert.ok(tableLayout.wideCellsStayOnOneLine, "Wide tables must not squeeze ordinary values into narrow columns");
    await page.screenshot({ path: join(artifacts, `markdown-tables-${viewport.width}.png`) });
    console.log(`PASS: ${viewport.width}px wrapping long table cells and scrolling wide tables`);
    assert.equal(await finalMessage.getByRole("button", { name: /^Thinking/ }).count(), 0);
    assert.equal(await finalMessage.getByText("test/E2E Model", { exact: true }).count(), 1);
    // The turn's work sits inside its folds, so open them to reach the tool card below. How
    // many folds there are is this fork's own design (one per run of thinking and tool calls,
    // where upstream keeps one per turn) and is asserted nowhere here.
    const processDetails = page.getByRole("button", { name: /^Process details/ });
    for (const group of await processDetails.all()) await group.click();
    await page.getByText("echo E2E tool output", { exact: true }).waitFor();
    await page.getByRole("button", { name: /bash.*echo E2E tool output/ }).click();
    await page.getByText("E2E tool output", { exact: true }).waitFor();
    await page.goto(`${base}/?session=${COMPACTED}`, { waitUntil: "domcontentloaded" });
    const heading = page.getByRole("heading", { name: "E2E compacted heading", exact: true });
    await heading.waitFor({ state: "attached" });
    if (viewport.width > 600) {
      const node = page.locator("[data-minimap-node-index='0']");
      await node.waitFor();
      const rect = await node.boundingBox();
      assert.ok(rect);
      await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2);
      const preview = page.locator("[data-minimap-preview-box]");
      await preview.getByRole("button", { name: "E2E compaction anchor", exact: true }).waitFor();
      await preview.getByRole("button", { name: "E2E compacted heading", exact: true }).click();
      await page.waitForFunction(() => {
        const heading = document.querySelector("[data-entry-id='answer'] h2");
        const scroll = heading?.closest(".overflow-y-auto");
        return heading && scroll && Math.abs(heading.getBoundingClientRect().top
          - scroll.getBoundingClientRect().top - scroll.clientHeight * 0.3) < 5;
      });
      await page.screenshot({ path: join(artifacts, "compaction-minimap.png") });

      // A session row of the sidebar's sessions, found by its visible title
      // (the row's tooltip adds message count and time, so no exact title match).
      const sessionRow = (title) => page.locator("#session-sidebar-panel-sessions .session-tree-session").filter({
        has: page.locator(".session-tree-title", { hasText: new RegExp(`^${title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`) }),
      });
      const clickSessionRow = async (title) => {
        await showSidebarSessions(page);
        await sessionRow(title).locator(".session-tree-main").click();
      };
      const selectSession = async (title, entryId) => {
        await clickSessionRow(title);
        await page.locator(`[data-entry-id="${entryId}"]:not([data-message-role])`).waitFor({ state: "visible" });
      };
      const readingOffset = (target) => target.evaluate((element) => (
        element.getBoundingClientRect().top - element.closest(".overflow-y-auto").getBoundingClientRect().top
      ));
      const positionForReading = async (target) => {
        await target.evaluate((element) => {
          const scroll = element.closest(".overflow-y-auto");
          scroll.scrollTop += element.getBoundingClientRect().top - scroll.getBoundingClientRect().top - 120;
        });
        return readingOffset(target);
      };
      await selectSession(text(0), "e4999");
      const olderPage = page.waitForResponse((response) => response.url().includes(`/api/sessions/${LONG}/context?`));
      await page.getByText("Scroll up to load earlier messages", { exact: true }).evaluate((element) => element.scrollIntoView({ block: "start", behavior: "instant" }));
      await olderPage;
      const olderMessage = page.locator("[data-entry-id='e4920']");
      const olderOffset = await positionForReading(olderMessage);
      // Leaving a session and coming back must restore the reading position. What followed here
      // was upstream's: it expanded the one group its turn had and expected the answer not to
      // move once the group came back collapsed. This fork folds each run of thinking and tool
      // calls, so that geometry is the branch's own design and is not asserted from e2e.
      await selectSession("Render **E2E markdown**", "user");
      await selectSession(text(0), "e4920");
      assert.ok(Math.abs(await readingOffset(olderMessage) - olderOffset) < 5, "Returning to older history must restore its reading offset");

      // Hold pagination until a different branch has loaded, exercising effect cancellation.
      let releaseHistory;
      const historyGate = new Promise((resolve) => { releaseHistory = resolve; });
      const contextRoute = `**/api/sessions/${LONG}/context?*`;
      await page.route(contextRoute, async (route) => {
        if (new URL(route.request().url()).searchParams.has("before")) await historyGate;
        await route.continue().catch(() => {});
      });
      // Context loading is real; avoid starting an agent just to persist the test branch.
      const agentRoute = `**/api/agent/${LONG}`;
      await page.route(agentRoute, (route) => route.fulfill({ json: {} }));
      try {
        const pendingHistory = page.waitForRequest((request) => request.url().includes(`/api/sessions/${LONG}/context?`) && new URL(request.url()).searchParams.has("before"));
        await clickSessionRow(text(0));
        // Older history is asked for the way a user asks for it: the sentinel scrolling into
        // view. Re-opening the session no longer fetches on its own, because the window now
        // shows every message that is loaded, so the content is already tall enough to restore
        // the reading position into — the extra page this used to wait for was the window bug
        // asking for content it had just cut off the top.
        await page.getByText("Scroll up to load earlier messages", { exact: true })
          .evaluate((element) => element.scrollIntoView({ block: "start", behavior: "instant" }));
        await pendingHistory;
        await page.getByRole("button", { name: "Branches", exact: true }).click();
        await page.getByText("E2E alternate history branch", { exact: true }).click();
        await page.locator("[data-entry-id='alternate']:not([data-message-role])").waitFor({ state: "visible" });
        await page.screenshot({ path: join(artifacts, "scroll-restore-branch.png") });
      } finally {
        releaseHistory();
        await page.unroute(contextRoute);
        await page.unroute(agentRoute);
      }
      console.log("PASS: session reading offsets and cancelled branch restoration");
      await page.goto(`${base}/?session=${COMPACTED}`, { waitUntil: "domcontentloaded" });
      await heading.waitFor({ state: "visible" });
    }
    await page.goto(`${base}/?session=${RICH}`, { waitUntil: "domcontentloaded" });
    await page.locator(".markdown-code-block pre").waitFor();
    await checkFilePanel(page, previewFile);
    await checkExtensionDialogs(page, artifacts, viewport.width);
    await checkExtensionDialogSizing(page, viewport.width);
    if (viewport.width > 600) {
      // A row's actions, on the desktop leg only: at 390px the same menu is the
      // sidebar's bottom sheet, and a phone has no right-click to open it with.
      await checkFileRowMenu(page, previewFile, "preview.html", filePanelFixture);
      await page.goto(`${base}/?session=${RICH}`, { waitUntil: "domcontentloaded" });
      await page.locator(".markdown-code-block pre").waitFor();
      await checkChatAppearance(page);
      await page.setViewportSize(viewport);
      // Returning from the mobile breakpoint restores the desktop sidebar preference in an effect, so wait for the toggle to settle.
      const hideSidebar = page.getByRole("button", { name: "Hide sidebar", exact: true });
      const showSidebar = page.getByRole("button", { name: "Show sidebar", exact: true });
      // Seen once: the toggle absent for the whole 30s after the breakpoint changed back, with the
      // session otherwise rendered — a hydration that had not settled. Reloading is what a reader
      // would do, and it costs one navigation in a suite that runs minutes.
      await hideSidebar.or(showSidebar).waitFor({ state: "visible", timeout: 10_000 }).catch(async () => {
        await page.goto(`${base}/?session=${RICH}`, { waitUntil: "domcontentloaded" });
        await page.locator(".markdown-code-block pre").waitFor();
      });
      await hideSidebar.or(showSidebar).waitFor({ state: "visible" });
      if (await showSidebar.isVisible()) await showSidebar.click();
      // The toggle keeps settling after a breakpoint change, so a click can land before it
      // takes effect. The sidebar being open is what matters, not how many clicks it took.
      await hideSidebar.waitFor({ state: "visible", timeout: 5_000 }).catch(async () => {
        if (await showSidebar.isVisible()) await showSidebar.click();
      });
      await hideSidebar.waitFor({ state: "visible" });
      // The files sit below the sessions on a desktop; Settings › General ›
      // File browser brings the tabs back, and goes back.
      await checkFilesPlacement(page);
      console.log("PASS: files below the sessions by default, tabs from Settings and back");
      await checkModelDiscovery(page, modelDiscoveryStub);
    }
    await page.goto(`${base}/?session=${CODE_BACKGROUND}`, { waitUntil: "domcontentloaded" });
    await page.locator(".markdown-code-block pre").waitFor();
    await checkCodeBackground(page);
    assert.deepEqual(errors, [], `Browser errors at width ${viewport.width}`);
    console.log(`PASS: ${viewport.width}px browser pagination, branch, markdown, code, tool call, and compaction navigation`);
    await context.tracing.stop();
    await context.close();
    context = undefined;
    page = undefined;
  }
  // Last, in its own context and tabs, so the checks above run as before. It
  // restores the sidebar state (pins, archive) and deletes the fork it makes.
  await checkSessionNavigation({
    browser,
    base,
    artifacts,
    a: { id: BRANCH, entry: "new", text: "Active branch answer" },
    b: { id: CODE_BACKGROUND, entry: "answer", text: "const x = 1;" },
    api,
    deleteSession: async (id) => {
      const response = await fetch(`${base}/api/sessions/${encodeURIComponent(id)}`, { method: "DELETE", signal: AbortSignal.timeout(30_000) });
      assert.ok(response.ok, `DELETE session ${id} -> ${response.status}`);
    },
  });
} catch (error) {
  console.error(error);
  process.exitCode = 1;
  if (page) await page.screenshot({ path: join(artifacts, "failure.png") }).catch(() => {});
  if (context) await context.tracing.stop({ path: join(artifacts, "trace.zip") }).catch(() => {});
} finally {
  await browser?.close().catch(() => {});
  if (server && server.exitCode === null && server.signalCode === null) {
    server.kill("SIGTERM");
    const forceKill = setTimeout(() => server.kill("SIGKILL"), 10_000);
    await serverExited;
    clearTimeout(forceKill);
  }
  serverLog.end();
  rmSync(agentDir, { recursive: true, force: true });
  process.off("SIGINT", interrupt);
  process.off("SIGTERM", interrupt);
}
