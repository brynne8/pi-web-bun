import type { ReactNode } from "react";

/**
 * The top bar's right-hand group. Its own element carries the row's `marginLeft: auto`
 * anchor, so a button inside it that may not render cannot take the anchor with it.
 */
export function TopBarRightGroup({ children }: { children: ReactNode }) {
  return (
    <div data-top-bar-group="right" style={{ marginLeft: "auto", display: "flex", alignItems: "center", height: "100%", minWidth: 0 }}>
      {children}
    </div>
  );
}
