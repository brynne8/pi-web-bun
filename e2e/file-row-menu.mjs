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
import { readFile } from "node:fs/promises";
import { showSidebarFiles } from "./sidebar.mjs";

const LABEL = {
  mention: "Insert path into chat",
  download: "Download file",
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

  // 2. The row's menu opens at the pointer and holds exactly the three actions.
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
  assert.equal(items.length, 3, `a file row's menu holds three items: ${JSON.stringify(items)}`);
  assert.equal(items[0], LABEL.mention, items.join(" / "));
  assert.equal(items[1], LABEL.download, items.join(" / "));
  const reveal = menu.getByRole("menuitem", { name: items[2] });
  assert.equal(await reveal.isEnabled(), availability.supported === true,
    `reveal is enabled exactly when the file manager is reachable: ${JSON.stringify(availability)}`);
  if (availability.supported !== true) {
    assert.ok(items[2].includes(availability.reason), `a disabled reveal says why: ${items[2]}`);
  }

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
    assert.equal(dirItems.length, 2, `a folder row's menu drops the download: ${JSON.stringify(dirItems)}`);
    assert.equal(dirItems[0], LABEL.mention, dirItems.join(" / "));
    await page.keyboard.press("Escape");
    await dirMenu.waitFor({ state: "detached", timeout: 5_000 });
  }

  // 6. The mention writes the row's path into the composer the way the @ picker types it.
  const composer = page.locator(".chat-input-textarea");
  await composer.waitFor({ state: "visible", timeout: 10_000 });
  await composer.fill("");
  await rightClickRow(page, fileRow);
  await page.getByRole("menu").getByRole("menuitem", { name: LABEL.mention }).first().click();
  await page.waitForTimeout(400);
  const typed = await composer.inputValue();
  assert.ok(typed.includes("@") && typed.includes(name),
    `the menu wrote the row's path into the composer: ${JSON.stringify(typed)}`);

  console.log(`PASS: file row menu and its actions at ${page.viewportSize().width}px (${items.join(" / ")})`);
}
