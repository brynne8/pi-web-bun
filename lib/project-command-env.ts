import { Type } from "typebox";
import {
  createBashToolDefinition,
  createLocalBashOperations,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  getAgentDir,
  type BashOperations,
  type InlineExtension,
  type LoadExtensionsResult,
} from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { createWriteStream } from "node:fs";
import { readFile } from "node:fs/promises";
import {
  bgLogPath,
  FOREGROUND_AUTO_BACKGROUND_MS,
  noteBgTaskOutput,
  PreHandoffBuffer,
  promoteBgTask,
  settleBgTask,
  trackBgTask,
  untrackBgTask,
  wasBgTaskKilled,
} from "./bash-bg-tasks";
import { buildBgTaskNotification, type BgTaskOutcome } from "./bg-task-notification";

const HOST_EXTENSION_NAME = "pi-web-project-command-environment";
const HOST_EXTENSION_PATH = `<inline:${HOST_EXTENSION_NAME}>`;
// Pi's own abort path settles well within this once the process tree is gone.
const ABORT_SETTLE_GRACE_MS = 1000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

type ProjectShellSettings = {
  getShellCommandPrefix(): string | undefined;
  getShellPath(): string | undefined;
};

type BgTaskOptions = {
  /** Delivers the completion notification into the parent session. */
  notify(sessionId: string, text: string, outcome: BgTaskOutcome): Promise<void>;
};

type ProjectCommandBashOperationsOptions = {
  abortSettleGraceMs?: number;
  agentBinDir?: string;
  baseEnvironment?: NodeJS.ProcessEnv;
  localOperations?: BashOperations;
  platform?: NodeJS.Platform;
  shellPath?: string;
  /**
   * The project's shell prefix, which pi joins onto the command as `${prefix}\n${command}`. Only
   * the command itself reaches the activity view: a row that read `cd /repo && …` said nothing
   * about what was running, and every row in one project read the same.
   */
  commandPrefix?: string;
  /** When set, foreground commands without an explicit timeout hand off to background after this long. */
  autoBackgroundMs?: number;
  /** When set, a foreground command that prints more lines than this hands off to background instead. */
  maxOutputLines?: number;
  bgTask?: {
    sessionId: string;
    notify: BgTaskOptions["notify"];
  };
};

type BashExecResult = Awaited<ReturnType<BashOperations["exec"]>>;

function isHostRuntimeVariable(name: string, platform: NodeJS.Platform): boolean {
  const comparableName = platform === "win32" ? name.toUpperCase() : name;
  return comparableName === "PORT"
    || comparableName === "NODE_ENV"
    || comparableName.startsWith("NEXT_")
    // The browser login password guards this server; commands run on behalf of
    // a project (and the model reading their output) have no use for it.
    || comparableName === "PI_WEB_PASSWORD";
}

export function sanitizeProjectCommandEnvironment(
  baseEnvironment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  const environment = { ...baseEnvironment };
  for (const name of Object.keys(environment)) {
    if (isHostRuntimeVariable(name, platform)) delete environment[name];
  }
  return environment;
}

function withAgentBinDirectory(
  environment: NodeJS.ProcessEnv,
  agentBinDir: string,
  platform: NodeJS.Platform,
): NodeJS.ProcessEnv {
  const pathKey = platform === "win32"
    ? Object.keys(environment).find((name) => name.toUpperCase() === "PATH") ?? "PATH"
    : "PATH";
  const pathDelimiter = platform === "win32" ? ";" : ":";
  const currentPath = environment[pathKey] ?? "";
  const pathEntries = currentPath.split(pathDelimiter).filter(Boolean);
  if (!pathEntries.includes(agentBinDir)) {
    environment[pathKey] = [agentBinDir, currentPath].filter(Boolean).join(pathDelimiter);
  }
  return environment;
}

export function createProjectCommandBashOperations(
  options: ProjectCommandBashOperationsOptions = {},
): BashOperations {
  const {
    abortSettleGraceMs = ABORT_SETTLE_GRACE_MS,
    agentBinDir = join(getAgentDir(), "bin"),
    baseEnvironment = process.env,
    localOperations = createLocalBashOperations({ shellPath: options.shellPath }),
    platform = process.platform,
    commandPrefix,
    autoBackgroundMs,
    maxOutputLines,
    bgTask,
  } = options;

  return {
    exec(command, cwd, executionOptions) {
      const environment = withAgentBinDirectory(
        sanitizeProjectCommandEnvironment(executionOptions.env ?? baseEnvironment, platform),
        agentBinDir,
        platform,
      );
      const { onData, signal, timeout } = executionOptions;
      let released = false;
      // The local ops only listens to our controller, so a tool-call abort after
      // the auto-background handoff can no longer kill the backgrounded process.
      // Before the handoff, abort forwards into the controller (see below);
      // after it, the wrapper's abort listener is gone and the process survives.
      const bgController = bgTask ? new AbortController() : undefined;
      // What the panel shows: the command as it was written, without the project's prefix.
      const shownCommand = commandPrefix && command.startsWith(`${commandPrefix}\n`)
        ? command.slice(commandPrefix.length + 1)
        : command;
      if (bgController && bgTask) {
        // Hidden until a handoff: this command is still in front of the user.
        trackBgTask(bgTask.sessionId, bgController, { command: shownCommand, startedAtMs: Date.now() });
      }
      const execSignal = bgController ? bgController.signal : signal;
      let handedOff = false;
      // With a handoff armed, capture everything the model has not seen yet so the
      // handoff log keeps it. An explicit timeout does not disable the handoff; it
      // stays the process's own hard limit.
      const autoBgArmed = (autoBackgroundMs !== undefined || maxOutputLines !== undefined) && bgTask !== undefined;
      const buffer = autoBgArmed ? new PreHandoffBuffer() : undefined;
      let bgStream: ReturnType<typeof createWriteStream> | undefined;
      // Set once the command's own promise is wired, so the output path can hand off.
      let handOffOnOutput: (() => void) | undefined;
      let outputLines = 0;
      const startedAtMs = Date.now();
      // Pi rejects any other timeout before it starts the command, so the
      // sanitized value goes downstream too: a model that means "unlimited" by
      // passing 0 must not fail the task before it spawns anything.
      const timeoutSeconds = typeof timeout === "number" && Number.isFinite(timeout) && timeout > 0
        ? timeout
        : undefined;
      const timeoutMs = timeoutSeconds === undefined ? undefined : timeoutSeconds * 1000;
      const execution = localOperations.exec(command, cwd, {
        ...executionOptions,
        env: environment,
        signal: execSignal,
        timeout: timeoutSeconds,
        // Callers finalize their output once the command is released; a
        // survivor must not append to it afterwards.
        onData: (data) => {
          if (!released) onData(data);
          if (bgStream) {
            bgStream.write(data);
            if (bgController) noteBgTaskOutput(bgController);
          } else buffer?.push(data);
          if (maxOutputLines !== undefined && !handedOff) {
            outputLines += data.toString("utf8").split("\n").length - 1;
            if (outputLines > maxOutputLines) handOffOnOutput?.();
          }
        },
      });
      if (!execSignal && timeoutMs === undefined && !autoBgArmed) return execution;

      // On Stop or a timeout, pi kills the shell's process tree but then keeps
      // reading until every inherited stdout/stderr handle falls idle. A
      // descendant the kill cannot reach (its own session on POSIX, an orphan
      // `taskkill /T` misses on Windows) can keep writing and hold the tool
      // call, and with it Stop and any steering, until the script ends on its
      // own (#647). The errors are pi's own, so the bash tool reports them as
      // "Command aborted" and "Command timed out".
      return new Promise<BashExecResult>((resolve, reject) => {
        const timers: ReturnType<typeof setTimeout>[] = [];
        const release = () => {
          released = true;
          for (const timer of timers) clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          execSignal?.removeEventListener("abort", onAbort);
        };
        const releaseAfter = (delayMs: number, error: Error) => {
          timers.push(setTimeout(() => {
            release();
            reject(error);
          }, Math.min(delayMs, MAX_TIMER_DELAY_MS)));
        };
        const onAbort = () => {
          if (!handedOff) bgController?.abort();
          releaseAfter(abortSettleGraceMs, new Error("aborted"));
        };
        if (timeoutMs !== undefined) {
          releaseAfter(timeoutMs + abortSettleGraceMs, new Error(`timeout:${timeout}`));
        }
        if (autoBgArmed && buffer && bgTask) {
          const handOff = (reason: "time" | "lines") => {
            if (handedOff) return;
            handedOff = true;
            released = true;
            const logPath = bgLogPath(bgTask.sessionId);
            const stream = createWriteStream(logPath);
            bgStream = stream;
            if (bgController) {
              promoteBgTask(bgController, { command: shownCommand, logPath, startedAtMs, trigger: reason });
            }
            for (const chunk of buffer.dump()) stream.write(chunk);
            execution.then(
              (result) => {
                if (bgController) settleBgTask(bgController, { exitCode: result.exitCode ?? null });
                if (bgController && wasBgTaskKilled(bgController)) return;
                void reportBgTask(bgTask, command, logPath, startedAtMs, result.exitCode ?? null, undefined, stream);
              },
              (error: unknown) => {
                const message = error instanceof Error ? error.message : String(error);
                if (bgController) settleBgTask(bgController, { exitCode: null, error: message });
                if (bgController && wasBgTaskKilled(bgController)) return;
                void reportBgTask(bgTask, command, logPath, startedAtMs, null, message, stream);
              },
            );
            release();
            reject(new Error(`bg-task-backgrounded:${reason}:${logPath}`));
          };
          handOffOnOutput = () => handOff("lines");
          // Output that arrived before this block wired the trigger up has already
          // crossed the limit; checking here is what keeps that window from losing it.
          if (maxOutputLines !== undefined && outputLines > maxOutputLines) handOffOnOutput();
          if (autoBackgroundMs !== undefined) {
            const timer = setTimeout(() => handOff("time"), autoBackgroundMs);
            (timer as { unref?: () => void }).unref?.();
            timers.push(timer);
          }
        }
        if (bgController && bgTask) {
          // Auto-bg completion reports through bg.onEnd; a handoff already
          // rejected the promise, so settle both branches only on non-handoff.
          execution.then(
            () => { if (!handedOff) untrackBgTask(bgTask.sessionId, bgController); },
            () => { if (!handedOff) untrackBgTask(bgTask.sessionId, bgController); },
          );
        }
        execution.then((result) => {
          release();
          resolve(result);
        }, (error: unknown) => {
          release();
          reject(error);
        });
        if (execSignal?.aborted) onAbort();
        else execSignal?.addEventListener("abort", onAbort, { once: true });
        // The tool call's own signal is what Stop fires, and with a bg task the
        // child listens to our controller instead. Forward one into the other;
        // after a handoff onAbort leaves the backgrounded process alone.
        if (signal && signal !== execSignal) {
          if (signal.aborted) onAbort();
          else signal.addEventListener("abort", onAbort, { once: true });
        }
      });
    },
  };
}

/** Closes a task's log and waits for the buffered bytes to reach the file. */
async function drainLog(logStream: ReturnType<typeof createWriteStream>): Promise<void> {
  await new Promise<void>((resolve) => {
    logStream.once("error", () => resolve());
    logStream.end(() => resolve());
  });
}

async function reportBgTask(
  bgTask: { sessionId: string; notify: BgTaskOptions["notify"] },
  command: string,
  logPath: string,
  startedAtMs: number,
  exitCode: number | null,
  error: string | undefined,
  logStream: ReturnType<typeof createWriteStream>,
): Promise<void> {
  // A chatty command still has its output queued in the writer when the process ends,
  // so reading now would report a tail from somewhere in the middle of it.
  await drainLog(logStream);
  const tail = await readLogTail(logPath);
  try {
    const outcome: BgTaskOutcome = {
      command, logPath, startedAtMs, finishedAtMs: Date.now(), exitCode, error,
    };
    await bgTask.notify(bgTask.sessionId, buildBgTaskNotification(outcome, tail), outcome);
  } catch (cause) {
    console.error("[pi-web] failed to deliver bg task notification:", cause instanceof Error ? cause.message : cause);
  }
}

async function readLogTail(path: string, maxBytes = 4096): Promise<string> {
  try {
    const content = await readFile(path);
    return (content.length > maxBytes ? content.subarray(content.length - maxBytes) : content).toString("utf8");
  } catch {
    return "";
  }
}

export function createProjectCommandBashExtension(options: {
  cwd: string;
  settings: ProjectShellSettings;
  bgTasks?: { notify(sessionId: string, text: string, outcome: BgTaskOutcome): Promise<void> };
}): InlineExtension {
  return {
    name: HOST_EXTENSION_NAME,
    hidden: true,
    factory: (pi) => {
      const bg = options.bgTasks;
      const displayDefinition = createBashToolDefinition(options.cwd);
      // One rule per line, its subject first: this description is the only place the tool says
      // how to be used, and rules written as one run-on paragraph are rules the model skips.
      const descriptionLines = [
        `Execute a bash command in \`${options.cwd}\`.`,
        "Already in that directory: `cd` only to enter a subdirectory.",
        `Returns stdout and stderr, cut to the last ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever comes first); full output goes to a temp file.`,
        "Optionally provide a timeout in seconds.",
      ];
      if (bg) {
        descriptionLines.push(
          "Bound the command to see less (`git log --oneline -20`, `find . -maxdepth 2`); never `| tail`, `>` or `>>` — they end the output early and save nothing.",
          `A long-running command: run_in_background=true. A foreground command hands off to the background after ${FOREGROUND_AUTO_BACKGROUND_MS / 1000} seconds and reports back when it finishes.`,
        );
      }
      const description = descriptionLines.join("\n");
      pi.registerTool({
        ...displayDefinition,
        description,
        ...(bg
          ? {
              parameters: Type.Object({
                command: Type.String({ description: "Shell command to execute. Never pipe it through `| tail`; never redirect with `>` or `>>`." }),
                timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (optional, no default timeout)" })),
                run_in_background: Type.Optional(Type.Boolean({ description: "Run this command in the background immediately; you will be notified when it completes." })),
                max_output_lines: Type.Optional(Type.Number({ description: "Line count before the command goes to the background. Always set it unless you already know the output is short." })),
              }),
              promptGuidelines: [
                ...(displayDefinition.promptGuidelines ?? []),
                "NEVER pipe a command through `| tail` or redirect its output with `>` or `>>`. Both end the output early, so nothing is saved to a file. Run the command plain.",
                "To see less, bound the command: `git log --oneline -20`, `gh run list -L 15`, `find . -maxdepth 2`, or pass `max_output_lines` when it has no such flag.",
                "When you can already expect a command to run for a long time (dev server, watcher, long build, large download), DO NOT force a timeout: set run_in_background=true.",
                "A foreground command auto-backgrounds after 120 seconds; treat that as a handoff, not a failure.",
              ],
            }
          : {}),
        // This stands in for pi's built-in bash, so like it, it is active only when named:
        // by `defaultTools` (pi's default list names it), a preset or `set_tools`. Otherwise
        // pi turns it on at every start and reload, as it does any extension tool, whatever
        // `defaultTools` leaves out (#1235).
        defaultActive: false,
        async execute(toolCallId, params, signal, onUpdate, context) {
          const input = params as { command: string; timeout?: number; run_in_background?: boolean; max_output_lines?: number };
          if (bg && input.run_in_background === true) {
            return startBackgroundCommand(options, input, context);
          }
          const executionDefinition = createBashToolDefinition(options.cwd, {
            commandPrefix: options.settings.getShellCommandPrefix(),
            operations: createProjectCommandBashOperations({
              shellPath: options.settings.getShellPath(),
              commandPrefix: options.settings.getShellCommandPrefix(),
              autoBackgroundMs: bg ? FOREGROUND_AUTO_BACKGROUND_MS : undefined,
              maxOutputLines: input.max_output_lines,
              bgTask: bg && context?.sessionManager
                ? { sessionId: context.sessionManager.getSessionId(), notify: bg.notify }
                : undefined,
            }),
          });
          try {
            return await executionDefinition.execute(toolCallId, params, signal, onUpdate, context);
          } catch (error) {
            if (error instanceof Error && error.message.startsWith("bg-task-backgrounded:")) {
              const [, reason, logPath] = error.message.split(":");
              const why = reason === "lines"
                ? `after printing more than ${input.max_output_lines} lines`
                : `after ${FOREGROUND_AUTO_BACKGROUND_MS / 1000}s`;
              return {
                content: [{ type: "text" as const, text: `Command auto-backgrounded ${why}.\nLog file: ${logPath}\nThe result arrives on its own when the command finishes — do not poll, sleep, check the log, or run any other command for it. Do other work that does not need it if you have any; if you have none, stop — no output, no commands — until it arrives. Stopping does not cancel the task.` }],
                details: undefined,
              };
            }
            throw error;
          }
        },
      });
    },
  };
}

function startBackgroundCommand(
  options: { cwd: string; settings: ProjectShellSettings; bgTasks?: { notify(sessionId: string, text: string, outcome: BgTaskOutcome): Promise<void> } },
  params: { command: string; timeout?: number },
  context?: { cwd?: string; sessionManager?: { getSessionId(): string } },
) {
  const sessionId = context?.sessionManager?.getSessionId();
  const cwd = context?.cwd ?? options.cwd;
  const logPath = bgLogPath(sessionId);
  const stream = createWriteStream(logPath);
  const controller = new AbortController();
  const startedAtMs = Date.now();
  if (sessionId) {
    trackBgTask(sessionId, controller, {
      command: params.command,
      logPath,
      startedAtMs,
      background: true,
      trigger: "background",
    });
  }
  const prefix = options.settings.getShellCommandPrefix();
  const commandText = prefix ? `${prefix}\n${params.command}` : params.command;
  const ops = createProjectCommandBashOperations({ shellPath: options.settings.getShellPath() });
  const execution = ops.exec(commandText, cwd, {
    onData: (data) => {
      stream.write(data);
      noteBgTaskOutput(controller);
    },
    signal: controller.signal,
    timeout: params.timeout,
  });
  void (async () => {
    let exitCode: number | null = null;
    let error: string | undefined;
    try {
      const result = await execution;
      exitCode = result.exitCode;
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
      if (error === "aborted") error = "aborted (session stopped)";
      else if (error.startsWith("timeout:")) error = `timed out after ${error.split(":")[1]}s`;
    }
    await drainLog(stream);
    if (sessionId) settleBgTask(controller, { exitCode, error });
    if (sessionId && options.bgTasks && !wasBgTaskKilled(controller)) {
      try {
        const tail = await readLogTail(logPath);
        const outcome: BgTaskOutcome = {
          command: params.command, logPath, startedAtMs, finishedAtMs: Date.now(), exitCode, error,
        };
        await options.bgTasks.notify(sessionId, buildBgTaskNotification(outcome, tail), outcome);
      } catch (cause) {
        console.error("[pi-web] failed to deliver bg task notification:", cause instanceof Error ? cause.message : cause);
      }
    }
  })();
  return Promise.resolve({
    content: [{ type: "text" as const, text: `Command started in background.\nLog file: ${logPath}\nThe result arrives on its own when the command finishes — do not poll, sleep, check the log, or run any other command for it. Do other work that does not need it if you have any; if you have none, stop — no output, no commands — until it arrives. Stopping does not cancel the task.` }],
    details: undefined,
  });
}

export function preferUserBashExtension(base: LoadExtensionsResult): LoadExtensionsResult {
  const hostExtensionIndex = base.extensions.findIndex((extension) => extension.path === HOST_EXTENSION_PATH);
  if (hostExtensionIndex < 0) return base;

  const userBashOwner = base.extensions
    .slice(0, hostExtensionIndex)
    .find((extension) => extension.tools.has("bash"));
  if (!userBashOwner) return base;

  return {
    ...base,
    extensions: base.extensions.filter((_, index) => index !== hostExtensionIndex),
    errors: base.errors.filter((error) => !(
      error.path === HOST_EXTENSION_PATH
      && error.error === `Tool "bash" conflicts with ${userBashOwner.path}`
    )),
  };
}
