"use client";

import type { CSSProperties, ReactNode } from "react";

/** The left column: the name of the thing, never the prose around it. */
export const fieldLabelStyle: CSSProperties = {
  padding: "4px 12px 4px 0",
  color: "var(--text-dim)",
  fontSize: 11,
  whiteSpace: "nowrap",
  verticalAlign: "top",
};

const VALUE: CSSProperties = {
  padding: "4px 0",
  color: "var(--text-muted)",
  fontSize: 12,
  fontFamily: "var(--font-mono)",
  overflowWrap: "anywhere",
};

/** A value with newlines of its own: kept as text, scrolled in place, never folded into one line. */
export const valueBlockStyle: CSSProperties = {
  margin: 0,
  padding: "8px 10px",
  maxHeight: 260,
  overflow: "auto",
  border: "1px solid var(--border)",
  borderRadius: 6,
  background: "var(--bg)",
  color: "var(--text-muted)",
  fontSize: 12,
  lineHeight: 1.5,
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
};

export interface KeyValueRow {
  label: string;
  value: ReactNode;
  multiline?: boolean;
}

/**
 * One row per fact: label in the left column, value in mono on the right. This
 * is how a settled background bash task has always read, and anything else that
 * comes as a flat set of fields uses it too — see `lib/tool-fields.ts`.
 */
export function KeyValueTable({ rows }: { rows: KeyValueRow[] }) {
  return (
    <table style={{ borderCollapse: "collapse", tableLayout: "auto" }}>
      <tbody>
        {rows.map((row) => (
          <tr key={row.label}>
            <td style={fieldLabelStyle}>{row.label}</td>
            <td style={VALUE}>{row.multiline ? <pre style={valueBlockStyle}>{row.value}</pre> : row.value}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
