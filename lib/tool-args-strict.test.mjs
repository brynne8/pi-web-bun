import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  declaredToolArgNames,
  serverOrigin,
  strictToolArgsBlockReason,
  toolSchemaUrl,
  unknownToolArgNames,
} = await jiti.import("./tool-args-strict.ts");

const object = (properties, extra = {}) => ({ type: "object", required: Object.keys(properties), properties, ...extra });

test("a plain object schema declares its own fields", () => {
  const declared = declaredToolArgNames(object({ prompt: { type: "string" }, wait: { type: "number" } }));
  assert.deepEqual([...declared], ["prompt", "wait"]);
});

test("a schema with no type but properties still declares its fields", () => {
  // MCP servers send a bare inputSchema, which pi fills in as an object.
  const declared = declaredToolArgNames({ properties: { note: { type: "string" } } });
  assert.deepEqual([...declared], ["note"]);
});

test("allOf branches are read as one set of fields", () => {
  const declared = declaredToolArgNames({
    type: "object",
    allOf: [object({ path: { type: "string" } }), object({ edits: { type: "array" } })],
  });
  assert.deepEqual([...declared].sort(), ["edits", "path"]);
});

test("a schema that leaves its fields open is not checked", () => {
  assert.equal(declaredToolArgNames(object({ note: { type: "string" } }, { additionalProperties: true })), undefined);
  assert.equal(declaredToolArgNames(object({ note: { type: "string" } }, { additionalProperties: { type: "string" } })), undefined);
  assert.equal(declaredToolArgNames({ type: "object", patternProperties: { "^.*$": { type: "string" } } }), undefined);
});

test("a schema that composes its fields is not checked", () => {
  assert.equal(declaredToolArgNames({ anyOf: [object({ a: { type: "string" } })] }), undefined);
  assert.equal(declaredToolArgNames({ oneOf: [object({ a: { type: "string" } })] }), undefined);
  assert.equal(declaredToolArgNames({ $ref: "#/$defs/task" }), undefined);
  assert.equal(declaredToolArgNames({
    type: "object",
    allOf: [object({ path: { type: "string" } }), { additionalProperties: true }],
  }), undefined);
});

test("a schema that declares no field is not checked", () => {
  // pi gives an MCP server's free-form input schema an empty `properties` too.
  assert.equal(declaredToolArgNames(object({})), undefined);
  assert.equal(declaredToolArgNames({ type: "object" }), undefined);
  assert.equal(declaredToolArgNames({ type: "object", properties: {} }), undefined);
});

test("a schema that is not an object schema is not checked", () => {
  assert.equal(declaredToolArgNames(undefined), undefined);
  assert.equal(declaredToolArgNames("prompt"), undefined);
  assert.equal(declaredToolArgNames([{ type: "string" }]), undefined);
  assert.equal(declaredToolArgNames({ type: "string" }), undefined);
});

test("only fields the schema does not name are unknown, in the order the call wrote them", () => {
  const declared = declaredToolArgNames(object({ prompt: { type: "string" }, model: { type: "string" } }));
  assert.deepEqual(unknownToolArgNames({ model: "m", prompt: "p" }, declared), []);
  assert.deepEqual(unknownToolArgNames({ prompt: "p", input_files: ["a"], bogus: 1 }, declared), ["input_files", "bogus"]);
  assert.deepEqual(unknownToolArgNames(undefined, declared), []);
});

test("the block reason names the tool, the unknown fields and where the schema is", () => {
  const reason = strictToolArgsBlockReason(
    "Agent",
    ["input_files", "bogus"],
    "http://127.0.0.1:30141/api/tool_schema/Agent?session=abc",
  );
  assert.match(reason, /^Tool "Agent" was called with fields its schema does not define: input_files, bogus\./);
  assert.match(reason, /Its schema: http:\/\/127\.0\.0\.1:30141\/api\/tool_schema\/Agent\?session=abc\./);
  assert.match(reason, /Fetch it, then re-issue the call with the fields it declares\.$/);
  // No field list: a model that has lost the definition guesses from one, and reads the schema instead.
  assert.equal(reason.includes("Its fields are"), false);
});

test("the schema URL names the route and the tool, with no session to carry", () => {
  assert.equal(new URL(toolSchemaUrl("Agent")).pathname, "/api/tool_schema/Agent");
  assert.equal(new URL(toolSchemaUrl("Agent")).search, "");
  assert.equal(new URL(toolSchemaUrl("mcp__app__read")).pathname, "/api/tool_schema/mcp__app__read");
});

test("the server address is read from the launcher's port flag, then the environment", () => {
  assert.equal(serverOrigin(["node", "vinext", "start", "-p", "4000"]), "http://127.0.0.1:4000");
  assert.equal(serverOrigin(["node", "vite", "dev", "--port", "30141"]), "http://127.0.0.1:30141");
  assert.equal(serverOrigin(["node", "vite", "dev", "--port=5000"], undefined), "http://127.0.0.1:5000");
  assert.equal(serverOrigin(["node", "server"], "8080"), "http://127.0.0.1:8080");
  assert.equal(serverOrigin(["node", "server"], undefined), "http://127.0.0.1:30141");
  assert.equal(serverOrigin(["node", "server", "--port", "nope"], undefined), "http://127.0.0.1:30141");
});
