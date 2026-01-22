#!/usr/bin/env tsx
/**
 * Generate Evidence Index
 *
 * Creates evidence-index.json from git history containing:
 * - File lifecycles (created, modified, deleted)
 * - Abandoned approaches (files created then deleted within 30 days)
 * - Multiple attempts (commits with "again", "retry", "fix" patterns)
 * - Candid commit messages
 * - Architecture shifts (changes to key directories over time)
 */

import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

interface FileEvent {
  commit: string;
  date: string;
  message: string;
  action: "added" | "modified" | "deleted" | "renamed";
}

interface FileLifecycle {
  path: string;
  created?: { commit: string; date: string; message: string };
  deleted?: { commit: string; date: string; message: string };
  modifications: number;
  events: FileEvent[];
}

interface AbandonedApproach {
  file: string;
  created: { commit: string; date: string; message: string };
  deleted: { commit: string; date: string; message: string };
  daysActive: number;
  totalLinesWritten?: number;
}

interface MultipleAttempt {
  pattern: string;
  commits: Array<{
    commit: string;
    date: string;
    message: string;
    filesChanged: string[];
  }>;
}

interface CandidMessage {
  commit: string;
  date: string;
  message: string;
  keywords: string[];
}

interface EvidenceIndex {
  generated: string;
  totalCommits: number;
  totalFilesTracked: number;
  fileLifecycles: Record<string, FileLifecycle>;
  abandonedApproaches: AbandonedApproach[];
  multipleAttempts: MultipleAttempt[];
  candidMessages: CandidMessage[];
  mostChurnedFiles: Array<{ path: string; modifications: number }>;
}

// Candid message patterns - real developer emotions
const CANDID_PATTERNS = [
  /again/i,
  /cant|can't|cannot/i,
  /broken/i,
  /hack|hacky/i,
  /workaround/i,
  /temporary|temp\s/i,
  /lol|haha/i,
  /finally/i,
  /actually\s+work/i,
  /still\s+broken/i,
  /give\s+up/i,
  /figure\s*(it\s+)?out/i,
  /crashing/i,
  /ram|memory/i,
  /tried|attempt/i,
  /revert/i,
  /undo/i,
  /oops/i,
  /forgot/i,
  /mistake/i,
  /wrong/i,
];

// Multiple attempt patterns
const ATTEMPT_PATTERNS = [
  /again/i,
  /retry/i,
  /attempt/i,
  /\bfix\b.*\bfix\b/i,
  /second|third|another/i,
  /still/i,
  /properly/i,
  /correctly/i,
  /actually/i,
];

function exec(cmd: string): string {
  try {
    return execSync(cmd, { encoding: "utf8", maxBuffer: 50 * 1024 * 1024 });
  } catch (error) {
    console.error(`Command failed: ${cmd}`);
    return "";
  }
}

function parseDate(dateStr: string): Date {
  return new Date(dateStr);
}

function daysBetween(date1: string, date2: string): number {
  const d1 = parseDate(date1);
  const d2 = parseDate(date2);
  const diffTime = Math.abs(d2.getTime() - d1.getTime());
  return Math.ceil(diffTime / (1000 * 60 * 60 * 24));
}

function getCommitsWithFiles(): Array<{
  commit: string;
  date: string;
  message: string;
  files: Array<{ action: string; file: string }>;
}> {
  console.log("Fetching commit history with file changes...");

  // Get all commits with their changed files
  const rawLog = exec(
    `git log --format="COMMIT:%H|%ad|%s" --date=short --name-status`
  );

  const commits: Array<{
    commit: string;
    date: string;
    message: string;
    files: Array<{ action: string; file: string }>;
  }> = [];

  let currentCommit: (typeof commits)[0] | null = null;

  for (const line of rawLog.split("\n")) {
    if (line.startsWith("COMMIT:")) {
      if (currentCommit) {
        commits.push(currentCommit);
      }
      const [, rest] = line.split("COMMIT:");
      const [commit, date, ...messageParts] = rest.split("|");
      currentCommit = {
        commit: commit.trim(),
        date: date.trim(),
        message: messageParts.join("|").trim(),
        files: [],
      };
    } else if (currentCommit && line.trim()) {
      const match = line.match(/^([AMDRC])\t(.+)$/);
      if (match) {
        currentCommit.files.push({
          action: match[1],
          file: match[2],
        });
      }
      // Handle renames: R100 old-path new-path
      const renameMatch = line.match(/^R\d+\t(.+)\t(.+)$/);
      if (renameMatch) {
        currentCommit.files.push({
          action: "R",
          file: `${renameMatch[1]} -> ${renameMatch[2]}`,
        });
      }
    }
  }

  if (currentCommit) {
    commits.push(currentCommit);
  }

  console.log(`Found ${commits.length} commits`);
  return commits;
}

function buildFileLifecycles(
  commits: Array<{
    commit: string;
    date: string;
    message: string;
    files: Array<{ action: string; file: string }>;
  }>
): Record<string, FileLifecycle> {
  console.log("Building file lifecycles...");

  const lifecycles: Record<string, FileLifecycle> = {};

  // Process commits in chronological order (oldest first)
  const chronological = [...commits].reverse();

  for (const commit of chronological) {
    for (const file of commit.files) {
      const filePath = file.file.includes(" -> ")
        ? file.file.split(" -> ")[1]
        : file.file;

      if (!lifecycles[filePath]) {
        lifecycles[filePath] = {
          path: filePath,
          modifications: 0,
          events: [],
        };
      }

      const lifecycle = lifecycles[filePath];
      let action: FileEvent["action"] = "modified";

      switch (file.action) {
        case "A":
          action = "added";
          if (!lifecycle.created) {
            lifecycle.created = {
              commit: commit.commit,
              date: commit.date,
              message: commit.message,
            };
          }
          break;
        case "D":
          action = "deleted";
          lifecycle.deleted = {
            commit: commit.commit,
            date: commit.date,
            message: commit.message,
          };
          break;
        case "M":
          action = "modified";
          lifecycle.modifications++;
          break;
        case "R":
          action = "renamed";
          break;
      }

      lifecycle.events.push({
        commit: commit.commit,
        date: commit.date,
        message: commit.message,
        action,
      });
    }
  }

  console.log(`Tracked ${Object.keys(lifecycles).length} files`);
  return lifecycles;
}

function detectAbandonedApproaches(
  lifecycles: Record<string, FileLifecycle>
): AbandonedApproach[] {
  console.log("Detecting abandoned approaches...");

  const abandoned: AbandonedApproach[] = [];

  for (const [filePath, lifecycle] of Object.entries(lifecycles)) {
    // Skip non-source files
    if (
      filePath.includes("node_modules") ||
      filePath.includes(".next") ||
      filePath.includes("dist/") ||
      filePath.endsWith(".lock") ||
      filePath.endsWith(".json") && !filePath.includes("schema")
    ) {
      continue;
    }

    if (lifecycle.created && lifecycle.deleted) {
      const daysActive = daysBetween(
        lifecycle.created.date,
        lifecycle.deleted.date
      );

      // Files created and deleted within 60 days are potentially abandoned approaches
      if (daysActive <= 60) {
        abandoned.push({
          file: filePath,
          created: lifecycle.created,
          deleted: lifecycle.deleted,
          daysActive,
        });
      }
    }
  }

  // Sort by most recent first
  abandoned.sort(
    (a, b) =>
      parseDate(b.deleted.date).getTime() - parseDate(a.deleted.date).getTime()
  );

  console.log(`Found ${abandoned.length} abandoned approaches`);
  return abandoned;
}

function detectMultipleAttempts(
  commits: Array<{
    commit: string;
    date: string;
    message: string;
    files: Array<{ action: string; file: string }>;
  }>
): MultipleAttempt[] {
  console.log("Detecting multiple attempts...");

  const patterns: Record<string, MultipleAttempt["commits"]> = {};

  for (const commit of commits) {
    for (const pattern of ATTEMPT_PATTERNS) {
      if (pattern.test(commit.message)) {
        const patternKey = pattern.source;
        if (!patterns[patternKey]) {
          patterns[patternKey] = [];
        }
        patterns[patternKey].push({
          commit: commit.commit,
          date: commit.date,
          message: commit.message,
          filesChanged: commit.files.map((f) => f.file),
        });
      }
    }
  }

  // Convert to array and filter for significance (>2 occurrences)
  const results: MultipleAttempt[] = Object.entries(patterns)
    .filter(([_, commits]) => commits.length >= 2)
    .map(([pattern, commits]) => ({
      pattern,
      commits,
    }))
    .sort((a, b) => b.commits.length - a.commits.length);

  console.log(`Found ${results.length} multiple attempt patterns`);
  return results;
}

function detectCandidMessages(
  commits: Array<{
    commit: string;
    date: string;
    message: string;
    files: Array<{ action: string; file: string }>;
  }>
): CandidMessage[] {
  console.log("Detecting candid commit messages...");

  const candid: CandidMessage[] = [];

  for (const commit of commits) {
    const keywords: string[] = [];

    for (const pattern of CANDID_PATTERNS) {
      if (pattern.test(commit.message)) {
        keywords.push(pattern.source.replace(/\\s\*/g, " ").replace(/\\/g, ""));
      }
    }

    if (keywords.length > 0) {
      candid.push({
        commit: commit.commit,
        date: commit.date,
        message: commit.message,
        keywords,
      });
    }
  }

  // Sort by date
  candid.sort(
    (a, b) => parseDate(b.date).getTime() - parseDate(a.date).getTime()
  );

  console.log(`Found ${candid.length} candid messages`);
  return candid;
}

function getMostChurnedFiles(
  lifecycles: Record<string, FileLifecycle>
): Array<{ path: string; modifications: number }> {
  console.log("Finding most churned files...");

  return Object.values(lifecycles)
    .filter(
      (l) =>
        l.modifications > 5 &&
        !l.path.includes("node_modules") &&
        !l.path.includes(".next") &&
        !l.path.endsWith(".lock")
    )
    .sort((a, b) => b.modifications - a.modifications)
    .slice(0, 100)
    .map((l) => ({
      path: l.path,
      modifications: l.modifications,
    }));
}

async function main() {
  console.log("=== Generating Evidence Index ===\n");

  const outputDir = path.join(process.cwd(), "docs/changelog/evidence");
  const outputFile = path.join(outputDir, "evidence-index.json");

  // Create output directory
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  // Get commit history
  const commits = getCommitsWithFiles();

  // Build file lifecycles
  const lifecycles = buildFileLifecycles(commits);

  // Detect patterns
  const abandonedApproaches = detectAbandonedApproaches(lifecycles);
  const multipleAttempts = detectMultipleAttempts(commits);
  const candidMessages = detectCandidMessages(commits);
  const mostChurnedFiles = getMostChurnedFiles(lifecycles);

  // Build evidence index
  const evidenceIndex: EvidenceIndex = {
    generated: new Date().toISOString(),
    totalCommits: commits.length,
    totalFilesTracked: Object.keys(lifecycles).length,
    fileLifecycles: lifecycles,
    abandonedApproaches,
    multipleAttempts,
    candidMessages,
    mostChurnedFiles,
  };

  // Write output
  fs.writeFileSync(outputFile, JSON.stringify(evidenceIndex, null, 2));
  console.log(`\n✓ Evidence index written to ${outputFile}`);

  // Print summary
  console.log("\n=== Summary ===");
  console.log(`Total commits: ${evidenceIndex.totalCommits}`);
  console.log(`Total files tracked: ${evidenceIndex.totalFilesTracked}`);
  console.log(`Abandoned approaches: ${abandonedApproaches.length}`);
  console.log(`Multiple attempt patterns: ${multipleAttempts.length}`);
  console.log(`Candid messages: ${candidMessages.length}`);

  // Show top abandoned approaches
  if (abandonedApproaches.length > 0) {
    console.log("\n--- Top 5 Abandoned Approaches ---");
    for (const approach of abandonedApproaches.slice(0, 5)) {
      console.log(`  ${approach.file}`);
      console.log(`    Created: ${approach.created.date} - "${approach.created.message}"`);
      console.log(`    Deleted: ${approach.deleted.date} - "${approach.deleted.message}"`);
      console.log(`    Active for: ${approach.daysActive} days\n`);
    }
  }

  // Show top candid messages
  if (candidMessages.length > 0) {
    console.log("\n--- Sample Candid Messages ---");
    for (const msg of candidMessages.slice(0, 5)) {
      console.log(`  ${msg.date}: "${msg.message}"`);
      console.log(`    Keywords: ${msg.keywords.join(", ")}\n`);
    }
  }
}

main().catch(console.error);
