import type { InlineExtension } from "@earendil-works/pi-coding-agent";

// A tool call that names a field its schema does not have used to run anyway: pi's
// validator checks the fields a schema names and passes the rest through untouched,
// so the extra field does nothing and the model never learns it invented one. This
// extension blocks such a call and names the fields it cannot accept.

export const STRICT_TOOL_ARGS_EXTENSION_NAME = "pi-web-strict-tool-args";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Whether a schema leaves its fields open, so there is no fixed set to check against. */
function opensFields(schema: Record<string, unknown>): boolean {
  if (schema.additionalProperties === true) return true;
  if (isRecord(schema.additionalProperties)) return true;
  return isRecord(schema.patternProperties) && Object.keys(schema.patternProperties).length > 0;
}

function fieldNames(properties: unknown): string[] {
  return isRecord(properties) ? Object.keys(properties) : [];
}

/**
 * The top-level field names a tool's schema declares, or `undefined` when it does not
 * fix them: an open object, a keyed map, a union, a reference, or no fields at all. A
 * schema that names no field is not checked, because pi gives an MCP server's
 * free-form input schema an empty `properties` too, and such a tool may well take
 * anything. Only a fixed set is checked, since anything else would refuse fields the
 * schema does allow.
 */
export function declaredToolArgNames(parameters: unknown): Set<string> | undefined {
  if (!isRecord(parameters)) return undefined;
  const schema = parameters;
  if (schema.anyOf !== undefined || schema.oneOf !== undefined || schema.$ref !== undefined) return undefined;
  if (opensFields(schema)) return undefined;
  const branches = Array.isArray(schema.allOf) ? schema.allOf : [];
  for (const branch of branches) {
    if (!isRecord(branch) || opensFields(branch)) return undefined;
  }
  const names = new Set(fieldNames(schema.properties));
  for (const branch of branches) {
    for (const name of fieldNames((branch as Record<string, unknown>).properties)) names.add(name);
  }
  return names.size > 0 ? names : undefined;
}

/** The argument keys the declared fields do not cover, in the order the call wrote them. */
export function unknownToolArgNames(input: unknown, declared: ReadonlySet<string>): string[] {
  if (!isRecord(input)) return [];
  return Object.keys(input).filter((name) => !declared.has(name));
}

/**
 * The address this server answers on. `vinext start -p <port>` passes the port as an argument, not
 * in `process.env.PORT`, so the launcher's own flags are where it is read from.
 */
export function serverOrigin(argv: readonly string[] = process.argv, port = process.env.PORT): string {
  const index = argv.findIndex((arg) => arg === "-p" || arg === "--port" || arg.startsWith("--port="));
  const flag = argv[index];
  const value = flag?.startsWith("--port=") ? flag.slice("--port=".length) : argv[index + 1];
  const chosen = value && /^\d+$/.test(value) ? value : port?.trim();
  return `http://127.0.0.1:${chosen && /^\d+$/.test(chosen) ? chosen : "30141"}`;
}

/** The route that serves `toolName`'s definition, as the model is told to read it. */
export function toolSchemaUrl(toolName: string): string {
  return `${serverOrigin()}/api/tool_schema/${encodeURIComponent(toolName)}`;
}

export function strictToolArgsBlockReason(
  toolName: string,
  unknownNames: readonly string[],
  schemaUrl: string,
): string {
  return `Tool "${toolName}" was called with fields its schema does not define: ${unknownNames.join(", ")}. `
    + `Its schema: ${schemaUrl}. Fetch it, then re-issue the call with the fields it declares.`;
}

/**
 * Blocks every tool call — a model's own or one a codemode script made — whose
 * arguments name a field the tool's schema does not declare. Fields the schema does
 * declare are left to pi's validator, whatever their value.
 */
export function createStrictToolArgsExtension(): InlineExtension {
  return {
    name: STRICT_TOOL_ARGS_EXTENSION_NAME,
    hidden: true,
    factory: (pi) => {
      pi.on("tool_call", (event) => {
        const tool = pi.getAllTools().find((candidate) => candidate.name === event.toolName);
        if (!tool) return undefined;
        const declared = declaredToolArgNames(tool.parameters);
        if (!declared) return undefined;
        const unknownNames = unknownToolArgNames(event.input, declared);
        if (unknownNames.length === 0) return undefined;
        return { block: true, reason: strictToolArgsBlockReason(event.toolName, unknownNames, toolSchemaUrl(event.toolName)) };
      });
    },
  };
}
