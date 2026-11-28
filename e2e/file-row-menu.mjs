// A file row's actions live in its right-click menu, not on top of its name.
//
// They used to be two buttons absolutely positioned over the row, shown on hover: the row's
// name span is `flex: 1`, so its box ran under them and the row's geometric centre measured
// *inside* the mention button — which is how a click where a reader aims came to land on an
// action instead of the file (the file-row bullet in docs/agents/tests.md keeps the
// measurements). Now a row offers its menu at the pointer and the name is what you click.
//
// Labels are English literals, as elsewhere in the suite: the context is created with locale
// en-US and no persisted language, so the app renders English.
//
// What the menu holds and what each item does: docs/agents/files-and-access.md → "A row's own actions".
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { showSidebarFiles } from "./sidebar.mjs";

const LABEL = {
  mention: "Insert path into chat",
  download: "Download file",
  revert: "Revert changes",
  delete: "Delete file",
  rename: "Rename",
  newFolder: "New folder",
  /** The tree's own delete, which asks in the menu; `delete` is the Revert question's item. */
  deleteEntry: "Delete…",
  cancel: "Cancel",
};

/** Right-clicks the middle of a row — where a reader aims, and where an action button used to be. */
async function rightClickRow(page, locator) {
  await locator.scrollIntoViewIfNeeded();
  const box = await locator.boundingBox();
  assert.ok(box, "the row has a box to right-click");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  // down+up rather than click({ button: "right" }): the pair e2e/sidebar.mjs uses for a session row.
  await page.mouse.down({ button: "right" });
  await page.mouse.up({ button: "right" });
}

const itemNames = async (menu) =>
  (await menu.getByRole("menuitem").allInnerTexts()).map((text) => text.split("\n")[0].trim());

/** Reads the file until it holds `expected`, because the revert is a request, not a keystroke. */
async function readUntil(filePath, expected) {
  for (let attempt = 0; attempt < 40; attempt++) {
    if (readFileSync(filePath, "utf8") === expected) return true;
    await delay(250);
  }
  return false;
}

/** Waits until the file is gone, because a delete is a request too. */
async function waitUntilGone(filePath) {
  for (let attempt = 0; attempt < 40; attempt++) {
    if (!existsSync(filePath)) return true;
    await delay(250);
  }
  return false;
}

/**
 * Opens the row's menu and waits until it holds `label`.
 *
 * `refreshButton` is clicked only when the caller changed the file behind the app's back,
 * and sparingly: every click runs `git status` for the project on the same server that is
 * answering the app's own requests, and a starved `GET /api/agent/[id]` is a browser error
 * the suite then blames on whatever runs next.
 */
async function openMenuWithRevert(page, fileRow, menu, refreshButton, label = LABEL.revert) {
  for (let attempt = 0; attempt < 8; attempt++) {
    if (attempt > 0 && refreshButton) await refreshButton.click().catch(() => {});
    await rightClickRow(page, fileRow);
    if (await menu.isVisible().catch(() => false)) {
      if ((await itemNames(menu)).includes(label)) return;
      await page.keyboard.press("Escape");
      await menu.waitFor({ state: "detached", timeout: 5_000 });
    }
    await delay(750);
  }
  assert.fail("the row never came back with a change to undo");
}

/**
 * @param {object} page          a page on a session whose cwd is the e2e project
 * @param {string} filePath      the fixture file's absolute path, as the row's title shows it
 * @param {string} name          the fixture file's name
 * @param {string} fixtureText   the fixture file's bytes, for the download to be checked against
 */
export async function checkFileRowMenu(page, filePath, name, fixtureText) {
  const showSidebar = page.getByRole("button", { name: "Show sidebar", exact: true });
  if (await showSidebar.isVisible()) await showSidebar.click();
  await showSidebarFiles(page);
  const body = page.locator("#session-sidebar-panel-files .sidebar-files-body");
  await body.waitFor({ state: "visible" });

  const fileRow = body.locator("[data-file-row-is-dir='false']").filter({ hasText: name }).first();
  await fileRow.waitFor({ state: "visible", timeout: 30_000 });
  // The row says what it is, which is how the menu finds out what to act on.
  assert.equal(await fileRow.getAttribute("data-file-row-path"), filePath, "a file row names its own file");
  const titlePath = filePath.replace(/\\/g, "/");

  // 1. Under the hover state, the middle of the row is the file's own name — not one of its actions.
  const box = await fileRow.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  const cover = await fileRow.evaluate((el) => {
    const rect = el.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
    return { tag: hit ? hit.tagName : "none", title: hit ? hit.getAttribute("title") ?? "" : "" };
  });
  assert.ok(cover.tag !== "BUTTON" && cover.tag !== "A",
    `the centre of a hovered row is not an action control: ${cover.tag}`);
  assert.equal(cover.title, titlePath, "the centre of the row is the file's own name");

  // 2. The row's menu opens at the pointer and holds exactly these actions: what is done
  // to the entry, then where it is and what it is called (`fileMenuItems()`).
  // No Revert: the fixture project is a fresh directory in tmpdir and no Git repository,
  // so no row has a change to undo and the Revert item a changed row gets
  // (lib/git-revert-rule.ts) has nothing to appear on. Making the fixture a repository
  // would put that item on every row and this assertion with it.
  // The file-manager item is judged by what the server itself answers, the same
  // /api/open-in-explorer reply the project's own button reads — never clicked, because
  // raising a real Finder window on whoever runs the suite is not a test.
  const availability = await page.evaluate(async () => {
    const res = await fetch("/api/open-in-explorer");
    return res.json();
  });
  await rightClickRow(page, fileRow);
  const menu = page.getByRole("menu", { name: `Actions for ${name}` });
  await menu.waitFor({ state: "visible", timeout: 5_000 });
  const items = await itemNames(menu);
  assert.deepEqual(items.slice(0, 2), [LABEL.mention, LABEL.download], items.join(" / "));
  assert.deepEqual(items.slice(3), [LABEL.rename, LABEL.deleteEntry], items.join(" / "));
  const reveal = menu.getByRole("menuitem", { name: items[2] });
  assert.equal(await reveal.isEnabled(), availability.supported === true,
    `reveal is enabled exactly when the file manager is reachable: ${JSON.stringify(availability)}`);

  // 3. Escape closes it, like every other sidebar menu.
  await page.keyboard.press("Escape");
  await menu.waitFor({ state: "detached", timeout: 5_000 });

  // 4. Download is the file's own bytes.
  const downloadWait = page.context().waitForEvent("download", { timeout: 20_000 });
  await rightClickRow(page, fileRow);
  await page.getByRole("menu").getByRole("menuitem", { name: LABEL.download }).first().click();
  const download = await downloadWait;
  // The bytes are the contract; the suggested name is the browser's to derive from the response
  // (WebKit drops the leading dot of a dotfile's name, for one), so only what the app controls.
  assert.ok(download.suggestedFilename().endsWith(".html"), `download name: ${download.suggestedFilename()}`);
  assert.equal(await readFile(await download.path(), "utf8"), fixtureText, "the downloaded bytes are the file's bytes");

  // 5. A folder's menu has nothing to download and everything else.
  const dirRow = body.locator("[data-file-row-is-dir='true']").first();
  if (await dirRow.count()) {
    const dirName = (await dirRow.getAttribute("data-file-row-path")).split(/[\\/]/).filter(Boolean).pop();
    await rightClickRow(page, dirRow);
    const dirMenu = page.getByRole("menu", { name: `Actions for ${dirName}` });
    await dirMenu.waitFor({ state: "visible", timeout: 5_000 });
    const dirItems = await itemNames(dirMenu);
    // No download (a folder has nothing to download) and a new folder named in it.
    assert.deepEqual(dirItems, [LABEL.mention, dirItems[1], LABEL.rename, LABEL.newFolder, LABEL.deleteEntry],
      `a folder row's menu drops the download: ${JSON.stringify(dirItems)}`);
    await page.keyboard.press("Escape");
    await dirMenu.waitFor({ state: "detached", timeout: 5_000 });
  }

  // 6. The mention writes the row's path into the composer the way the @ picker types it.
  const composer = page.locator(".chat-input-textarea");
  await composer.waitFor({ state: "visible", timeout: 10_000 });
  await composer.fill("");
  await rightClickRow(page, fileRow);
  await page.getByRole("menu").getByRole("menuitem", { name: LABEL.mention }).first().click();
  // The composer is cleared above, so its first non-empty value is the mention's writing:
  // waiting for that is the state this reads, not a moment after the click.
  await page.waitForFunction((expected) => {
    const input = document.querySelector(".chat-input-textarea");
    return Boolean(input && input.value.includes(expected));
  }, name);
  const typed = await composer.inputValue();
  assert.ok(typed.includes("@") && typed.includes(name),
    `the menu wrote the row's path into the composer: ${JSON.stringify(typed)}`);

  console.log(`PASS: file row menu and its actions at ${page.viewportSize().width}px (${items.join(" / ")})`);
}

/**
 * The same row when it *does* have a change Git can undo, in a project that is a Git
 * repository (the fixture above is not, so nothing there can be undone).
 *
 * What this pins is the confirmation: the undo cannot run on the click that asks for
 * it, because what it discards is kept nowhere — no stash, no copy. The question's
 * focus sits on Cancel, so a stray Enter changes nothing, and Shift on the item is
 * the one way past the question, the same way it answers a session's Delete.
 *
 * @param {object} page          a page on a session whose cwd is the fixture repository
 * @param {string} filePath      the tracked file's absolute path, as the row shows it
 * @param {string} name          the tracked file's name
 * @param {string} committedText the file's bytes in HEAD
 * @param {string} editedText    the file's modified bytes, what a Cancel must leave
 */
export async function checkFileRowRevert(page, filePath, name, committedText, editedText) {
  const showSidebar = page.getByRole("button", { name: "Show sidebar", exact: true });
  if (await showSidebar.isVisible()) await showSidebar.click();
  await showSidebarFiles(page);
  const body = page.locator("#session-sidebar-panel-files .sidebar-files-body");
  await body.waitFor({ state: "visible" });
  const fileRow = body.locator("[data-file-row-is-dir='false']").filter({ hasText: name }).first();
  await fileRow.waitFor({ state: "visible", timeout: 30_000 });
  const menu = page.getByRole("menu", { name: `Actions for ${name}` });
  const question = page.getByText(`Revert ${name}?`);
  const refreshButton = page.getByRole("button", { name: "Refresh file list", exact: true });

  // 1. A row with a change Git can undo offers the undo. Polling because the row is
  // only as current as the last git status the explorer asked for.
  await openMenuWithRevert(page, fileRow, menu, null);
  assert.ok((await itemNames(menu)).includes(LABEL.revert), "a changed row's menu holds the undo");

  // 2. The click does not do it. The menu turns into its question, and the answer
  // that changes nothing holds the focus.
  await menu.getByRole("menuitem", { name: LABEL.revert }).first().click();
  await question.waitFor({ state: "visible", timeout: 5_000 });
  const focused = await page.evaluate(() => document.activeElement?.textContent?.trim() ?? "");
  assert.equal(focused, LABEL.cancel, `the question focuses Cancel: ${JSON.stringify(focused)}`);

  // 3. Cancel writes nothing and leaves the row as it was.
  await page.getByRole("button", { name: LABEL.cancel, exact: true }).click();
  await menu.getByRole("menuitem", { name: LABEL.mention }).first().waitFor({ state: "visible", timeout: 5_000 });
  assert.equal(readFileSync(filePath, "utf8"), editedText, "Cancel discarded nothing");
  await page.keyboard.press("Escape");
  await menu.waitFor({ state: "detached", timeout: 5_000 });

  // 4. Shift on the item is the reader saying they know: straight to it, no question.
  await rightClickRow(page, fileRow);
  await menu.waitFor({ state: "visible", timeout: 5_000 });
  await page.keyboard.down("Shift");
  await menu.getByRole("menuitem", { name: LABEL.revert }).first().click();
  await page.keyboard.up("Shift");
  assert.ok(await readUntil(filePath, committedText), "Shift went straight to HEAD's bytes");
  await page.getByText(`Reverted ${name}`).waitFor({ state: "visible", timeout: 10_000 });

  // 5. And the plain path: the question's own button. The file is what is waited on,
  // since the undo is a request whose answer arrives when it arrives.
  writeFileSync(filePath, editedText);
  await openMenuWithRevert(page, fileRow, menu, refreshButton);
  await menu.getByRole("menuitem", { name: LABEL.revert }).first().click();
  await question.waitFor({ state: "visible", timeout: 5_000 });
  await page.getByRole("button", { name: LABEL.revert, exact: true }).click();
  assert.ok(await readUntil(filePath, committedText), "the confirmed undo wrote HEAD's bytes back");

  // 6. With nothing left to undo the item is gone, so the menu cannot offer a second one.
  // No refresh here: the undo already had the explorer re-read Git, and the listing is
  // only a moment behind.
  for (let attempt = 0; attempt < 8; attempt++) {
    await rightClickRow(page, fileRow);
    if (await menu.isVisible().catch(() => false)) {
      const after = await itemNames(menu);
      if (!after.includes(LABEL.revert)) {
        await page.keyboard.press("Escape");
        await menu.waitFor({ state: "detached", timeout: 5_000 });
        console.log(`PASS: file row undo asks first at ${page.viewportSize().width}px (${after.join(" / ")})`);
        return;
      }
      await page.keyboard.press("Escape");
      await menu.waitFor({ state: "detached", timeout: 5_000 });
    }
    await delay(750);
  }
  assert.fail("the reverted row never fell quiet: its menu kept offering an undo");
}

/**
 * The same row when the file is one Git never held: untracked, or staged for the
 * first time. There are no bytes to put back, so the item deletes the file — and
 * it asks first exactly like the restore does, because what it discards is kept
 * nowhere at all.
 *
 * @param {object} page     a page on a session whose cwd is the fixture repository
 * @param {string} filePath the file's absolute path, as the row shows it
 * @param {string} name     the file's name
 */
export async function checkFileRowRevertDelete(page, filePath, name) {
  const showSidebar = page.getByRole("button", { name: "Show sidebar", exact: true });
  if (await showSidebar.isVisible()) await showSidebar.click();
  await showSidebarFiles(page);
  const body = page.locator("#session-sidebar-panel-files .sidebar-files-body");
  await body.waitFor({ state: "visible" });
  const fileRow = body.locator("[data-file-row-is-dir='false']").filter({ hasText: name }).first();
  await fileRow.waitFor({ state: "visible", timeout: 30_000 });
  const menu = page.getByRole("menu", { name: `Actions for ${name}` });
  const question = page.getByText(`Delete ${name}?`);

  // 1. The item is there under its own name: a delete, not a restore.
  await openMenuWithRevert(page, fileRow, menu, null, LABEL.delete);
  assert.ok((await itemNames(menu)).includes(LABEL.delete), "a row Git never held offers the delete");

  // 2. It asks first, and the answer that changes nothing holds the focus.
  await menu.getByRole("menuitem", { name: LABEL.delete }).first().click();
  await question.waitFor({ state: "visible", timeout: 5_000 });
  const focused = await page.evaluate(() => document.activeElement?.textContent?.trim() ?? "");
  assert.equal(focused, LABEL.cancel, `the question focuses Cancel: ${JSON.stringify(focused)}`);

  // 3. Cancel leaves the file where it is.
  await page.getByRole("button", { name: LABEL.cancel, exact: true }).click();
  await menu.getByRole("menuitem", { name: LABEL.mention }).first().waitFor({ state: "visible", timeout: 5_000 });
  assert.equal(existsSync(filePath), true, "Cancel discarded nothing");
  await page.keyboard.press("Escape");
  await menu.waitFor({ state: "detached", timeout: 5_000 });

  // 4. The question's own button deletes the file, and the row goes with it.
  await rightClickRow(page, fileRow);
  await menu.waitFor({ state: "visible", timeout: 5_000 });
  await menu.getByRole("menuitem", { name: LABEL.delete }).first().click();
  await question.waitFor({ state: "visible", timeout: 5_000 });
  await page.getByRole("button", { name: LABEL.delete, exact: true }).click();
  assert.ok(await waitUntilGone(filePath), "the confirmed delete removed the file");
  await page.getByText(`Deleted ${name}`).waitFor({ state: "visible", timeout: 10_000 });

  console.log(`PASS: file row delete asks first at ${page.viewportSize().width}px (${name})`);
}

/**
 * A folder row's undo: every changed file under it, each with its own action —
 * the tracked ones back to HEAD's bytes, the ones Git never held deleted. The
 * question counts both, and Cancel still holds the focus.
 *
 * @param {object} page      a page on a session whose cwd is the fixture repository
 * @param {string} dirPath   the folder's absolute path
 * @param {string} name      the folder's name
 * @param {string} underFile a tracked file under the folder, whose bytes go back to HEAD
 * @param {string} committed its bytes in HEAD
 * @param {string} freshFile an untracked file under the folder, which is deleted
 */
export async function checkFileRowRevertFolder(page, dirPath, name, underFile, committed, freshFile) {
  const showSidebar = page.getByRole("button", { name: "Show sidebar", exact: true });
  if (await showSidebar.isVisible()) await showSidebar.click();
  await showSidebarFiles(page);
  const body = page.locator("#session-sidebar-panel-files .sidebar-files-body");
  await body.waitFor({ state: "visible" });
  const dirRow = body.locator("[data-file-row-is-dir='true']").filter({ hasText: name }).first();
  await dirRow.waitFor({ state: "visible", timeout: 30_000 });
  const menu = page.getByRole("menu", { name: `Actions for ${name}` });
  const question = page.getByText("Revert this folder?");

  // 1. A folder with changed files under it offers the undo.
  await rightClickRow(page, dirRow);
  await menu.waitFor({ state: "visible", timeout: 5_000 });
  assert.ok((await itemNames(menu)).includes(LABEL.revert), "a folder with changes under it offers the undo");

  // 2. The question counts the files it covers and the ones it deletes, and Cancel
  // holds the focus: the answer that changes nothing is the one a stray Enter gives.
  await menu.getByRole("menuitem", { name: LABEL.revert }).first().click();
  await question.waitFor({ state: "visible", timeout: 5_000 });
  const asked = await page.locator(".sidebar-menu-question-text").innerText();
  assert.ok(asked.includes("Reverts the 2 changed files"), `the question counts the files: ${asked}`);
  assert.ok(asked.includes("deleting the 1 Git never committed"), `the question counts the deletes: ${asked}`);
  const focused = await page.evaluate(() => document.activeElement?.textContent?.trim() ?? "");
  assert.equal(focused, LABEL.cancel, `the question focuses Cancel: ${JSON.stringify(focused)}`);

  // 3. Cancel leaves every file under it as it was.
  await page.getByRole("button", { name: LABEL.cancel, exact: true }).click();
  await menu.getByRole("menuitem", { name: LABEL.mention }).first().waitFor({ state: "visible", timeout: 5_000 });
  assert.equal(readFileSync(underFile, "utf8"), `${committed}edited under the folder\n`, "Cancel discarded nothing");
  assert.equal(existsSync(freshFile), true, "Cancel deleted nothing");
  await page.keyboard.press("Escape");
  await menu.waitFor({ state: "detached", timeout: 5_000 });

  // 4. The confirmed answer covers the whole folder: the tracked file back to
  // HEAD's bytes, the untracked one gone, and the toast counts what it did.
  // HEAD's bytes are `committed` as the fixture committed them, newline included.
  await rightClickRow(page, dirRow);
  await menu.waitFor({ state: "visible", timeout: 5_000 });
  await menu.getByRole("menuitem", { name: LABEL.revert }).first().click();
  await question.waitFor({ state: "visible", timeout: 5_000 });
  await page.getByRole("button", { name: LABEL.revert, exact: true }).click();
  assert.ok(await readUntil(underFile, committed), "the folder's tracked file went back to HEAD");
  assert.ok(await waitUntilGone(freshFile), "the folder's untracked file was deleted");
  await page.getByText("Reverted 2 files").waitFor({ state: "visible", timeout: 10_000 });

  console.log(`PASS: folder row undo covers its files at ${page.viewportSize().width}px (${name})`);
}
