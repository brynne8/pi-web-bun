import { readFileSync } from "node:fs";
import { formatSkillsForPrompt, type DefaultResourceLoader, type InlineExtension, type Skill } from "@earendil-works/pi-coding-agent";
import { parseFrontmatter } from "./frontmatter";
import { subagentNameList } from "./subagents";

/**
 * Prefixed to the skill catalog when it is delivered as its own user turn ahead of the
 * delegated task. The `<skills>` system-prompt section is routinely skipped, which makes the
 * agent guess a skill path or search the filesystem for it; the same listing placed in the
 * turn immediately before the task is read, and its `<location>` is used verbatim.
 */
const SKILL_CATALOG_INSTRUCTION =
  "Below is the catalog of available skills. When a task matches a skill description, read its " +
  "<location> file directly. Never search for a skill, never guess or invent a path, never claim " +
  "it is missing.";

/** One discovery binding and one prompt projection, shared by spawn and reopen. */
export function createSubagentSkillsBinding(options: {
  loadSkills: boolean;
  skills?: readonly string[];
  exactSystemPrompt?: string;
}) {
  // `load_skills: false` wins over a list.
  const names = options.loadSkills && options.skills !== undefined ? subagentNameList(options.skills) : undefined;
  let discovered: Skill[] = [];
  let activeTools: () => readonly string[] = () => [];
  let effectiveExactPrompt = options.exactSystemPrompt;
  const suffix = (): string => {
    if (!options.loadSkills) return "";
    if (names === undefined) {
      // Replace mode keeps the catalog, as pi does under `--system-prompt`.
      const tools = activeTools();
      const reader = tools.includes("read") ? "read" : tools.includes("bash") ? "bash" : undefined;
      return reader ? formatSkillsForPrompt(discovered, reader) : "";
    }
    // Names are only looked up among the skills the SDK discovered, never used as paths.
    return names.map((name) => {
      const skill = discovered.find((item) => item.name === name);
      if (!skill) return `Skill ${JSON.stringify(name)} not found in SDK discovery.`;
      try {
        const { rest } = parseFrontmatter(readFileSync(skill.filePath, "utf8"));
        return `## Skill: ${name}\nLocation: ${skill.filePath}\nBase directory for relative references: ${skill.baseDir}\n\n${rest.trim()}`;
      } catch (error) {
        return `Skill ${JSON.stringify(name)} unreadable at ${skill.filePath}: ${error instanceof Error ? error.message : String(error)}`;
      }
    }).join("\n\n");
  };
  const compose: InlineExtension = {
    name: "pi-web-subagent-skills",
    hidden: true,
    factory: (pi) => {
      pi.on("before_agent_start", (event) => {
        const skillsText = suffix();
        if (!skillsText && options.exactSystemPrompt === undefined) return undefined;
        const base = options.exactSystemPrompt ?? event.systemPrompt;
        const prompt = skillsText ? `${base}\n\n${skillsText}` : base;
        if (options.exactSystemPrompt !== undefined) effectiveExactPrompt = prompt;
        return { systemPrompt: prompt };
      });
    },
  };
  const needsProjection = names !== undefined || options.exactSystemPrompt !== undefined;
  const loaderOptions: Pick<ConstructorParameters<typeof DefaultResourceLoader>[0], "noSkills" | "skillsOverride" | "extensionFactories"> = {
    // Off means pi's `noSkills`, which still keeps the skills an extension provides.
    noSkills: !options.loadSkills,
    ...(options.loadSkills && needsProjection ? {
      skillsOverride: (base) => {
        // Keep SDK collision winners and diagnostics, but hide the catalog in named mode.
        discovered = base.skills;
        return names !== undefined ? { ...base, skills: [] } : base;
      },
    } : {}),
    ...(needsProjection ? { extensionFactories: [compose] } : {}),
  };
  return {
    loaderOptions,
    setActiveToolsGetter(getter: () => readonly string[]) { activeTools = getter; },
    /**
     * The skill catalog as a standalone user turn, or undefined when it is not applicable:
     * skills are off, nothing was discovered, or the profile names its skills (named mode
     * already inlines each skill's body and `Location` into the system prompt).
     */
    getSkillCatalogMessage(): string | undefined {
      if (!options.loadSkills || names !== undefined) return undefined;
      const tools = activeTools();
      const reader = tools.includes("read") ? "read" : tools.includes("bash") ? "bash" : undefined;
      if (!reader || discovered.length === 0) return undefined;
      return `${SKILL_CATALOG_INSTRUCTION}\n\n${formatSkillsForPrompt(discovered, reader)}`;
    },
    getExactSystemPrompt: options.exactSystemPrompt === undefined ? undefined : () => effectiveExactPrompt!,
  };
}
