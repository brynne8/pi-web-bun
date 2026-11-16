import assert from "node:assert/strict";
import test from "node:test";
import { json, withAgentSession } from "./__fixtures__/agent-session-harness.mjs";

// A bare /mcp opens Settings › MCP when pi's built-in MCP extension owns it, or
// when the session has no /mcp at all (ADR 0006, lib/mcp-command.ts).

const builtinMcp = { name: "mcp", source: "extension", sourceInfo: { path: "builtin:mcp", source: "builtin", scope: "temporary", origin: "top-level" } };
const otherMcp = { name: "mcp", source: "extension", sourceInfo: { path: "/home/me/.pi/agent/extensions/mcp-adapter.ts", source: "local", scope: "user", origin: "top-level" } };
const deploy = { name: "deploy", source: "extension", sourceInfo: { path: "/project/.pi/extensions/deploy.ts", source: "local", scope: "project", origin: "top-level" } };

const commandsReply = (commands) => (entry) => (entry.body?.type === "get_commands" ? json({ success: true, data: { commands } }) : undefined);
const askedForCommands = (requests) => requests.filter((entry) => entry.body?.type === "get_commands");

/** A page with Settings › MCP reachable, and the sections it was opened on. */
function page(handle) {
  const opened = [];
  return { opened, options: { props: { onOpenSettings: (section) => opened.push(section) }, handle } };
}

test("a bare /mcp the built-in owns opens Settings › MCP with no notice and no request", async () => {
  const { opened, options } = page(commandsReply([deploy, builtinMcp]));
  await withAgentSession(options, async (env) => {
    await env.hook.result.loadSlashCommands();
    await env.settle();
    const before = askedForCommands(env.requests).length;
    assert.deepEqual(await env.hook.result.handleBuiltinSlashCommand("/mcp"), { handled: true, action: "openSettings" });
    assert.deepEqual(opened, ["mcp"]);
    // complete() says nothing for a command that opens a panel.
    assert.deepEqual(env.hook.result.notices, []);
    assert.equal(askedForCommands(env.requests).length, before, "a list already loaded is not asked for again");
    assert.deepEqual(env.requests.filter((entry) => entry.body?.type === "prompt"), []);
  });
});

test("another extension's /mcp is sent as before", async () => {
  const { opened, options } = page(commandsReply([deploy, otherMcp]));
  await withAgentSession(options, async (env) => {
    await env.hook.result.loadSlashCommands();
    await env.settle();
    assert.deepEqual(await env.hook.result.handleBuiltinSlashCommand("/mcp"), { handled: false });
    assert.deepEqual(opened, []);
    assert.deepEqual(env.hook.result.notices, []);
  });
});

test("with several extensions' mcp:1 / mcp:2, a bare /mcp opens Settings and /mcp:1 is sent", async () => {
  // pi runs neither for a bare /mcp (it looks commands up by exact name), so sending it would
  // hand the model the text "/mcp"; Settings › MCP says which extensions took the name.
  const commands = [{ ...otherMcp, name: "mcp:1" }, { ...otherMcp, name: "mcp:2" }];
  const bare = page(commandsReply(commands));
  await withAgentSession(bare.options, async (env) => {
    await env.hook.result.loadSlashCommands();
    await env.settle();
    assert.deepEqual(await env.hook.result.handleBuiltinSlashCommand("/mcp"), { handled: true, action: "openSettings" });
    assert.deepEqual(bare.opened, ["mcp"]);
  });
  const numbered = page(commandsReply(commands));
  await withAgentSession(numbered.options, async (env) => {
    await env.hook.result.loadSlashCommands();
    await env.settle();
    assert.deepEqual(await env.hook.result.handleBuiltinSlashCommand("/mcp:1"), { handled: false });
    assert.deepEqual(numbered.opened, []);
  });
});

test("every /mcp subcommand is sent, without asking whose /mcp it is", async () => {
  for (const message of ["/mcp login docs", "/mcp logout", "/mcp reconnect", "/mcp   login"]) {
    const { opened, options } = page(commandsReply([]));
    await withAgentSession(options, async (env) => {
      assert.deepEqual(await env.hook.result.handleBuiltinSlashCommand(message), { handled: false }, message);
      assert.deepEqual(opened, []);
      assert.deepEqual(askedForCommands(env.requests), []);
    });
  }
});

test("a command list still loading is awaited, not guessed", async () => {
  // The palette asks for the list as "/mcp" is typed; Enter often comes first.
  const load = Promise.withResolvers();
  const { opened, options } = page((entry) => (entry.body?.type === "get_commands" ? load.promise : undefined));
  await withAgentSession(options, async (env) => {
    const loading = env.hook.result.loadSlashCommands();
    await env.settle();
    let settled = false;
    const result = env.hook.result.handleBuiltinSlashCommand("/mcp").then((value) => { settled = true; return value; });
    await env.settle();
    assert.equal(settled, false);
    assert.deepEqual(opened, []);
    load.resolve(json({ success: true, data: { commands: [builtinMcp] } }));
    assert.deepEqual(await result, { handled: true, action: "openSettings" });
    assert.deepEqual(opened, ["mcp"]);
    assert.equal(askedForCommands(env.requests).length, 1, "the request under way is reused");
    await loading;
  });

  const other = Promise.withResolvers();
  const second = page((entry) => (entry.body?.type === "get_commands" ? other.promise : undefined));
  await withAgentSession(second.options, async (env) => {
    const sent = env.hook.result.handleBuiltinSlashCommand("/mcp");
    other.resolve(json({ success: true, data: { commands: [otherMcp] } }));
    assert.deepEqual(await sent, { handled: false });
  });

  // A request under way wins over an older list, which a reload may have outdated.
  const fresh = Promise.withResolvers();
  let loads = 0;
  const third = page((entry) => {
    if (entry.body?.type !== "get_commands") return undefined;
    loads += 1;
    return loads === 1 ? json({ success: true, data: { commands: [otherMcp] } }) : fresh.promise;
  });
  await withAgentSession(third.options, async (env) => {
    await env.hook.result.loadSlashCommands();
    await env.settle();
    const reloading = env.hook.result.loadSlashCommands();
    const opened3 = env.hook.result.handleBuiltinSlashCommand("/mcp");
    fresh.resolve(json({ success: true, data: { commands: [builtinMcp] } }));
    assert.deepEqual(await opened3, { handled: true, action: "openSettings" });
    await reloading;
  });
});

test("with no list yet, /mcp asks for one and keeps it", async () => {
  const { options } = page(commandsReply([builtinMcp]));
  await withAgentSession(options, async (env) => {
    assert.deepEqual(await env.hook.result.handleBuiltinSlashCommand("/mcp"), { handled: true, action: "openSettings" });
    await env.settle();
    assert.equal(askedForCommands(env.requests).length, 1);
    // The list the palette renders is the one the answer left.
    assert.deepEqual(env.hook.result.slashCommands, [builtinMcp]);
    assert.equal(env.hook.result.slashCommandsLoading, false);
  });

  // A Chat-only session (or MCP turned off) lists no /mcp at all.
  const chatOnly = page(commandsReply([]));
  await withAgentSession(chatOnly.options, async (env) => {
    assert.deepEqual(await env.hook.result.handleBuiltinSlashCommand("/mcp"), { handled: true, action: "openSettings" });
    assert.deepEqual(chatOnly.opened, ["mcp"]);
    assert.equal(askedForCommands(env.requests).length, 1);
  });
});

test("a list that cannot be read sends /mcp as before", async () => {
  const { opened, options } = page((entry) => (entry.body?.type === "get_commands" ? json({ error: "HTTP 500" }, 500) : undefined));
  await withAgentSession(options, async (env) => {
    assert.deepEqual(await env.hook.result.handleBuiltinSlashCommand("/mcp"), { handled: false });
    assert.deepEqual(opened, []);
    assert.deepEqual(env.hook.result.notices, []);
  });

  // A failed refresh falls back to the list already loaded.
  const refresh = Promise.withResolvers();
  let loads = 0;
  const known = page((entry) => {
    if (entry.body?.type !== "get_commands") return undefined;
    loads += 1;
    return loads === 1 ? json({ success: true, data: { commands: [builtinMcp] } }) : refresh.promise;
  });
  await withAgentSession(known.options, async (env) => {
    await env.hook.result.loadSlashCommands();
    await env.settle();
    const reloading = env.hook.result.loadSlashCommands();
    const result = env.hook.result.handleBuiltinSlashCommand("/mcp");
    refresh.resolve(null);
    assert.deepEqual(await result, { handled: true, action: "openSettings" });
    await reloading;
  });
});

test("a list cleared by set_tools is not written back by a request it outdated", async () => {
  // Another extension's /mcp, then a switch to Chat only while the palette's request runs.
  const answer = Promise.withResolvers();
  const { opened, options } = page((entry) => (entry.body?.type === "get_commands" ? answer.promise : undefined));
  await withAgentSession(options, async (env) => {
    const outdated = env.hook.result.loadSlashCommands();
    await env.settle();
    assert.equal(askedForCommands(env.requests).length, 1);
    await env.hook.result.handleToolPresetChange("read-only");
    await env.settle();
    answer.resolve(json({ success: true, data: { commands: [otherMcp] } }));
    assert.deepEqual(await outdated, [otherMcp]);
    await env.settle();
    assert.equal(env.hook.result.slashCommandsLoading, false, "nothing newer is loading, so the palette stops waiting");
    assert.deepEqual(env.hook.result.slashCommands, [], "the cleared list stays cleared");

    // The next bare /mcp asks the session as it is now: Chat only lists no /mcp.
    const asked = env.requests.length;
    assert.deepEqual(await env.hook.result.handleBuiltinSlashCommand("/mcp"), { handled: true, action: "openSettings" });
    assert.equal(env.requests.length - asked, 1);
    assert.deepEqual(opened, ["mcp"]);
  });
});

test("an older request answering after a newer one does not overwrite it", async () => {
  const answers = [Promise.withResolvers(), Promise.withResolvers()];
  let next = 0;
  const { options } = page((entry) => (entry.body?.type === "get_commands" ? answers[next++].promise : undefined));
  await withAgentSession(options, async (env) => {
    const older = env.hook.result.loadSlashCommands();
    const newer = env.hook.result.loadSlashCommands();
    await env.settle();
    answers[1].resolve(json({ success: true, data: { commands: [builtinMcp] } }));
    await newer;
    await env.settle();
    assert.deepEqual(env.hook.result.slashCommands, [builtinMcp]);
    answers[0].resolve(json({ success: true, data: { commands: [otherMcp] } }));
    await older;
    await env.settle();
    assert.deepEqual(env.hook.result.slashCommands, [builtinMcp]);
    assert.equal(env.hook.result.slashCommandsLoading, false, "the newer answer ended the wait");
  });
});

test("without a way to open Settings, /mcp is sent", async () => {
  await withAgentSession({ handle: commandsReply([builtinMcp]) }, async (env) => {
    await env.hook.result.loadSlashCommands();
    await env.settle();
    const before = askedForCommands(env.requests).length;
    assert.deepEqual(await env.hook.result.handleBuiltinSlashCommand("/mcp"), { handled: false });
    assert.equal(askedForCommands(env.requests).length, before);
  });
});
