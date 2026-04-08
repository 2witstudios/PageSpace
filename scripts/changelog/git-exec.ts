import { execFileSync } from "child_process";

/**
 * Execute a git command safely using execFileSync (no shell interpolation).
 * Arguments are passed as an array, bypassing the shell entirely.
 * Returns empty string on error (matching existing exec() behavior).
 */
export function execGit(args: string[]): string {
  try {
    return execFileSync("git", args, {
      encoding: "utf8",
      maxBuffer: 50 * 1024 * 1024,
      stdio: ["pipe", "pipe", "ignore"],
    });
  } catch {
    return "";
  }
}
