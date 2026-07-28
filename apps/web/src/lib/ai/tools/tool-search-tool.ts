import { z } from 'zod';
import type { Tool, ToolSet } from 'ai';
import type { SkillSearchEntry } from '../core/skill-catalog';

/**
 * One search over the whole capability corpus: deferred tools (returning
 * their parameter schemas) and skills/commands (returning load_skill
 * pointers). Skills are part of the same primitive as tools — same name
 * rules, same description-driven discovery — so they share the search
 * surface instead of growing a parallel one. Pass `skills` only where the
 * caller also advertises load_skill; with the default empty list the output
 * stays byte-identical to the tools-only behavior.
 */
/**
 * Cap on skill/command entries per search result. The skill corpus includes
 * user/drive commands, which are unbounded per drive — without a cap a broad
 * keyword (or a degenerate empty query, which `includes('')` matches for
 * every entry) could append an arbitrarily large tool result and blow the
 * next request's context, defeating the deliberately-capped catalog.
 */
const MAX_SKILL_MATCHES = 10;

export function createToolSearchTool(
  fullTools: ToolSet,
  skills: readonly SkillSearchEntry[] = []
): Tool {
  return {
    description:
      skills.length > 0
        ? 'Get full parameter schemas for any PageSpace tool before calling it, or find loadable skills/commands by topic. Use "select:name1,name2" for specific names, or a keyword like "calendar", "task", "website" to search descriptions. Skill matches are loaded with load_skill.'
        : 'Get full parameter schemas for any PageSpace tool before calling it. Use "select:name1,name2" for specific tools by name, or a keyword like "calendar", "agent", "task", "channel", "drive" to find all tools in that area.',
    inputSchema: z.object({
      query: z.string().describe(
        'Either "select:name1,name2" for specific tools or a search keyword'
      ),
    }),
    execute: async ({ query }: { query: string }) => {
      // An empty/whitespace query matches everything via includes('') —
      // reject it instead of dumping the whole corpus into the context.
      if (!query.trim()) {
        return { tools: [], error: 'Provide a search keyword or "select:name1,name2".' };
      }

      const matches = resolveMatches(fullTools, query);
      const result = Object.entries(matches).map(([name, t]) => ({
        name,
        description: t.description,
        inputSchema: z.toJSONSchema(t.inputSchema as z.ZodType),
      }));

      const allSkillMatches = resolveSkillMatches(skills, query);
      const skillMatches = allSkillMatches.slice(0, MAX_SKILL_MATCHES).map((skill) => ({
        ...skill,
        usage: `load_skill("${skill.name}")`,
      }));
      const omittedSkills = allSkillMatches.length - skillMatches.length;

      return {
        tools: result,
        ...(skillMatches.length > 0 ? { skills: skillMatches } : {}),
        ...(omittedSkills > 0
          ? { note: `${omittedSkills} more skill/command matches omitted — use a more specific keyword.` }
          : {}),
      };
    },
  };
}

function resolveMatches(tools: ToolSet, query: string): ToolSet {
  if (query.startsWith('select:')) {
    const names = query.slice(7).split(',').map((s) => s.trim());
    return Object.fromEntries(names.filter((n) => tools[n]).map((n) => [n, tools[n]]));
  }
  const kw = query.toLowerCase();
  return Object.fromEntries(
    Object.entries(tools).filter(
      ([name, t]) => name.includes(kw) || (t.description ?? '').toLowerCase().includes(kw)
    )
  );
}

function resolveSkillMatches(
  skills: readonly SkillSearchEntry[],
  query: string
): SkillSearchEntry[] {
  if (skills.length === 0) return [];
  if (query.startsWith('select:')) {
    const names = new Set(query.slice(7).split(',').map((s) => s.trim()));
    return skills.filter((skill) => names.has(skill.name));
  }
  const kw = query.toLowerCase();
  return skills.filter(
    (skill) => skill.name.includes(kw) || skill.description.toLowerCase().includes(kw)
  );
}
