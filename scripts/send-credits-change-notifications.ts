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
 * Idempotent / resumable: every successful send is appended (and fsync'd) to a
 * local JSONL ledger (default `<repo>/.credits-change-sent.jsonl`, override with
 * CREDITS_EMAIL_LOG_PATH or --log). Re-running skips any recipient already in
 * the ledger, so an interrupted run can be resumed without double-sending. The
 * ledger is opened/validated BEFORE the first send; a per-recipient provider
 * failure is recorded as retryable (not written), but a ledger-write failure
 * AFTER a successful send is fatal — the run aborts and names the unrecorded
 * recipient so it can never be silently re-sent.
 *
 * Safety: a live (non --dry-run) send refuses to run if the resolved app base
 * URL points at localhost, so the broadcast can never email a broken CTA.
 *
 * Usage:
 *   bun scripts/send-credits-change-notifications.ts --dry-run
 *   bun scripts/send-credits-change-notifications.ts --verified-only
 *   bun scripts/send-credits-change-notifications.ts --limit=50
 *   bun scripts/send-credits-change-notifications.ts --log=/tmp/credits-sent.jsonl
 *
 * The CTA link uses NEXT_PUBLIC_APP_URL, falling back to WEB_APP_URL (the first
 * non-localhost value wins).
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
import type { FileHandle } from 'node:fs/promises';
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

/**
 * Open the ledger for appending, creating its parent directory first. Validating
 * writability UP FRONT (before any email is sent) turns a bad --log path or a
 * permission/disk problem into a clean pre-flight failure instead of a
 * mid-broadcast crash that leaves successful sends unrecorded.
 */
async function openLedger(logPath: string): Promise<FileHandle> {
  await fs.mkdir(path.dirname(logPath), { recursive: true });
  return fs.open(logPath, 'a');
}

/**
 * Append one successful send and fsync it to disk before returning, so the
 * record is durable the instant `sendEmail` is acknowledged. A failure here is
 * treated as fatal by the caller: an unrecorded successful send would be
 * re-sent on the next run, so we must never silently continue past it.
 */
async function recordSent(handle: FileHandle, entry: SentLedgerEntry): Promise<void> {
  await handle.write(`${JSON.stringify(entry)}\n`, null, 'utf8');
  await handle.sync();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** True when the URL points at the local machine (unsafe for a broadcast CTA). */
function isLocalhostUrl(url: string): boolean {
  try {
    const { hostname } = new URL(url);
    return (
      hostname === 'localhost' ||
      hostname === '127.0.0.1' ||
      hostname === '0.0.0.0' ||
      hostname === '::1' ||
      hostname === '[::1]'
    );
  } catch {
    // Unparseable → treat as unsafe so we never email a malformed CTA.
    return true;
  }
}

/**
 * Resolve the public app base URL for the email CTA. Prefers the first
 * configured NON-localhost candidate so a setup with only the server-side
 * WEB_APP_URL pointed at production (and a stale localhost NEXT_PUBLIC_APP_URL)
 * still produces working links. Falls back to whatever is set, else localhost.
 */
function resolveBaseUrl(): string {
  const candidates = [
    process.env.NEXT_PUBLIC_APP_URL,
    process.env.WEB_APP_URL,
  ].map((c) => c?.trim()).filter((c): c is string => Boolean(c));

  const live = candidates.find((c) => !isLocalhostUrl(c));
  const chosen = live ?? candidates[0] ?? 'http://localhost:3000';
  return chosen.replace(/\/+$/, '');
}

/**
 * Resolve and validate the marketing base URL for the announcement blog link.
 * MARKETING_BASE_URL is operator-set; a malformed value (missing protocol, stray
 * path, trailing slash) would otherwise produce a broken link in a mass email.
 * Returns the scheme+host origin only, falling back to the public site.
 */
function resolveMarketingBase(): string {
  const fallback = 'https://pagespace.ai';
  const raw = process.env.MARKETING_BASE_URL?.trim();
  if (!raw) return fallback;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return fallback;
    return url.origin;
  } catch {
    return fallback;
  }
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const baseUrl = resolveBaseUrl();
  const manageUrl = `${baseUrl}/settings/plan`;
  const localhostBase = isLocalhostUrl(baseUrl);

  // Public marketing blog post backing the announcement. Lives on the marketing
  // site (not the app), so it resolves independently of the app base URL.
  const blogUrl = `${resolveMarketingBase()}/blog/usage-based-pricing-and-built-for-scale`;

  console.log('📢 Metered AI-credits announcement broadcast');
  console.log(`  Mode:          ${opts.dryRun ? 'DRY RUN (no sends)' : 'LIVE SEND'}`);
  console.log(`  Audience:      ${opts.verifiedOnly ? 'verified emails only' : 'all users with a valid email'}`);
  console.log(`  Ledger:        ${opts.logPath}`);
  console.log(`  Manage URL:    ${manageUrl}`);
  if (opts.limit) console.log(`  Limit:         ${opts.limit}`);
  console.log('');

  // Never email every user a broken localhost CTA. A dry run may use localhost
  // (it sends nothing); a live send must resolve a real public URL.
  if (localhostBase) {
    if (opts.dryRun) {
      console.warn('  ⚠️  Base URL resolves to localhost — set NEXT_PUBLIC_APP_URL or WEB_APP_URL before a real send.\n');
    } else {
      console.error(
        '❌ Refusing live send: app base URL resolves to localhost, which would email broken links.\n' +
          '   Set NEXT_PUBLIC_APP_URL (or WEB_APP_URL) to the public app URL and re-run.',
      );
      process.exit(1);
    }
  }

  const sentEmails = await loadSentEmails(opts.logPath);
  if (sentEmails.size > 0) {
    console.log(`↩️  Resuming: ${sentEmails.size} recipient(s) already recorded in the ledger.\n`);
  }

  // Open (and validate writability of) the ledger BEFORE the first send, so a
  // bad path or permission error fails fast rather than after emails go out.
  const ledger: FileHandle | null = opts.dryRun ? null : await openLedger(opts.logPath);

  // Pull all users that can receive email. emailVerified gating is opt-in via
  // --verified-only; email validity is always enforced in code below.
  const rows = await db
    .select({
      id: users.id,
      name: users.name,
      email: users.email,
      subscriptionTier: users.subscriptionTier,
    })
    .from(users)
    .where(opts.verifiedOnly ? isNotNull(users.emailVerified) : undefined);

  console.log(`👥 ${rows.length} user(s) returned from the database.\n`);

  let sentCount = 0;
  let attemptedCount = 0;
  let skippedAlready = 0;
  let skippedInvalid = 0;
  let errorCount = 0;
  const errors: string[] = [];

  for (const user of rows) {
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

    // Count ATTEMPTS, not just successes, against --limit: a provider outage must
    // not let a `--limit=50` canary still try the whole audience. Checked after the
    // skip filters so already-sent / invalid rows don't consume the budget.
    if (opts.limit !== null && attemptedCount >= opts.limit) {
      console.log(`\n⏹️  Reached --limit=${opts.limit}; stopping.`);
      break;
    }
    attemptedCount++;

    const summary = getTierCreditSummary(normalizeTier(user.subscriptionTier));
    const component = CreditsChangeEmail({
      userName: user.name?.trim() || 'there',
      summary,
      manageUrl,
      blogUrl,
    });

    if (opts.dryRun) {
      // Render to HTML so the dry run exercises the real template path and
      // surfaces any rendering error, without contacting the provider.
      try {
        const html = await renderEmailToHtml(component);
        console.log(
          `  [dry-run] → ${email} (${summary.tierLabel}, ${summary.monthlyAllowanceLabel}/mo, ${html.length} bytes)`,
        );
        sentCount++;
      } catch (error) {
        errorCount++;
        const msg = error instanceof Error ? error.message : String(error);
        errors.push(`${email}: ${msg}`);
        console.error(`  ✗ Render failed for ${email}: ${msg}`);
      }
      continue;
    }

    // Live send. A provider failure is per-recipient retryable, but once a send
    // is accepted the ledger record MUST persist — otherwise a re-run would
    // double-send. So a ledger-write failure after a successful send is fatal:
    // we name the unrecorded recipient and abort before sending anyone else.
    try {
      await sendEmail({ to: email, subject: EMAIL_SUBJECT, react: component });
    } catch (error) {
      errorCount++;
      const msg = error instanceof Error ? error.message : String(error);
      errors.push(`${email}: ${msg}`);
      console.error(`  ✗ Send failed for ${email}: ${msg}`);
      continue;
    }

    try {
      await recordSent(ledger!, {
        email: emailKey,
        userId: user.id,
        sentAt: new Date().toISOString(),
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(
        `\n❌ FATAL: sent to ${email} but failed to record it in the ledger: ${msg}\n` +
          `   Add this line to ${opts.logPath} before re-running, or that user will be emailed again:\n` +
          `   ${JSON.stringify({ email: emailKey, userId: user.id })}`,
      );
      await ledger!.close();
      process.exit(1);
    }

    sentEmails.add(emailKey);
    sentCount++;
    console.log(`  ✓ ${email} (${summary.tierLabel})`);
    if (opts.delayMs > 0) await sleep(opts.delayMs);
  }

  if (ledger) await ledger.close();

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
