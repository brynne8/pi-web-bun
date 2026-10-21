import assert from "node:assert/strict";

/** Starts and ends in General settings, with both font overrides reset. */
export async function checkFontPreferences(page) {
  const ui = page.getByRole("textbox", { name: "Interface font", exact: true });
  const mono = page.getByRole("textbox", { name: "Monospace font", exact: true });
  const uiWeight = page.getByRole("slider", { name: "Interface font weight", exact: true });
  const monoWeight = page.getByRole("slider", { name: "Monospace font weight", exact: true });
  const weight = (selector) => page.locator(selector).first().evaluate((el) => getComputedStyle(el).fontWeight);
  const resetUi = page.getByRole("button", { name: "Reset interface font", exact: true });
  const resetMono = page.getByRole("button", { name: "Reset monospace font", exact: true });
  const font = (selector) => page.locator(selector).first().evaluate((el) => getComputedStyle(el).fontFamily);
  const openSettings = async () => {
    const sidebar = page.getByRole("button", { name: "Show sidebar", exact: true });
    if (await sidebar.isVisible()) await sidebar.click();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
  };
  assert.equal(await ui.inputValue(), "");
  assert.equal(await mono.inputValue(), "");
  assert.equal(await uiWeight.inputValue(), "400");
  assert.equal(await monoWeight.inputValue(), "400");
  assert.equal(await weight(".markdown-user-message"), "400", "Regular, not Light, is the default");
  assert.equal(await weight(".markdown-code-block code"), "400");
  await uiWeight.fill("500");
  await monoWeight.fill("600");
  for (const selector of ["body", ".chat-input-textarea", ".markdown-user-message", "#settings-font-ui"]) {
    assert.equal(await weight(selector), "500", selector);
  }
  for (const selector of [".markdown-code-block pre", ".markdown-code-block code", "#settings-font-mono"]) {
    assert.equal(await weight(selector), "600", selector);
  }
  assert.equal(await weight(".markdown-user-message strong"), "700", "Markdown emphasis keeps its weight");
  assert.equal(await weight(".markdown-body h2"), "600", "Headings keep their weight");
  await ui.pressSequentially("Times New Roman, serif");
  assert.equal(await ui.inputValue(), "Times New Roman, serif", "Typing spaces must not join font names");
  await mono.fill("monospace");
  for (const selector of ["body", ".chat-input-textarea", ".markdown-user-message", "#settings-font-ui"]) {
    assert.match(await font(selector), /^"?Times New Roman"?, serif,/, selector);
  }
  for (const selector of [".markdown-code-block code", "#settings-font-mono"]) {
    assert.match(await font(selector), /^monospace,/, selector);
  }
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator(".markdown-code-block code").waitFor();
  assert.match(await font("body"), /^"?Times New Roman"?, serif,/);
  assert.match(await font(".markdown-code-block code"), /^monospace,/);
  assert.equal(await weight(".markdown-user-message"), "500");
  assert.equal(await weight(".markdown-code-block code"), "600");
  await openSettings();
  assert.equal(await ui.inputValue(), "Times New Roman, serif");
  assert.equal(await mono.inputValue(), "monospace");
  assert.equal(await uiWeight.inputValue(), "500");
  assert.equal(await monoWeight.inputValue(), "600");

  const other = await page.context().newPage();
  try {
    await other.goto(page.url(), { waitUntil: "domcontentloaded" });
    await ui.fill("serif");
    await other.waitForFunction(() => getComputedStyle(document.body).fontFamily.startsWith("serif,"));
    await uiWeight.fill("300");
    await other.waitForFunction(() => getComputedStyle(document.body).fontWeight === "300");
    await resetUi.click();
    await other.waitForFunction(() => !document.documentElement.style.getPropertyValue("--font-ui") && getComputedStyle(document.body).fontWeight === "400");
  } finally {
    await other.close();
  }
  assert.equal(await mono.inputValue(), "monospace", "Resetting the UI font must preserve the code font");
  assert.equal(await uiWeight.inputValue(), "400");
  assert.equal(await monoWeight.inputValue(), "600");
  await ui.fill("serif");
  await uiWeight.fill("500");
  await resetMono.click();
  assert.equal(await ui.inputValue(), "serif", "Resetting the code font must preserve the UI font");
  assert.equal(await uiWeight.inputValue(), "500");
  assert.equal(await monoWeight.inputValue(), "400");
  await resetUi.click();
  await uiWeight.fill("600");
  assert.equal(await resetUi.isDisabled(), false, "Weight alone must enable Reset");
  await resetUi.click();

  // Changing font metrics must refit a draft without requiring another keystroke.
  await page.keyboard.press("Escape");
  const textarea = page.locator(".chat-input-textarea");
  await textarea.fill("iiii llll mmmm wwww sample text ".repeat(12));
  await openSettings();
  await ui.fill("serif");
  const serifHeight = await textarea.evaluate((el) => el.clientHeight);
  await ui.fill("monospace");
  // What must be true is what a reader sees: the box fits what the new family draws. Whether the
  // height itself moves is the machine's choice — how many lines this draft wraps into under the
  // generic `serif` and `monospace` depends on which fonts are installed here, and a CI image
  // where they come out equal has no height change to wait for (30s of waiting, and a bare
  // TimeoutError with nothing measured in it). The direction that must grow the draft is
  // asserted where the change is guaranteed to move metrics: the width and font-size sliders in
  // chat-appearance.mjs. Failing here still reports both families and both heights.
  const measuredFit = () => textarea.evaluate((el) => ({
    height: el.clientHeight, scroll: el.scrollHeight, family: getComputedStyle(el).fontFamily,
  }));
  const fit = await page.waitForFunction(() => {
    const input = document.querySelector(".chat-input-textarea");
    if (!input || (input.scrollHeight > input.clientHeight + 1 && input.clientHeight < 199)) return null;
    return { height: input.clientHeight, scroll: input.scrollHeight, family: getComputedStyle(input).fontFamily };
  }, null, { timeout: 10_000 }).then((handle) => handle.jsonValue(), measuredFit);
  assert.ok(fit.scroll <= fit.height + 1 || fit.height >= 199,
    `The draft must fit the family it is drawn in: ${serifHeight}px under serif, `
    + `${fit.height}px box with ${fit.scroll}px of content under ${fit.family}`);
  console.log(`  draft refit on family change: serif ${serifHeight}px -> monospace ${fit.height}px of ${fit.scroll}px`);
  await resetUi.click();

  assert.deepEqual(await page.evaluate(() => ({
    ui: localStorage.getItem("pi-ui-font-family"),
    mono: localStorage.getItem("pi-mono-font-family"),
    uiWeight: localStorage.getItem("pi-ui-font-weight"),
    monoWeight: localStorage.getItem("pi-mono-font-weight"),
    width: localStorage.getItem("pi-chat-content-width"),
    fontSize: localStorage.getItem("pi-chat-content-font-size"),
  })), { ui: null, mono: null, uiWeight: null, monoWeight: null, width: "820", fontSize: "14" });
  assert.equal(await resetUi.isDisabled(), true);
  assert.equal(await resetMono.isDisabled(), true);
  console.log("PASS: font families and weights, persistence, cross-tab sync, independent reset, emphasis and draft resizing");
}
