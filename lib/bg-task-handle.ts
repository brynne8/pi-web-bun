/**
 * A background command's handle: the 8 random characters its log file already carries, behind a
 * `bash-` prefix that tells the model which backend `get_result` will read. Pure string work, so
 * the chat's report card can recognize one without pulling a filesystem module into the browser.
 */

const HANDLE_PREFIX = "bash-";
const HANDLE_PATTERN = /^bash-([0-9a-f]{8})$/;
const LOG_NAME_PATTERN = /-([0-9a-f]{8})\.log$/;

/** The handle for a log path. */
export function bgTaskHandle(logPath: string): string {
  const name = logPath.split(/[\\/]/).pop() ?? "";
  const random = LOG_NAME_PATTERN.exec(name)?.[1] ?? name.replace(/\W/g, "").replace(/\.log$/, "").slice(-8);
  return `${HANDLE_PREFIX}${random}`;
}

/** The 8 hex characters behind a handle, or null when the text is not one. */
export function parseBgTaskHandle(handle: string): string | null {
  return HANDLE_PATTERN.exec(handle.trim())?.[1] ?? null;
}
