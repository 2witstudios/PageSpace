import { spawn } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { logger } from './logger';

/**
 * Command Path Resolver for Packaged Electron Apps
 *
 * Resolves commands like 'npx', 'node' to their absolute paths before spawning.
 * This is critical for packaged apps which have minimal PATH environments.
 */

// Cache for resolved command paths (performance optimization)
const commandCache = new Map<string, string>();

/**
 * Resolves a command to its absolute path
 * Works cross-platform (Unix: which, Windows: where)
 *
 * @param command - Command name or path to resolve
 * @returns Absolute path to command, or original command if resolution fails
 */
export async function resolveCommand(command: string): Promise<string> {
  // If already absolute path, return as-is
  if (path.isAbsolute(command)) {
    return command;
  }

  // Check cache
  if (commandCache.has(command)) {
    return commandCache.get(command)!;
  }

  // Resolve using which/where
  const resolvedPath = await findCommandPath(command);

  if (resolvedPath) {
    commandCache.set(command, resolvedPath);
    return resolvedPath;
  }

  // Fallback to unresolved command (might still work in some cases)
  logger.warn('Could not resolve command to absolute path, using as-is', { command });
  return command;
}

/**
 * Find command path using which (Unix) or where (Windows)
 */
async function findCommandPath(command: string): Promise<string | null> {
  return new Promise((resolve) => {
    const isWindows = process.platform === 'win32';
    const whichCommand = isWindows ? 'where' : 'which';

    // Construct enhanced PATH for the which/where command
    const enhancedEnv = getEnhancedEnvironment();

    const proc = spawn(whichCommand, [command], {
      env: enhancedEnv,
      stdio: ['ignore', 'pipe', 'ignore'],
    });

    let output = '';
    proc.stdout.on('data', (data) => {
      output += data.toString();
    });

    proc.on('close', (code) => {
      if (code === 0 && output.trim()) {
        // On Windows, 'where' returns multiple paths, take the first one
        const firstPath = output.trim().split('\n')[0].trim();
        resolve(firstPath);
      } else {
        resolve(null);
      }
    });

    proc.on('error', () => {
      resolve(null);
    });
  });
}

/**
 * Constructs enhanced environment with common Node.js paths
 * This helps find npx, node, etc. even in packaged apps
 *
 * @returns Environment object with enhanced PATH
 */
export function getEnhancedEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };

  // Common Node.js installation paths to check
  const commonPaths: (string | null)[] = [
    '/usr/local/bin',
    '/usr/bin',
    '/opt/homebrew/bin', // Apple Silicon Homebrew
    '/home/linuxbrew/.linuxbrew/bin', // Linux Homebrew
    process.env.HOME ? `${process.env.HOME}/.nvm/versions/node` : null,
    process.env.HOME ? `${process.env.HOME}/.fnm/node-versions` : null,
    process.env.APPDATA ? `${process.env.APPDATA}\\npm` : null, // Windows npm global
    'C:\\Program Files\\nodejs', // Windows standard install
  ];

  // Expand version manager paths (nvm, fnm)
  const expandedPaths: string[] = [];
  for (const p of commonPaths) {
    if (!p) continue;

    if (p.includes('.nvm/versions/node') || p.includes('.fnm/node-versions')) {
      // Expand version manager directories
      expandedPaths.push(...expandVersionManagerPaths(p));
    } else {
      expandedPaths.push(p);
    }
  }

  // Construct enhanced PATH
  const existingPath = env.PATH || '';
  const pathSeparator = process.platform === 'win32' ? ';' : ':';
  const enhancedPath = [...expandedPaths, existingPath]
    .filter(Boolean)
    .join(pathSeparator);

  env.PATH = enhancedPath;

  return env;
}

/**
 * Expands version manager paths (nvm, fnm) to actual bin directories
 *
 * For example, expands ~/.nvm/versions/node to all installed versions:
 * - ~/.nvm/versions/node/v22.17.0/bin
 * - ~/.nvm/versions/node/v20.10.0/bin
 *
 * Returns the most recent version's bin directory
 */
function expandVersionManagerPaths(basePath: string): string[] {
  try {
    // Check if base directory exists
    if (!fs.existsSync(basePath)) {
      return [];
    }

    // Read all version directories
    const entries = fs.readdirSync(basePath);

    // Find bin directories
    const binPaths = entries
      .map((entry) => {
        const versionPath = path.join(basePath, entry);
        const binPath = path.join(versionPath, 'bin');

        // Check if bin directory exists
        try {
          if (fs.existsSync(binPath) && fs.statSync(binPath).isDirectory()) {
            return binPath;
          }
        } catch {
          // Ignore errors for invalid paths
        }

        // For fnm, also check 'installation/bin'
        const fnmBinPath = path.join(versionPath, 'installation', 'bin');
        try {
          if (fs.existsSync(fnmBinPath) && fs.statSync(fnmBinPath).isDirectory()) {
            return fnmBinPath;
          }
        } catch {
          // Ignore errors
        }

        return null;
      })
      .filter((p): p is string => p !== null);

    return binPaths;
  } catch (error) {
    logger.warn('Error expanding version manager paths', { basePath, error });
    return [];
  }
}

/**
 * Clear the command cache (useful for testing or when PATH changes)
 */
export function clearCommandCache(): void {
  commandCache.clear();
}
