import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { DefaultResourceLoader, createBashToolDefinition } from "@earendil-works/pi-coding-agent";

import { createProjectCommandBashOperations, createProjectCommandBashExtension, preferUserBashExtension } from "./project-command-env.ts";
import {
  SHELL_FRAME_COLLAPSE_EXTENSION_NAME,
  collapseShellResultFrames,
  createShellFrameCollapseExtension,
  createShellStreamCollapse,
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

test("pi web's own bash hands over the screen, frames left behind", async () => {
  // Pi builds the result, the live output and a `!` command's transcript entry out of the bytes
  // our operations hand up, so the collapse has to sit there: by the time a `tool_result` exists,
  // the frames are already in the text and in the truncation count.
  const tool = await registerPiWebBashTool();
  const own = await runFrameCommand((...args) => tool.execute(...args));
  assert.equal(own.content[0].text, FRAME_OUTPUT);
  assert.equal(registerToolResultHandler()(resultEvent("bash", own.content)), undefined);
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

// -------------------------------------------------------------------------------------------
// The stream collapse: what our operations hand upstream, which is where pi builds its result,
// its live output and a `!` command's transcript entry from.
// -------------------------------------------------------------------------------------------

function collector() {
  const parts = [];
  const sink = createShellStreamCollapse((data) => parts.push(data.toString("utf8")));
  return { sink, text: () => parts.join("") };
}

test("a row is handed over when it ends, with the frames behind it", () => {
  const { sink, text } = collector();
  // A frame rarely arrives whole: a read ends wherever the pipe happens to stop.
  sink.push(Buffer.from("\x1b[?25l\u25d2 install"));
  assert.equal(text(), "");
  sink.push(Buffer.from("ing\x1b[1G\x1b[J\u25c7 installed"));
  assert.equal(text(), "", "the row has not ended yet");
  sink.push(Buffer.from("\n"));
  assert.equal(text(), "\u25c7 installed\n");
});

test("output with nothing to collapse arrives as the bytes it came in", () => {
  const { sink, text } = collector();
  sink.push(Buffer.from("first\nsecond\n"));
  assert.equal(text(), "first\nsecond\n");
  sink.push(Buffer.from("third\n"));
  assert.equal(text(), "first\nsecond\nthird\n");
  // A redraw inside one row: the row's own last word, and the rows around it untouched.
  const { sink: repaint, text: repainted } = collector();
  repaint.push(Buffer.from("kept\rwinner\nkept again\n"));
  assert.equal(repainted(), "winner\nkept again\n");
});

test("a multi-byte character split across reads is not decoded in pieces", () => {
  const { sink, text } = collector();
  const bytes = Buffer.from("\u25c7 installed\n", "utf8");
  const middle = bytes.indexOf(0x69) - 1; // inside the 3 bytes of \u25c7
  sink.push(bytes.subarray(0, middle));
  sink.push(bytes.subarray(middle));
  assert.equal(text(), "\u25c7 installed\n");
});

test("the last row is handed over when the command ends, however it ends", () => {
  const { sink, text } = collector();
  sink.push(Buffer.from("writing with no line end at all\x1b[1G"));
  assert.equal(text(), "");
  sink.flush();
  assert.equal(text(), "writing with no line end at all");
  // A survivor that keeps writing after the caller finalized must stay out of the text, as it
  // did before the buffer existed.
  sink.push(Buffer.from("\ntoo late\n"));
  assert.equal(text(), "writing with no line end at all");
  sink.flush();
  assert.equal(text(), "writing with no line end at all");
});

test("a row that never ends is handed over rather than held forever", () => {
  const { sink, text } = collector();
  const huge = Buffer.from("x".repeat(4 * 1024 * 1024 + 8));
  sink.push(huge);
  assert.equal(text().length, huge.length, "an endless row is passed along instead of buffered");
  sink.flush();
  assert.equal(text().length, huge.length);
});

test("what a command leaves on screen is what our operations hand up", async () => {
  const operations = createProjectCommandBashOperations({});
  const parts = [];
  const result = await operations.exec(
    `'${RUNTIME}' -e '${FRAME_WRITER}'`,
    process.cwd(),
    { onData: (data) => parts.push(data.toString("utf8")) },
  );
  assert.equal(parts.join(""), "\u25c7 installed\n");
  assert.equal(result.exitCode, 0);

  const plain = [];
  const plainResult = await operations.exec(
    "printf 'first\\nsecond\\n'",
    process.cwd(),
    { onData: (data) => plain.push(data.toString("utf8")) },
  );
  assert.equal(plain.join(""), "first\nsecond\n");
  assert.equal(plainResult.exitCode, 0);
});
