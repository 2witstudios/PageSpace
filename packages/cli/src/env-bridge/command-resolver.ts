/**
 * Command path resolution for the exec runner — lifted from
 * `apps/desktop/src/main/command-resolver.ts` (the packaged-app problem: a
 * daemon started from a launcher or a service has a minimal PATH, so `node`,
 * `npx`, `git` must be found in the places they usually live) with one
 * deliberate change: the desktop version shells out to `which`, and this
 * daemon may call `child_process` in exactly ONE file (`exec-runner.ts`). So
 * this is a pure PATH walk over an injected filesystem view. Nothing here
 * runs anything.
 *
 * Resolution is bare-name-or-absolute only. A relative path with a separator
 * (`./run.sh`) is refused (`null`): the runner must never combine an
 * agent-supplied relative path with a cwd itself — if the agent wants a
 * script in the repo, it names it absolutely (and the path still has to
 * confine).
 */
export interface CommandResolverDeps {
  readonly platform: NodeJS.Platform | string;
  /** Reads PATH and (on Windows) PATHEXT. */
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly isExecutableFile: (path: string) => boolean;
  readonly isDirectory: (path: string) => boolean;
  /** Entry names of a directory; may throw (treated as empty). */
  readonly listDir: (path: string) => readonly string[];
}

/** Well-known install locations checked BEFORE the inherited PATH, in this order. */
function commonDirs(deps: CommandResolverDeps): readonly string[] {
  const home = deps.env.HOME;
  const appData = deps.env.APPDATA;
  return [
    '/usr/local/bin',
    '/usr/bin',
    '/opt/homebrew/bin', // Apple Silicon Homebrew
    '/home/linuxbrew/.linuxbrew/bin', // Linux Homebrew
    ...(home ? [`${home}/.nvm/versions/node`, `${home}/.fnm/node-versions`] : []),
    ...(appData ? [`${appData}\\npm`] : []),
    'C:\\Program Files\\nodejs',
  ];
}

const isVersionManagerRoot = (dir: string): boolean => dir.includes('.nvm/versions/node') || dir.includes('.fnm/node-versions');

/** `~/.nvm/versions/node/<v>/bin` and `~/.fnm/node-versions/<v>/installation/bin` for every installed version. */
function expandVersionManagerDirs(base: string, deps: CommandResolverDeps): string[] {
  let entries: readonly string[];
  try {
    if (!deps.isDirectory(base)) return [];
    entries = deps.listDir(base);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const entry of entries) {
    for (const candidate of [`${base}/${entry}/bin`, `${base}/${entry}/installation/bin`]) {
      try {
        if (deps.isDirectory(candidate)) {
          out.push(candidate);
          break;
        }
      } catch {
        // unreadable candidate: skip it
      }
    }
  }
  return out;
}

/** The directories a bare command is searched in: well-known dirs (version managers expanded), then the inherited PATH. */
export function enhancedPathDirs(deps: CommandResolverDeps): readonly string[] {
  const separator = deps.platform === 'win32' ? ';' : ':';
  const expanded: string[] = [];
  for (const dir of commonDirs(deps)) {
    if (isVersionManagerRoot(dir)) expanded.push(...expandVersionManagerDirs(dir, deps));
    else expanded.push(dir);
  }
  const inherited = (deps.env.PATH ?? '').split(separator).filter((entry) => entry.length > 0);
  return [...new Set([...expanded, ...inherited])];
}

/** The PATH string the child is given: the enhanced dirs joined with the platform separator. */
export function enhancedPath(deps: CommandResolverDeps): string {
  return enhancedPathDirs(deps).join(deps.platform === 'win32' ? ';' : ':');
}

/**
 * @returns the absolute path to run, or `null` when the command cannot be
 * resolved to an executable file (the runner reports 127, never guesses).
 */
export function resolveCommand(command: string, deps: CommandResolverDeps): string | null {
  const isAbsolute = command.startsWith('/') || /^[A-Za-z]:[\\/]/.test(command);
  if (isAbsolute) return command;
  if (command.includes('/') || command.includes('\\')) return null;
  const suffixes = deps.platform === 'win32' ? windowsExtensions(deps) : [''];
  for (const dir of enhancedPathDirs(deps)) {
    for (const suffix of suffixes) {
      const candidate = `${dir}/${command}${suffix}`;
      try {
        if (deps.isExecutableFile(candidate)) return candidate;
      } catch {
        // unreadable dir: keep looking
      }
    }
  }
  return null;
}

/** Extensions a bare Windows command may carry, from PATHEXT (a `node` request must find `node.exe`); a sensible default set when PATHEXT is unset. Always includes the empty suffix so an explicit `foo.exe` still matches. */
function windowsExtensions(deps: CommandResolverDeps): string[] {
  const fromEnv = (deps.env.PATHEXT ?? '').split(';').map((ext) => ext.trim()).filter((ext) => ext.length > 0);
  const exts = fromEnv.length > 0 ? fromEnv : ['.COM', '.EXE', '.BAT', '.CMD'];
  return ['', ...exts.map((ext) => (ext.startsWith('.') ? ext : `.${ext}`)), ...exts.map((ext) => (ext.startsWith('.') ? ext : `.${ext}`).toLowerCase())];
}
