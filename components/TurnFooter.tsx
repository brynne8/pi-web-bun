"use client";

import { useState } from "react";
import { copyText } from "@/lib/clipboard";
import { useI18n } from "@/hooks/useI18n";
import { formatTime, formatUsage } from "./MessageView";
import { TurnWrittenFiles } from "./TurnWrittenFiles";
import type { WrittenFile } from "@/lib/turn-written-files";
import type { AssistantMessage } from "@/lib/types";

/**
 * The turn's footer, once at its end: what the last response cost, what the turn
 * changed on disk, and a Copy of everything it wrote.
 *
 * This is deliberately not a message's footer. A turn renders as segments, so
 * whichever part happens to hold the last sentence is not where the turn ends —
 * stop a run while it is thinking and the turn ends on a folded group, and a
 * footer inside a folded group is one nobody can reach. Attached to the parts it
 * was worse still: every part showed its own copy, since pi-web saves one
 * assistant entry per tool call.
 */
export function TurnFooter({ usage, timestamp, text, writtenFiles = [], onOpenFile }: {
  usage?: AssistantMessage["usage"];
  /** When the turn's last response began, which is the time a message used to show. */
  timestamp?: number;
  /** Everything the turn wrote, which is what Copy hands over. */
  text?: string;
  writtenFiles?: WrittenFile[];
  onOpenFile?: (filePath: string, page?: number) => void;
}) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const [hovered, setHovered] = useState(false);
  const usageText = usage ? formatUsage(usage) : "";
  const timeText = formatTime(timestamp);
  // A time on its own is no footer: a turn with nothing else about it shows nothing.
  if (!usageText && !text && writtenFiles.length === 0) return null;

  const copy = () => {
    copyText(text ?? "").then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        // Tucked under the block that precedes it rather than sitting a full block
        // gap below: it describes the turn above, not a new one.
        marginTop: -8,
        marginBottom: 16,
      }}
    >
      {writtenFiles.length > 0 && <TurnWrittenFiles files={writtenFiles} onOpenFile={onOpenFile} />}
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 4 }}>
        {usageText && (
          <div style={{ fontSize: 11, color: "var(--text-dim)" }}>{usageText}</div>
        )}
        {text && (
          <button
            type="button"
            onClick={copy}
            title={t("i18n.copyMessage")}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 4,
              padding: "3px 8px",
              height: 22,
              background: "none",
              border: "none",
              borderRadius: 5,
              color: copied ? "var(--accent)" : "var(--text-dim)",
              cursor: "pointer",
              fontSize: 11,
              fontWeight: 400,
              whiteSpace: "nowrap",
              // As under a message: the affordance is for the reader who wants it,
              // not a permanent label on every turn.
              opacity: hovered ? 1 : 0,
              pointerEvents: hovered ? "auto" : "none",
              transition: "opacity 0.12s, color 0.12s",
            }}
          >
            {copied ? t("i18n.copied") : t("i18n.copy")}
          </button>
        )}
        {timeText && (
          <span style={{ fontSize: 10, color: "var(--text-dim)", marginLeft: "auto" }}>{timeText}</span>
        )}
      </div>
    </div>
  );
}
