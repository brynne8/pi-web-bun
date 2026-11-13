/** A shell command with a leading `cd` to the working directory taken off. */
export interface WorkingDirectoryCdStrip {
  command: string;
  /** Whether one or more `cd` to the working directory came off. */
  stripped: boolean;
}

export interface WorkingDirectoryCdOptions {
  /** Windows: the case and the separator the model typed are as good as the session's own. */
  caseInsensitivePaths?: boolean;
}

// `cd <path>` followed by a separator. A bare `cd` is left alone: an empty command is
// worse than a redundant one. The unquoted path is lazy so `cd /p&&make` ends it at the
// separator instead of swallowing the whole line as one path.
const CD_LEADING = /^[ \t\r\n]*cd[ \t]+(?:"([^"]*)"|'([^']*)'|([^\s]+?))[ \t]*(?:&&|;)[ \t\r\n]*/;

function comparablePath(path: string, caseInsensitive: boolean): string {
  let text = path;
  if (caseInsensitive) text = text.toLowerCase().replace(/\//g, "\\");
  // A trailing separator names the same directory, except on a filesystem root.
  if (text.length > 1 && (text.endsWith("/") || text.endsWith("\\"))) text = text.slice(0, -1);
  return text;
}

/**
 * Takes every leading `cd <cwd> &&` (or `cd <cwd>;`) off `command`, as long as a command
 * follows it. Only the directory the session runs in comes off: a `cd` to a subdirectory
 * is the call's own work and stays.
 */
export function stripWorkingDirectoryCd(
  command: string,
  cwd: string,
  options: WorkingDirectoryCdOptions = {},
): WorkingDirectoryCdStrip {
  const caseInsensitive = options.caseInsensitivePaths === true;
  const target = comparablePath(cwd, caseInsensitive);
  let rest = command;
  let stripped = false;
  for (;;) {
    const match = CD_LEADING.exec(rest);
    if (!match) break;
    const path = match[1] ?? match[2] ?? match[3];
    if (path === undefined || comparablePath(path, caseInsensitive) !== target) break;
    const tail = rest.slice(match[0].length);
    if (tail.length === 0) break;
    rest = tail;
    stripped = true;
  }
  return { command: rest, stripped };
}
