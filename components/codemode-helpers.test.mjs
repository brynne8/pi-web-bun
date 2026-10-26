import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const {
  CODEMODE_MODE_DESCRIPTION_KEYS,
  CODEMODE_MODE_KEYS,
  CODEMODE_PREFERENCE_KEYS,
  CODEMODE_SETTINGS_TIMEOUT_MS,
  codemodeAlwaysUnavailableNotice,
  codemodeBuiltinNotice,
  codemodeInlineBudgetDraftChanges,
  codemodeInlineBudgetDraftOf,
  codemodeInlineBudgetNotices,
  codemodeModeChanges,
  codemodeModeNotices,
  codemodeProjectOverrideNotice,
  codemodeSettingsUrl,
  loadCodemodeInfo,
  parseCodemodeInlineBudgetDraft,
  saveCodemodeInlineBudget,
  saveCodemodeMode,
  saveCodemodePreference,
} = await jiti.import("./codemode-helpers.ts");
const { enLocale } = await jiti.import("@/lib/i18n/messages/en.ts");

const messages = enLocale.messages;

/** A `CodemodeInfo` as the route answers it, with the fields a test cares about overridden. */
function info(overrides = {}) {
  return { sandbox: { state: "available" }, builtinDisabled: false, preference: "always", ...overrides };
}

/** A `GET/PUT /api/tools/settings` answer: the whole read-back, of which the page keeps `codemode`. */
function settings(codemode, overrides = {}) {
  return { isWindows: false, powerShellEnabled: false, bgTasksEnabled: false, codemode, ...overrides };
}

function fakeFetch(responses) {
  const calls = [];
  const fetchImpl = async (input, init) => {
    calls.push({ input, init });
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return {
      ok: next.status >= 200 && next.status < 300,
      status: next.status,
      json: async () => {
        if (next.body === undefined) throw new SyntaxError("Unexpected end of JSON input");
        return next.body;
      },
    };
  };
  return { calls, fetchImpl };
}

const globalSettingsPath = "/Users/me/.pi/agent/settings.json";
const projectSettingsPath = "/Users/me/repo/.pi/settings.json";

test("the choice offers Automatic and Always on, each named and described", () => {
  for (const key of [
    ...Object.values(CODEMODE_PREFERENCE_KEYS),
    "settings.codemode.automaticDescription",
    "settings.codemode.alwaysDescription",
  ]) assert.equal(typeof messages[key], "string", key);
});

test("a trusted project's own defaultTools is named, whether or not it agrees with the global choice", () => {
  assert.equal(codemodeProjectOverrideNotice(info()), undefined);
  assert.deepEqual(codemodeProjectOverrideNotice(info({ projectOverride: { settingsPath: projectSettingsPath, preference: "always" } })), {
    key: "settings.codemode.projectOverride.always",
    params: { path: projectSettingsPath },
  });
  assert.deepEqual(codemodeProjectOverrideNotice(info({ projectOverride: { settingsPath: projectSettingsPath, preference: "automatic" } })), {
    key: "settings.codemode.projectOverride.automatic",
    params: { path: projectSettingsPath },
  });
  // Said even when it agrees with the global choice: changing that choice still changes nothing there.
  assert.ok(codemodeProjectOverrideNotice(info({
    preference: "always",
    projectOverride: { settingsPath: projectSettingsPath, preference: "always" },
  })));
  for (const key of ["settings.codemode.projectOverride.always", "settings.codemode.projectOverride.automatic"]) {
    assert.match(messages[key], /\{path\}/, key);
  }
});

test("Always on is unavailable while no session could offer Code mode, and says why", () => {
  assert.equal(codemodeAlwaysUnavailableNotice(info()), undefined);
  // Nobody has run the self-test yet: Always on stays available, and the Sandbox line says it is unchecked.
  assert.equal(codemodeAlwaysUnavailableNotice(info({ sandbox: { state: "not-checked" } })), undefined);
  // The sandbox first: nothing in Settings fixes it.
  assert.deepEqual(
    codemodeAlwaysUnavailableNotice(info({
      sandbox: { state: "unavailable", error: "x" },
      builtinDisabled: true,
      builtinSettingsPath: globalSettingsPath,
      globalBuiltinSettingsPath: globalSettingsPath,
    })),
    { key: "settings.codemode.alwaysUnavailable.sandbox" },
  );
  assert.deepEqual(
    codemodeAlwaysUnavailableNotice(info({ builtinDisabled: true, builtinSettingsPath: globalSettingsPath, globalBuiltinSettingsPath: globalSettingsPath })),
    { key: "settings.codemode.alwaysUnavailable.builtin", params: { path: globalSettingsPath } },
  );
  for (const key of ["sandbox", "builtin"]) {
    assert.equal(typeof messages[`settings.codemode.alwaysUnavailable.${key}`], "string", key);
  }
  assert.match(messages["settings.codemode.alwaysUnavailable.builtin"], /\{path\}/);
});

test("Always on is weighed against the global extensions alone, never the project Settings was opened from", () => {
  const projectPath = "/work/app/.pi/settings.json";
  // Only the trusted project turns Code mode off: its sessions lose it, Always on still works everywhere else.
  const projectOnly = info({ builtinDisabled: true, builtinSettingsPath: projectPath });
  assert.equal(codemodeAlwaysUnavailableNotice(projectOnly), undefined);
  assert.deepEqual(codemodeBuiltinNotice(projectOnly), { key: "settings.codemode.builtinDisabledProject", params: { path: projectPath } });
  // The global settings turn it off and the project turns it back on: Always on is still unavailable,
  // as it is from every other folder, and this project's sessions have nothing to report.
  const reEnabled = info({ globalBuiltinSettingsPath: globalSettingsPath });
  assert.deepEqual(codemodeAlwaysUnavailableNotice(reEnabled), { key: "settings.codemode.alwaysUnavailable.builtin", params: { path: globalSettingsPath } });
  assert.equal(codemodeBuiltinNotice(reEnabled), undefined);
  // Both off: the line names the file that decides for these sessions.
  assert.deepEqual(
    codemodeBuiltinNotice(info({ builtinDisabled: true, builtinSettingsPath: projectPath, globalBuiltinSettingsPath: globalSettingsPath })),
    { key: "settings.codemode.builtinDisabled", params: { path: projectPath } },
  );
  assert.deepEqual(
    codemodeBuiltinNotice(info({ builtinDisabled: true, builtinSettingsPath: globalSettingsPath, globalBuiltinSettingsPath: globalSettingsPath })),
    { key: "settings.codemode.builtinDisabled", params: { path: globalSettingsPath } },
  );
  assert.deepEqual(codemodeBuiltinNotice(info({ builtinDisabled: true })), { key: "settings.codemode.builtinDisabledUnknown" });
  assert.equal(codemodeBuiltinNotice(info()), undefined);
  for (const key of ["settings.codemode.builtinDisabled", "settings.codemode.builtinDisabledProject"]) {
    assert.match(messages[key], /\{path\}/, key);
  }
  assert.equal(typeof messages["settings.codemode.builtinDisabledUnknown"], "string");
});

test("the mode switch saves another mode, or either one over a value that is not a mode", () => {
  const mode = { settingsPath: globalSettingsPath, value: "on" };
  assert.equal(codemodeModeChanges(mode, "on"), false);
  assert.equal(codemodeModeChanges(mode, "only"), true);
  assert.equal(codemodeModeChanges({ ...mode, value: "only" }, "only"), false);
  assert.equal(codemodeModeChanges({ ...mode, invalid: '"never"' }, "on"), true);
  for (const key of [...Object.values(CODEMODE_MODE_KEYS), ...Object.values(CODEMODE_MODE_DESCRIPTION_KEYS)]) {
    assert.equal(typeof messages[key], "string", key);
  }
});

test("the mode's notes name a value that is not a mode, a project that decides for itself, and Automatic's wait", () => {
  const withMode = (mode, extra = {}) => info({ preference: "always", mode, ...extra });
  assert.deepEqual(codemodeModeNotices(withMode(undefined)), []);
  assert.deepEqual(codemodeModeNotices(withMode({ settingsPath: globalSettingsPath, value: "only" })), []);
  assert.deepEqual(codemodeModeNotices(withMode({
    settingsPath: globalSettingsPath,
    value: "on",
    invalid: '"never"',
    projectOverride: { settingsPath: projectSettingsPath, value: "only" },
  })), [
    { key: "settings.codemode.toolMode.invalid", params: { path: globalSettingsPath, value: '"never"' } },
    { key: "settings.codemode.toolMode.projectOverride.only", params: { path: projectSettingsPath } },
  ]);
  assert.deepEqual(codemodeModeNotices(withMode({
    settingsPath: globalSettingsPath,
    value: "only",
    projectOverride: { settingsPath: projectSettingsPath, value: "on" },
  })), [{ key: "settings.codemode.toolMode.projectOverride.on", params: { path: projectSettingsPath } }]);

  // "only" under Automatic waits for an MCP server to turn Code mode on; the effective values count.
  const only = { settingsPath: globalSettingsPath, value: "only" };
  assert.deepEqual(codemodeModeNotices(withMode(only, { preference: "automatic" })), [{ key: "settings.codemode.toolMode.automaticNote" }]);
  assert.deepEqual(codemodeModeNotices(withMode(only, { preference: "automatic", projectOverride: { settingsPath: projectSettingsPath, preference: "always" } })), []);
  assert.deepEqual(codemodeModeNotices(withMode(
    { settingsPath: globalSettingsPath, value: "on", projectOverride: { settingsPath: projectSettingsPath, value: "only" } },
    { projectOverride: { settingsPath: projectSettingsPath, preference: "automatic" } },
  )).map((notice) => notice.key), ["settings.codemode.toolMode.projectOverride.only", "settings.codemode.toolMode.automaticNote"]);
  for (const key of [
    "settings.codemode.toolMode.invalid",
    "settings.codemode.toolMode.projectOverride.on",
    "settings.codemode.toolMode.projectOverride.only",
    "settings.codemode.toolMode.automaticNote",
    "settings.codemode.toolMode.saveFailed",
  ]) assert.equal(typeof messages[key], "string", key);
});

const inlineBudget = { settingsPath: globalSettingsPath, default: 3000, max: 1_000_000 };

test("the budget field is empty for pi's default and saves a whole number within the limit, or empty", () => {
  assert.equal(codemodeInlineBudgetDraftOf(inlineBudget), "");
  assert.equal(codemodeInlineBudgetDraftOf({ ...inlineBudget, value: 0 }), "0");
  assert.deepEqual(parseCodemodeInlineBudgetDraft("", 1_000_000), { ok: true, value: null });
  assert.deepEqual(parseCodemodeInlineBudgetDraft("  ", 1_000_000), { ok: true, value: null });
  assert.deepEqual(parseCodemodeInlineBudgetDraft(" 1500 ", 1_000_000), { ok: true, value: 1500 });
  assert.deepEqual(parseCodemodeInlineBudgetDraft("0", 1_000_000), { ok: true, value: 0 });
  assert.deepEqual(parseCodemodeInlineBudgetDraft("1000000", 1_000_000), { ok: true, value: 1_000_000 });
  for (const draft of ["-1", "1.5", "1e3", "3,000", "abc", "1000001"]) {
    assert.deepEqual(parseCodemodeInlineBudgetDraft(draft, 1_000_000), { ok: false }, draft);
  }

  const changes = (budget, draft) => codemodeInlineBudgetDraftChanges(budget, parseCodemodeInlineBudgetDraft(draft, budget.max));
  assert.equal(changes(inlineBudget, ""), false);
  assert.equal(changes(inlineBudget, "3000"), true, "writing the default's value is a change: it no longer follows pi");
  assert.equal(changes({ ...inlineBudget, value: 1000 }, "1000"), false);
  assert.equal(changes({ ...inlineBudget, value: 1000 }, ""), true);
  assert.equal(changes({ ...inlineBudget, value: 1000 }, "x"), false);
  // Saving empty over a value pi ignores removes it.
  assert.equal(changes({ ...inlineBudget, invalid: '"lots"' }, ""), true);
});

test("the budget's warnings name a value pi ignores and a project that decides for itself", () => {
  assert.deepEqual(codemodeInlineBudgetNotices(inlineBudget), []);
  assert.deepEqual(codemodeInlineBudgetNotices({
    ...inlineBudget,
    invalid: '"lots"',
    projectOverride: { settingsPath: projectSettingsPath, value: 800 },
  }), [
    { key: "settings.codemode.inlineBudget.invalid", params: { path: inlineBudget.settingsPath, value: '"lots"', default: "3000" } },
    { key: "settings.codemode.inlineBudget.projectOverride", params: { path: projectSettingsPath, value: "800" } },
  ]);
  // A project value pi ignores, or a codemode that is not an object, leaves its sessions the default.
  for (const projectOverride of [{ settingsPath: projectSettingsPath }, { settingsPath: projectSettingsPath, invalid: "null" }]) {
    assert.deepEqual(codemodeInlineBudgetNotices({ ...inlineBudget, projectOverride }), [
      { key: "settings.codemode.inlineBudget.projectOverrideDefault", params: { path: projectSettingsPath, default: "3000" } },
    ]);
  }
  for (const key of [
    "settings.codemode.inlineBudget.invalid",
    "settings.codemode.inlineBudget.projectOverride",
    "settings.codemode.inlineBudget.projectOverrideDefault",
    "settings.codemode.inlineBudget.saveFailed",
  ]) assert.equal(typeof messages[key], "string", key);
});

test("the choice is saved through the tools settings route and answers with the settings it read back", async () => {
  assert.equal(CODEMODE_SETTINGS_TIMEOUT_MS, 15_000);
  const stored = info({ preference: "automatic" });
  const saved = fakeFetch([{ status: 200, body: settings(stored) }]);
  assert.deepEqual(await saveCodemodePreference("always", null, saved.fetchImpl), { ok: true, codemode: stored });
  assert.equal(saved.calls.length, 1);
  assert.equal(saved.calls[0].input, "/api/tools/settings");
  assert.equal(saved.calls[0].init.method, "PUT");
  assert.deepEqual(saved.calls[0].init.headers, { "Content-Type": "application/json" });
  assert.deepEqual(JSON.parse(saved.calls[0].init.body), { codemode: "always" });

  // With a project, the read-back carries its overrides: the URL names the folder, the change is still global.
  const withProject = fakeFetch([{ status: 200, body: settings(stored) }]);
  await saveCodemodePreference("always", "/a b/c&d", withProject.fetchImpl);
  assert.equal(withProject.calls[0].input, "/api/tools/settings?cwd=%2Fa%20b%2Fc%26d");
  assert.deepEqual(JSON.parse(withProject.calls[0].init.body), { codemode: "always" });

  // Refusals keep their reason; failures without one keep their diagnostic.
  const refused = fakeFetch([{ status: 403, body: { error: "Untrusted API request", reason: "request-denied" } }]);
  assert.deepEqual(await saveCodemodePreference("always", null, refused.fetchImpl), {
    ok: false,
    error: { error: "Untrusted API request", reason: "request-denied" },
  });
  const unparsable = fakeFetch([{ status: 500, body: { error: "Unexpected token n in JSON", reason: "internal" } }]);
  assert.deepEqual(await saveCodemodePreference("automatic", null, unparsable.fetchImpl), {
    ok: false,
    error: { error: "Unexpected token n in JSON", reason: "internal" },
  });
  const network = fakeFetch([new TypeError("Failed to fetch")]);
  assert.deepEqual(await saveCodemodePreference("always", null, network.fetchImpl), { ok: false, error: { error: "Failed to fetch" } });
  const html = fakeFetch([{ status: 502 }]);
  assert.deepEqual(await saveCodemodePreference("always", null, html.fetchImpl), { ok: false, error: { error: "HTTP 502" } });
  // A 200 without the page's Code mode settings is not taken for a save.
  const odd = fakeFetch([{ status: 200, body: { codemode: "always" } }]);
  assert.deepEqual(await saveCodemodePreference("always", null, odd.fetchImpl), { ok: false, error: { error: "HTTP 200" } });
});

test("the mode is saved through the tools settings route and answers with the whole read-back", async () => {
  const stored = info({ mode: { settingsPath: globalSettingsPath, value: "only" } });
  const saved = fakeFetch([{ status: 200, body: settings(stored) }]);
  assert.deepEqual(await saveCodemodeMode("only", null, saved.fetchImpl), { ok: true, codemode: stored });
  assert.equal(saved.calls[0].input, "/api/tools/settings");
  assert.equal(saved.calls[0].init.method, "PUT");
  assert.deepEqual(JSON.parse(saved.calls[0].init.body), { codemodeMode: "only" });

  const refused = fakeFetch([{ status: 500, body: { error: "Invalid settings.json: codemode must be an object", reason: "internal" } }]);
  assert.deepEqual(await saveCodemodeMode("only", null, refused.fetchImpl), {
    ok: false,
    error: { error: "Invalid settings.json: codemode must be an object", reason: "internal" },
  });
  const timedOut = await saveCodemodeMode("on", null, () => new Promise(() => {}), undefined, 30);
  assert.equal(timedOut.ok, false);
  assert.equal(timedOut.error.timedOut, true);
});

test("the budget is saved through the tools settings route, and null asks for pi's default again", async () => {
  const stored = info({ inlineBudget: { ...inlineBudget, value: 1000 } });
  const saved = fakeFetch([{ status: 200, body: settings(stored) }]);
  assert.deepEqual(await saveCodemodeInlineBudget(1000, null, saved.fetchImpl), { ok: true, codemode: stored });
  assert.equal(saved.calls[0].input, "/api/tools/settings");
  assert.equal(saved.calls[0].init.method, "PUT");
  assert.deepEqual(JSON.parse(saved.calls[0].init.body), { codemodeInlineBudget: 1000 });

  const reset = fakeFetch([{ status: 200, body: settings(info({ inlineBudget })) }]);
  const answered = await saveCodemodeInlineBudget(null, null, reset.fetchImpl);
  assert.deepEqual(answered.codemode.inlineBudget, inlineBudget);
  assert.deepEqual(JSON.parse(reset.calls[0].init.body), { codemodeInlineBudget: null });

  const refused = fakeFetch([{ status: 500, body: { error: "Invalid settings.json: codemode must be an object", reason: "internal" } }]);
  assert.deepEqual(await saveCodemodeInlineBudget(1000, null, refused.fetchImpl), {
    ok: false,
    error: { error: "Invalid settings.json: codemode must be an object", reason: "internal" },
  });
  const timedOut = await saveCodemodeInlineBudget(1000, null, () => new Promise(() => {}), undefined, 30);
  assert.equal(timedOut.ok, false);
  assert.equal(timedOut.error.timedOut, true);
});

test("a save that never answers ends at the deadline, and the caller's signal reaches it", async () => {
  const hung = [];
  const started = Date.now();
  const timedOut = await saveCodemodePreference("always", null, (input, init) => {
    hung.push(init.signal);
    return new Promise(() => {});
  }, undefined, 30);
  assert.ok(Date.now() - started < 2_000);
  assert.equal(timedOut.ok, false);
  assert.equal(timedOut.error.timedOut, true);
  assert.equal(hung[0].aborted, true);

  const caller = new AbortController();
  const seen = [];
  const pending = saveCodemodePreference("always", null, (input, init) => {
    seen.push(init.signal);
    return new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
  }, caller.signal);
  caller.abort();
  const aborted = await pending;
  assert.equal(seen[0].aborted, true);
  assert.equal(aborted.ok, false);
  assert.equal(aborted.error.timedOut, undefined);
  for (const key of ["settings.codemode.saveFailed", "settings.codemode.saveTimedOut"]) assert.equal(typeof messages[key], "string", key);
});

test("the settings are loaded for the page's project, or the global ones alone without one", async () => {
  const codemode = info({ mode: { settingsPath: globalSettingsPath, value: "on" } });
  assert.equal(codemodeSettingsUrl(null), "/api/tools/settings");
  assert.equal(codemodeSettingsUrl("/a b/c&d"), "/api/tools/settings?cwd=%2Fa%20b%2Fc%26d");

  const global = fakeFetch([{ status: 200, body: settings(codemode) }]);
  assert.deepEqual(await loadCodemodeInfo(null, global.fetchImpl), { ok: true, codemode });
  assert.deepEqual(global.calls.map((call) => call.input), ["/api/tools/settings"]);

  const project = fakeFetch([{ status: 200, body: settings(codemode) }]);
  assert.deepEqual(await loadCodemodeInfo("/repo", project.fetchImpl), { ok: true, codemode });
  assert.deepEqual(project.calls.map((call) => call.input), ["/api/tools/settings?cwd=%2Frepo"]);
});

test("a project folder the route refuses still leaves the global choice readable", async () => {
  for (const [status, reason] of [[403, "cwd-denied"], [400, "cwd-not-directory"], [400, "cwd-invalid"]]) {
    const codemode = info();
    const { calls, fetchImpl } = fakeFetch([
      { status, body: { error: "Access denied", reason } },
      { status: 200, body: settings(codemode) },
    ]);
    assert.deepEqual(await loadCodemodeInfo("/gone", fetchImpl), {
      ok: true,
      codemode,
      projectError: { error: "Access denied", reason },
    }, reason);
    assert.deepEqual(calls.map((call) => call.input), ["/api/tools/settings?cwd=%2Fgone", "/api/tools/settings"]);
  }
  // Without a project there is nothing to fall back from.
  const noProject = fakeFetch([{ status: 403, body: { error: "Access denied", reason: "cwd-denied" } }]);
  assert.deepEqual(await loadCodemodeInfo(null, noProject.fetchImpl), { ok: false, error: { error: "Access denied", reason: "cwd-denied" } });
  // When the global read fails too, that failure is what the page shows.
  const both = fakeFetch([
    { status: 403, body: { error: "Access denied", reason: "cwd-denied" } },
    { status: 500, body: { error: "boom", reason: "internal" } },
  ]);
  assert.deepEqual(await loadCodemodeInfo("/gone", both.fetchImpl), { ok: false, error: { error: "boom", reason: "internal" } });
  // A reason that is not about the folder is the answer, not something to work around.
  const other = fakeFetch([{ status: 409, body: { error: "off", reason: "mcp-off" } }]);
  assert.deepEqual(await loadCodemodeInfo("/repo", other.fetchImpl), { ok: false, error: { error: "off", reason: "mcp-off" } });
  assert.equal(other.calls.length, 1);
});

test("a load that never answers ends at the deadline, and the caller's signal reaches it", async () => {
  const hung = [];
  const timedOut = await loadCodemodeInfo("/repo", (input, init) => {
    hung.push(init.signal);
    return new Promise(() => {});
  }, undefined, 30);
  assert.equal(timedOut.ok, false);
  assert.equal(timedOut.error.timedOut, true);
  assert.match(timedOut.error.error, /GET \/api\/tools\/settings did not answer within 30 ms/);
  assert.equal(hung[0].aborted, true);

  const caller = new AbortController();
  const pending = loadCodemodeInfo(null, (input, init) => new Promise((_, reject) => {
    init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
  }), caller.signal);
  caller.abort();
  const aborted = await pending;
  assert.equal(aborted.ok, false);
  assert.equal(aborted.error.timedOut, undefined);
});
