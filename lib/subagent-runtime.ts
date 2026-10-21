import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  getAgentDir,
  initTheme,
  SessionManager,
  SettingsManager,
  type ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import type { AgentSessionLike } from "./pi-types";
import {
  subagentNotificationText,
  subagentToolDetails,
  type ResumeSubagentRequest,
  type StartSubagentRequest,
  type SubagentExecution,
  type SubagentExtensionRuntime,
} from "./subagent-extension";
import {
  readSubagentRun,
  resolveSubagentProfile,
  SUBAGENT_META_TYPE,
  SUBAGENT_STATUS_TYPE,
  SUBAGENT_RESULT_TYPE,
  selectSubagentExtensionTools,
  settleOrphanedSubagentStatus,
  subagentExtensionLoaderOptions,
  subagentToolOptions,
  withSubagentExtensionTools,
  type SubagentMetadata,
  type SubagentResultMetadata,
  type SubagentRunInfo,
} from "./subagents";
import type { SessionEntry } from "./types";
import { buildSubagentPromptPlan } from "./subagent-prompt";
import { createSubagentSkillsBinding } from "./subagent-skills";
import { projectTrustReloadOptions } from "./project-trust";
import { createSubagentCodemodeExtension, createSubagentMcpExtensions } from "./builtin-extensions";
import type { McpHost } from "./mcp-host";
import { createSubagentMcpPolicyExtension } from "./mcp-read-only-policy";
import { resolveShellTools } from "./powershell-settings";
import { isBuiltInSubagentsEnabled, readSubagentSettings } from "./subagent-settings";
import { pendingTitleFrom } from "./pending-notifications";
import type { SettledReportSink } from "./settled-report-note";
import { SubagentQueue } from "./subagent-queue";
import { addWorktree, removeWorktree } from "./worktree";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { writeSessionFileAtomicSync } from "./atomic-file";

interface HostSession {
  readonly inner: AgentSessionLike;
  readonly sessionFile: string;
  readonly cwd: string;
  isAlive(): boolean;
  isRunning(): boolean;
  waitUntilReady(): Promise<void>;
  /**
   * Connect the session's MCP servers before a run prompts the SDK session directly, past the
   * wrapper's `send()`; false when Stop or `signal` ended the wait and the run must not start.
   */
  prepareMcpForRun?(signal: AbortSignal): Promise<boolean>;
}

export interface SubagentRuntimeDependencies {
  getSession(sessionId: string): HostSession | undefined;
  registerSession(
    inner: AgentSessionLike,
    options?: { exactSystemPrompt?: () => string; chatOnly?: boolean; mcpHost?: McpHost },
  ): HostSession | void;
  reopenSession(sessionId: string, sessionFile: string): Promise<HostSession>;
  resolveSessionPath(sessionId: string): Promise<string | null>;
  invalidateSessionList(): void;
  isBuiltInSubagentsEnabled?(): boolean;
  /** Where a settled run's report is queued for its parent. */
  settledReports: SettledReportSink;
}

export interface SubagentController {
  readonly extensionRuntime: SubagentExtensionRuntime;
  get(sessionId: string): Promise<SubagentRunInfo | null>;
  steer(sessionId: string, message: string): Promise<void>;
  abort(sessionId: string): Promise<void>;
  /**
   * A prompt sent to a child's own chat, outside `Agent` / `resume`: adopt it as a run so its
   * status and result are recorded and its parent is told when it finishes.
   */
  beginDirectPrompt(sessionId: string, task: string): DirectSubagentPromptRun | undefined;
}

export interface DirectSubagentPromptRun {
  run: SubagentRunInfo;
  finish(outcome: { aborted?: boolean; error?: string }): Promise<SubagentRunInfo>;
}

type StoredSubagentExecution = {
  run: SubagentRunInfo;
  completion: Promise<SubagentRunInfo>;
  abortRequested: boolean;
  /** Set once the turn limit ends the run; later steering is refused instead of starting another turn. */
  turnLimitReached?: boolean;
  cancelQueued?: () => boolean;
  /** Ends the wait for the child's MCP servers before its prompt (`prepareChildMcp()`). */
  mcpWait?: AbortController;
};

declare global {
  var __piSubagentRuns: Map<string, StoredSubagentExecution> | undefined;
  var __piSubagentResultCollectors: Map<string, Set<ResultCollector>> | undefined;
  var __piSubagentQueue: SubagentQueue<SubagentRunInfo> | undefined;
  var __piSubagentConsumedResults: Map<string, string> | undefined;
  var __piSubagentParentNotifications: Set<Pick<SubagentRunInfo, "sessionId" | "parentSessionId">> | undefined;
}
const SUBAGENT_CONTEXT_LIMIT = 50_000;
const THINKING_LEVELS = new Set<ThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

const TURN_LIMIT_INSTRUCTION = "You have reached your turn limit. Wrap up immediately and provide your final answer now.";

/**
 * How the last model request ended when `prompt()` resolved anyway: pi records a provider
 * failure, or a request stopped from the child's own chat, on the assistant message.
 */
function lastAssistantStop(sessionManager: { getEntries?: () => unknown }): { aborted?: true; error?: string } | undefined {
  const entries = sessionManager.getEntries?.();
  if (!Array.isArray(entries)) return undefined;
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i] as { type?: unknown; message?: { role?: unknown; stopReason?: unknown; errorMessage?: unknown } };
    if (entry?.type !== "message" || entry.message?.role !== "assistant") continue;
    if (entry.message.stopReason === "aborted") return { aborted: true };
    if (entry.message.stopReason !== "error") return undefined;
    return { error: typeof entry.message.errorMessage === "string" && entry.message.errorMessage ? entry.message.errorMessage : "Provider returned an error" };
  }
  return undefined;
}

function turnLimitError(turnLimit: number, undelivered: readonly string[]): string {
  const error = `Subagent reached its turn limit (${turnLimit}) without completing the task.`;
  if (undelivered.length === 0) return error;
  return `${error} These queued messages were not delivered:\n${undelivered.map((text) => `- ${text}`).join("\n")}`;
}

/**
 * A child with `mcp: on` connects its servers before its prompt, as a prompt sent to the wrapper
 * does. The parent's Stop and `abort()` end the wait through `stored.mcpWait`, the child's own
 * Stop through the wrapper; either way the run is aborted before it starts.
 */
async function prepareChildMcp(session: HostSession | void, stored: StoredSubagentExecution): Promise<void> {
  if (!session?.prepareMcpForRun) return;
  const controller = new AbortController();
  stored.mcpWait = controller;
  try {
    if (stored.abortRequested) controller.abort();
    if (await session.prepareMcpForRun(controller.signal)) return;
  } finally {
    stored.mcpWait = undefined;
  }
  stored.abortRequested = true;
  throw new Error("Stopped while connecting MCP servers");
}

function getSubagentRuns(): Map<string, StoredSubagentExecution> {
  if (!globalThis.__piSubagentRuns) globalThis.__piSubagentRuns = new Map();
  return globalThis.__piSubagentRuns;
}

/** How long a notification waits for an in-flight `get_subagent_result` of its own run. */
const RESULT_COLLECTION_GRACE_MS = 2_000;

/**
 * `get_subagent_result` calls currently in flight, by subagent session id. A background run that
 * settles while its parent sits inside that call must not also be announced: the parent is handed
 * the same text as a tool result within the poll interval, so the notification would only wake a
 * second turn to repeat it. This call is the one thing worth waiting for; waiting for the parent
 * to fall idle is what delivered forty-minute-old reports in a burst.
 */
function getResultCollectors(): Map<string, Set<ResultCollector>> {
  if (!globalThis.__piSubagentResultCollectors) globalThis.__piSubagentResultCollectors = new Map();
  return globalThis.__piSubagentResultCollectors;
}

/** One in-flight `get_subagent_result`, with the handle that ends it. */
type ResultCollector = { done: Promise<void>; end: () => void };

/** Announce that a `get_subagent_result` for `sessionId` is running; the returned fn ends it. */
export function beginSubagentResultCollection(sessionId: string): () => void {
  const collectors = getResultCollectors();
  let finish = () => {};
  const done = new Promise<void>((resolve) => { finish = resolve; });
  const collector: ResultCollector = { done, end: () => {} };
  collector.end = () => {
    const set = collectors.get(sessionId);
    if (set) {
      set.delete(collector);
      if (set.size === 0) collectors.delete(sessionId);
    }
    finish();
  };
  const open = collectors.get(sessionId) ?? new Set<ResultCollector>();
  collectors.set(sessionId, open);
  open.add(collector);
  return collector.end;
}

/** Resolve when every in-flight collection for `sessionId` has ended, or once `timeoutMs` passes. */
export async function awaitSubagentResultCollection(sessionId: string, timeoutMs: number): Promise<void> {
  const open = [...(getResultCollectors().get(sessionId) ?? [])].map((collector) => collector.done);
  if (open.length === 0) return;
  await Promise.race([
    Promise.all(open),
    new Promise<void>((resolve) => { setTimeout(resolve, timeoutMs); }),
  ]);
}

/**
 * Background runs whose completion `notifyParent()` is still delivering: the run has left the
 * run map, but the parent's turn starts only once the parent is ready and idle.
 */
function getParentNotifications(): Set<Pick<SubagentRunInfo, "sessionId" | "parentSessionId">> {
  globalThis.__piSubagentParentNotifications ??= new Set();
  return globalThis.__piSubagentParentNotifications;
}

/**
 * Whether a subagent run under this session, at any depth, is still unsettled: its end can
 * start a turn there (`notifyParent()`, `triggerTurn`). A run counts from dispatch until its
 * result is written (the run map), then until its parent notification is delivered or fails.
 * A hidden page keeps the session's event stream while this holds (#1283).
 */
export function hasUnsettledSubagentRun(sessionId: string): boolean {
  const runs = [...[...getSubagentRuns().values()].map((stored) => stored.run), ...getParentNotifications()];
  const family = new Set([sessionId]);
  for (let grew = true; grew;) {
    grew = false;
    for (const run of runs) {
      if (!family.has(run.parentSessionId) || family.has(run.sessionId)) continue;
      family.add(run.sessionId);
      grew = true;
    }
  }
  return family.size > 1;
}

function getSubagentQueue(): SubagentQueue<SubagentRunInfo> {
  if (!globalThis.__piSubagentQueue) globalThis.__piSubagentQueue = new SubagentQueue();
  return globalThis.__piSubagentQueue;
}

type SubagentRunIdentity = Pick<SubagentRunInfo, "sessionId" | "completedAt">;

/**
 * Background runs whose terminal result the parent already collected with `get_subagent_result`,
 * keyed by subagent session ID and holding the collected run's `completedAt`. `resume` reruns
 * the same session ID, so the mark must name the run: a parent that polls *after* a run's
 * notification was delivered leaves a mark nothing consumes, and a bare session ID would let it
 * swallow the next run's notification (#987). `resume` deliberately does not clear the entry:
 * the parent can collect a run and resume it in the same turn while that run's notification is
 * still held, and the mark must keep suppressing it. Only background runs are recorded — a
 * foreground run never notifies — and each session holds at most one entry.
 */
function getConsumedSubagentResults(): Map<string, string> {
  // A hot reload can leave the pre-#987 Set on globalThis; replace it rather than call Map methods on it.
  if (!(globalThis.__piSubagentConsumedResults instanceof Map)) globalThis.__piSubagentConsumedResults = new Map();
  return globalThis.__piSubagentConsumedResults;
}

function markResultConsumed(run: SubagentRunIdentity): void {
  // A terminal run without `completedAt` (interrupted) never notifies, so there is nothing to drop.
  if (!run.completedAt) return;
  getConsumedSubagentResults().set(run.sessionId, run.completedAt);
}

/** Take the mark only when it names this very run; a mark left by an earlier run is ignored. */
function takeResultConsumed(run: SubagentRunIdentity): boolean {
  const consumed = getConsumedSubagentResults();
  if (!run.completedAt || consumed.get(run.sessionId) !== run.completedAt) return false;
  consumed.delete(run.sessionId);
  return true;
}

/**
 * A run lives in `getSubagentRuns()` from dispatch until its result entry is written, so a
 * persisted `running` / `queued` status reaching `get()` without that entry (and without a running
 * wrapper) was left by a process that stopped mid-run and will never be finished. Report it as
 * `interrupted` so `get_subagent_result({ wait: true })` returns instead of polling forever, and
 * `resume` can pick the session up again.
 */
function settleOrphanedRun(run: SubagentRunInfo): SubagentRunInfo {
  return { ...run, status: settleOrphanedSubagentStatus(run.status) };
}

/** The status of a run this process still holds, so a listing does not have to guess from its file. */
export function getLiveSubagentStatus(sessionId: string): SubagentRunInfo["status"] | undefined {
  return getSubagentRuns().get(sessionId)?.run.status;
}

function findSubagentModel(runtime: ModelRuntime, reference: string) {
  const slash = reference.indexOf("/");
  if (slash > 0) return runtime.getModel(reference.slice(0, slash), reference.slice(slash + 1));
  const matches = runtime.getModels().filter((model) => model.id === reference);
  if (matches.length > 1) throw new Error(`Subagent model is ambiguous; use provider/modelId: ${reference}`);
  return matches[0];
}

/**
 * Reads a model reference as pi's `--model` does: `provider/modelId` or a bare id, optionally
 * followed by `:<thinking level>`. The whole reference is tried first, so an id that itself
 * contains a colon (`qwen3:8b`) still matches; a suffix that is no thinking level never matches.
 */
function parseSubagentModel(runtime: ModelRuntime, value: string | undefined) {
  if (!value?.trim()) return undefined;
  const requested = value.trim();
  const exact = findSubagentModel(runtime, requested);
  if (exact) return { model: exact };
  const colon = requested.lastIndexOf(":");
  const level = requested.slice(colon + 1) as ThinkingLevel;
  if (colon > 0 && THINKING_LEVELS.has(level)) {
    const model = findSubagentModel(runtime, requested.slice(0, colon));
    if (model) return { model, thinkingLevel: level };
  }
  throw new Error(`Subagent model not found: ${requested}`);
}

function parentContextText(parent: HostSession): string {
  const messages = parent.inner.sessionManager.buildSessionContext().messages;
  const serialized = JSON.stringify(messages);
  if (serialized.length <= SUBAGENT_CONTEXT_LIMIT) return serialized;
  return `${serialized.slice(0, SUBAGENT_CONTEXT_LIMIT)}\n[Parent context truncated]`;
}

/**
 * pi creates a session file only once a user or assistant message exists, so a run that ended
 * before its prompt reached the model (stopped while queued or connecting MCP servers, a provider
 * without credentials) held its metadata and result in memory only: once its idle wrapper was
 * released, `get_subagent_result` and `resume` answered `Subagent not found` and the session left
 * the sidebar. Write the file at dispatch; `setSessionFile()` reloads it, so pi appends every entry.
 */
function persistChildSession(sessionManager: SessionManager): void {
  const sessionFile = sessionManager.getSessionFile();
  const header = sessionManager.getHeader();
  if (!sessionFile || !header || existsSync(sessionFile)) return;
  const lines = [header, ...sessionManager.getEntries()].map((entry) => JSON.stringify(entry));
  writeSessionFileAtomicSync(sessionFile, `${lines.join("\n")}\n`, { exclusive: true });
  sessionManager.setSessionFile(sessionFile);
}

async function cleanupWorktree(
  parentCwd: string,
  worktree: { path: string; branch: string } | undefined,
): Promise<string | undefined> {
  if (!worktree) return undefined;
  try {
    await removeWorktree(parentCwd, worktree.path);
    return undefined;
  } catch (error) {
    return `Worktree retained at ${worktree.path}: ${error instanceof Error ? error.message : String(error)}`;
  }
}

/**
 * Writes a settled run's result entry, which `readSubagentRun()` reads back, and returns the run as
 * recorded. An isolated run's entry keeps whether its worktree path still exists now, which decides
 * what the parent is told about it, live and read back alike (#1202): a checkout removed during
 * the run is gone though git's removal then failed, and a resumed run removes nothing.
 */
function recordResult(sessionManager: SessionManager, run: SubagentRunInfo): SubagentRunInfo {
  const recorded = run.worktreePath ? { ...run, worktreeExists: existsSync(run.worktreePath) } : run;
  const entry: SubagentResultMetadata = {
    version: 1,
    status: recorded.status as SubagentResultMetadata["status"],
    completedAt: recorded.completedAt!,
    ...(recorded.result ? { result: recorded.result } : {}),
    ...(recorded.error ? { error: recorded.error } : {}),
    ...(recorded.worktreeCleanupError ? { worktreeCleanupError: recorded.worktreeCleanupError } : {}),
    ...(recorded.worktreeExists !== undefined ? { worktreeExists: recorded.worktreeExists } : {}),
  };
  sessionManager.appendCustomEntry(SUBAGENT_RESULT_TYPE, entry);
  return recorded;
}

export function createSubagentController(
  dependencies: SubagentRuntimeDependencies,
): SubagentController {
  async function start(request: StartSubagentRequest): Promise<SubagentExecution> {
    const enabled = dependencies.isBuiltInSubagentsEnabled ?? isBuiltInSubagentsEnabled;
    if (!enabled()) throw new Error("Pi Web built-in sub-agents are disabled");
    const parentSessionId = request.parentContext.sessionManager.getSessionId();
    const parent = dependencies.getSession(parentSessionId);
    if (!parent?.isAlive()) throw new Error("Parent session is no longer available");
    if (!parent.sessionFile) throw new Error("Parent session must be persisted before starting a subagent");

    let isolatedWorktree: { path: string; branch: string } | undefined;
    try {
      const profile = resolveSubagentProfile(parent.cwd, request.profile);
      if (!profile) throw new Error(`Unknown or disabled subagent profile: ${request.profile}`);

      const runInBackground = request.runInBackground ?? profile.runInBackground;
      const isolation = profile.isolation === "off" ? undefined : request.isolation ?? profile.isolation;
      const parentModelRuntime = (parent.inner as unknown as { modelRuntime: ModelRuntime }).modelRuntime;
      if (isolation === "worktree") {
        isolatedWorktree = await addWorktree(parent.cwd, `pi-web-agent-${randomUUID()}`);
      }
      const childCwd = isolatedWorktree?.path ?? parent.cwd;
      const inheritContext = profile.inheritContext;
      // `parseProfileFile` already floors a positive profile `max_turns`, so it is an integer or absent.
      const turnLimit = profile.maxTurns;

      const agentDir = getAgentDir();
      const settingsManager = SettingsManager.create(childCwd, agentDir);
      const inheritedParentContext = inheritContext
        ? `The following is the active conversation context from the parent session. Use it only as background for the delegated task:\n${parentContextText(parent)}`
        : undefined;
      const promptPlan = buildSubagentPromptPlan({
        profileSystemPrompt: profile.systemPrompt,
        tools: profile.tools,
        loadSkills: profile.loadSkills,
        loadExtensions: profile.loadExtensions,
        promptMode: profile.promptMode,
        task: request.task,
        inheritedParentContext,
      });
      const parentCodemodeEnabled = parent.inner.getActiveToolNames().includes("codemode");
      const wantsCodemode = profile.codemode === "on"
        || (profile.codemode === "inherit" && parentCodemodeEnabled);
      if (promptPlan.chatOnly && profile.codemode === "on") {
        throw new Error("Code mode cannot be enabled for a chat-only subagent profile");
      }
      // A chat-only profile remains chat-only when inheritance is selected. An explicit `on`
      // is rejected above so it cannot silently grant a script capability to tools:none.
      const codemodeEnabled = !promptPlan.chatOnly && wantsCodemode;
      if (promptPlan.chatOnly && profile.mcp === "on") {
        throw new Error("MCP cannot be enabled for a chat-only subagent profile");
      }
      const mcpEnabled = profile.mcp === "on";
      const chatOnly = promptPlan.chatOnly;
      const { appendSystemPrompt, delegatedTask } = promptPlan;
      const skillsBinding = createSubagentSkillsBinding({
        loadSkills: profile.loadSkills,
        skills: profile.skills,
        exactSystemPrompt: promptPlan.exactSystemPrompt,
      });
      const codemodeExtension = codemodeEnabled
        ? await createSubagentCodemodeExtension({
            agentDir,
            cwd: childCwd,
            projectTrusted: () => settingsManager.isProjectTrusted(),
          })
        : undefined;
      // The policy reads the child's tools once they are resolved below.
      const mcpScope: { tools: readonly string[]; allExtensionTools?: boolean } = { tools: [] };
      const mcp = mcpEnabled
        ? await createSubagentMcpExtensions({
            agentDir,
            cwd: childCwd,
            projectTrusted: () => settingsManager.isProjectTrusted(),
            codemode: codemodeEnabled,
          })
        : undefined;
      const extensionFactories = [
        ...(codemodeExtension ? [codemodeExtension] : []),
        ...(mcp ? [...mcp.extensions, createSubagentMcpPolicyExtension(() => mcpScope)] : []),
        ...(skillsBinding.loaderOptions.extensionFactories ?? []),
      ];
      if (!chatOnly) initTheme();
      const services = await createAgentSessionServices({
        cwd: childCwd,
        agentDir,
        modelRuntime: parentModelRuntime,
        settingsManager,
        resourceLoaderOptions: {
          ...subagentExtensionLoaderOptions({ ...profile, mcp: mcpEnabled }),
          ...skillsBinding.loaderOptions,
          ...(extensionFactories.length > 0 ? { extensionFactories } : {}),
          noPromptTemplates: true,
          noThemes: true,
          noContextFiles: true,
          ...(chatOnly || promptPlan.exactSystemPrompt !== undefined
            ? {
                systemPrompt: " ",
                systemPromptOverride: () => undefined,
              }
            : {}),
          appendSystemPrompt,
        },
        ...((profile.loadExtensions || profile.loadSkills || codemodeEnabled || mcpEnabled)
          ? { resourceLoaderReloadOptions: projectTrustReloadOptions(childCwd, agentDir) }
          : {}),
      });

      if (codemodeEnabled && !services.resourceLoader.getExtensions().extensions.some((extension) => extension.tools.has("codemode"))) {
        throw new Error("Code mode is unavailable: builtin:codemode was not registered");
      }

      // `ext:` selectors that `disallowed_tools` cancels out leave an empty list, which admits none.
      const allExtensionTools = profile.loadExtensions && profile.extensionTools === undefined;
      const extensionToolNames = profile.loadExtensions
        ? profile.extensionTools !== undefined
          ? selectSubagentExtensionTools(
            services.resourceLoader.getExtensions().extensions,
            profile.extensionTools,
            profile.disallowedExtensionTools,
          )
          : services.resourceLoader.getExtensions().extensions.flatMap((extension) => [...extension.tools.keys()])
        : [];
      const activeTools = resolveShellTools(
        withSubagentExtensionTools(profile.tools, extensionToolNames),
        settingsManager.getDefaultTools(),
      );
      if (codemodeEnabled && !activeTools.includes("codemode")) activeTools.push("codemode");
      mcpScope.tools = activeTools;
      mcpScope.allExtensionTools = allExtensionTools;

      const sessionManager = isolatedWorktree
        ? SessionManager.create(childCwd, undefined, { parentSession: parent.sessionFile })
        : SessionManager.create(parent.cwd, undefined, { parentSession: parent.sessionFile });
      const createdAt = new Date().toISOString();
      const metadata: SubagentMetadata = {
        version: 1,
        parentSessionId,
        parentSessionPath: parent.sessionFile,
        parentToolCallId: request.parentToolCallId,
        profile: profile.name,
        description: request.description.trim() || profile.displayName,
        task: request.task,
        runInBackground,
        createdAt,
        resourceSnapshot: {
          version: 1,
          appendSystemPrompt: [...appendSystemPrompt],
          tools: [...activeTools],
          ...(codemodeEnabled ? { codemode: true as const } : {}),
          ...(mcpEnabled ? { mcp: true as const } : {}),
          loadSkills: profile.loadSkills,
          ...(profile.skills !== undefined ? { skills: [...profile.skills] } : {}),
          loadExtensions: profile.loadExtensions,
          ...(allExtensionTools ? { allExtensionTools: true } : {}),
          ...(profile.extensions !== undefined ? { extensions: [...profile.extensions] } : {}),
          ...(promptPlan.exactSystemPrompt !== undefined ? { exactSystemPrompt: promptPlan.exactSystemPrompt } : {}),
        },
        ...(isolatedWorktree ? { worktreePath: isolatedWorktree.path, worktreeBranch: isolatedWorktree.branch } : {}),
      };
      sessionManager.appendCustomEntry(SUBAGENT_META_TYPE, metadata);
      sessionManager.appendSessionInfo(metadata.description);

      // A `:level` suffix travels with its model. As with pi's `--thinking` over `--model x:level`,
      // the profile's own `thinking` beats a suffix on the profile's model, while a call naming
      // a model with a suffix chose both for this run.
      const callModel = parseSubagentModel(parentModelRuntime, request.model);
      const profileModel = callModel ? undefined : parseSubagentModel(parentModelRuntime, profile.model);
      const thinking = callModel?.thinkingLevel
        ?? profile.thinking
        ?? profileModel?.thinkingLevel
        ?? parent.inner.agent.state?.thinkingLevel;
      if (thinking && !THINKING_LEVELS.has(thinking as ThinkingLevel)) {
        throw new Error(`Invalid subagent thinking level: ${thinking}`);
      }
      const parentModel = parent.inner.model as ReturnType<ModelRuntime["getModel"]>;
      const { session: inner } = await createAgentSessionFromServices({
        services,
        sessionManager,
        model: (callModel ?? profileModel)?.model ?? parentModel,
        ...(thinking ? { thinkingLevel: thinking as ThinkingLevel } : {}),
        ...subagentToolOptions({ tools: activeTools, allExtensionTools, mcp: mcpEnabled }),
      });
      persistChildSession(sessionManager);
      skillsBinding.setActiveToolsGetter(() => inner.getActiveToolNames());
      const childSession = dependencies.registerSession(inner, {
        ...(skillsBinding.getExactSystemPrompt !== undefined
          ? { exactSystemPrompt: skillsBinding.getExactSystemPrompt }
          : {}),
        chatOnly,
        ...(mcp?.mcpHost ? { mcpHost: mcp.mcpHost } : {}),
      });

      const initialRun: SubagentRunInfo = {
        sessionId: inner.sessionId,
        sessionPath: inner.sessionFile ?? sessionManager.getSessionFile() ?? "",
        parentSessionId,
        parentToolCallId: request.parentToolCallId,
        profile: profile.name,
        description: metadata.description,
        task: request.task,
        runInBackground,
        status: "queued",
        createdAt,
        ...(isolatedWorktree ? { worktreePath: isolatedWorktree.path, worktreeBranch: isolatedWorktree.branch } : {}),
      };

      let resolveCompletion!: (run: SubagentRunInfo) => void;
      const completion = new Promise<SubagentRunInfo>((resolve) => { resolveCompletion = resolve; });
      const stored: StoredSubagentExecution = {
        run: initialRun,
        completion,
        abortRequested: false,
      };
      getSubagentRuns().set(initialRun.sessionId, stored);
      request.onUpdate?.(initialRun);
      dependencies.invalidateSessionList();

      const handleParentAbort = () => {
        stored.abortRequested = true;
        if (stored.run.status === "queued") stored.cancelQueued?.();
        else if (stored.mcpWait) stored.mcpWait.abort();
        else void inner.abort();
      };
      if (!runInBackground) request.signal?.addEventListener("abort", handleParentAbort, { once: true });

      const execute = async (): Promise<SubagentRunInfo> => {
        // Reached only when the abort fires while the run is being queued, before `cancelQueued`
        // is set; a run aborted later in the queue ends in `finishQueuedAbort`.
        if (stored.abortRequested) {
          const cleanupError = await cleanupWorktree(parent.cwd, isolatedWorktree);
          const result = recordResult(sessionManager, {
            ...initialRun,
            status: "aborted",
            completedAt: new Date().toISOString(),
            ...(cleanupError ? { worktreeCleanupError: cleanupError } : {}),
          });
          stored.run = result;
          request.onUpdate?.(result);
          getSubagentRuns().delete(stored.run.sessionId);
          dependencies.invalidateSessionList();
          return result;
        }
        stored.run = { ...stored.run, status: "running" };
        sessionManager.appendCustomEntry(SUBAGENT_STATUS_TYPE, { version: 1, status: "running" });
        request.onUpdate?.(stored.run);
        dependencies.invalidateSessionList();
        let turnCount = 0;
        let maxTurnsReached = false;
        let undelivered: string[] = [];
        const previousFinishTurn = inner.agent.finishTurn;
        const previousSteeringMode = inner.agent.steeringMode;
        let unsubscribeTools: (() => void) | undefined;
        if (turnLimit) {
          // Finalized events retain the SDK's terminate hint; tool-result messages do not.
          const terminatingTools = new Set<string>();
          unsubscribeTools = inner.subscribe((event) => {
            if (event.type === "tool_execution_end" && event.result?.terminate === true) {
              terminatingTools.add(event.toolCallId);
            }
          });
          inner.agent.finishTurn = async (turn, signal) => {
            const decision = (await previousFinishTurn?.(turn, signal)) ?? undefined;
            const toolsContinue = turn.toolResults.some((message) => !terminatingTools.has(message.toolCallId));
            terminatingTools.clear();
            turnCount += 1;
            if (signal?.aborted || decision?.action === "end" ||
              turn.message.stopReason === "error" || turn.message.stopReason === "aborted") return decision;
            const needsAnotherTurn = toolsContinue || decision?.action === "continue" || inner.agent.hasQueuedMessages();
            if (!needsAnotherTurn || turnCount < turnLimit) return decision;
            if (turnCount >= turnLimit + 1) {
              maxTurnsReached = true;
              stored.turnLimitReached = true;
              // AgentSession starts another run for anything still queued, past an `end`
              // decision, so the limit holds only once the queues are empty.
              const { steering, followUp } = inner.clearQueue();
              undelivered = [...undelivered, ...steering, ...followUp];
              return { action: "end" };
            }
            // The awaited SDK boundary delivers the instruction before the wrap-up request.
            // In one-at-a-time mode a steer queued earlier would take the wrap-up turn and
            // leave the instruction for later, so that turn takes everything queued.
            inner.agent.steeringMode = "all";
            await inner.steer(TURN_LIMIT_INSTRUCTION);
            return decision;
          };
        }
        let result: SubagentRunInfo;
        try {
          // A profile's `mcp: on` connects this child's own mcp.json servers before
          // its first prompt (the parent's host does not cover a child).
          await prepareChildMcp(childSession, stored);
          // The skill catalog goes out as its own turn, ahead of the task. Left in the
          // `<skills>` system-prompt section it is skipped, and the agent then guesses a
          // skill path or searches the filesystem for one.
          const skillCatalogMessage = skillsBinding.getSkillCatalogMessage();
          if (skillCatalogMessage) await inner.prompt(skillCatalogMessage, { source: "rpc" });
          await inner.prompt(delegatedTask, { source: "rpc" });
          const text = inner.getLastAssistantText()?.trim();
          const stop = stored.abortRequested ? undefined : lastAssistantStop(sessionManager);
          const aborted = stored.abortRequested || stop?.aborted === true;
          const errorMessage = aborted ? undefined : stop?.error ??
            (maxTurnsReached && turnLimit ? turnLimitError(turnLimit, undelivered) : undefined);
          result = {
            ...initialRun,
            status: aborted ? "aborted" : errorMessage ? "failed" : "completed",
            completedAt: new Date().toISOString(),
            ...(text ? { result: text } : {}),
            ...(errorMessage ? { error: errorMessage } : {}),
          };
        } catch (error) {
          const text = inner.getLastAssistantText()?.trim();
          const aborted = stored.abortRequested || request.signal?.aborted;
          result = {
            ...initialRun,
            status: aborted ? "aborted" : "failed",
            completedAt: new Date().toISOString(),
            ...(text ? { result: text } : {}),
            ...(!aborted
              ? { error: error instanceof Error ? error.message : String(error) }
              : {}),
          };
        } finally {
          if (turnLimit) {
            inner.agent.finishTurn = previousFinishTurn;
            inner.agent.steeringMode = previousSteeringMode;
          }
          unsubscribeTools?.();
          request.signal?.removeEventListener("abort", handleParentAbort);
        }

        const cleanupError = await cleanupWorktree(parent.cwd, isolatedWorktree);
        if (cleanupError) result = { ...result, worktreeCleanupError: cleanupError };
        result = recordResult(sessionManager, result);
        stored.run = result;
        request.onUpdate?.(result);
        getSubagentRuns().delete(stored.run.sessionId);
        dependencies.invalidateSessionList();
        return result;
      };

      const finishQueuedAbort = async () => {
        if (stored.run.status !== "queued") return;
        const result: SubagentRunInfo = { ...initialRun, status: "aborted", completedAt: new Date().toISOString() };
        const cleanupError = await cleanupWorktree(parent.cwd, isolatedWorktree);
        const finalResult = recordResult(sessionManager, cleanupError ? { ...result, worktreeCleanupError: cleanupError } : result);
        stored.run = finalResult;
        request.onUpdate?.(finalResult);
        getSubagentRuns().delete(stored.run.sessionId);
        dependencies.invalidateSessionList();
        resolveCompletion(finalResult);
      };
      const queued = getSubagentQueue().enqueue(
        parentSessionId,
        readSubagentSettings().maxConcurrent,
        execute,
        (state) => {
          if (state === "queued") {
            sessionManager.appendCustomEntry(SUBAGENT_STATUS_TYPE, { version: 1, status: "queued" });
          }
          request.onUpdate?.({ ...stored.run, status: state });
          stored.run = { ...stored.run, status: state };
          dependencies.invalidateSessionList();
        },
        finishQueuedAbort,
      );
      stored.cancelQueued = queued.cancel;
      void queued.promise.then(resolveCompletion, (error) => {
        resolveCompletion({ ...initialRun, status: "failed", completedAt: new Date().toISOString(), error: error instanceof Error ? error.message : String(error) });
      });

      return { run: stored.run, completion: stored.completion };
    } catch (error) {
      if (isolatedWorktree) {
        try { await removeWorktree(parent.cwd, isolatedWorktree.path); } catch { /* preserve setup failure and avoid force deletion */ }
      }
      throw error;
    }
  }

  async function resume(request: ResumeSubagentRequest): Promise<SubagentExecution> {
    const enabled = dependencies.isBuiltInSubagentsEnabled ?? isBuiltInSubagentsEnabled;
    if (!enabled()) throw new Error("Pi Web built-in sub-agents are disabled");
    const parentSessionId = request.parentContext.sessionManager.getSessionId();
    const existing = await get(request.sessionId);
    if (!existing) throw new Error(`Subagent not found: ${request.sessionId}`);
    if (existing.parentSessionId !== parentSessionId) throw new Error("Subagent does not belong to this parent session");
    if (existing.status === "running" || existing.status === "queued") throw new Error("Subagent is already running");
    const parent = dependencies.getSession(parentSessionId);
    if (!parent?.isAlive()) throw new Error("Parent session is no longer available");
    const sessionPath = existing.sessionPath || await dependencies.resolveSessionPath(request.sessionId);
    if (!sessionPath) throw new Error(`Subagent session file not found: ${request.sessionId}`);
    let wrapper = dependencies.getSession(request.sessionId);
    if (!wrapper?.isAlive()) wrapper = await dependencies.reopenSession(request.sessionId, sessionPath);
    if (!wrapper.isAlive()) throw new Error("Subagent session is no longer available");
    if (wrapper.isRunning()) throw new Error("Subagent is already running");
    // The run prompts the SDK session directly, past the wrapper's `send()`, so refuse here as
    // `send()` does: an isolated child's worktree is removed when its run ends, and a run in the
    // missing folder would only let the model's tools fail (and `write` recreate it outside git).
    // The error reaches the model, so it also says what to do instead.
    if (!existsSync(wrapper.cwd)) throw new Error(`Directory does not exist: ${wrapper.cwd}. Start a new subagent instead.`);

    const runInBackground = request.runInBackground ?? existing.runInBackground;
    const initialRun: SubagentRunInfo = {
      ...existing,
      parentToolCallId: request.parentToolCallId,
      task: request.task,
      description: request.description.trim() || existing.description,
      runInBackground,
      status: "queued",
      completedAt: undefined,
      result: undefined,
      error: undefined,
      // Resume removes no worktree: this run's result says only whether it is still there.
      worktreeCleanupError: undefined,
      worktreeExists: undefined,
      resumed: true,
    };
    const manager = wrapper.inner.sessionManager;
    let resolveCompletion!: (run: SubagentRunInfo) => void;
    const completion = new Promise<SubagentRunInfo>((resolve) => { resolveCompletion = resolve; });
    const stored: StoredSubagentExecution = { run: initialRun, completion, abortRequested: false };
    getSubagentRuns().set(request.sessionId, stored);
    request.onUpdate?.(initialRun);
    dependencies.invalidateSessionList();
    const handleParentAbort = () => {
      stored.abortRequested = true;
      if (stored.run.status === "queued") stored.cancelQueued?.();
      else if (stored.mcpWait) stored.mcpWait.abort();
      else void wrapper!.inner.abort();
    };
    if (!runInBackground) request.signal?.addEventListener("abort", handleParentAbort, { once: true });

    const execute = async (): Promise<SubagentRunInfo> => {
      if (stored.abortRequested) {
        const result = recordResult(manager, { ...initialRun, status: "aborted", completedAt: new Date().toISOString() });
        stored.run = result;
        getSubagentRuns().delete(stored.run.sessionId);
        resolveCompletion(result);
        return result;
      }
      stored.run = { ...stored.run, status: "running" };
      manager.appendCustomEntry(SUBAGENT_STATUS_TYPE, { version: 1, status: "running" });
      request.onUpdate?.(stored.run);
      let result: SubagentRunInfo;
      try {
        await prepareChildMcp(wrapper, stored);
        await wrapper!.inner.prompt(request.task, { source: "rpc" });
        const text = wrapper!.inner.getLastAssistantText()?.trim();
        const stop = stored.abortRequested ? undefined : lastAssistantStop(manager);
        const aborted = stored.abortRequested || stop?.aborted === true;
        const providerError = aborted ? undefined : stop?.error;
        result = {
          ...initialRun,
          status: aborted ? "aborted" : providerError ? "failed" : "completed",
          completedAt: new Date().toISOString(),
          ...(text ? { result: text } : {}),
          ...(providerError ? { error: providerError } : {}),
        };
      } catch (error) {
        result = {
          ...initialRun,
          status: stored.abortRequested || request.signal?.aborted ? "aborted" : "failed",
          completedAt: new Date().toISOString(),
          ...(!stored.abortRequested && !request.signal?.aborted ? { error: error instanceof Error ? error.message : String(error) } : {}),
        };
      } finally {
        request.signal?.removeEventListener("abort", handleParentAbort);
      }
      result = recordResult(manager, result);
      stored.run = result;
      request.onUpdate?.(result);
      getSubagentRuns().delete(stored.run.sessionId);
      dependencies.invalidateSessionList();
      return result;
    };
    const finishQueuedAbort = () => {
      if (stored.run.status !== "queued") return;
      const result = recordResult(manager, { ...initialRun, status: "aborted", completedAt: new Date().toISOString() });
      stored.run = result;
      request.onUpdate?.(result);
      getSubagentRuns().delete(stored.run.sessionId);
      dependencies.invalidateSessionList();
      resolveCompletion(result);
    };
    const queued = getSubagentQueue().enqueue(parentSessionId, readSubagentSettings().maxConcurrent, execute, (state) => {
      if (state === "queued") manager.appendCustomEntry(SUBAGENT_STATUS_TYPE, { version: 1, status: "queued" });
      stored.run = { ...stored.run, status: state };
      request.onUpdate?.(stored.run);
      dependencies.invalidateSessionList();
    }, finishQueuedAbort);
    stored.cancelQueued = queued.cancel;
    void queued.promise.then(resolveCompletion, (error) => resolveCompletion({ ...initialRun, status: "failed", completedAt: new Date().toISOString(), error: error instanceof Error ? error.message : String(error) }));
    return { run: stored.run, completion };
  }

  function beginDirectPrompt(sessionId: string, task: string): DirectSubagentPromptRun | undefined {
    // A live run already owns this child: the prompt joins it (steering, follow-up) and the
    // run's own completion records the result.
    if (getSubagentRuns().has(sessionId)) return undefined;
    const wrapper = dependencies.getSession(sessionId);
    if (!wrapper?.isAlive()) return undefined;
    const manager = wrapper.inner.sessionManager;
    const existing = readSubagentRun(
      manager.getEntries() as unknown as SessionEntry[],
      sessionId,
      wrapper.sessionFile,
    );
    if (!existing) return undefined;

    const initialRun: SubagentRunInfo = {
      ...existing,
      ...(task.trim() ? { task } : {}),
      // From the parent's side nobody is waiting on this prompt: it was typed in the child's
      // own chat, so its result is collected or announced like any background run's.
      runInBackground: true,
      status: "running",
      completedAt: undefined,
      result: undefined,
      error: undefined,
      worktreeCleanupError: undefined,
      worktreeExists: undefined,
      resumed: true,
    };
    let resolveCompletion!: (run: SubagentRunInfo) => void;
    const completion = new Promise<SubagentRunInfo>((resolve) => { resolveCompletion = resolve; });
    const stored: StoredSubagentExecution = { run: initialRun, completion, abortRequested: false };
    getSubagentRuns().set(sessionId, stored);
    manager.appendCustomEntry(SUBAGENT_STATUS_TYPE, { version: 1, status: "running" });
    dependencies.invalidateSessionList();

    return {
      run: initialRun,
      async finish(outcome) {
        const text = wrapper.inner.getLastAssistantText()?.trim();
        const stop = outcome.aborted || stored.abortRequested ? undefined : lastAssistantStop(manager);
        const aborted = Boolean(outcome.aborted || stored.abortRequested || stop?.aborted);
        const message = aborted ? undefined : stop?.error ?? outcome.error;
        const result = recordResult(manager, {
          ...initialRun,
          status: aborted ? "aborted" : message ? "failed" : "completed",
          completedAt: new Date().toISOString(),
          ...(text ? { result: text } : {}),
          ...(message ? { error: message } : {}),
        });
        stored.run = result;
        getSubagentRuns().delete(sessionId);
        dependencies.invalidateSessionList();
        resolveCompletion(result);
        // The user chatted with the child directly, so its parent was not waiting on this run
        // and must be told when it settles. Recorded first: a slow parent must not hold the
        // child's status back.
        void notifyParent(result).catch((error) => {
          console.error(
            `[pi-web] failed to deliver subagent completion for ${sessionId}:`,
            error instanceof Error ? error.message : error,
          );
        });
        return result;
      },
    };
  }

  async function get(sessionId: string): Promise<SubagentRunInfo | null> {
    const stored = getSubagentRuns().get(sessionId);
    if (stored) return stored.run;
    const wrapper = dependencies.getSession(sessionId);
    if (wrapper?.isAlive()) {
      const run = readSubagentRun(
        wrapper.inner.sessionManager.getEntries() as unknown as SessionEntry[],
        sessionId,
        wrapper.sessionFile,
      );
      if (run && wrapper.isRunning()) return { ...run, status: "running" };
      if (run) return settleOrphanedRun(run);
    }
    const sessionPath = await dependencies.resolveSessionPath(sessionId);
    if (!sessionPath) return null;
    const manager = SessionManager.open(sessionPath);
    const run = readSubagentRun(manager.getEntries() as unknown as SessionEntry[], sessionId, sessionPath);
    return run && settleOrphanedRun(run);
  }

  async function steer(sessionId: string, message: string): Promise<void> {
    const wrapper = dependencies.getSession(sessionId);
    if (!wrapper?.isAlive() || !wrapper.isRunning()) throw new Error("Subagent is not running");
    if (getSubagentRuns().get(sessionId)?.turnLimitReached) throw new Error("Subagent reached its turn limit and is stopping; resume it to continue");
    if (!message.trim()) throw new Error("Steering message is required");
    await wrapper.inner.steer(message.trim());
  }

  async function notifyParent(run: SubagentRunInfo): Promise<void> {
    const pending = { sessionId: run.sessionId, parentSessionId: run.parentSessionId };
    getParentNotifications().add(pending);
    try {
      await deliverParentNotification(run);
    } finally {
      getParentNotifications().delete(pending);
    }
  }

  async function deliverParentNotification(run: SubagentRunInfo): Promise<void> {
    if (takeResultConsumed(run)) return;
    let parent = dependencies.getSession(run.parentSessionId);
    if (!parent?.isAlive()) {
      const sessionFile = await dependencies.resolveSessionPath(run.parentSessionId);
      if (!sessionFile) throw new Error(`Parent session not found: ${run.parentSessionId}`);
      parent = await dependencies.reopenSession(run.parentSessionId, sessionFile);
    }
    await parent.waitUntilReady();
    // Queued the moment the run settles, not held until the parent looks idle: a parent that runs
    // on for forty minutes delivered a burst of stale reports at the end of it. The one thing
    // still worth waiting for is a `get_subagent_result` in flight for *this* run, which is about
    // to give the parent the same text as a tool result; that wait is bounded by the call.
    await awaitSubagentResultCollection(run.sessionId, RESULT_COLLECTION_GRACE_MS);
    if (takeResultConsumed(run)) return;
    if (!parent.isAlive()) throw new Error(`Parent session is no longer available: ${run.parentSessionId}`);
    // The report joins the batch already in the parent's queue: several subagents finishing
    // together reach the model as one message, not one message each.
    await dependencies.settledReports.deliver(run.parentSessionId, {
      kind: "subagent",
      id: run.sessionId,
      title: pendingTitleFrom(run.description || run.task),
      outcome: run.status,
      finishedAtMs: run.completedAt ? Date.parse(run.completedAt) : Date.now(),
      customType: "pi-web:subagent-notification",
      fetchHint: `get_subagent_result("${run.sessionId}")`,
      text: subagentNotificationText(run),
      details: subagentToolDetails(run),
    });
  }

  async function abort(sessionId: string): Promise<void> {
    const wrapper = dependencies.getSession(sessionId);
    const stored = getSubagentRuns().get(sessionId);
    if (stored?.run.status === "queued") {
      stored.abortRequested = true;
      if (!stored.cancelQueued?.()) throw new Error("Subagent is no longer queued");
      return;
    }
    // Still connecting its MCP servers: no run to stop yet, so the wait ends instead.
    if (stored?.mcpWait) {
      stored.abortRequested = true;
      stored.mcpWait.abort();
      return;
    }
    if (!wrapper?.isAlive() || !wrapper.isRunning()) throw new Error("Subagent is not running");
    if (stored) stored.abortRequested = true;
    await wrapper.inner.abort();
  }

  return {
    // `abort` goes to the tools as well as to the routes: the parent that started a run can end one
    // it no longer wants, and does not need a report back telling it what it just did.
    extensionRuntime: { start, resume, get, steer, abort, notifyParent, markResultConsumed },
    get,
    steer,
    abort,
    beginDirectPrompt,
  };
}
