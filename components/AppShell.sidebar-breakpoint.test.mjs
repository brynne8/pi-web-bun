import assert from "node:assert/strict";
import test from "node:test";
import { sidebarOpenForBreakpoint, toggleSidebar } from "../lib/sidebar-breakpoint.ts";

// The sidebar's two shapes: on a phone it is an overlay drawer that starts closed, on a
// desktop it is a panel the reader's own preference decides. A drawer action must not
// change the remembered desktop preference.

/** One page, as the breakpoint resolves and the reader uses the hamburger. */
function page(collapsed = false) {
  let state = {
    isMobile: false,
    sidebarOpen: !collapsed,
    desktopSidebarOpen: !collapsed,
  };
  return {
    get state() { return state; },
    resize: (mobile) => {
      state = { ...state, isMobile: mobile, sidebarOpen: sidebarOpenForBreakpoint(mobile, state.desktopSidebarOpen) };
    },
    toggle: () => { state = toggleSidebar(state); },
  };
}

test("closing a mobile drawer restores the previously open desktop sidebar", () => {
  const shell = page();
  shell.resize(true);
  assert.equal(shell.state.sidebarOpen, false);
  shell.toggle();
  assert.equal(shell.state.sidebarOpen, true);
  shell.toggle();
  assert.equal(shell.state.sidebarOpen, false);
  shell.resize(false);
  assert.equal(shell.state.sidebarOpen, true);
});

test("opening a mobile drawer does not reopen an explicitly collapsed desktop sidebar", () => {
  const shell = page();
  shell.toggle();
  assert.equal(shell.state.sidebarOpen, false);
  shell.resize(true);
  shell.toggle();
  shell.resize(false);
  assert.equal(shell.state.sidebarOpen, false);
  shell.toggle();
  shell.resize(true);
  shell.resize(false);
  assert.equal(shell.state.sidebarOpen, true);
});

test("URL sidebar collapse survives hydration and repeated breakpoint crossings", () => {
  const shell = page(true);
  shell.resize(false);
  assert.equal(shell.state.sidebarOpen, false);
  shell.resize(true);
  shell.toggle();
  shell.resize(false);
  assert.equal(shell.state.sidebarOpen, false);
  shell.resize(true);
  shell.resize(false);
  assert.equal(shell.state.sidebarOpen, false);
});

test("a drawer action never writes the desktop preference", () => {
  const shell = page();
  shell.resize(true);
  shell.toggle();
  shell.toggle();
  assert.equal(shell.state.desktopSidebarOpen, true, "the drawer's own state is not remembered as the desktop's");
  shell.resize(false);
  assert.equal(shell.state.sidebarOpen, true);
});
