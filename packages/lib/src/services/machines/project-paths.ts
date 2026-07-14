/**
 * Machine project path confinement (pure).
 *
 * A Project is a git repo cloned into a fixed subtree of a Machine's
 * persistent filesystem. The directory name comes from the caller (the
 * navigator UI / an agent), so it is `normalizeProjectName`d into a strict
 * slug BEFORE being joined onto `PROJECTS_ROOT` — no path separators, no `..`,
 * no leading dot — and the join is re-checked with the shared
 * `resolvePathWithinSync` confinement helper (belt-and-suspenders, matching
 * sandbox-paths.ts). `isValidProjectName` remains the contract the normalizer
 * must satisfy, and the second gate `resolveProjectPath` still runs.
 *
 * `isValidProjectName`/`normalizeProjectName` themselves live in
 * `./project-name` (re-exported here for existing call sites) — that module
 * has zero node-builtin imports, so a client component can import it directly
 * for a live-typing name preview without dragging `resolvePathWithinSync`'s
 * `fs`/`path` dependency into the browser bundle.
 */

import { resolvePathWithinSync } from '../../security/path-validator';
import { isValidId } from '../../validators/id-validators';
import { isValidProjectName, MAX_PROJECT_NAME_LENGTH } from './project-name';

export { isValidProjectName, normalizeProjectName, MAX_PROJECT_NAME_LENGTH } from './project-name';

/** Root directory on a Machine's filesystem under which every Project is cloned. */
export const PROJECTS_ROOT = '/workspace/projects';

/**
 * Resolve a project directory name to its absolute path, or `null` if the
 * name is invalid or escapes the root. This is the ONE confinement gate:
 * `resolveProjectClonePath` funnels through it, and legacy rows (created
 * before per-row paths) persisted exactly this `PROJECTS_ROOT/<name>` shape.
 * Do NOT use it to re-derive a live project's directory from its name — since
 * per-row paths, only the row's persisted `path` column says where a project
 * lives.
 */
export function resolveProjectPath(name: string): string | null {
  if (!isValidProjectName(name)) return null;
  return resolvePathWithinSync(PROJECTS_ROOT, name);
}

/** A lossy cut must not strand a separator edge — mirrors `truncateWithDigest`. */
const TRAILING_PROJECT_SEPARATORS_RE = /[._-]+$/;

/**
 * Resolve the clone path for one project ROW: `PROJECTS_ROOT/<name>-<id>`.
 *
 * The id suffix is what makes the directory unique per row rather than per
 * name — two concurrent adds of the SAME name land in two different
 * directories, so neither operation can ever clone into (or `rm -rf`) a
 * directory the other owns. The name prefix is kept purely for human
 * legibility in a shell; nothing resolves a path from a name anymore — every
 * consumer reads the row's persisted `path`.
 *
 * The row id crosses a trust boundary into an `rm -rf` argument, so it is
 * validated with the shared cuid2 predicate (`isValidId`) rather than assumed
 * to be well-formed. This resolver stays total and fails closed on a bad id;
 * `planAddProject` is the layer that turns that into a loud wiring error.
 *
 * The combined directory name is capped at `MAX_PROJECT_NAME_LENGTH` by
 * truncating the NAME portion (the id must survive intact — it is the
 * uniqueness; a truncated name prefix costs nothing because the DB enforces
 * name uniqueness on the FULL name), and the join goes through
 * `resolveProjectPath` — one shared validity + confinement gate.
 */
export function resolveProjectClonePath(name: string, id: string): string | null {
  if (!isValidProjectName(name)) return null;
  if (!isValidId(id)) return null;

  const room = MAX_PROJECT_NAME_LENGTH - id.length - '-'.length;
  if (room < 1) return null;

  const stem =
    name.length > room ? name.slice(0, room).replace(TRAILING_PROJECT_SEPARATORS_RE, '') : name;
  return resolveProjectPath(`${stem}-${id}`);
}

const HTTPS_REPO_URL_RE = /^https:\/\/.+/;

/** Only HTTPS remotes are supported — mirrors the agent `git_clone` tool's constraint. */
export function isValidRepoUrl(repoUrl: string): boolean {
  return typeof repoUrl === 'string' && HTTPS_REPO_URL_RE.test(repoUrl);
}
