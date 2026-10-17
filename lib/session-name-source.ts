import type { SessionManager } from "@earendil-works/pi-coding-agent";
import type { SessionEntry } from "./types";

export const SESSION_NAME_SOURCE_TYPE = "pi-web:session-name";

/** Who wrote a session name: a person, or pi-web's title generator. */
export type SessionNameSource = "user" | "auto";

export interface SessionNameSourceData {
  version: 1;
  /** The name this record describes, as the session's `session_info` entry stores it. */
  name: string;
  source: SessionNameSource;
}

export interface SessionNameRecord {
  /** The current name (the newest `session_info` entry), if the session has one. */
  name: string | undefined;
  /**
   * Where that name came from. "unknown" is any name nothing here recorded - one
   * set in the pi TUI, by an extension, or before this record existed.
   */
  source: SessionNameSource | "unknown";
}

function parseNameSource(data: unknown): SessionNameSourceData | undefined {
  if (typeof data !== "object" || data === null || Array.isArray(data)) return undefined;
  const candidate = data as { version?: unknown; name?: unknown; source?: unknown };
  if (candidate.version !== 1) return undefined;
  if (candidate.source !== "user" && candidate.source !== "auto") return undefined;
  if (typeof candidate.name !== "string") return undefined;
  return { version: 1, name: candidate.name, source: candidate.source };
}

/** The name as pi's `appendSessionInfo()` stores it: it collapses line breaks. */
function storedName(name: string): string {
  return name.replace(/[\r\n]+/g, " ").trim();
}

/**
 * The current name with its provenance, read off a session's entries. The newest
 * valid record is used, and only when it names the current name: a later name from
 * anywhere else (a pi TUI rename, an extension's title) has no provenance pi-web can
 * claim. So an unknown name is never attributed to auto-naming, which is the safe
 * direction - it is a name auto-naming must not replace.
 */
export function readSessionNameRecord(entries: readonly SessionEntry[]): SessionNameRecord {
  let name: string | undefined;
  let recorded: SessionNameSourceData | undefined;
  for (const entry of entries) {
    if (entry.type === "session_info") {
      // An empty name explicitly clears the session title, as the SDK reads it.
      name = entry.name?.trim() || undefined;
    } else if (entry.type === "custom" && entry.customType === SESSION_NAME_SOURCE_TYPE) {
      recorded = parseNameSource(entry.data);
    }
  }
  if (name === undefined || recorded?.name !== name) return { name, source: "unknown" };
  return { name, source: recorded.source };
}

/**
 * Whether automated naming must leave the current name alone. A name it wrote
 * itself is fair game; a name a person typed - through the sidebar, `/name`, the
 * pi TUI or an extension - is not.
 */
export function autoNameDeclines(record: SessionNameRecord): boolean {
  return record.name !== undefined && record.source !== "auto";
}

/** Record who set a name, beside the `session_info` entry that carries it. */
export function appendSessionNameSource(
  sessionManager: SessionManager,
  name: string,
  source: SessionNameSource,
): void {
  sessionManager.appendCustomEntry(SESSION_NAME_SOURCE_TYPE, {
    version: 1,
    name: storedName(name),
    source,
  } satisfies SessionNameSourceData);
}
