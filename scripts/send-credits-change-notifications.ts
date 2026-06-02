#!/usr/bin/env bun
/**
 * Broadcast the "AI usage is moving to metered credits" announcement to users.
 *
 * Mirrors scripts/send-tos-notifications.ts but sends a transactional product
 * announcement (one React Email per recipient) via the shared, rate-limited
 * `sendEmail` service. Per-tier dollar figures are derived from the billing
 * source of truth (`@pagespace/lib/billing/credit-pricing`) so the email can
 * never quote a number that disagrees with what the credit gate actually grants.
 *
 * Idempotent / resumable: every successful send is appended to a local JSONL
 * ledger (default `<repo>/.credits-change-sent.jsonl`, override with
 * CREDITS_EMAIL_LOG_PATH or --log). Re-running skips any recipient already in
 * the ledger, so an interrupted run can be resumed without double-sending.
 * Failures are NOT recorded, so they are retried on the next run.
 *
 * Usage:
 *   bun scripts/send-credits-change-notifications.ts --dry-run
 *   bun scripts/send-credits-change-notifications.ts --verified-only
 *   bun scripts/send-credits-change-notifications.ts --limit=50
 *   bun scripts/send-credits-change-notifications.ts --log=/tmp/credits-sent.jsonl
 *
 * Flags:
 *   --dry-run         Render + report recipients; send nothing, write nothing.
 *   --verified-only   Only target users whose email is verified.
 *   --limit=N         Cap the number of (not-yet-sent) recipients this run.
 *   --delay-ms=N      Pause between real sends (default 120ms) to be gentle on
 *                     the provider API. Ignored in --dry-run.
 *   --log=PATH        Override the idempotency ledger path.
 *
 * Docker usage:
 *   docker compose run --rm migrate bun scripts/send-credits-change-notifications.ts --dry-run
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db } from '@pagespace/db/db';
import { users } from '@pagespace/db/schema/auth';
import { isNotNull } from '@pagespace/db/operators';
import { sendEmail } from '@pagespace/lib/services/email-service';
import { isValidEmail } from '@pagespace/lib/validators/email';
import { CreditsChangeEmail } from '@pagespace/lib/email-templates/CreditsChangeEmail';
import { renderEmailToHtml } from '@pagespace/lib/email-templates/render-email';
import {
  getTierCreditSummary,
  normalizeTier,
} from '@pagespace/lib/email-templates/credits-change-content';

const EMAIL_SUBJECT = 'Your PageSpace AI usage is moving to monthly credits';

interface CliOptions {
  dryRun: boolean;
  verifiedOnly: boolean;
  limit: number | null;
  delayMs: number;
  logPath: string;
}

interface SentLedgerEntry {
  email: string;
  userId: string;
  sentAt: string;
}

function defaultLogPath(): string {
  const fromEnv = process.env.CREDITS_EMAIL_LOG_PATH?.trim();
  if (fromEnv) return path.resolve(fromEnv);
  // Resolve relative to the repo root (scripts/..) so the ledger location is
  // stable regardless of the directory the script is launched from.
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.join(here, '..', '.credits-change-sent.jsonl');
}

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    dryRun: false,
    verifiedOnly: false,
    limit: null,
    delayMs: 120,
    logPath: defaultLogPath(),
  };

  for (const arg of argv) {
    if (arg === '--dry-run') {
      opts.dryRun = true;
    } else if (arg === '--verified-only') {
      opts.verifiedOnly = true;
    } else if (arg.startsWith('--limit=')) {
      const n = Number.parseInt(arg.slice('--limit='.length), 10);
      if (!Number.isInteger(n) || n <= 0) {
        throw new Error(`Invalid --limit value: ${arg}`);
      }
      opts.limit = n;
    } else if (arg.startsWith('--delay-ms=')) {
      const n = Number.parseInt(arg.slice('--delay-ms='.length), 10);
      if (!Number.isInteger(n) || n < 0) {
        throw new Error(`Invalid --delay-ms value: ${arg}`);
      }
      opts.delayMs = n;
    } else if (arg.startsWith('--log=')) {
      const p = arg.slice('--log='.length).trim();
      if (!p) throw new Error('--log requires a path');
      opts.logPath = path.resolve(p);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return opts;
}

/** Load the set of already-emailed addresses (lowercased) from the ledger. */
async function loadSentEmails(logPath: string): Promise<Set<string>> {
  const sent = new Set<string>();
  let raw: string;
  try {
    raw = await fs.readFile(logPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return sent;
    throw error;
  }

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const entry = JSON.parse(trimmed) as Partial<SentLedgerEntry>;
      if (entry.email) sent.add(entry.email.toLowerCase());
    } catch {
      console.warn(`  ⚠️  Skipping malformed ledger line: ${trimmed.slice(0, 80)}`);
    }
  }
  return sent;
}

/** Append one successful send to the ledger (atomic per-line). */
async function recordSent(
  logPath: string,
  entry: SentLedgerEntry,
): Promise<void> {
  await fs.appendFile(logPath, `${JSON.stringify(entry)}\n`, 'utf8');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function appBaseUrl(): string {
  return process.env.NEXT_PUBLIC_APP_URL?.trim() || 'http://localhost:3000';
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const baseUrl = appBaseUrl();
  const manageUrl = `${baseUrl}/settings/plan`;

  console.log('📢 Metered AI-credits announcement broadcast');
  console.log(`  Mode:          ${opts.dryRun ? 'DRY RUN (no sends)' : 'LIVE SEND'}`);
  console.log(`  Audience:      ${opts.verifiedOnly ? 'verified emails only' : 'all users with a valid email'}`);
  console.log(`  Ledger:        ${opts.logPath}`);
  console.log(`  Manage URL:    ${manageUrl}`);
  if (opts.limit) console.log(`  Limit:         ${opts.limit}`);
  if (baseUrl.includes('localhost')) {
    console.warn('  ⚠️  NEXT_PUBLIC_APP_URL is unset — links point at localhost. Set it before a real send.');
  }
  console.log('');

  const sentEmails = await loadSentEmails(opts.logPath);
  if (sentEmails.size > 0) {
    console.log(`↩️  Resuming: ${sentEmails.size} recipient(s) already recorded in the ledger.\n`);
  }

  // Pull all users that can receive email. emailVerified gating is opt-in via
  // --verified-only; email validity is always enforced in code below.
  const rows = await db
    .select({
      id: users.id,
      name: users.name,
      email: users.email,
      emailVerified: users.emailVerified,
      subscriptionTier: users.subscriptionTier,
    })
    .from(users)
    .where(opts.verifiedOnly ? isNotNull(users.emailVerified) : undefined);

  console.log(`👥 ${rows.length} user(s) returned from the database.\n`);

  let sentCount = 0;
  let skippedAlready = 0;
  let skippedInvalid = 0;
  let errorCount = 0;
  const errors: string[] = [];

  for (const user of rows) {
    if (opts.limit !== null && sentCount >= opts.limit) {
      console.log(`\n⏹️  Reached --limit=${opts.limit}; stopping.`);
      break;
    }

    const email = user.email?.trim();
    if (!email || !isValidEmail(email)) {
      skippedInvalid++;
      continue;
    }

    const emailKey = email.toLowerCase();
    if (sentEmails.has(emailKey)) {
      skippedAlready++;
      continue;
    }

    const summary = getTierCreditSummary(normalizeTier(user.subscriptionTier));
    const component = CreditsChangeEmail({
      userName: user.name?.trim() || 'there',
      summary,
      manageUrl,
    });

    try {
      if (opts.dryRun) {
        // Render to HTML so the dry run exercises the real template path and
        // surfaces any rendering error, without contacting the provider.
        const html = await renderEmailToHtml(component);
        console.log(
          `  [dry-run] → ${email} (${summary.tierLabel}, ${summary.monthlyAllowanceLabel}/mo, ${html.length} bytes)`,
        );
      } else {
        await sendEmail({ to: email, subject: EMAIL_SUBJECT, react: component });
        await recordSent(opts.logPath, {
          email: emailKey,
          userId: user.id,
          sentAt: new Date().toISOString(),
        });
        console.log(`  ✓ ${email} (${summary.tierLabel})`);
        if (opts.delayMs > 0) await sleep(opts.delayMs);
      }
      sentEmails.add(emailKey);
      sentCount++;
    } catch (error) {
      errorCount++;
      const msg = error instanceof Error ? error.message : String(error);
      errors.push(`${email}: ${msg}`);
      console.error(`  ✗ Failed for ${email}: ${msg}`);
    }
  }

  console.log('\n📊 Summary:');
  console.log(`  ${opts.dryRun ? 'Would send' : 'Sent'}:        ${sentCount}`);
  console.log(`  Skipped (already sent): ${skippedAlready}`);
  console.log(`  Skipped (invalid email): ${skippedInvalid}`);
  console.log(`  Errors:                 ${errorCount}`);
  errors.forEach((err) => console.error(`    - ${err}`));

  if (opts.dryRun) {
    console.log('\n✅ Dry run complete — no emails sent, ledger untouched.');
  } else if (errorCount === 0) {
    console.log('\n✅ Broadcast complete.');
  } else {
    console.log('\n⚠️  Broadcast finished with errors; re-run to retry the failures.');
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('\n❌ Script failed:', error);
    process.exit(1);
  });
