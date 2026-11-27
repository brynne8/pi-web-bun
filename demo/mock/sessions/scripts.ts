import type { SessionScript } from "./types.ts";
import { welcomeSession } from "./content/welcome.ts";
import { filesSession } from "./content/files.ts";
import { modelsSession } from "./content/models.ts";
import { branchingForkSession, branchingSession } from "./content/branching.ts";
import { featureSession } from "./content/feature.ts";
import { extendSession, extendSubagentSession } from "./content/extend.ts";
import { tipsSession } from "./content/tips.ts";
import { scratchSession } from "./content/scratch.ts";

/** Every tutorial session, in the order they were "created". */
export const SESSION_SCRIPTS: SessionScript[] = [
  scratchSession,
  tipsSession,
  extendSession,
  extendSubagentSession,
  featureSession,
  branchingSession,
  branchingForkSession,
  modelsSession,
  filesSession,
  welcomeSession,
];
