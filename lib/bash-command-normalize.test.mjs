import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { DefaultResourceLoader } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const normalizeModule = await jiti.import("./bash-command-normalize.ts");
const {
  BASH_COMMAND_NORMALIZE_EXTENSION_NAME,
  createBashCommandNormalizeExtension,
  stripWorkingDirectoryCdInMessage,
} = normalizeModule;
const { createProjectCommandBashExtension, preferUserBashExtension } = await jiti.import(
  "./project-command-env.ts"
);

const CWD = "/repo/app";

const assistantWith = (...blocks) => ({ role: "assistant", content: blocks });
const call = (name, command, id = "call-1") => ({
  type: "toolCall",
  id,
  name,
  arguments: { command },
});
const commandOf = (message, index = 0) => message.content[index].arguments.command;

test("a cd to the working directory is taken off before the message is kept", () => {
  const message = assistantWith(call("bash", "cd /repo/app && make"));
  const replaced = stripWorkingDirectoryCdInMessage(message, CWD);
  assert.equal(commandOf(replaced), "make");
  assert.equal(replaced.role, "assistant");
});

test("every shell tool in the message is cleaned, and nothing else is touched", () => {
  const text = { type: "text", text: "building" };
  const elsewhere = call("bash", "cd /repo/other && make", "call-3");
  const notAShell = call("mcp__srv__run", "cd /repo/app && make", "call-4");
  const replaced = stripWorkingDirectoryCdInMessage(
    assistantWith(
      text,
      call("bash", "cd /repo/app && make", "call-1"),
      call("powershell", "cd /repo/app; npm test", "call-2"),
      elsewhere,
      notAShell,
    ),
    CWD,
  );
  assert.equal(commandOf(replaced, 1), "make");
  assert.equal(commandOf(replaced, 2), "npm test");
  assert.equal(replaced.content[0], text, "a block with nothing to take off keeps its own identity");
  assert.equal(replaced.content[3], elsewhere);
  assert.equal(replaced.content[4], notAShell);
});

test("a message with nothing to take off is returned as it stands", () => {
  assert.equal(stripWorkingDirectoryCdInMessage(assistantWith(call("bash", "make")), CWD), undefined);
  assert.equal(
    stripWorkingDirectoryCdInMessage({ role: "user", content: [{ type: "text", text: "cd /repo/app && make" }] }, CWD),
    undefined,
  );
});

test("the handler answers a message_end with the replacement it made", () => {
  let handler;
  createBashCommandNormalizeExtension({ cwd: CWD }).factory({
    on(type, registered) {
      if (type === "message_end") handler = registered;
    },
  });
  const result = handler({ message: assistantWith(call("bash", "cd /repo/app && make")) });
  assert.equal(commandOf(result.message), "make");
  assert.equal(handler({ message: assistantWith(call("bash", "make")) }), undefined);
});

test("a user extension's own bash tool does not take the rule with it", async () => {
  const userBash = {
    name: "user-bash",
    factory: (pi) => {
      pi.registerTool({
        name: "bash",
        label: "user bash",
        description: "user override",
        parameters: { type: "object", properties: {} },
        async execute() {
          return { content: [{ type: "text", text: "user override" }], details: undefined };
        },
      });
    },
  };
  const loader = new DefaultResourceLoader({
    cwd: process.cwd(),
    agentDir: join(process.cwd(), ".test-agent"),
    extensionFactories: [
      userBash,
      createProjectCommandBashExtension({
        cwd: process.cwd(),
        settings: { getShellCommandPrefix: () => undefined, getShellPath: () => undefined },
      }),
      createBashCommandNormalizeExtension({ cwd: CWD }),
    ],
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionsOverride: (base) => preferUserBashExtension(base),
  });
  await loader.reload();
  const extensions = loader.getExtensions();
  const paths = extensions.extensions.map((extension) => extension.path);
  assert.equal(paths.includes("<inline:user-bash>"), true);
  // Pi Web's own bash tool is the one the user extension replaces.
  assert.equal(paths.includes("<inline:pi-web-project-command-environment>"), false);
  const normalize = extensions.extensions.find(
    (extension) => extension.path === `<inline:${BASH_COMMAND_NORMALIZE_EXTENSION_NAME}>`,
  );
  assert.ok(normalize, "the strip stays registered whatever tool ends up owning bash");
  assert.deepEqual([...normalize.tools.keys()], []);
  assert.deepEqual(extensions.errors, []);
});
