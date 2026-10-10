"use client";

import { useMemo } from "react";
import { fieldLabelStyle, KeyValueTable, valueBlockStyle } from "./KeyValueTable";
import { parseBgTaskReport } from "@/lib/bg-task-notification";

/**
 * A settled background bash task, shown as its facts rather than as the raw
 * report text: the model-only prefix never reaches the screen, and the fields
 * read as a table instead of prose.
 */
export function BgTaskNotificationView({ text, fallback }: { text: string; fallback: React.ReactNode }) {
  const report = useMemo(() => parseBgTaskReport(text), [text]);
  // A report in a shape this build does not know is still worth reading.
  if (!report) return <>{fallback}</>;
  return (
    <div style={{ fontSize: 12 }}>
      <KeyValueTable
        rows={[
          { label: "Outcome", value: `${report.outcome} in ${report.duration}s` },
          { label: "Command", value: report.command },
          { label: "Log file", value: report.logPath },
        ]}
      />
      <div style={{ marginTop: 8 }}>
        <div style={{ ...fieldLabelStyle, padding: "0 0 4px" }}>Output tail</div>
        <pre style={valueBlockStyle}>{report.tail}</pre>
      </div>
    </div>
  );
}
