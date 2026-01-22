#!/usr/bin/env tsx
/**
 * Track File Evolution
 *
 * Generates per-file markdown histories for files with >5 commits
 * Shows:
 * - Size evolution over time
 * - Key patterns (features added then removed)
 * - Commit history with diffs
 */

import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

interface FileCommit {
  commit: string;
  date: string;
  message: string;
  linesAdded: number;
  linesDeleted: number;
  action: "A" | "M" | "D" | "R";
}

interface FileHistory {
  path: string;
  commits: FileCommit[];
  totalCommits: number;
  totalLinesAdded: number;
  totalLinesDeleted: number;
  created?: { date: string; commit: string };
  deleted?: { date: string; commit: string };
}

function exec(cmd: string): string {
  try {
    return execSync(cmd, { encoding: "utf8", maxBuffer: 50 * 1024 * 1024 });
  } catch {
    return "";
  }
}

function getFileHistory(filePath: string): FileHistory {
  // Get all commits that touched this file
  const log = exec(
    `git log --follow --format="COMMIT:%H|%ad|%s" --date=short --numstat -- "${filePath}"`
  );

  const commits: FileCommit[] = [];
  let currentCommit: Partial<FileCommit> | null = null;

  for (const line of log.split("\n")) {
    if (line.startsWith("COMMIT:")) {
      if (currentCommit && currentCommit.commit) {
        commits.push(currentCommit as FileCommit);
      }
      const [, rest] = line.split("COMMIT:");
      const [commit, date, ...msgParts] = rest.split("|");
      currentCommit = {
        commit: commit.trim(),
        date: date.trim(),
        message: msgParts.join("|").trim(),
        linesAdded: 0,
        linesDeleted: 0,
        action: "M",
      };
    } else if (currentCommit && line.match(/^\d+\t\d+\t/)) {
      const [added, deleted] = line.split("\t");
      currentCommit.linesAdded = parseInt(added, 10) || 0;
      currentCommit.linesDeleted = parseInt(deleted, 10) || 0;
    }
  }

  if (currentCommit && currentCommit.commit) {
    commits.push(currentCommit as FileCommit);
  }

  // Detect created/deleted
  const statusLog = exec(
    `git log --follow --diff-filter=AD --format="COMMIT:%H|%ad|%s" --date=short --name-status -- "${filePath}"`
  );

  let created: { date: string; commit: string } | undefined;
  let deleted: { date: string; commit: string } | undefined;

  const lines = statusLog.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith("COMMIT:")) {
      const [, rest] = line.split("COMMIT:");
      const [commit, date] = rest.split("|");
      const nextLine = lines[i + 1] || "";
      if (nextLine.startsWith("A\t")) {
        created = { date: date.trim(), commit: commit.trim() };
      } else if (nextLine.startsWith("D\t")) {
        deleted = { date: date.trim(), commit: commit.trim() };
      }
    }
  }

  // Mark actions
  for (const c of commits) {
    if (created && c.commit === created.commit) c.action = "A";
    if (deleted && c.commit === deleted.commit) c.action = "D";
  }

  const totalLinesAdded = commits.reduce((sum, c) => sum + c.linesAdded, 0);
  const totalLinesDeleted = commits.reduce((sum, c) => sum + c.linesDeleted, 0);

  return {
    path: filePath,
    commits: commits.reverse(), // Chronological order
    totalCommits: commits.length,
    totalLinesAdded,
    totalLinesDeleted,
    created,
    deleted,
  };
}

function generateMarkdown(history: FileHistory): string {
  const lines: string[] = [];

  lines.push(`# File Evolution: ${history.path}`);
  lines.push("");
  lines.push(`> Generated: ${new Date().toISOString()}`);
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push(`- **Total Commits**: ${history.totalCommits}`);
  lines.push(`- **Lines Added**: ${history.totalLinesAdded}`);
  lines.push(`- **Lines Deleted**: ${history.totalLinesDeleted}`);
  lines.push(`- **Net Change**: ${history.totalLinesAdded - history.totalLinesDeleted} lines`);

  if (history.created) {
    lines.push(`- **Created**: ${history.created.date} (\`${history.created.commit.slice(0, 8)}\`)`);
  }
  if (history.deleted) {
    lines.push(`- **Deleted**: ${history.deleted.date} (\`${history.deleted.commit.slice(0, 8)}\`)`);
  }

  lines.push("");
  lines.push("## Lifecycle Status");
  lines.push("");

  if (history.deleted) {
    lines.push("**🗑️ DELETED** - This file no longer exists in the codebase.");
    if (history.created && history.deleted) {
      const created = new Date(history.created.date);
      const deleted = new Date(history.deleted.date);
      const days = Math.ceil(
        (deleted.getTime() - created.getTime()) / (1000 * 60 * 60 * 24)
      );
      lines.push(`Active for ${days} days before deletion.`);
    }
  } else {
    lines.push("**✅ ACTIVE** - This file exists in the current codebase.");
  }

  lines.push("");
  lines.push("## Commit History");
  lines.push("");
  lines.push("| Date | Commit | +/- | Message |");
  lines.push("|------|--------|-----|---------|");

  for (const commit of history.commits) {
    const shortHash = commit.commit.slice(0, 8);
    const changeStr =
      commit.action === "A"
        ? `+${commit.linesAdded} (created)`
        : commit.action === "D"
          ? `-${commit.linesDeleted} (deleted)`
          : `+${commit.linesAdded}/-${commit.linesDeleted}`;
    const escapedMsg = commit.message.replace(/\|/g, "\\|").slice(0, 60);
    lines.push(`| ${commit.date} | \`${shortHash}\` | ${changeStr} | ${escapedMsg} |`);
  }

  lines.push("");
  lines.push("## Size Evolution");
  lines.push("");
  lines.push("```");

  // Build cumulative size chart
  let cumulativeSize = 0;
  for (const commit of history.commits) {
    if (commit.action === "A") {
      cumulativeSize = commit.linesAdded;
    } else if (commit.action === "D") {
      cumulativeSize = 0;
    } else {
      cumulativeSize += commit.linesAdded - commit.linesDeleted;
    }

    const bar = "█".repeat(Math.min(50, Math.floor(cumulativeSize / 10)));
    lines.push(`${commit.date}: ${bar} ${cumulativeSize} lines`);
  }

  lines.push("```");

  // Notable patterns
  lines.push("");
  lines.push("## Notable Patterns");
  lines.push("");

  const bigChanges = history.commits.filter(
    (c) => c.linesAdded > 100 || c.linesDeleted > 100
  );
  if (bigChanges.length > 0) {
    lines.push("### Large Changes");
    lines.push("");
    for (const c of bigChanges) {
      lines.push(`- **${c.date}** (\`${c.commit.slice(0, 8)}\`): +${c.linesAdded}/-${c.linesDeleted}`);
      lines.push(`  - "${c.message}"`);
    }
    lines.push("");
  }

  // Candid messages
  const candidPatterns = [/lol|haha/i, /broken/i, /hack/i, /workaround/i, /cant|can't/i, /finally/i];
  const candidCommits = history.commits.filter((c) =>
    candidPatterns.some((p) => p.test(c.message))
  );

  if (candidCommits.length > 0) {
    lines.push("### Candid Developer Notes");
    lines.push("");
    for (const c of candidCommits) {
      lines.push(`- **${c.date}**: "${c.message}"`);
    }
    lines.push("");
  }

  // Verification
  lines.push("## Verification Commands");
  lines.push("");
  lines.push("```bash");
  lines.push(`# View full file history`);
  lines.push(`git log --follow --stat -- "${history.path}"`);
  lines.push("");
  lines.push(`# View specific commit diff`);
  lines.push(`git show <commit-hash> -- "${history.path}"`);
  if (history.created) {
    lines.push("");
    lines.push(`# View file at creation`);
    lines.push(`git show ${history.created.commit}:"${history.path}"`);
  }
  lines.push("```");

  return lines.join("\n");
}

function sanitizeFilename(filePath: string): string {
  return filePath
    .replace(/\//g, "-")
    .replace(/\\/g, "-")
    .replace(/[^a-zA-Z0-9.-]/g, "_")
    .toLowerCase();
}

async function main() {
  console.log("=== Tracking File Evolution ===\n");

  const outputDir = path.join(process.cwd(), "docs/changelog/evidence/files");

  // Create output directory
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  // Get most churned files (files with >5 commits)
  console.log("Finding files with significant history...");
  const churnOutput = exec(`git log --format= --name-only | sort | uniq -c | sort -rn`);

  const significantFiles: string[] = [];
  for (const line of churnOutput.split("\n")) {
    const match = line.trim().match(/^(\d+)\s+(.+)$/);
    if (match) {
      const count = parseInt(match[1], 10);
      const file = match[2];

      // Filter for interesting files
      if (
        count >= 5 &&
        !file.includes("node_modules") &&
        !file.includes(".next") &&
        !file.includes("package-lock") &&
        !file.includes("pnpm-lock") &&
        !file.endsWith(".lock") &&
        (file.endsWith(".ts") ||
          file.endsWith(".tsx") ||
          file.endsWith(".js") ||
          file.endsWith(".jsx") ||
          file.endsWith(".css") ||
          file.endsWith(".md"))
      ) {
        significantFiles.push(file);
      }
    }

    // Limit to top 100 files
    if (significantFiles.length >= 100) break;
  }

  console.log(`Found ${significantFiles.length} significant files\n`);

  // Generate histories
  let processed = 0;
  for (const file of significantFiles) {
    process.stdout.write(`\rProcessing ${++processed}/${significantFiles.length}: ${file.slice(0, 50)}...`);

    const history = getFileHistory(file);
    if (history.totalCommits < 5) continue; // Double-check threshold

    const markdown = generateMarkdown(history);
    const outputFile = path.join(outputDir, `${sanitizeFilename(file)}.md`);
    fs.writeFileSync(outputFile, markdown);
  }

  console.log(`\n\n✓ Generated ${processed} file evolution documents in ${outputDir}`);

  // Also create an index
  const indexLines = [
    "# File Evolution Index",
    "",
    "> Per-file commit histories for significant files",
    "",
    `Generated: ${new Date().toISOString()}`,
    "",
    "## Files",
    "",
    "| File | Commits | Status |",
    "|------|---------|--------|",
  ];

  for (const file of significantFiles.slice(0, 100)) {
    const history = getFileHistory(file);
    const status = history.deleted ? "🗑️ Deleted" : "✅ Active";
    const link = sanitizeFilename(file);
    indexLines.push(`| [${file}](./files/${link}.md) | ${history.totalCommits} | ${status} |`);
  }

  fs.writeFileSync(path.join(outputDir, "../file-index.md"), indexLines.join("\n"));
  console.log("✓ Generated file index");
}

main().catch(console.error);
