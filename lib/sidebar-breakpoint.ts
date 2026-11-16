// The sidebar's two shapes: on a phone it is an overlay drawer that starts closed, on a
// desktop it is a panel the reader's own preference decides. A drawer action must not
// change the remembered desktop preference, so crossing the breakpoint back restores it.

/** The sidebar state one breakpoint crossing or one toggle produces. */
export interface SidebarBreakpointState {
  isMobile: boolean;
  sidebarOpen: boolean;
  /** The desktop preference a drawer action must leave alone. */
  desktopSidebarOpen: boolean;
}

/** What the breakpoint effect opens the sidebar as, once it resolves after hydration. */
export function sidebarOpenForBreakpoint(isMobile: boolean, desktopSidebarOpen: boolean): boolean {
  return isMobile ? false : desktopSidebarOpen;
}

/**
 * The hamburger's action. On a phone it only opens or closes the drawer; on a desktop
 * it also remembers the preference the next breakpoint crossing restores.
 */
export function toggleSidebar(state: SidebarBreakpointState): SidebarBreakpointState {
  const sidebarOpen = !state.sidebarOpen;
  return {
    isMobile: state.isMobile,
    sidebarOpen,
    desktopSidebarOpen: state.isMobile ? state.desktopSidebarOpen : sidebarOpen,
  };
}
