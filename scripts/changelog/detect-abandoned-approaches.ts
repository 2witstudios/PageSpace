#!/usr/bin/env tsx
/**
 * Detect Abandoned Approaches
 *
 * Find files that were created then deleted - representing abandoned approaches,
 * failed experiments, or pivots in architecture.
 *
 * Outputs:
 * - evidence/patterns/abandoned-approaches.md
 */

import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

interface AbandonedFile {
  path: string;
  created: {
    commit: string;
    date: string;
    message: string;
    body?: string;
  };
  deleted: {
    commit: string;
    date: string;
    message: string;
    body?: string;
  };
  daysActive: number;
  linesAtDeletion?: number;
}

function exec(cmd: string): string {
  try {
    return execSync(cmd, { encoding: "utf8", maxBuffer: 50 * 1024 * 1024 });
  } catch {
    return "";
  }
}

function getCreatedFiles(): Map<string, { commit: string; date: string; message: string }> {
  const created = new Map<string, { commit: string; date: string; message: string }>();

  const log = exec(
    `git log --diff-filter=A --format="COMMIT:%H|%ad|%s" --date=short --name-only`
  );

  let currentCommit: { commit: string; date: string; message: string } | null = null;

  for (const line of log.split("\n")) {
    if (line.startsWith("COMMIT:")) {
      const [, rest] = line.split("COMMIT:");
      const [commit, date, ...msgParts] = rest.split("|");
      currentCommit = {
        commit: commit.trim(),
        date: date.trim(),
        message: msgParts.join("|").trim(),
      };
    } else if (currentCommit && line.trim() && !line.includes("|")) {
      created.set(line.trim(), currentCommit);
    }
  }

  return created;
}

function getDeletedFiles(): Map<string, { commit: string; date: string; message: string }> {
  const deleted = new Map<string, { commit: string; date: string; message: string }>();

  const log = exec(
    `git log --diff-filter=D --format="COMMIT:%H|%ad|%s" --date=short --name-only`
  );

  let currentCommit: { commit: string; date: string; message: string } | null = null;

  for (const line of log.split("\n")) {
    if (line.startsWith("COMMIT:")) {
      const [, rest] = line.split("COMMIT:");
      const [commit, date, ...msgParts] = rest.split("|");
      currentCommit = {
        commit: commit.trim(),
        date: date.trim(),
        message: msgParts.join("|").trim(),
      };
    } else if (currentCommit && line.trim() && !line.includes("|")) {
      deleted.set(line.trim(), currentCommit);
    }
  }

  return deleted;
}

function getLinesAtCommit(commit: string, file: string): number {
  try {
    const content = exec(`git show ${commit}^:"${file}" 2>/dev/null`);
    return content.split("\n").length;
  } catch {
    return 0;
  }
}

function getCommitBody(commit: string): string {
  return exec(`git log -1 --format="%b" ${commit}`).trim();
}

function categorizeAbandonment(file: AbandonedFile): string {
  const msg = (file.deleted.message + " " + (file.deleted.body || "")).toLowerCase();

  if (msg.includes("revert") || msg.includes("undo")) return "Reverted";
  if (msg.includes("refactor") || msg.includes("move") || msg.includes("rename")) return "Refactored Away";
  if (msg.includes("broken") || msg.includes("crash") || msg.includes("memory") || msg.includes("ram")) return "Technical Issues";
  if (msg.includes("cant") || msg.includes("can't") || msg.includes("figure")) return "Hit Dead End";
  if (msg.includes("replace") || msg.includes("better") || msg.includes("new")) return "Replaced with Better Solution";
  if (msg.includes("temp") || msg.includes("experiment") || msg.includes("test")) return "Experimental";
  if (file.daysActive <= 1) return "Quick Pivot";
  if (file.daysActive <= 7) return "Short-lived Approach";

  return "Superseded";
}

function generateMarkdown(abandoned: AbandonedFile[]): string {
  const lines: string[] = [];

  lines.push("# Abandoned Approaches");
  lines.push("");
  lines.push("> Files that were created and then deleted - evidence of iterations, pivots, and learning");
  lines.push("");
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push(`- **Total Abandoned Files**: ${abandoned.length}`);

  // Group by category
  const categories = new Map<string, AbandonedFile[]>();
  for (const file of abandoned) {
    const cat = categorizeAbandonment(file);
    if (!categories.has(cat)) categories.set(cat, []);
    categories.get(cat)!.push(file);
  }

  lines.push("");
  lines.push("### By Category");
  lines.push("");
  for (const [cat, files] of categories.entries()) {
    lines.push(`- **${cat}**: ${files.length} files`);
  }

  // Calculate total effort discarded
  const totalLines = abandoned.reduce((sum, f) => sum + (f.linesAtDeletion || 0), 0);
  lines.push("");
  lines.push(`### Effort Analysis`);
  lines.push("");
  lines.push(`- **Total Lines Discarded**: ~${totalLines.toLocaleString()} lines`);
  lines.push(`- **Files Under 1 Day**: ${abandoned.filter(f => f.daysActive <= 1).length}`);
  lines.push(`- **Files 2-7 Days**: ${abandoned.filter(f => f.daysActive > 1 && f.daysActive <= 7).length}`);
  lines.push(`- **Files 8-30 Days**: ${abandoned.filter(f => f.daysActive > 7 && f.daysActive <= 30).length}`);
  lines.push(`- **Files Over 30 Days**: ${abandoned.filter(f => f.daysActive > 30).length}`);

  lines.push("");
  lines.push("---");
  lines.push("");
  lines.push("## Notable Abandoned Approaches");
  lines.push("");
  lines.push("These are the most significant abandoned files, often revealing key learnings.");
  lines.push("");

  // Filter for notable ones (>100 lines or interesting messages)
  const notable = abandoned
    .filter(f => {
      const msg = f.created.message + f.deleted.message;
      return (
        (f.linesAtDeletion && f.linesAtDeletion > 50) ||
        /cant|can't|broken|crash|lol|hack|workaround|figure/i.test(msg)
      );
    })
    .slice(0, 30);

  for (const file of notable) {
    const category = categorizeAbandonment(file);
    lines.push(`### ${file.path}`);
    lines.push("");
    lines.push(`**Category**: ${category}`);
    lines.push(`**Active**: ${file.daysActive} day${file.daysActive !== 1 ? "s" : ""}`);
    if (file.linesAtDeletion) {
      lines.push(`**Lines at Deletion**: ${file.linesAtDeletion}`);
    }
    lines.push("");
    lines.push("| Event | Date | Commit | Message |");
    lines.push("|-------|------|--------|---------|");
    lines.push(`| Created | ${file.created.date} | \`${file.created.commit.slice(0, 8)}\` | ${file.created.message.slice(0, 60).replace(/\|/g, "\\|")} |`);
    lines.push(`| Deleted | ${file.deleted.date} | \`${file.deleted.commit.slice(0, 8)}\` | ${file.deleted.message.slice(0, 60).replace(/\|/g, "\\|")} |`);

    if (file.deleted.body) {
      lines.push("");
      lines.push("**Deletion Context**:");
      lines.push("");
      lines.push("```");
      lines.push(file.deleted.body.slice(0, 500));
      lines.push("```");
    }

    lines.push("");
  }

  lines.push("---");
  lines.push("");
  lines.push("## All Abandoned Files");
  lines.push("");
  lines.push("| File | Created | Deleted | Days | Lines | Category |");
  lines.push("|------|---------|---------|------|-------|----------|");

  for (const file of abandoned) {
    const category = categorizeAbandonment(file);
    const fileName = file.path.length > 50 ? "..." + file.path.slice(-47) : file.path;
    lines.push(`| ${fileName} | ${file.created.date} | ${file.deleted.date} | ${file.daysActive} | ${file.linesAtDeletion || "?"} | ${category} |`);
  }

  lines.push("");
  lines.push("## Verification");
  lines.push("");
  lines.push("```bash");
  lines.push("# View creation commit");
  lines.push('git show <commit> -- "path/to/file"');
  lines.push("");
  lines.push("# View deletion commit");
  lines.push('git show <commit> -- "path/to/file"');
  lines.push("");
  lines.push("# View file content at deletion");
  lines.push('git show <delete-commit>^:"path/to/file"');
  lines.push("```");

  return lines.join("\n");
}

async function main() {
  console.log("=== Detecting Abandoned Approaches ===\n");

  const outputDir = path.join(process.cwd(), "docs/changelog/evidence/patterns");

  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  console.log("Finding created files...");
  const created = getCreatedFiles();
  console.log(`Found ${created.size} created files`);

  console.log("Finding deleted files...");
  const deleted = getDeletedFiles();
  console.log(`Found ${deleted.size} deleted files`);

  console.log("Finding abandoned approaches...");
  const abandoned: AbandonedFile[] = [];

  for (const [filePath, deleteInfo] of deleted.entries()) {
    // Skip non-source files
    if (
      filePath.includes("node_modules") ||
      filePath.includes(".next") ||
      filePath.includes("dist/") ||
      filePath.endsWith(".lock") ||
      (filePath.endsWith(".json") && !filePath.includes("schema"))
    ) {
      continue;
    }

    const createInfo = created.get(filePath);
    if (createInfo) {
      const createdDate = new Date(createInfo.date);
      const deletedDate = new Date(deleteInfo.date);
      const daysActive = Math.max(
        1,
        Math.ceil((deletedDate.getTime() - createdDate.getTime()) / (1000 * 60 * 60 * 24))
      );

      // Only include files deleted within 90 days of creation
      if (daysActive <= 90) {
        const linesAtDeletion = getLinesAtCommit(deleteInfo.commit, filePath);
        const body = getCommitBody(deleteInfo.commit);

        abandoned.push({
          path: filePath,
          created: createInfo,
          deleted: {
            ...deleteInfo,
            body: body || undefined,
          },
          daysActive,
          linesAtDeletion,
        });
      }
    }
  }

  // Sort by lines discarded (most significant first)
  abandoned.sort((a, b) => (b.linesAtDeletion || 0) - (a.linesAtDeletion || 0));

  console.log(`Found ${abandoned.length} abandoned approaches\n`);

  // Generate markdown
  const markdown = generateMarkdown(abandoned);
  const outputFile = path.join(outputDir, "abandoned-approaches.md");
  fs.writeFileSync(outputFile, markdown);

  console.log(`✓ Written to ${outputFile}`);

  // Show top examples
  console.log("\n--- Top 5 Abandoned Approaches by Lines ---");
  for (const file of abandoned.slice(0, 5)) {
    console.log(`  ${file.path}`);
    console.log(`    Created: ${file.created.date} - "${file.created.message.slice(0, 50)}"`);
    console.log(`    Deleted: ${file.deleted.date} - "${file.deleted.message.slice(0, 50)}"`);
    console.log(`    ${file.daysActive} days, ${file.linesAtDeletion || "?"} lines\n`);
  }
}

main().catch(console.error);
