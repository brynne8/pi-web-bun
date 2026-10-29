import { Type } from "@earendil-works/pi-ai";
import {
  defineTool,
  type ExtensionContext,
  type InlineExtension,
  type LoadExtensionsResult,
  type ToolExposure,
} from "@earendil-works/pi-coding-agent";
import {
  SUBAGENT_NOTIFICATION_CUSTOM_TYPE,
  SUBAGENT_NOTIFICATION_PREFIX,
} from "./subagent-notification";
import {
  SUBAGENT_CONTROL_TOOL_NAMES,
  type SubagentListEntry,
  type SubagentProfile,
  type SubagentRunInfo,
} from "./subagents";
import { worktreeHasUncommittedFiles } from "./worktree";
import { shortSessionId } from "./session-short-id";

// The guard and its screen-side strip live in the client-safe module, so the chat view can take
// it off without importing the extension that writes it. Re-exported here because this is where
// the report is built.
export { SUBAGENT_NOTIFICATION_PREFIX, SUBAGENT_NOTIFICATION_CUSTOM_TYPE };

export const HOST_SUBAGENT_EXTENSION_NAME = "pi-web-subagents";
const HOST_SUBAGENT_EXTENSION_PATH = `<inline:${HOST_SUBAGENT_EXTENSION_NAME}>`;
const SUBAGENT_TOOL_NAMES = new Set<string>(SUBAGENT_CONTROL_TOOL_NAMES);
const LEGACY_SUBAGENT_PACKAGE_NAME = "pi-subagents";
const TERMINAL_SUBAGENT_STATUSES = new Set<SubagentRunInfo["status"]>(["completed", "failed", "aborted", "interrupted"]);
/** How long an abort waits for the run to write its terminal status before answering. */
const ABORT_SETTLE_WAIT_MS = 2_000;
const ABORT_SETTLE_POLL_MS = 50;

export const SUBAGENT_WAIT_TIMEOUT_MS = 30 * 60_000;
// Node timers overflow above a signed 32-bit millisecond delay.
const MAX_SUBAGENT_WAIT_SECONDS = Math.floor(2_147_483_647 / 1000);
const waitTimeoutParameter = () => Type.Optional(Type.Integer({
  minimum: 1,
  maximum: MAX_SUBAGENT_WAIT_SECONDS,
  description: "Seconds to wait for completion. Default: 1800 (30 minutes). Use a longer budget for long tasks. Applies only to a foreground Agent or get_subagent_result with wait: true; expiry returns status without cancelling the child.",
}));

function waitTimeoutMs(seconds?: number): number {
  if (seconds === undefined) return SUBAGENT_WAIT_TIMEOUT_MS;
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > MAX_SUBAGENT_WAIT_SECONDS) {
    throw new Error(`wait_timeout must be an integer between 1 and ${MAX_SUBAGENT_WAIT_SECONDS} seconds`);
  }
  return seconds * 1000;
}

function pollDelay(signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(new Error("Result wait aborted"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, 500);
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** Bound the caller's wait, not the child run. Abort only the local polling on exit. */
async function waitForSubagent<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<T | undefined> {
  if (signal?.aborted) throw new Error("Result wait aborted");
  const polling = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([
      new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(new Error("Result wait aborted"));
        signal?.addEventListener("abort", onAbort, { once: true });
      }),
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), timeoutMs);
      }),
      operation(polling.signal),
    ]);
  } finally {
    clearTimeout(timer);
    if (onAbort) signal?.removeEventListener("abort", onAbort);
    polling.abort();
  }
}

function waitTimeoutText(run: SubagentRunInfo | undefined, sessionId: string, timeoutMs: number): string {
  const status = run ? subagentFinalText(run) : `Subagent ${sessionId}: status lookup is still pending.`;
  return `Wait budget exhausted (${timeoutMs / 1000} seconds). ${status} Only the wait ended; the subagent was not cancelled. Do not immediately repeat the same wait; continue independent work or return control to the user. Use a longer wait_timeout when planning a long task.`;
}
/**
 * The control tools are declared to the model and activated on registration like `direct` tools,
 * but pi never lets another tool call a `model-only` tool through `ctx.executeTool()`, so a
 * codemode script cannot start, collect, steer, or stop a subagent. A run started from a script
 * would record the nested call id (`<codemode call>/<n>`) as its `parentToolCallId`, which no
 * transcript entry carries, so the chat would lose the link to the child session.
 */
const SUBAGENT_TOOL_EXPOSURE = "model-only" satisfies ToolExposure;
const AGENT_TOOL_NAME = SUBAGENT_CONTROL_TOOL_NAMES[0];
const SUBAGENT_ACTIVE_STATUSES = new Set<SubagentListEntry["status"]>(["starting", "queued", "running"]);
/** Exits that leave work behind: the default view keeps only the recent ones. */
const SUBAGENT_ABNORMAL_STATUSES = new Set<SubagentListEntry["status"]>(["failed", "aborted", "interrupted"]);
const SUBAGENT_UNFINISHED_STATUSES = new Set<SubagentListEntry["status"]>([
  ...SUBAGENT_ACTIVE_STATUSES,
  ...SUBAGENT_ABNORMAL_STATUSES,
]);
/** How long a failed, stopped or interrupted run stays in the default process list. */
const SUBAGENT_RECENT_EXIT_MS = 60 * 60 * 1000;
const SUBAGENT_LIST_DESCRIPTION_MAX = 120;
/**
 * The delegation policy's opening rule, in a `<delegation>` block of its own appended to the
 * text of the run's system prompt — not the tool's `promptGuidelines`, which pi flattens into
 * its one `<rules>` list, and not a `sections` entry, which any extension's forced prompt
 * (`pi-l`'s) drops entirely. The block tags itself: pi wraps nothing around forced text. The
 * System panel reports a forced prompt (sessions.md); the rest is in subagents.md.
 */
const DELEGATION_INTRO = `\`${AGENT_TOOL_NAME}\` runs a whole task in a fresh session and returns only the result, so this conversation stays small. Delegate as soon as the goal is clear; a goal and known paths are enough.`;

const DELEGATION_RULES = [
  "Split independent implementation across subagents; scopes may overlap, and an isolated run can use a worktree.",
  "Do not duplicate work already delegated.",
];

/** The policy block, with the enabled subagents the model can choose from (`[]` lists none). */
export function subagentDelegationBlock(profiles: readonly SubagentProfile[]): string {
  const available = profiles.filter((profile) => profile.enabled);
  const named = new Set(available.map((profile) => profile.name));
  const rules = [DELEGATION_INTRO];
  if (named.has("explore")) {
    rules.push("Use `explore` when you need to map an unfamiliar codebase, or when a change ripples through code you have not mapped and must be handled carefully. It only reads. Never use it for a file, symbol or call site you already know; read those yourself.");
  }
  if (named.has("plan")) {
    rules.push("Use `plan` for a large, complex task whose steps need thought before work starts. Never use it for a change a few steps already describe, however many files it touches. Never set `run_in_background` for it, and never run it alongside the work it plans.");
  }
  rules.push(...DELEGATION_RULES);
  const others = available.filter((profile) => profile.name !== "explore" && profile.name !== "plan");
  if (others.length > 0) {
    rules.push(`Other subagents: ${others.map((profile) => `\`${profile.name}\``).join(", ")}.`);
  }
  return ["<delegation>", ...rules.map((rule) => `- ${rule}`), "</delegation>"].join("\n");
}

export const SUBAGENT_DELEGATION_BLOCK = subagentDelegationBlock([]);

/**
 * The run's prompt with the delegation block appended. Reads `event.systemPrompt`, which renders
 * as the options stand when it is read, so text an earlier extension forced (`pi-l`) is carried
 * along, and a plugin forcing after us appends to the same text, so the block survives either
 * order; only an extension composing from `systemPromptOptions` rather than reading
 * `event.systemPrompt` drops it.
 */
export function withSubagentDelegationPrompt(prompt: string, profiles: readonly SubagentProfile[] = []): string {
  return `${prompt}\n\n${subagentDelegationBlock(profiles)}`;
}

export interface SubagentToolDetails {
  kind: "pi-web-subagent";
  sessionId: string;
  profile: string;
  description: string;
  status: SubagentRunInfo["status"];
  /** Set on a delivered *notification* only: how the pending index recognizes it as read. */
  notificationId?: string;
  runInBackground: boolean;
  createdAt: string;
  completedAt?: string;
  error?: string;
  worktreePath?: string;
  worktreeBranch?: string;
  worktreeCleanupError?: string;
}

export interface StartSubagentRequest {
  parentContext: ExtensionContext;
  parentToolCallId: string;
  profile: string;
  task: string;
  description: string;
  runInBackground?: boolean;
  model?: string;
  isolation?: "worktree";
  signal?: AbortSignal;
  onUpdate?: (run: SubagentRunInfo) => void;
}

export interface ResumeSubagentRequest {
  parentContext: ExtensionContext;
  parentToolCallId: string;
  sessionId: string;
  task: string;
  description: string;
  runInBackground?: boolean;
  signal?: AbortSignal;
  onUpdate?: (run: SubagentRunInfo) => void;
}

export interface SubagentExecution {
  run: SubagentRunInfo;
  completion: Promise<SubagentRunInfo>;
}

export interface SubagentExtensionRuntime {
  start(request: StartSubagentRequest): Promise<SubagentExecution>;
  resume(request: ResumeSubagentRequest): Promise<SubagentExecution>;
  get(sessionId: string): Promise<SubagentRunInfo | null>;
  /**
   * The full id for the 8-character form a report shows; anything else is returned as given, and an
   * ambiguous short id throws. Optional so a fake runtime in a test still runs.
   */
  resolveSessionId?(sessionId: string): Promise<string>;
  /** Every subagent this parent delegated, from the session index and the live run map. */
  list(parentSessionId: string): Promise<SubagentListEntry[]>;
  steer(sessionId: string, message: string): Promise<void>;
  /**
   * End a run the parent no longer wants: it takes the queued run out of the queue, ends the wait
   * for a run still connecting its MCP servers, and aborts a running one. Throws when the session
   * is neither queued nor running.
   */
  abort(sessionId: string): Promise<void>;
  notifyParent(run: SubagentRunInfo): Promise<void>;
  markResultConsumed(run: SubagentRunInfo): void;
  /**
   * Mark a `get_subagent_result` for `sessionId` as in flight and return the fn that ends it.
   * Optional so a fake runtime without it still runs; nothing is suppressed for it then.
   */
  beginResultCollection?(sessionId: string): () => void;
}

export type SubagentProfileProvider = () => readonly SubagentProfile[];
export type SubagentEnabledProvider = () => boolean;

function agentTypeDescription(profiles: readonly SubagentProfile[]): string {
  const available = profiles.filter((profile) => profile.enabled);
  if (available.length === 0) return "No subagent profiles are currently enabled.";
  return available.map((profile) => {
    const details = [`Tools: ${profile.tools.length > 0 ? profile.tools.join(", ") : "none"}`];
    if (profile.model) details.push(`Model: ${profile.model}`);
    if (profile.thinking) details.push(`Thinking: ${profile.thinking}`);
    return `- ${profile.name}: ${profile.description} (${details.join("; ")})`;
  }).join("\n");
}

export function subagentToolDetails(run: SubagentRunInfo): SubagentToolDetails {
  return {
    kind: "pi-web-subagent",
    sessionId: run.sessionId,
    profile: run.profile,
    description: run.description,
    status: run.status,
    runInBackground: run.runInBackground,
    createdAt: run.createdAt,
    ...(run.completedAt ? { completedAt: run.completedAt } : {}),
    ...(run.error ? { error: run.error } : {}),
    ...(run.worktreePath ? { worktreePath: run.worktreePath } : {}),
    ...(run.worktreeBranch ? { worktreeBranch: run.worktreeBranch } : {}),
    ...(run.worktreeCleanupError ? { worktreeCleanupError: run.worktreeCleanupError } : {}),
  };
}

/**
 * Where an isolated run's worktree is, as its result was recorded: the model reads only `content`,
 * never `details` (#1202). Git keeps the branch, with any commits, when it removes the checkout,
 * and refuses to remove one that still has changes. Only this run's own refusal gives a reason, and
 * never in git's words, which end in "use --force to delete it". A result recorded without
 * `worktreeExists` (before #1202) says nothing.
 */
function worktreeOutcomeText(run: SubagentRunInfo): string | undefined {
  if (!run.worktreePath || !run.worktreeBranch || run.worktreeExists === undefined) return undefined;
  if (!run.worktreeExists) return `Its worktree was removed; branch ${run.worktreeBranch} keeps any commits it made.`;
  return run.worktreeCleanupError && worktreeHasUncommittedFiles(run.worktreeCleanupError)
    ? `Its worktree was kept at ${run.worktreePath} (branch ${run.worktreeBranch}) because it still has uncommitted or untracked files.`
    : `Its worktree is still at ${run.worktreePath} (branch ${run.worktreeBranch}).`;
}

export function subagentFinalText(run: SubagentRunInfo): string {
  // The report names the run by the 8 characters that tell it apart from every other session; the
  // model only sees `content`, never `details`, so this is the id it copies into `resume` and
  // `get_subagent_result`. A full UUIDv7 shares its head with every session started around it.
  const id = shortSessionId(run.sessionId);
  if (run.status === "queued" || run.status === "starting" || run.status === "running") {
    return `Subagent ${id} is ${run.status}.`;
  }
  // The worktree line follows the status, before the subagent's own words.
  const worktree = worktreeOutcomeText(run);
  const withWorktree = (status: string) => worktree ? `${status}\n\n${worktree}` : status;
  if (run.status === "completed") {
    const result = run.result?.trim();
    return result
      ? `${withWorktree(`Subagent ${id} completed.`)}\n\n${result}`
      : withWorktree(`Subagent ${id} completed without text output.`);
  }
  if (run.status === "aborted") return withWorktree(`Subagent ${id} was stopped.`);
  if (run.status === "interrupted") return `Subagent ${id} was interrupted before completion.`;
  const failure = withWorktree(`Subagent ${id} failed: ${run.error ?? "Unknown error"}`);
  const partial = run.result?.trim();
  return partial ? `${failure}\n\nPartial output:\n\n${partial}` : failure;
}

function subagentListField(value: string, max = SUBAGENT_LIST_DESCRIPTION_MAX): string {
  const flat = value.replace(/[\t\r\n]+/g, " ").replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  const last = flat.charCodeAt(max - 1);
  const cut = last >= 0xd800 && last <= 0xdbff ? max - 1 : max;
  return `${flat.slice(0, cut)}…`;
}

/**
 * `list_subagent_runs` answers in TSV: a fixed header plus one compact row per subagent, never the
 * task or result. The default view is a process list: live runs plus exits recent enough to still
 * matter. Completed runs and older exits are counted in one note instead of filling the answer.
 */
export function formatSubagentList(
  entries: readonly SubagentListEntry[],
  options: { status?: string; now?: number } = {},
): string {
  const filter = options.status === "active"
    || options.status === "unfinished"
    || options.status === "completed"
    || options.status === "all"
    ? options.status
    : "recent";
  const now = options.now ?? Date.now();
  const isRecentExit = (entry: SubagentListEntry) => {
    const endedAt = Date.parse(entry.updatedAt);
    return Number.isFinite(endedAt) && now - endedAt <= SUBAGENT_RECENT_EXIT_MS;
  };
  const filtered = entries.filter((entry) => {
    if (filter === "all") return true;
    if (filter === "active") return SUBAGENT_ACTIVE_STATUSES.has(entry.status);
    if (filter === "completed") return entry.status === "completed";
    if (filter === "unfinished") return SUBAGENT_UNFINISHED_STATUSES.has(entry.status);
    return SUBAGENT_ACTIVE_STATUSES.has(entry.status)
      || (SUBAGENT_ABNORMAL_STATUSES.has(entry.status) && isRecentExit(entry));
  });
  if (entries.length === 0) return "No subagents delegated by this session.";

  const olderExits = filter === "recent"
    ? entries.filter((entry) => SUBAGENT_ABNORMAL_STATUSES.has(entry.status) && !isRecentExit(entry)).length
    : 0;
  const completedHidden = filter === "recent"
    ? entries.filter((entry) => entry.status === "completed").length
    : 0;
  const hiddenNote = () => {
    const what = [
      ...(olderExits > 0 ? [`${olderExits} older exit${olderExits === 1 ? "" : "s"}`] : []),
      ...(completedHidden > 0 ? [`${completedHidden} completed run${completedHidden === 1 ? "" : "s"}`] : []),
    ];
    const ways = olderExits > 0 && completedHidden > 0
      ? '"all"'
      : olderExits > 0 ? '"unfinished" or "all"' : '"completed" or "all"';
    return `note: ${what.join(" and ")} not shown; set status to ${ways} to include them.`;
  };

  if (filtered.length === 0) {
    if (filter === "active") return "No subagents are running or queued.";
    if (filter === "completed") return "No completed subagents.";
    if (filter === "all") return "No subagents delegated by this session.";
    const empty = filter === "recent"
      ? "No subagents are active or recently exited."
      : "No active or unresolved subagents.";
    return olderExits + completedHidden > 0 ? `${empty}\n${hiddenNote()}` : empty;
  }

  const sorted = [...filtered].sort((a, b) => {
    const rank = Number(!SUBAGENT_ACTIVE_STATUSES.has(a.status)) - Number(!SUBAGENT_ACTIVE_STATUSES.has(b.status));
    return rank || b.updatedAt.localeCompare(a.updatedAt);
  });
  const lines = ["agent_id\tprofile\tstatus\tlast_activity\tdescription"];
  for (const entry of sorted) {
    lines.push([
      subagentListField(shortSessionId(entry.sessionId), 64),
      subagentListField(entry.profile, 40),
      entry.status,
      subagentListField(entry.updatedAt, 40),
      subagentListField(entry.description),
    ].join("\t"));
  }
  if (olderExits + completedHidden > 0) lines.push(hiddenNote());
  return lines.join("\n");
}

/**
 * Background completions reach the parent session as a `custom` message, and pi's `convertToLlm`
 * maps every custom message onto the `user` role with its content verbatim. Without an explicit
 * marker a compaction pass reads the subagent's report as user intent and writes it into the
 * summary's Goal / Constraints sections (#875). Prefixing in code rather than through the
 * subagent's prompt keeps the marker from being dropped by the model.
 */
export function subagentNotificationText(run: SubagentRunInfo): string {
  const text = subagentFinalText(run);
  if (!run.resumed) return `${SUBAGENT_NOTIFICATION_PREFIX}${text}`;
  // `resume` reuses the session ID, so without this line a resumed run's report reads exactly like
  // the earlier run's, and the parent cannot tell a new result from a repeat of one it handled (#985).
  return `${SUBAGENT_NOTIFICATION_PREFIX}This report is from a resumed run of subagent ${shortSessionId(run.sessionId)}; it supersedes any earlier report from the same subagent.\n\n${text}`;
}

/**
 * The run as an abort leaves it, or `null` when it is still unwinding after the wait (or gone).
 * The stop call needs the terminal run: it is what marks the run's completion as already held, so
 * a subagent the parent killed does not also report back that it was stopped.
 */
async function waitForSettledRun(
  runtime: SubagentExtensionRuntime,
  sessionId: string,
): Promise<SubagentRunInfo | null> {
  const deadline = Date.now() + ABORT_SETTLE_WAIT_MS;
  for (;;) {
    const run = await runtime.get(sessionId);
    if (!run || TERMINAL_SUBAGENT_STATUSES.has(run.status)) return run;
    if (Date.now() >= deadline) return null;
    await new Promise<void>((resolve) => setTimeout(resolve, ABORT_SETTLE_POLL_MS));
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The full id behind an `agent_id` the model passed: the 8-character form its report showed, or the
 * full id. Resolution lives in the runtime so its run map and the session files stay keyed as before.
 */
async function resolveAgentId(runtime: SubagentExtensionRuntime, input: string): Promise<string> {
  return runtime.resolveSessionId ? await runtime.resolveSessionId(input) : input;
}

/** The way back to a run's transcript, named in every answer that leaves one behind. */
function subagentTranscriptBackText(sessionId: string): string {
  return `What it got to stays in its session: read it with get_subagent_result("${shortSessionId(sessionId)}"), or continue it with Agent's \`resume\`.`;
}

/** The answer for a run that had nothing left to stop. */
function subagentNothingToStopText(run: SubagentRunInfo): string {
  return `Subagent ${shortSessionId(run.sessionId)} already ${run.status}; nothing to stop. ${subagentTranscriptBackText(run.sessionId)}`;
}

/** What a stop answers with, naming the way back to the transcript it left behind. */
function subagentStopText(run: SubagentRunInfo): string {
  const back = subagentTranscriptBackText(run.sessionId);
  const id = shortSessionId(run.sessionId);
  // The run ended on its own terms while the stop was landing, so report what it is instead of
  // claiming the stop did it.
  if (TERMINAL_SUBAGENT_STATUSES.has(run.status)) {
    return run.status === "aborted"
      ? `Subagent ${id} stopped. ${back}`
      : subagentFinalText(run);
  }
  return `Stop requested for subagent ${id}; it is still unwinding. ${back}`;
}

export function createSubagentExtension(
  runtime: SubagentExtensionRuntime,
  getProfiles: SubagentProfileProvider,
  isEnabled: SubagentEnabledProvider = () => true,
): InlineExtension {
  return {
    name: HOST_SUBAGENT_EXTENSION_NAME,
    hidden: true,
    factory: (pi) => {
      if (!isEnabled()) return;
      const profiles = getProfiles().filter((profile) => profile.enabled);
      const profileNames = profiles.map((profile) => profile.name);
      const availableTypes = profileNames.length > 0 ? profileNames.join(", ") : "none";
      pi.registerTool(defineTool({
        name: "Agent",
        label: "Agent",
        description: `Delegate a task to a configured subagent: a full Pi session whose profile decides its tools. Use background mode for work that can run while you continue, foreground mode when you need the result now. A foreground wait defaults to 30 minutes; set wait_timeout (seconds) for a longer budget, and an exhausted one leaves the child running, its report arriving on its own.\n\nAvailable agent types:\n${agentTypeDescription(profiles)}`,
        promptSnippet: "Delegate a task to an inspectable subagent session. Whenever possible, delegate work to subagents instead of doing it yourself. Read the delegation section of the system prompt for which subagent to pick and when.",
        exposure: SUBAGENT_TOOL_EXPOSURE,
        executionMode: "parallel",
        // Only the parameters a model can choose from the information this tool gives it. A profile
        // decides `thinking`, `max_turns` and `inherit_context`, and there is no `input_files`: a
        // per-call list inlined whole files into the delegated task even though the child already
        // has `read` and `bash`, which filled the child's context and pushed a freshly opened
        // subagent straight into compaction. pi's validator allows keys the schema does not name, so
        // a call written against the old schema still validates and the extra key is ignored.
        parameters: Type.Object({
          subagent_type: Type.Optional(Type.String({ description: `Configured agent profile. Available types: ${availableTypes}. Default: general-purpose.` })),
          prompt: Type.String({ description: "The complete task for the subagent." }),
          resume: Type.Optional(Type.String({ description: "Existing subagent: its 8-character id, as its report shows it (the full session id also works). Continues with its current profile, model, thinking, and context. Omit new-session options." })),
          description: Type.String({ description: "Short activity label shown in the UI." }),
          run_in_background: Type.Optional(Type.Boolean({ description: "Return immediately and notify this session when complete. `plan` should always run in the foreground." })),
          wait_timeout: waitTimeoutParameter(),
          model: Type.Optional(Type.String({ description: 'Optional provider/modelId override. Append ":<level>" (off, minimal, low, medium, high, xhigh, max) to also set the thinking level for this run, e.g. "provider/model:high".' })),
          isolation: Type.Optional(Type.String({ description: 'Set to "worktree" to run the subagent in an isolated git worktree.' })),
        }),
        async execute(toolCallId, params, signal, onUpdate, ctx) {
          // Runtime cancellation follows this signal only while the Agent call is attached.
          // A later parent Stop must not cancel a child whose foreground wait already expired.
          const childAbort = new AbortController();
          const onParentAbort = () => childAbort.abort();
          if (signal?.aborted) childAbort.abort();
          else signal?.addEventListener("abort", onParentAbort, { once: true });
          let attached = true;
          let latestRun: SubagentRunInfo | undefined;
          const update = (run: SubagentRunInfo) => {
            latestRun = run;
            if (attached) onUpdate?.({
              content: [{ type: "text", text: `${run.profile}: ${run.description} (${run.status})` }],
              details: subagentToolDetails(run),
            });
          };
          const notifyOnCompletion = (execution: SubagentExecution) => {
            void execution.completion
              .then((run) => runtime.notifyParent(run))
              .catch((error) => {
                console.error(
                  "[pi-web] failed to deliver subagent completion:",
                  error instanceof Error ? error.message : error,
                );
              });
          };
          try {
            const timeoutMs = waitTimeoutMs(params.wait_timeout);
            const resume = params.resume?.trim();
            if (resume) {
              const creationOptions = [
                params.model?.trim() && "model",
                params.isolation?.trim() && "isolation",
              ].filter(Boolean);
              if (creationOptions.length > 0) {
                throw new Error(`${creationOptions.join(", ")} only apply to new subagents. Omit them to resume the existing session, or start a new subagent.`);
              }
            }
            const execution = resume
              ? await runtime.resume({
                  parentContext: ctx,
                  parentToolCallId: toolCallId,
                  sessionId: await resolveAgentId(runtime, resume),
                  task: params.prompt,
                  description: params.description,
                  ...(params.run_in_background !== undefined ? { runInBackground: params.run_in_background } : {}),
                  signal: childAbort.signal,
                  onUpdate: update,
                })
              : await runtime.start({
              parentContext: ctx,
              parentToolCallId: toolCallId,
              profile: params.subagent_type ?? "general-purpose",
              task: params.prompt,
              description: params.description,
              ...(params.run_in_background !== undefined ? { runInBackground: params.run_in_background } : {}),
              ...(params.model ? { model: params.model } : {}),
              ...(params.isolation === "worktree" ? { isolation: "worktree" as const } : {}),
              signal: childAbort.signal,
              onUpdate: update,
                });

            if (execution.run.runInBackground) {
              notifyOnCompletion(execution);
              return {
                content: [{ type: "text", text: `Subagent started in background. Session ID: ${shortSessionId(execution.run.sessionId)}. Its report arrives on its own when it finishes — do not poll it, call get_subagent_result for it, or wait on it. Do other work that does not need it if you have any; if you have none, stop — no output, no tools — until it arrives. Stopping does not cancel the subagent.` }],
                details: subagentToolDetails(execution.run),
              };
            }

            const run = await waitForSubagent(() => execution.completion, timeoutMs, signal);
            if (!run) {
              notifyOnCompletion(execution);
              return {
                content: [{ type: "text", text: `${waitTimeoutText(latestRun ?? execution.run, shortSessionId(execution.run.sessionId), timeoutMs)} Its completion report will arrive automatically.` }],
                details: subagentToolDetails(latestRun ?? execution.run),
              };
            }
            return {
              content: [{ type: "text", text: subagentFinalText(run) }],
              details: subagentToolDetails(run),
              ...(run.status === "failed" ? { isError: true } : {}),
            };
          } catch (error) {
            return {
              content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
              details: undefined,
              isError: true,
            };
          } finally {
            attached = false;
            signal?.removeEventListener("abort", onParentAbort);
          }
        },
      }));

      pi.registerTool(defineTool({
        name: "get_subagent_result",
        label: "Get agent result",
        description: "Fetch a subagent's report that is no longer in the conversation, or when the user asks for it. Never call this to check or wait for a run; its report arrives on its own.",
        exposure: SUBAGENT_TOOL_EXPOSURE,
        parameters: Type.Object({
          agent_id: Type.String({ description: "The subagent's 8-character id, as its report shows it (the full session id also works)." }),
          wait: Type.Optional(Type.Boolean({ description: "Only when the user asks you to wait for a run." })),
          wait_timeout: waitTimeoutParameter(),
        }),
        async execute(_toolCallId, params, signal) {
          // Registers this call so a run that settles under it is not also announced as a
          // notification; see `beginSubagentResultCollection` in the runtime.
          let agentId: string;
          try {
            agentId = await resolveAgentId(runtime, params.agent_id);
          } catch (error) {
            return { content: [{ type: "text", text: errorMessage(error) }], details: undefined, isError: true };
          }
          const endCollection = runtime.beginResultCollection?.(agentId);
          try {
            let run: SubagentRunInfo | null | undefined;
            if (params.wait) {
              // The budget is validated before the first lookup, so an invalid one
              // costs no read and starts nothing.
              const timeoutMs = waitTimeoutMs(params.wait_timeout);
              // The last status a lookup answered with, never one invented for a
              // lookup that has not answered yet.
              let lastSeen: SubagentRunInfo | null | undefined;
              const settled = await waitForSubagent(async (pollSignal) => {
                for (;;) {
                  const found = await runtime.get(agentId);
                  pollSignal.throwIfAborted();
                  lastSeen = found;
                  if (!found || TERMINAL_SUBAGENT_STATUSES.has(found.status)) return found;
                  await pollDelay(pollSignal);
                }
              }, timeoutMs, signal);
              if (settled === undefined) {
                return {
                  content: [{ type: "text", text: waitTimeoutText(lastSeen ?? undefined, agentId, timeoutMs) }],
                  details: lastSeen ? subagentToolDetails(lastSeen) : undefined,
                };
              }
              run = settled;
            } else {
              run = await runtime.get(agentId);
            }
            if (!run) return { content: [{ type: "text", text: `Subagent not found: ${params.agent_id}` }], details: undefined, isError: true };
            // The parent now holds this result, so the completion notification must not
            // deliver the same text again and wake a duplicate turn — a foreground run whose
            // wait expired reports on its own as well, so every terminal run is marked.
            if (TERMINAL_SUBAGENT_STATUSES.has(run.status)) runtime.markResultConsumed(run);
            return {
              content: [{ type: "text", text: subagentFinalText(run) }],
              details: subagentToolDetails(run),
              ...(run.status === "failed" ? { isError: true } : {}),
            };
          } finally {
            endCollection?.();
          }
        },
      }));

      pi.registerTool(defineTool({
        name: "steer_subagent",
        label: "Steer agent",
        description: "Send a steering message to a currently running subagent session.",
        exposure: SUBAGENT_TOOL_EXPOSURE,
        parameters: Type.Object({
          agent_id: Type.String({ description: "The subagent's 8-character id, as its report shows it (the full session id also works)." }),
          message: Type.String({ description: "Instruction to inject after the current tool execution." }),
        }),
        async execute(_toolCallId, params) {
          try {
            const agentId = await resolveAgentId(runtime, params.agent_id);
            await runtime.steer(agentId, params.message);
            return { content: [{ type: "text", text: `Steering message sent to ${shortSessionId(agentId)}.` }], details: undefined };
          } catch (error) {
            return { content: [{ type: "text", text: errorMessage(error) }], details: undefined, isError: true };
          }
        },
      }));

      pi.registerTool(defineTool({
        name: "abort_subagent",
        label: "Stop agent",
        description: "Stop a subagent session that is running, queued, or still connecting its servers. Its transcript stays, so it can be read afterwards or continued with `Agent`'s `resume`.",
        exposure: SUBAGENT_TOOL_EXPOSURE,
        parameters: Type.Object({
          agent_id: Type.String({ description: "The subagent's 8-character id, as its report shows it (the full session id also works)." }),
        }),
        async execute(_toolCallId, params) {
          const input = params.agent_id.trim();
          if (!input) {
            return { content: [{ type: "text", text: "Subagent session ID is required" }], details: undefined, isError: true };
          }
          let agentId: string;
          try {
            agentId = await resolveAgentId(runtime, input);
          } catch (error) {
            return { content: [{ type: "text", text: errorMessage(error) }], details: undefined, isError: true };
          }
          const before = await runtime.get(agentId);
          if (!before) {
            return { content: [{ type: "text", text: `Subagent not found: ${input}` }], details: undefined, isError: true };
          }
          if (TERMINAL_SUBAGENT_STATUSES.has(before.status)) {
            return {
              content: [{ type: "text", text: subagentNothingToStopText(before) }],
              details: subagentToolDetails(before),
            };
          }
          // A run the parent stops itself has no reason to report back, so this call holds its
          // completion the way an in-flight `get_subagent_result` does and takes the settled run as
          // its own result: the notification then finds the parent already holding the outcome.
          const endCollection = runtime.beginResultCollection?.(agentId);
          try {
            await runtime.abort(agentId);
            const settled = await waitForSettledRun(runtime, agentId);
            const run = settled ?? before;
            if (settled?.runInBackground) runtime.markResultConsumed(settled);
            return {
              content: [{ type: "text", text: subagentStopText(run) }],
              details: subagentToolDetails(run),
            };
          } catch (error) {
            // A run that settles between the check above and the abort is not a failure to stop.
            const run = await runtime.get(agentId).catch(() => null);
            if (run && TERMINAL_SUBAGENT_STATUSES.has(run.status)) {
              return {
                content: [{ type: "text", text: subagentNothingToStopText(run) }],
                details: subagentToolDetails(run),
              };
            }
            return { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], details: undefined, isError: true };
          } finally {
            endCollection?.();
          }
        },
      }));

      pi.registerTool(defineTool({
        name: "list_subagent_runs",
        label: "List agent runs",
        description: "List the subagents this session delegated, as TSV: agent_id, profile, status, last_activity, description. Use it when you no longer remember which subagents exist. It does not wait for or fetch results. The default view is a process list: active runs, plus runs that failed, were stopped or were interrupted in the last hour, active ones first. Older exits and completed runs are counted in one note unless status asks for them.",
        exposure: SUBAGENT_TOOL_EXPOSURE,
        parameters: Type.Object({
          status: Type.Optional(Type.String({ description: 'Which runs to list: "recent" (default), "active", "unfinished", "completed", or "all".' })),
        }),
        async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
          const parentSessionId = ctx?.sessionManager?.getSessionId?.();
          if (!parentSessionId) {
            return { content: [{ type: "text", text: "Cannot list subagents: no session." }], details: undefined, isError: true };
          }
          try {
            const entries = await runtime.list(parentSessionId);
            return {
              content: [{ type: "text", text: formatSubagentList(entries, { status: params.status }) }],
              details: undefined,
            };
          } catch (error) {
            return { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], details: undefined, isError: true };
          }
        },
      }));

      // The delegation policy and the profiles it can pick ride on every run's prompt; see
      // subagentDelegationBlock().
      pi.on?.("before_agent_start", (event) => {
        return { systemPrompt: withSubagentDelegationPrompt(event.systemPrompt, profiles) };
      });
    },
  };
}

/** Keep Pi Web's integrated implementation when the legacy package is loaded. */
export function preferPiWebSubagentExtension(base: LoadExtensionsResult): LoadExtensionsResult {
  const host = base.extensions.find((extension) => extension.path === HOST_SUBAGENT_EXTENSION_PATH);
  if (!host?.tools.has("Agent")) return base;
  const legacyPaths = new Set(base.extensions
    .filter((extension) => extension.path !== HOST_SUBAGENT_EXTENSION_PATH)
    .filter((extension) => {
      const source = extension.sourceInfo?.source ?? "";
      const sourcePackage = source.replace(/^npm:/, "").split("@")[0];
      const pathSegments = extension.path.replaceAll("\\", "/").split("/");
      return sourcePackage === LEGACY_SUBAGENT_PACKAGE_NAME
        || pathSegments.some((segment) => segment === LEGACY_SUBAGENT_PACKAGE_NAME);
    })
    .filter((extension) => [...SUBAGENT_TOOL_NAMES].some((name) => extension.tools.has(name)))
    .map((extension) => extension.path));
  if (legacyPaths.size === 0) return base;
  return {
    ...base,
    extensions: base.extensions.filter((extension) => !legacyPaths.has(extension.path)),
    errors: base.errors.filter((error) => {
      if (legacyPaths.has(error.path)) return false;
      if (error.path !== HOST_SUBAGENT_EXTENSION_PATH) return true;
      return ![...legacyPaths].some((legacyPath) =>
        [...SUBAGENT_TOOL_NAMES].some((name) =>
          error.error === `Tool "${name}" conflicts with ${legacyPath}`
        )
      );
    }),
  };
}
