"use client";

import { useMemo, type CSSProperties } from "react";
import { hasAnsi, isErrorStreamStyle, parseAnsiRuns, type AnsiRun, type AnsiStyle } from "@/lib/ansi-text";

/**
 * A PowerShell tool's output with the colours PowerShell wrote it in: SGR codes
 * become styles, every other escape is dropped. This tool's output only — every
 * other card prints the text as it came.
 *
 * `succeeded` says whether the command exited 0. It is false unless told, so a
 * caller that does not know keeps every colour as it was.
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

/**
 * `$PSStyle.Error` without its colour and weight, so the line is drawn as the
 * text around it. Every other attribute the command set is kept.
 */
function withoutErrorStreamStyle(style: AnsiStyle): AnsiStyle | undefined {
  const plain: AnsiStyle = {};
  if (style.background) plain.background = style.background;
  if (style.faint) plain.faint = true;
  if (style.italic) plain.italic = true;
  if (style.underline) plain.underline = true;
  if (style.strike) plain.strike = true;
  return Object.keys(plain).length > 0 ? plain : undefined;
}

export function PowerShellOutput({ text, succeeded = false }: { text: string; succeeded?: boolean }) {
  const runs = useMemo(() => (hasAnsi(text) ? parseAnsiRuns(text) : null), [text]);
  // A `2>&1` redirect merges a command's stderr into its output, and PowerShell
  // marks every merged line with `$PSStyle.Error`. When the command itself exited
  // 0 that mark says which stream a line came from, not that it failed, so such a
  // line is drawn as the text around it. A failed run keeps the colour, and so
  // does a caller that leaves the outcome unsaid (the default).
  const drawn = succeeded && runs
    ? runs.map((run) => (isErrorStreamStyle(run.style) ? { ...run, style: withoutErrorStreamStyle(run.style) } : run))
    : runs;
  if (!drawn) return <>{text}</>;
  return <>{drawn.map(renderRun)}</>;
}
