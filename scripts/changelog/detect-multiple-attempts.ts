#!/usr/bin/env tsx
/**
 * Detect Multiple Attempts
 *
 * Find commits that indicate multiple tries at solving the same problem.
 * Patterns like "again", "retry", "finally", "actually works now"
 *
 * Outputs:
 * - evidence/patterns/multiple-attempts.md
 * - evidence/patterns/candid-messages.md
 */

import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

interface Commit {
  hash: string;
  date: string;
  subject: string;
  body: string;
  filesChanged: string[];
}

interface AttemptPattern {
  name: string;
  description: string;
  regex: RegExp;
  commits: Commit[];
}

interface CandidCommit {
  commit: Commit;
  matchedPatterns: string[];
  sentiment: "frustration" | "relief" | "humor" | "uncertainty" | "other";
}

// Multiple attempt patterns - indicate retrying
const ATTEMPT_PATTERNS: Omit<AttemptPattern, "commits">[] = [
  { name: "again", description: "Explicit retry", regex: /\bagain\b/i },
  { name: "retry", description: "Explicit retry", regex: /\bretry\b|\bretried\b/i },
  { name: "attempt", description: "Multiple attempts", regex: /\battempt\b|\battemptin?g?\b/i },
  { name: "another", description: "Another try", regex: /\banother\b.*(?:try|attempt|approach)/i },
  { name: "second/third", description: "Numbered attempts", regex: /\b(?:second|third|fourth)\s+(?:try|attempt)/i },
  { name: "still", description: "Ongoing issue", regex: /\bstill\b.*(?:broken|not|issue|bug|fail|error)/i },
  { name: "properly", description: "Finally doing it right", regex: /\bproperly\b|\bcorrectly\b/i },
  { name: "actually", description: "Skeptical success", regex: /\bactually\b.*(?:work|fix|function)/i },
  { name: "finally", description: "Long-awaited success", regex: /\bfinally\b/i },
  { name: "now works", description: "Relief at working", regex: /\bnow\s+(?:work|function)/i },
  { name: "this time", description: "Hope for success", regex: /\bthis\s+time\b/i },
];

// Candid patterns - real developer emotions
const CANDID_PATTERNS: { name: string; regex: RegExp; sentiment: CandidCommit["sentiment"] }[] = [
  // Frustration
  { name: "cant/can't", regex: /\bcan'?t\b.*(?:figure|work|get|find|understand)/i, sentiment: "frustration" },
  { name: "broken", regex: /\bbroken\b/i, sentiment: "frustration" },
  { name: "crashing", regex: /\bcrash(?:ing|es|ed)?\b/i, sentiment: "frustration" },
  { name: "memory/RAM", regex: /\b(?:memory|ram)\b.*(?:issue|error|crash|limit)/i, sentiment: "frustration" },
  { name: "give up", regex: /\bgive\s*up\b/i, sentiment: "frustration" },
  { name: "impossible", regex: /\bimpossible\b/i, sentiment: "frustration" },
  { name: "stuck", regex: /\bstuck\b/i, sentiment: "frustration" },
  { name: "annoying", regex: /\bannoying\b/i, sentiment: "frustration" },
  { name: "ugh", regex: /\bugh\b/i, sentiment: "frustration" },

  // Relief/Success
  { name: "finally", regex: /\bfinally\b/i, sentiment: "relief" },
  { name: "works!", regex: /work(?:s|ing)?!+/i, sentiment: "relief" },
  { name: "fixed!", regex: /fix(?:ed)?!+/i, sentiment: "relief" },
  { name: "yay", regex: /\byay\b/i, sentiment: "relief" },

  // Humor
  { name: "lol", regex: /\blol\b/i, sentiment: "humor" },
  { name: "haha", regex: /\bhaha\b/i, sentiment: "humor" },
  { name: "oops", regex: /\boops\b/i, sentiment: "humor" },
  { name: "whoops", regex: /\bwhoops\b/i, sentiment: "humor" },

  // Uncertainty/Hedging
  { name: "hack/hacky", regex: /\bhack(?:y|s)?\b/i, sentiment: "uncertainty" },
  { name: "workaround", regex: /\bworkaround\b/i, sentiment: "uncertainty" },
  { name: "temporary", regex: /\btemporar(?:y|ily)\b|\btemp\s/i, sentiment: "uncertainty" },
  { name: "maybe", regex: /\bmaybe\b.*(?:fix|work|help)/i, sentiment: "uncertainty" },
  { name: "hopefully", regex: /\bhopefully\b/i, sentiment: "uncertainty" },
  { name: "should work", regex: /\bshould\s+work\b/i, sentiment: "uncertainty" },
  { name: "might work", regex: /\bmight\s+work\b/i, sentiment: "uncertainty" },
  { name: "try this", regex: /\btry\s+this\b/i, sentiment: "uncertainty" },
  { name: "not sure", regex: /\bnot\s+sure\b/i, sentiment: "uncertainty" },

  // Other notable
  { name: "forgot", regex: /\bforgot\b/i, sentiment: "other" },
  { name: "mistake", regex: /\bmistake\b/i, sentiment: "other" },
  { name: "wrong", regex: /\bwrong\b/i, sentiment: "other" },
  { name: "revert", regex: /\brevert\b/i, sentiment: "other" },
  { name: "undo", regex: /\bundo\b/i, sentiment: "other" },
];

function exec(cmd: string): string {
  try {
    return execSync(cmd, { encoding: "utf8", maxBuffer: 50 * 1024 * 1024 });
  } catch {
    return "";
  }
}

function getCommits(): Commit[] {
  const log = exec(
    `git log --format="COMMIT:%H|%ad|%s|BODY_START%b|BODY_END" --date=short --name-only`
  );

  const commits: Commit[] = [];
  let current: Partial<Commit> | null = null;

  for (const line of log.split("\n")) {
    if (line.startsWith("COMMIT:")) {
      if (current && current.hash) {
        commits.push(current as Commit);
      }

      const match = line.match(/^COMMIT:([^|]+)\|([^|]+)\|([^|]+)\|BODY_START(.*)$/);
      if (match) {
        current = {
          hash: match[1].trim(),
          date: match[2].trim(),
          subject: match[3].trim(),
          body: match[4].replace(/\|BODY_END$/, "").trim(),
          filesChanged: [],
        };
      }
    } else if (current && line.trim() && !line.includes("BODY_END")) {
      current.filesChanged = current.filesChanged || [];
      current.filesChanged.push(line.trim());
    }
  }

  if (current && current.hash) {
    commits.push(current as Commit);
  }

  return commits;
}

function findAttemptPatterns(commits: Commit[]): AttemptPattern[] {
  const patterns: AttemptPattern[] = ATTEMPT_PATTERNS.map(p => ({ ...p, commits: [] }));

  for (const commit of commits) {
    const text = commit.subject + " " + commit.body;
    for (const pattern of patterns) {
      if (pattern.regex.test(text)) {
        pattern.commits.push(commit);
      }
    }
  }

  return patterns.filter(p => p.commits.length > 0).sort((a, b) => b.commits.length - a.commits.length);
}

function findCandidCommits(commits: Commit[]): CandidCommit[] {
  const candid: CandidCommit[] = [];

  for (const commit of commits) {
    const text = commit.subject + " " + commit.body;
    const matchedPatterns: string[] = [];
    let sentiment: CandidCommit["sentiment"] = "other";

    for (const pattern of CANDID_PATTERNS) {
      if (pattern.regex.test(text)) {
        matchedPatterns.push(pattern.name);
        sentiment = pattern.sentiment; // Last match determines sentiment
      }
    }

    if (matchedPatterns.length > 0) {
      candid.push({ commit, matchedPatterns, sentiment });
    }
  }

  return candid;
}

function generateMultipleAttemptsMarkdown(patterns: AttemptPattern[]): string {
  const lines: string[] = [];

  lines.push("# Multiple Attempts");
  lines.push("");
  lines.push("> Commits that indicate features or fixes that took multiple tries");
  lines.push("");
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push("");
  lines.push("## Summary");
  lines.push("");

  const totalAttemptCommits = new Set(patterns.flatMap(p => p.commits.map(c => c.hash))).size;
  lines.push(`- **Total Commits with Retry Patterns**: ${totalAttemptCommits}`);
  lines.push("");
  lines.push("### Pattern Frequency");
  lines.push("");
  lines.push("| Pattern | Description | Count |");
  lines.push("|---------|-------------|-------|");

  for (const pattern of patterns) {
    lines.push(`| ${pattern.name} | ${pattern.description} | ${pattern.commits.length} |`);
  }

  lines.push("");
  lines.push("---");
  lines.push("");
  lines.push("## Detailed Analysis");
  lines.push("");

  for (const pattern of patterns.slice(0, 10)) {
    lines.push(`### Pattern: "${pattern.name}"`);
    lines.push("");
    lines.push(`${pattern.description} - ${pattern.commits.length} occurrences`);
    lines.push("");
    lines.push("| Date | Commit | Message |");
    lines.push("|------|--------|---------|");

    for (const commit of pattern.commits.slice(0, 20)) {
      const msg = commit.subject.slice(0, 60).replace(/\|/g, "\\|");
      lines.push(`| ${commit.date} | \`${commit.hash.slice(0, 8)}\` | ${msg} |`);
    }

    if (pattern.commits.length > 20) {
      lines.push(`| ... | ... | *${pattern.commits.length - 20} more commits* |`);
    }

    lines.push("");
  }

  lines.push("## Notable Multi-Attempt Stories");
  lines.push("");
  lines.push("Files that appear in multiple retry commits often represent challenging problems.");
  lines.push("");

  // Find files that appear multiple times across retry commits
  const fileAppearances = new Map<string, number>();
  for (const pattern of patterns) {
    for (const commit of pattern.commits) {
      for (const file of commit.filesChanged) {
        fileAppearances.set(file, (fileAppearances.get(file) || 0) + 1);
      }
    }
  }

  const frequentFiles = Array.from(fileAppearances.entries())
    .filter(([file, count]) => count >= 3 && !file.includes("node_modules"))
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20);

  lines.push("| File | Retry Commits |");
  lines.push("|------|---------------|");

  for (const [file, count] of frequentFiles) {
    const shortFile = file.length > 60 ? "..." + file.slice(-57) : file;
    lines.push(`| ${shortFile} | ${count} |`);
  }

  lines.push("");
  lines.push("## Verification");
  lines.push("");
  lines.push("```bash");
  lines.push("# Find commits with 'again' in message");
  lines.push('git log --grep="again" --oneline');
  lines.push("");
  lines.push("# Find commits with 'finally' in message");
  lines.push('git log --grep="finally" --oneline');
  lines.push("```");

  return lines.join("\n");
}

function generateCandidMessagesMarkdown(candid: CandidCommit[]): string {
  const lines: string[] = [];

  lines.push("# Candid Commit Messages");
  lines.push("");
  lines.push("> Real developer emotions and honest assessments in commit messages");
  lines.push("");
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push(`- **Total Candid Commits**: ${candid.length}`);
  lines.push("");

  // Group by sentiment
  const bysentiment = new Map<CandidCommit["sentiment"], CandidCommit[]>();
  for (const c of candid) {
    if (!bysentiment.has(c.sentiment)) bysentiment.set(c.sentiment, []);
    bysentiment.get(c.sentiment)!.push(c);
  }

  lines.push("### By Sentiment");
  lines.push("");
  lines.push("| Sentiment | Count | Percentage |");
  lines.push("|-----------|-------|------------|");

  for (const [sentiment, commits] of bysentiment.entries()) {
    const pct = ((commits.length / candid.length) * 100).toFixed(1);
    const emoji = {
      frustration: "😤",
      relief: "😌",
      humor: "😄",
      uncertainty: "🤔",
      other: "📝",
    }[sentiment];
    lines.push(`| ${emoji} ${sentiment} | ${commits.length} | ${pct}% |`);
  }

  lines.push("");
  lines.push("---");
  lines.push("");

  // Section for each sentiment
  const sentimentOrder: CandidCommit["sentiment"][] = ["frustration", "relief", "humor", "uncertainty", "other"];

  for (const sentiment of sentimentOrder) {
    const commits = bysentiment.get(sentiment);
    if (!commits || commits.length === 0) continue;

    const emoji = {
      frustration: "😤",
      relief: "😌",
      humor: "😄",
      uncertainty: "🤔",
      other: "📝",
    }[sentiment];

    lines.push(`## ${emoji} ${sentiment.charAt(0).toUpperCase() + sentiment.slice(1)}`);
    lines.push("");

    for (const c of commits.slice(0, 30)) {
      lines.push(`### ${c.commit.date}: "${c.commit.subject}"`);
      lines.push("");
      lines.push(`**Commit**: \`${c.commit.hash.slice(0, 8)}\``);
      lines.push(`**Patterns**: ${c.matchedPatterns.join(", ")}`);

      if (c.commit.body) {
        lines.push("");
        lines.push("**Full Message**:");
        lines.push("");
        lines.push("```");
        lines.push(c.commit.body.slice(0, 500));
        lines.push("```");
      }

      if (c.commit.filesChanged.length > 0) {
        lines.push("");
        lines.push(`**Files Changed**: ${c.commit.filesChanged.slice(0, 5).join(", ")}${c.commit.filesChanged.length > 5 ? ` (+${c.commit.filesChanged.length - 5} more)` : ""}`);
      }

      lines.push("");
    }

    if (commits.length > 30) {
      lines.push(`*${commits.length - 30} more ${sentiment} commits...*`);
      lines.push("");
    }
  }

  lines.push("## Verification");
  lines.push("");
  lines.push("```bash");
  lines.push("# Find commits with candid messages");
  lines.push('git log --grep="lol\\|haha\\|cant\\|broken\\|hack" --oneline -i');
  lines.push("```");

  return lines.join("\n");
}

async function main() {
  console.log("=== Detecting Multiple Attempts and Candid Messages ===\n");

  const outputDir = path.join(process.cwd(), "docs/changelog/evidence/patterns");

  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  console.log("Fetching commits...");
  const commits = getCommits();
  console.log(`Found ${commits.length} commits\n`);

  // Multiple attempts
  console.log("Finding multiple attempt patterns...");
  const patterns = findAttemptPatterns(commits);
  const attemptsMarkdown = generateMultipleAttemptsMarkdown(patterns);
  fs.writeFileSync(path.join(outputDir, "multiple-attempts.md"), attemptsMarkdown);
  console.log(`✓ Written multiple-attempts.md`);

  // Candid messages
  console.log("Finding candid commit messages...");
  const candid = findCandidCommits(commits);
  const candidMarkdown = generateCandidMessagesMarkdown(candid);
  fs.writeFileSync(path.join(outputDir, "candid-messages.md"), candidMarkdown);
  console.log(`✓ Written candid-messages.md`);

  // Summary
  console.log("\n=== Summary ===");
  console.log(`Multiple attempt patterns: ${patterns.length}`);
  console.log(`Total attempt commits: ${new Set(patterns.flatMap(p => p.commits.map(c => c.hash))).size}`);
  console.log(`Candid commits: ${candid.length}`);

  console.log("\n--- Sample Candid Messages ---");
  for (const c of candid.slice(0, 5)) {
    console.log(`  ${c.commit.date}: "${c.commit.subject}"`);
    console.log(`    Sentiment: ${c.sentiment}, Patterns: ${c.matchedPatterns.join(", ")}\n`);
  }
}

main().catch(console.error);
