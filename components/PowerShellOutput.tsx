"use client";

import { useMemo, type CSSProperties } from "react";
import { hasAnsi, parseAnsiRuns, type AnsiRun, type AnsiStyle } from "@/lib/ansi-text";

/**
 * A PowerShell tool's output with the colours PowerShell wrote it in: SGR codes
 * become styles, every other escape is dropped. This tool's output only — every
 * other card prints the text as it came.
 */

function cssStyle(style?: AnsiStyle): CSSProperties | undefined {
  if (!style) return undefined;
  const css: CSSProperties = {};
  if (style.color) css.color = style.color;
  if (style.background) {
    css.backgroundColor = style.background;
    // A terminal fills the cell; a browser fills the glyphs' box, so a run would
    // start and stop mid-word. The negative margin gives the pixel back.
    css.padding = "0 1px";
    css.margin = "0 -1px";
  }
  if (style.bold) css.fontWeight = "bold";
  if (style.faint) css.opacity = 0.55;
  if (style.italic) css.fontStyle = "italic";
  const decoration = [style.underline && "underline", style.strike && "line-through"].filter(Boolean).join(" ");
  if (decoration) css.textDecoration = decoration;
  return Object.keys(css).length > 0 ? css : undefined;
}

function renderRun(run: AnsiRun, index: number) {
  if (run.href) {
    // An osc 8 target the command wrote: a new tab, like every other link here.
    return (
      <a key={index} href={run.href} target="_blank" rel="noopener noreferrer">
        {run.text}
      </a>
    );
  }
  const css = cssStyle(run.style);
  if (!css) return run.text;
  return <span key={index} style={css}>{run.text}</span>;
}

export function PowerShellOutput({ text }: { text: string }) {
  const runs = useMemo(() => (hasAnsi(text) ? parseAnsiRuns(text) : null), [text]);
  if (!runs) return <>{text}</>;
  return <>{runs.map(renderRun)}</>;
}
