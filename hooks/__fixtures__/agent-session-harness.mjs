import { createRequire } from "node:module";
import { realpathSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createJiti } from "jiti";

// The real useAgentSession(), driven through the hooks stand-in with a fetch stub and an
// EventSource stub in place of the server: a test plays out what the page does and reads
// what the hook returns. `handle` answers the requests a test cares about, before the
// defaults below.
const shimPath = fileURLToPath(new URL("./react-hook-shim.mjs", import.meta.url));
// tryNative: false — Bun imports a .ts file natively and answers its `react` import
// from node_modules, so jiti's alias to the hook shim would never apply. Bun runs the
// whole suite in one process with one module registry, so a file that ran earlier may
// have loaded the hook natively, with the real React; drop that copy so this gets its
// own. Under Node each file has its own process.
const nodeRequire = createRequire(import.meta.url);
delete nodeRequire.cache[realpathSync(fileURLToPath(new URL("../useAgentSession.ts", import.meta.url)))];
const jiti = createJiti(import.meta.url, { tsconfigPaths: true, tryNative: false, alias: { react: shimPath } });
const { renderHook } = await import(pathToFileURL(shimPath).href);
const { useAgentSession } = await jiti.import("../useAgentSession.ts");
const { clearDraft, getDraft } = await jiti.import("@/lib/draft-store");
const { deleteSessionViewSnapshot } = await jiti.import("@/lib/session-view-cache");

export const SESSION = { id: "A", cwd: "/project", path: "/A.jsonl", name: "A" };

// The page globals the hook reads (visibility, the window's online event). Installed
// once for the whole suite and left in place: another test file may have installed its
// own at its module load and would find it gone if this harness took it back.
const PAGE_DOCUMENT = () => Object.assign(new EventTarget(), { visibilityState: "visible" });
function takePageGlobals() {
  globalThis.document ??= PAGE_DOCUMENT();
  globalThis.window ??= new EventTarget();
  return () => {};
}

// The store the composer writes drafts to, loaded through the harness' own jiti so a test
// reads the copy the hook wrote.
export { clearDraft, getDraft };

export const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { "Content-Type": "application/json" },
});

export async function settle(times = 10) {
  for (let index = 0; index < times; index++) await new Promise((resolve) => setImmediate(resolve));
}

export async function setupAgentSession({
  session = SESSION,
  newSessionCwd = session ? null : "/project",
  newSessionDraftKey = session ? null : "new:draft",
  draftKeys = ["A", "s1", "new:draft"],
  modelPayload = { models: {}, modelList: [] },
  props = {},
  // The `/api/sessions/<id>` read's reply, for a test that needs a session file with
  // stats or entries in it. Fields below merge into the empty session's; a function
  // takes the id the read is for, so a session switch answers differently.
  sessionReply = {},
  // What `GET /api/agent/<id>?systemPrompt=0` answers: the usage and live active-time
  // reads (the state read, the reconcile, each stream connect).
  agentState = {},
  handle,
} = {}) {
  let sid = session?.id ?? "s1";
  const replyFor = (value) => (typeof value === "function" ? value(sid) : value);
  const log = [];
  const sources = [];
  const requests = [];
  const realFetch = globalThis.fetch;
  const realEventSource = globalThis.EventSource;
  takePageGlobals();
  globalThis.EventSource = class {
    readyState = 0;
    onmessage = null;
    onerror = null;
    constructor(url) { this.url = url; sources.push(this); }
    close() { this.readyState = 2; }
    emit(event) {
      this.readyState = 1;
      this.onmessage?.({ data: JSON.stringify(event) });
    }
  };
  globalThis.fetch = async (requestUrl, init = {}) => {
    const url = String(requestUrl);
    const entry = { url, method: init.method ?? "GET", body: init.body ? JSON.parse(init.body) : undefined, init };
    requests.push(entry);
    if (entry.method === "POST" && url.startsWith("/api/agent/") && entry.body?.type) log.push(entry.body.type);
    const answered = await handle?.(entry, { sid, log, sources, requests });
    if (answered !== undefined) return answered;
    if (url.startsWith("/api/models")) return json(modelPayload);
    if (url === "/api/agent/new") return json({ sessionId: sid });
    if (url.startsWith(`/api/sessions/${sid}?`)) {
      log.push("read");
      return json({
        sessionId: sid,
        filePath: `/${sid}.jsonl`,
        leafId: null,
        tree: [],
        treeFormat: "summary",
        snapshotRevision: "r",
        context: { messages: [], entryIds: [], oldestEntryId: null, hasMore: false },
        ...(session ?? {}),
        ...replyFor(sessionReply),
      });
    }
    if (url === `/api/sessions/${sid}/state`) return json({ running: false });
    if (url.startsWith(`/api/sessions/${sid}/context`)) {
      return json({ messages: [], entryIds: [], oldestEntryId: null, hasMore: false });
    }
    if (url === `/api/agent/${sid}` && init.method === "POST") {
      return json({ success: true, data: null });
    }
    if (url.startsWith(`/api/agent/${sid}`)) return json({ running: false, state: agentState });
    return json({});
  };
  const initialProps = {
    session,
    newSessionCwd,
    newSessionDraftKey,
    t: (key) => key,
    ...props,
  };
  let currentProps = initialProps;
  const hook = renderHook(useAgentSession, initialProps);
  // The shim renders once per flush, but a read's state writes land in the render
  // after the one that read them: flush until the hook's answer stops moving.
  let rendered = hook;
  const settleAll = async () => {
    await settle();
    for (let round = 0; round < 3; round++) {
      const before = JSON.stringify(rendered.result);
      rendered.flush();
      if (JSON.stringify(rendered.result) === before) break;
    }
  };
  await settleAll();
  // New props for the same page: a refresh key, a callback that changed, a session switch.
  const rerender = async (patch = {}) => {
    if (patch.session) sid = patch.session.id ?? sid;
    currentProps = { ...currentProps, ...patch };
    hook.rerender(currentProps);
    await settleAll();
  };
  const connect = async () => {
    for (const source of sources) if (source.readyState === 0) source.emit({ type: "connected", sessionId: sid, isStreaming: false });
    await settleAll();
  };
  const emit = async (event) => {
    sources.filter((source) => source.readyState === 1).at(-1)?.emit(event);
    await settleAll();
  };
  // The page remounts the hook per session (AppShell keys ChatWindow by sessionKey), so a
  // switch is a fresh mount with the session present, not a prop change.
  const switchTo = async (nextSession) => {
    sid = nextSession?.id ?? "s1";
    hook.unmount();
    for (const source of sources) source.close();
    sources.length = 0;
    currentProps = {
      session: nextSession ?? null,
      newSessionCwd: nextSession ? null : "/project",
      newSessionDraftKey: nextSession ? null : "new:draft",
      t: (key) => key,
      ...(nextSession ? {} : props),
    };
    const next = renderHook(useAgentSession, currentProps);
    env.hook = next;
    rendered = next;
    env.sid = sid;
    await settleAll();
    return env;
  };
  // A page that navigated away or closed the tab: every read still out is stale.
  const unmount = () => {
    hook.unmount();
    for (const source of sources) source.close();
  };
  const teardown = () => {
    unmount();
    for (const key of draftKeys) clearDraft(key);
    for (const key of ["A", "s1", ...draftKeys]) deleteSessionViewSnapshot(key);
    globalThis.fetch = realFetch;
    if (realEventSource === undefined) delete globalThis.EventSource;
    else globalThis.EventSource = realEventSource;
  };
  // The run a page shows: a stream connected and a run started. Kept inside the
  // harness so a test's clock and gates stay armed across it.
  const start = async () => {
    await connect();
    await emit({ type: "agent_start" });
    return env;
  };
  const env = { hook, sid, log, sources, requests, connect, emit, start, unmount, rerender, switchTo, settle: settleAll, teardown, json };
  return env;
}

export async function withAgentSession(options, body) {
  const originalError = console.error;
  console.error = () => {};
  const env = await setupAgentSession(options);
  try {
    return await body(env);
  } finally {
    console.error = originalError;
    env.teardown();
  }
}
