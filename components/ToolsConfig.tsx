"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { CodemodeInfo, CodemodeMode, CodemodePreference } from "@/lib/api-types";
import { useI18n } from "@/hooks/useI18n";
import { shortenPath } from "@/lib/display-path";
import { revealHiddenCharacters } from "@/lib/mcp-server-display";
import { focusIfLost } from "@/lib/stacked-dialog";
import type { ToolEntry } from "@/lib/tool-presets";
import type { McpLoadFailure, McpNoticeText } from "./mcp-config-helpers";
import {
  CODEMODE_MODE_DESCRIPTION_KEYS,
  CODEMODE_MODE_KEYS,
  CODEMODE_PREFERENCE_KEYS,
  codemodeAlwaysUnavailableNotice,
  codemodeBuiltinNotice,
  codemodeInlineBudgetDraftChanges,
  codemodeInlineBudgetDraftOf,
  codemodeInlineBudgetNotices,
  codemodeModeChanges,
  codemodeModeNotices,
  codemodeProjectOverrideNotice,
  loadCodemodeInfo,
  parseCodemodeInlineBudgetDraft,
  saveCodemodeInlineBudget,
  saveCodemodeMode,
  saveCodemodePreference,
  type CodemodeSaveState,
} from "./codemode-helpers";
import { ConfigButton, ConfigScopeSwitch } from "./SettingsUi";

type Translate = ReturnType<typeof useI18n>["t"];

/** A path as the page shows it: the home folder as `~`, hidden characters escaped. */
function displayPath(path: string): string {
  return revealHiddenCharacters(shortenPath(path));
}

/** A notice's text, with any `path` parameter shown as `displayPath()` shows it. */
function noticeText({ key, params }: McpNoticeText, t: Translate): string {
  if (!params) return t(key);
  return t(key, params.path === undefined ? params : { ...params, path: displayPath(params.path) });
}

/** A refusal's translated reason, or for an internal or network failure its diagnostic. */
function failureText(failure: McpLoadFailure, t: Translate): string {
  return failure.reason && failure.reason !== "internal" ? t(`mcp.reason.${failure.reason}`) : failure.error;
}

/**
 * Settings › Tools: the Code mode choice, mode and budget (saved to the global
 * settings through `PUT /api/tools/settings`, read when a session starts), and
 * the names of the tools the open session offers the model, read from the
 * session itself. Nothing here starts a session: without one the list says so.
 */
export function ToolsConfig({
  cwd,
  sessionId,
  tools,
  toolsLoading,
  onRequestTools,
}: {
  cwd: string | null;
  sessionId: string | null;
  /** The open session's tools, as the page holds them; null until they are read. */
  tools: ToolEntry[] | null;
  toolsLoading: boolean;
  /** Asks the page for `sessionId`'s tools, as the Tools panel above the chat does. */
  onRequestTools?: () => void;
}) {
  const { t } = useI18n();
  const [codemode, setCodemode] = useState<CodemodeInfo | null>(null);
  const [loadError, setLoadError] = useState<McpLoadFailure | null>(null);
  const [loading, setLoading] = useState(true);
  // A folder the route refused left only the global settings readable, so the
  // saves are global too and ask for no project.
  const [projectRefused, setProjectRefused] = useState(false);
  const [save, setSave] = useState<CodemodeSaveState>({ saving: false, error: null });
  const requestRef = useRef(0);
  const controllerRef = useRef<AbortController | null>(null);
  const saveControllerRef = useRef<AbortController | null>(null);
  const requestedForRef = useRef<string | null>(null);

  const refresh = useCallback(async () => {
    const request = ++requestRef.current;
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    const result = await loadCodemodeInfo(cwd, undefined, controller.signal);
    if (request !== requestRef.current) return;
    setLoading(false);
    if (!result.ok) {
      setLoadError(result.error);
      return;
    }
    setLoadError(null);
    setCodemode(result.codemode);
    setProjectRefused(result.projectError !== undefined);
  }, [cwd]);

  useEffect(() => {
    setLoading(true);
    void refresh();
    return () => {
      requestRef.current += 1;
      controllerRef.current?.abort();
      saveControllerRef.current?.abort();
      saveControllerRef.current = null;
    };
  }, [refresh]);

  // Once per session: a list that failed to load is not asked for again on every render.
  useEffect(() => {
    if (!sessionId || tools !== null || requestedForRef.current === sessionId) return;
    requestedForRef.current = sessionId;
    onRequestTools?.();
  }, [onRequestTools, sessionId, tools]);

  const change = useCallback(async (
    target: NonNullable<CodemodeSaveState["target"]>,
    write: (saveCwd: string | null, signal: AbortSignal) => ReturnType<typeof saveCodemodePreference>,
  ) => {
    const controller = new AbortController();
    saveControllerRef.current = controller;
    setSave({ saving: true, error: null, target });
    const result = await write(projectRefused ? null : cwd, controller.signal);
    // Closed meanwhile: nothing is left to update.
    if (saveControllerRef.current !== controller) return;
    saveControllerRef.current = null;
    setSave({ saving: false, error: result.ok ? null : result.error, target });
    // Read back what is stored: a save that timed out may still land, and one
    // refused because the file no longer parses should show that file's error.
    void refresh();
  }, [cwd, projectRefused, refresh]);

  const saveChoice = (preference: CodemodePreference) =>
    void change("preference", (saveCwd, signal) => saveCodemodePreference(preference, saveCwd, undefined, signal));
  const saveMode = (mode: CodemodeMode) =>
    void change("mode", (saveCwd, signal) => saveCodemodeMode(mode, saveCwd, undefined, signal));
  const saveBudget = (budget: number | null) =>
    void change("inlineBudget", (saveCwd, signal) => saveCodemodeInlineBudget(budget, saveCwd, undefined, signal));

  return (
    <div className="settings-general">
      <section className="settings-general-section">
        <h3 className="settings-general-heading">{t("settings.codemode.title")}</h3>
        <p className="settings-general-description">{t("settings.codemode.intro")}</p>
        {loading ? (
          <p className="settings-general-description">{t("i18n.loading")}</p>
        ) : loadError ? (
          <p role="alert" className="settings-general-error">{t("settings.codemode.loadFailed")} {failureText(loadError, t)}</p>
        ) : codemode ? (
          <CodemodeSection
            codemode={codemode}
            save={save}
            onChoice={saveChoice}
            onMode={saveMode}
            onBudget={saveBudget}
          />
        ) : null}
        {!loading && !loadError && !cwd && (
          <p className="settings-general-description">{t("settings.codemode.projectNotListed")}</p>
        )}
      </section>

      <section className="settings-general-section">
        <h3 className="settings-general-heading">{t("settings.tools.available")}</h3>
        <p className="settings-general-description">{t("settings.tools.availableDescription")}</p>
        {tools && tools.length > 0 ? (
          <ul className="settings-tool-names">
            {tools.map((tool) => (
              <li
                key={tool.name}
                className="settings-tool-name"
                data-off={tool.active ? undefined : true}
                title={tool.description || undefined}
              >
                {tool.name}
                {tool.declarationHidden && <span className="settings-tool-note">{t("settings.tools.scriptOnly")}</span>}
              </li>
            ))}
          </ul>
        ) : (
          <p className="settings-general-description">
            {toolsLoading ? t("i18n.loading") : !sessionId ? t("settings.tools.noSession") : t("settings.tools.notLoaded")}
          </p>
        )}
      </section>
    </div>
  );
}

/**
 * The Code mode settings themselves: the choice, the mode, the budget, the
 * sandbox's self-test and the `-builtin:codemode` switch. Each save holds every
 * control until its answer is in, and shows its progress and failure in the row
 * it was made from.
 */
function CodemodeSection({
  codemode,
  save,
  onChoice,
  onMode,
  onBudget,
}: {
  codemode: CodemodeInfo;
  save: CodemodeSaveState;
  onChoice: (preference: CodemodePreference) => void;
  onMode: (mode: CodemodeMode) => void;
  onBudget: (budget: number | null) => void;
}) {
  const { t } = useI18n();
  const preference = codemode.preference;
  const waiting = save.saving;
  const choiceSave = save.target === undefined || save.target === "preference" ? save : { saving: false, error: null };
  const alwaysUnavailable = codemodeAlwaysUnavailableNotice(codemode);
  const projectOverride = codemodeProjectOverrideNotice(codemode);
  const builtinNotice = codemodeBuiltinNotice(codemode);
  return (
    <div className="settings-codemode-rows">
      <div className="settings-shell-option settings-codemode-row">
        <span>{t("settings.codemode.preference")}</span>
        {preference ? (
          <ConfigScopeSwitch
            value={preference}
            label={t("settings.codemode.preference")}
            options={[
              { value: "automatic", label: t(CODEMODE_PREFERENCE_KEYS.automatic), disabled: waiting },
              {
                value: "always",
                label: t(CODEMODE_PREFERENCE_KEYS.always),
                disabled: waiting || alwaysUnavailable !== undefined,
              },
            ]}
            disabledReason={alwaysUnavailable ? noticeText(alwaysUnavailable, t) : null}
            onChange={(value) => {
              if (value !== preference) onChoice(value);
            }}
          />
        ) : (
          <span className="settings-codemode-warning">
            {t("settings.codemode.preferenceError")}{" "}
            <code className="settings-codemode-chip">{revealHiddenCharacters(codemode.preferenceError ?? "")}</code>
          </span>
        )}
      </div>
      {preference && (
        <p className="settings-general-description">
          {t(preference === "always" ? "settings.codemode.alwaysDescription" : "settings.codemode.automaticDescription")}
        </p>
      )}
      {choiceSave.saving && <p role="status" className="settings-general-description">{t("i18n.saving")}</p>}
      {choiceSave.error && (
        <p role="alert" className="settings-general-error">
          {t("settings.codemode.saveFailed")} <SaveFailure error={choiceSave.error} />
        </p>
      )}
      {projectOverride && <p className="settings-codemode-warning">{noticeText(projectOverride, t)}</p>}

      {codemode.mode ? (
        <ModeRow mode={codemode.mode} codemode={codemode} save={save} waiting={waiting} onChange={onMode} />
      ) : codemode.modeError !== undefined && (
        <p className="settings-codemode-warning">
          {t("settings.codemode.preferenceError")}{" "}
          <code className="settings-codemode-chip">{revealHiddenCharacters(codemode.modeError)}</code>
        </p>
      )}

      {codemode.inlineBudget ? (
        <BudgetRow budget={codemode.inlineBudget} save={save} waiting={waiting} onSave={onBudget} />
      ) : codemode.inlineBudgetError !== undefined && (
        <p className="settings-codemode-warning">
          {t("settings.codemode.preferenceError")}{" "}
          <code className="settings-codemode-chip">{revealHiddenCharacters(codemode.inlineBudgetError)}</code>
        </p>
      )}

      <div className="settings-shell-option settings-codemode-row">
        <span>{t("settings.codemode.sandbox")}</span>
        <span className={codemode.sandbox.state === "unavailable" ? "settings-codemode-warning" : undefined}>
          {codemode.sandbox.state === "unavailable"
            ? t("settings.codemode.sandbox.unavailable")
            : t(codemode.sandbox.state === "available" ? "settings.codemode.sandbox.available" : "settings.codemode.sandbox.not-checked")}
        </span>
      </div>
      {codemode.sandbox.state === "unavailable" && (
        <p className="settings-general-error">
          <code className="settings-codemode-chip">{revealHiddenCharacters(codemode.sandbox.error)}</code>
        </p>
      )}
      {builtinNotice && <p className="settings-codemode-warning">{noticeText(builtinNotice, t)}</p>}
    </div>
  );
}

/** Why a save failed: a timeout may have landed, a refusal is translated, an internal failure shows its diagnostic. */
function SaveFailure({ error }: { error: McpLoadFailure }) {
  const { t } = useI18n();
  if (error.timedOut) return <>{t("settings.codemode.saveTimedOut")}</>;
  if (error.reason && error.reason !== "internal") return <>{t(`mcp.reason.${error.reason}`)}</>;
  return <code className="settings-codemode-chip">{revealHiddenCharacters(error.error)}</code>;
}

/**
 * The built-in tools' row: whether the tools Code mode covers are declared to
 * the model as well ("Direct", pi's default) or reached only from scripts
 * ("In scripts"). Sessions read it when they start.
 */
function ModeRow({
  mode,
  codemode,
  save,
  waiting,
  onChange,
}: {
  mode: NonNullable<CodemodeInfo["mode"]>;
  codemode: CodemodeInfo;
  save: CodemodeSaveState;
  waiting: boolean;
  onChange: (mode: CodemodeMode) => void;
}) {
  const { t } = useI18n();
  const own = save.target === "mode";
  const notices = codemodeModeNotices(codemode);
  return (
    <>
      <div className="settings-shell-option settings-codemode-row">
        <span>{t("settings.codemode.toolMode")}</span>
        <ConfigScopeSwitch
          value={mode.value}
          label={t("settings.codemode.toolMode")}
          options={[
            { value: "on", label: t(CODEMODE_MODE_KEYS.on), disabled: waiting },
            { value: "only", label: t(CODEMODE_MODE_KEYS.only), disabled: waiting },
          ]}
          onChange={(value) => {
            if (codemodeModeChanges(mode, value)) onChange(value);
          }}
        />
      </div>
      <p className="settings-general-description">{t(CODEMODE_MODE_DESCRIPTION_KEYS[mode.value])}</p>
      {notices.map((notice) => (
        <p key={notice.key} className="settings-codemode-warning">{noticeText(notice, t)}</p>
      ))}
      {own && save.saving && <p role="status" className="settings-general-description">{t("i18n.saving")}</p>}
      {own && save.error && (
        <p role="alert" className="settings-general-error">
          {t("settings.codemode.toolMode.saveFailed")} <SaveFailure error={save.error} />
        </p>
      )}
    </>
  );
}

/**
 * The budget: the estimated tokens (characters / 4) the codemode tool's
 * description may spend declaring tools. The field is empty for pi's default,
 * which its placeholder shows; Save (or Enter) writes it, and saving it empty
 * removes the key. It stays read-only rather than disabled while a write is on
 * its way, so it keeps focus, and Save gives focus back to it afterwards.
 */
function BudgetRow({
  budget,
  save,
  waiting,
  onSave,
}: {
  budget: NonNullable<CodemodeInfo["inlineBudget"]>;
  save: CodemodeSaveState;
  waiting: boolean;
  onSave: (budget: number | null) => void;
}) {
  const { t } = useI18n();
  const inputRef = useRef<HTMLInputElement>(null);
  const hintId = useId();
  const stored = codemodeInlineBudgetDraftOf(budget);
  const [draft, setDraft] = useState(stored);
  useEffect(() => {
    setDraft(stored);
  }, [stored]);
  const parsed = parseCodemodeInlineBudgetDraft(draft, budget.max);
  const changes = codemodeInlineBudgetDraftChanges(budget, parsed);
  const own = save.target === "inlineBudget";
  const saving = own && save.saving;
  const wasSavingRef = useRef(saving);
  useEffect(() => {
    const wasSaving = wasSavingRef.current;
    wasSavingRef.current = saving;
    if (wasSaving && !saving) focusIfLost(document, inputRef.current);
  }, [saving]);
  const notices = codemodeInlineBudgetNotices(budget);
  return (
    <>
      <div className="settings-shell-option settings-codemode-row">
        <span>{t("settings.codemode.inlineBudget")}</span>
        <form
          className="settings-codemode-budget"
          onSubmit={(event) => {
            event.preventDefault();
            if (parsed.ok && changes && !waiting) onSave(parsed.value);
          }}
        >
          <input
            ref={inputRef}
            className="settings-codemode-budget-input"
            inputMode="numeric"
            aria-label={t("settings.codemode.inlineBudget")}
            aria-describedby={hintId}
            aria-invalid={parsed.ok ? undefined : true}
            value={draft}
            placeholder={String(budget.default)}
            readOnly={waiting}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => setDraft(event.target.value)}
          />
          <span className="settings-codemode-unit">{t("settings.codemode.inlineBudget.unit")}</span>
          <ConfigButton type="submit" size="small" disabled={!changes || waiting}>
            {t("settings.codemode.inlineBudget.save")}
          </ConfigButton>
          {saving && <span role="status" className="settings-general-description">{t("i18n.saving")}</span>}
        </form>
      </div>
      {!parsed.ok && (
        <p role="alert" className="settings-general-error">
          {t("settings.codemode.inlineBudget.invalidDraft", { max: String(budget.max) })}
        </p>
      )}
      <p id={hintId} className="settings-general-description">
        {t("settings.codemode.inlineBudget.description", { default: String(budget.default) })}
      </p>
      {notices.map((notice) => (
        <p key={notice.key} className="settings-codemode-warning">{noticeText(notice, t)}</p>
      ))}
      {own && save.error && (
        <p role="alert" className="settings-general-error">
          {t("settings.codemode.inlineBudget.saveFailed")} <SaveFailure error={save.error} />
        </p>
      )}
    </>
  );
}
