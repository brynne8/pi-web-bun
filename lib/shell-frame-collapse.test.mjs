import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { DefaultResourceLoader, createBashToolDefinition } from "@earendil-works/pi-coding-agent";

import { createProjectCommandBashExtension, preferUserBashExtension } from "./project-command-env.ts";
import {
  SHELL_FRAME_COLLAPSE_EXTENSION_NAME,
  collapseShellResultFrames,
  createShellFrameCollapseExtension,
} from "./shell-frame-collapse.ts";

// This fork runs on Bun with no Node.js installed, so the child the suite spawns is the runtime
// the suite runs on: bun under `bun test`, node under `npm test`.
const RUNTIME = process.execPath;

// What an animated installer writes: one row, repainted. Every frame's bytes are tokens the
// model pays for and words it cannot use.
const FRAME_WRITER = 'process.stdout.write("\\x1b[?25l\\u25d2 installing\\x1b[1G\\x1b[J\\u25c7 installed\\x1b[?25h\\n")';
const FRAMES = "\x1b[?25l\u25d2 installing\x1b[1G\x1b[J\x1b[32m\u25c7 installed\x1b[0m\x1b[?25h\n";
const FRAME_OUTPUT = "\u25c7 installed\n";
// A colour survives as the bytes it came in: the pass answers where the text lands, not what it
// looks like.
const FRAME_OUTPUT_COLORED = "\x1b[32m\u25c7 installed\x1b[0m\n";

const toolContext = () => ({
  model: undefined,
  thinkingLevel: "off",
  sessionManager: { getSessionId: () => "session-frames", getSessionFile: () => undefined },
});

const resultEvent = (toolName, content, extra = {}) => ({
  type: "tool_result",
  toolCallId: "call-1",
  toolName,
  input: { command: "npx skills add x" },
  content,
  isError: false,
  ...extra,
});

function registerToolResultHandler() {
  let handler;
  createShellFrameCollapseExtension().factory({
    on(type, registered) {
      if (type === "tool_result") handler = registered;
    },
  });
  return handler;
}

async function runFrameCommand(execute) {
  const result = await execute(
    "frames-call",
    { command: `'${RUNTIME}' -e '${FRAME_WRITER}'` },
    undefined,
    undefined,
    toolContext(),
  );
  return result;
}

async function registerPiWebBashTool() {
  const extension = createProjectCommandBashExtension({
    cwd: process.cwd(),
    settings: { getShellCommandPrefix: () => undefined, getShellPath: () => undefined },
  });
  let registeredTool;
  await extension.factory({ registerTool(tool) { registeredTool = tool; } });
  return registeredTool;
}

test("a shell result reaches the model as the screen the command left", () => {
  const handler = registerToolResultHandler();
  const answered = handler(resultEvent("bash", [{ type: "text", text: FRAMES }]));
  assert.equal(answered.content[0].text, FRAME_OUTPUT_COLORED);
  // Only the content is answered: pi carries `details`, `isError` and `usage` off the event it
  // merges into, so the card keeps its full-output link and its exit status.
  assert.deepEqual(Object.keys(answered), ["content"]);
});

test("a result with nothing to collapse is not answered at all", () => {
  const handler = registerToolResultHandler();
  assert.equal(handler(resultEvent("bash", [{ type: "text", text: "\x1b[31mhi\x1b[0m\nplain\n" }])), undefined);
  assert.equal(handler(resultEvent("bash", [])), undefined);
});

test("only the shell tools are a screen", () => {
  const handler = registerToolResultHandler();
  for (const toolName of ["mcp__srv__run", "read", "grep", "subagent"]) {
    assert.equal(handler(resultEvent(toolName, [{ type: "text", text: FRAMES }])), undefined, toolName);
  }
  // `powershell` by name, so the rule needs no PowerShell installed to cover it.
  assert.equal(handler(resultEvent("powershell", [{ type: "text", text: FRAMES }])).content[0].text, FRAME_OUTPUT_COLORED);
});

test("an image block and a second text block survive the pass", () => {
  const handler = registerToolResultHandler();
  const image = { type: "image", data: "aGVsbG8=", mimeType: "image/png" };
  const answered = handler(resultEvent("bash", [image, { type: "text", text: FRAMES }, { type: "text", text: "tail\n" }]));
  assert.equal(answered.content[0], image);
  assert.equal(answered.content[1].text, FRAME_OUTPUT_COLORED);
  assert.equal(answered.content[2].text, "tail\n");
});

test("structured content is kept when the content is replaced", () => {
  const handler = registerToolResultHandler();
  const structured = { exitCode: 0 };
  const answered = handler(resultEvent("bash", [{ type: "text", text: FRAMES }], { structuredContent: structured }));
  assert.equal(answered.structuredContent, structured);
});

test("the handler is idempotent, so two passes over one result change nothing", () => {
  const once = collapseShellResultFrames(resultEvent("bash", [{ type: "text", text: FRAMES }]));
  assert.ok(once);
  assert.equal(collapseShellResultFrames(resultEvent("bash", once.content)), undefined);
});

test("pi web's bash result is collapsed by the extension, not by the tool", async () => {
  const tool = await registerPiWebBashTool();
  const raw = await runFrameCommand((...args) => tool.execute(...args));
  assert.ok(raw.content[0].text.includes("\u25d2 installing"), "the tool itself leaves the frames alone");

  const answered = registerToolResultHandler()(resultEvent("bash", raw.content, { details: raw.details }));
  assert.equal(answered.content[0].text, FRAME_OUTPUT);
});

test("a child session's own bash result collapses too", async () => {
  // A subagent runs pi's built-in `bash`, which knows nothing about this rule; the extension is
  // what covers it, which is why the rule does not live inside Pi Web's tool.
  const builtIn = createBashToolDefinition(process.cwd());
  const raw = await runFrameCommand((...args) => builtIn.execute(...args));
  assert.ok(raw.content[0].text.includes("\u25d2 installing"), "pi's own tool returns the frames as the command wrote them");

  const answered = registerToolResultHandler()(resultEvent("bash", raw.content, { details: raw.details }));
  assert.equal(answered.content[0].text, FRAME_OUTPUT);
});

test("the collapse stays registered whatever tool ends up owning bash", async () => {
  const userBash = {
    name: "user-bash",
    hidden: true,
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
      createShellFrameCollapseExtension(),
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
  assert.equal(paths.includes("<inline:pi-web-project-command-environment>"), false, "the user's bash replaced Pi Web's");
  const collapse = extensions.extensions.find(
    (extension) => extension.path === `<inline:${SHELL_FRAME_COLLAPSE_EXTENSION_NAME}>`,
  );
  assert.ok(collapse, "the collapse survives the replacement");
  assert.deepEqual([...collapse.tools.keys()], []);
  assert.deepEqual(extensions.errors, []);
});
