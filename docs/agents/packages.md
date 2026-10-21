# Pi packages: the standard way to extend pi-web

## The rule
- A tool, a command, a skill, injected system-prompt text or a provider: build a **pi package** — pi already has the mechanism, this repo adds nothing to it, and pi-web needs no code for it.
- pi-web's `extensionFactories` list in `lib/rpc-manager.ts` (`createXxxExtension()`) is plumbing — background bash, the subagent controller, the read-only MCP policy — not a feature slot: what goes there exists only in this repo, cannot be installed from a URL, and cannot be switched off without editing source.

## What a package can change
Standard pi package — the mechanism is entirely pi's, and a package behaves identically under the `pi` CLI and pi-web. An extension default-exports a factory receiving pi's `ExtensionAPI`; there is no build step (pi loads `.ts` through jiti). The core levers:

- **Prompt** — `before_agent_start` forces the system prompt; `context` / `context_with_system` edit what the model sees. The **System** panel shows that forced prompt, so a package's text is visible where the model reads it ([sessions.md](sessions.md#the-system-panel-shows-the-prompt-the-model-receives)).
- **Lifecycle** — `session_start` / `session_shutdown`, `agent_start` / `agent_end`, `turn_start` / `turn_end`, and the compaction and fork/switch guards.
- **Model request** — `before_provider_request` / `before_provider_headers` / `after_provider_response` / `provider_stream_event`; `model_select` / `thinking_level_select` veto or rewrite choices.
- **Tools and messages** — `registerTool`, `registerCommand`, `tool_call` / `tool_result`, `tool_execution_*`, `user_bash`, `input`.

pi-web adds **no hook, event, or field of its own** to the extension API — pi-web-only API is deliberately forbidden so a package behaves the same here as in the CLI (see *Extension compatibility* above). Everything above is pi's; the full event list and the rest of the API are in the SDK's `docs/extensions.md` and `docs/packages.md` under `node_modules/@earendil-works/pi-coding-agent/`, and findable by search.

Minimal extension — a package is a directory with `package.json` and an `extensions/` dir holding this:

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.on("before_agent_start", (event) => ({
    systemPrompt: `${event.systemPrompt}\n\nAnswer first. No greeting.`,
  }));
}
```

## Traps in this repo
- `GET /api/plugins` reports `status: "loaded"` from **file resolution**, not from the factory having run — it says nothing about whether the extension works.
- A factory that throws leaves the extension **silently absent**: no panel symptom, and the error only lands in `LoadExtensionsResult.errors`. Read it by loading standalone — `new DefaultResourceLoader({ cwd, agentDir, settingsManager: SettingsManager.create(cwd, agentDir) })`, `reload()`, then `.getExtensions().errors`.
- To confirm a live session loaded it, without spending a model call: `POST /api/agent/[id]` with `{ "type": "get_commands" }` — extension-registered commands carry `sourceInfo.path`.
- Disabling writes empty resource arrays to the package entry: sessions created afterwards skip it, a running session needs the panel's reload.
