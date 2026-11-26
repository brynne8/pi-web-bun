import type { Translate } from "@/lib/i18n/types";

interface Props {
  loading: boolean;
  prompt: string | null;
  translate: Translate;
}

// pi escapes the <available_skills> block as XML, so every quote in a skill
// description reaches us as &quot;. This panel is for reading the prompt, so
// unfold those entities back. One pass, left to right: "&amp;quot;" came from a
// literal "&quot;" in the source and must not unfold a second time.
const promptEntities = /&(?:amp|lt|gt|quot|#39|apos);/g;
const promptEntityText: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
};

function decodePromptEntities(text: string): string {
  return text.replace(promptEntities, (entity) => promptEntityText[entity] ?? entity);
}

export function SystemPromptPanel({ loading, prompt, translate }: Props) {
  return (
    <section className="system-prompt-panel" aria-label={translate("system.prompt")}>
      <div className="system-prompt-scroll">
        {prompt ? (
          <div className="system-prompt-text">{decodePromptEntities(prompt)}</div>
        ) : (
          <div className="system-prompt-empty">
            {prompt === ""
              ? translate("system.empty")
              : loading
                ? translate("system.loading")
                : translate("system.load")}
          </div>
        )}
      </div>

      <style>{`
        .system-prompt-panel {
          display: flex;
          height: min(600px, 75dvh);
          min-height: 220px;
          flex-direction: column;
          background: var(--bg-panel);
          border-bottom: 1px solid var(--border);
        }
        .system-prompt-scroll {
          min-height: 0;
          flex: 1;
          overflow: auto;
          padding: 12px 16px;
        }
        .system-prompt-text {
          color: var(--text-muted);
          font-family: var(--font-mono);
          font-size: 12px;
          line-height: 1.6;
          overflow-wrap: anywhere;
          white-space: pre-wrap;
        }
        .system-prompt-empty {
          padding: 10px 0;
          color: var(--text-muted);
          font-size: 12px;
          font-style: italic;
        }
      `}</style>
    </section>
  );
}
