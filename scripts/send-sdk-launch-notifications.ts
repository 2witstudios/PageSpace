#!/usr/bin/env bun
/**
 * Broadcast the "@pagespace/sdk + @pagespace/cli are live" announcement to users.
 *
 * Descends from the (now-removed) credits-change broadcast: one React Email per
 * recipient through the shared, rate-limited `sendEmail` service, with a local
 * JSONL ledger for idempotency. Three things it does that its ancestor did not,
 * because the platform moved underneath it:
 *
 *  1. `users.email` / `users.name` are AES-256-GCM ciphertext at rest (GDPR
 *     #965), so rows are decrypted before we can address an envelope.
 *  2. Addresses in the Resend erasure-suppression audience are EXCLUDED. A live
 *     send refuses to start if that audience can't be read — failing closed is
 *     the only safe direction when the alternative is mailing erased users.
 *  3. Recipients who already opted out of PRODUCT_UPDATE email keep that
 *     opt-out, and every email carries a one-click unsubscribe minted from the
 *     same token table as every other notification email.
 *
 * Safety: dry-run is the DEFAULT. A real send requires an explicit `--live`,
 * and even then refuses to run if the app base URL resolves to localhost (which
 * would mail the whole audience a broken CTA).
 *
 * Idempotent / resumable: every successful send is appended (and fsync'd) to a
 * local JSONL ledger (default `<repo>/.sdk-launch-sent.jsonl`, override with
 * SDK_LAUNCH_EMAIL_LOG_PATH or --log). Re-running skips any recipient already in
 * the ledger, so an interrupted run resumes without double-sending. The ledger
 * is opened/validated BEFORE the first send; a per-recipient provider failure is
 * retryable (nothing written), but a ledger-write failure AFTER a successful
 * send is fatal — the run aborts and names the unrecorded recipient so it can
 * never be silently re-sent. A ledger line that cannot be parsed is likewise
 * fatal: it may be the only record that someone was already emailed.
 *
 * The decision logic (flags, URL resolution, ledger parsing, who to skip) lives
 * in scripts/lib/sdk-launch-broadcast.ts and is unit-tested there.
 *
 * Usage:
 *   bun scripts/send-sdk-launch-notifications.ts                    # dry run (default)
 *   bun scripts/send-sdk-launch-notifications.ts --live --limit=25  # canary
 *   bun scripts/send-sdk-launch-notifications.ts --live --verified-only
 *
 * Flags:
 *   --live            Actually send. Without it, nothing leaves the building.
 *   --dry-run         Explicit form of the default; send nothing, write nothing.
 *   --verified-only   Only target users whose email is verified.
 *   --limit=N         Cap the number of (not-yet-sent) recipients this run.
 *   --delay-ms=N      Pause between real sends (default 120ms). Ignored in dry runs.
 *   --log=PATH        Override the idempotency ledger path.
 *
 * Docker usage:
 *   docker compose run --rm migrate bun scripts/send-sdk-launch-notifications.ts
 */

import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db } from '@pagespace/db/db';
import { users } from '@pagespace/db/schema/auth';
import { emailNotificationPreferences } from '@pagespace/db/schema/email-notifications';
import { and, eq, isNotNull } from '@pagespace/db/operators';
import { sendEmail } from '@pagespace/lib/services/email-service';
import { generateUnsubscribeToken } from '@pagespace/lib/services/notification-email-service';
import { listSuppressedEmails } from '@pagespace/lib/compliance/erasure/resend-suppression-client';
import { decryptUserRow } from '@pagespace/lib/auth/user-repository';
import { isValidEmail } from '@pagespace/lib/validators/email';
import { SdkCliLaunchEmail } from '@pagespace/lib/email-templates/SdkCliLaunchEmail';
import { renderEmailToHtml } from '@pagespace/lib/email-templates/render-email';
import {
  decideRecipient,
  isLocalhostUrl,
  loadSentEmails,
  openLedger,
  parseArgs,
  recordSent,
  resolveBaseUrl,
  resolveMarketingBase,
} from './lib/sdk-launch-broadcast';

const EMAIL_SUBJECT = 'Build on PageSpace: the SDK and CLI are here';

/** The opt-out channel this broadcast belongs to. */
const NOTIFICATION_TYPE = 'PRODUCT_UPDATE' as const;

function defaultLogPath(): string {
  const fromEnv = process.env.SDK_LAUNCH_EMAIL_LOG_PATH?.trim();
  if (fromEnv) return path.resolve(fromEnv);
  // Resolve relative to the repo root (scripts/..) so the ledger location is
  // stable regardless of the directory the script is launched from.
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.join(here, '..', '.sdk-launch-sent.jsonl');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** userIds that have explicitly turned PRODUCT_UPDATE email off. */
async function loadOptedOutUserIds(): Promise<Set<string>> {
  const rows = await db
    .select({ userId: emailNotificationPreferences.userId })
    .from(emailNotificationPreferences)
    .where(
      and(
        eq(emailNotificationPreferences.notificationType, NOTIFICATION_TYPE),
        eq(emailNotificationPreferences.emailEnabled, false),
      ),
    );
  return new Set(rows.map((r) => r.userId));
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2), defaultLogPath());
  const baseUrl = resolveBaseUrl();
  const marketingBase = resolveMarketingBase();
  const sdkDocsUrl = `${marketingBase}/docs/features/sdk`;
  const cliDocsUrl = `${marketingBase}/docs/features/cli`;

  console.log('📢 SDK + CLI launch announcement broadcast');
  console.log(`  Mode:          ${opts.live ? 'LIVE SEND' : 'DRY RUN (no sends) — pass --live to send'}`);
  console.log(`  Audience:      ${opts.verifiedOnly ? 'verified emails only' : 'all users with a valid email'}`);
  console.log(`  Ledger:        ${opts.logPath}`);
  console.log(`  Docs:          ${sdkDocsUrl}`);
  if (opts.limit) console.log(`  Limit:         ${opts.limit}`);
  console.log('');

  // Never email every user a broken localhost unsubscribe link. A dry run may
  // use localhost (it sends nothing); a live send must resolve a public URL.
  if (isLocalhostUrl(baseUrl)) {
    if (!opts.live) {
      console.warn('  ⚠️  Base URL resolves to localhost — set NEXT_PUBLIC_APP_URL or WEB_APP_URL before a real send.\n');
    } else {
      console.error(
        '❌ Refusing live send: app base URL resolves to localhost, which would email broken links.\n' +
          '   Set NEXT_PUBLIC_APP_URL (or WEB_APP_URL) to the public app URL and re-run.',
      );
      process.exit(1);
    }
  }

  // GDPR erasure suppression. Fail CLOSED on a live send: if we cannot read the
  // audience we cannot prove we're excluding erased users, so we don't send.
  const suppressed = await listSuppressedEmails();
  if (suppressed === null) {
    if (opts.live) {
      console.error(
        '❌ Refusing live send: the Resend suppression audience is not configured, so erased\n' +
          '   users cannot be excluded. Set RESEND_API_KEY and RESEND_AUDIENCE_ID and re-run.',
      );
      process.exit(1);
    }
    console.warn('  ⚠️  Suppression audience unavailable (unconfigured) — a live send would refuse to start.\n');
  } else {
    console.log(`🚫 ${suppressed.size} address(es) in the erasure-suppression audience will be skipped.\n`);
  }

  const alreadySent = await loadSentEmails(opts.logPath);
  if (alreadySent.size > 0) {
    console.log(`↩️  Resuming: ${alreadySent.size} recipient(s) already recorded in the ledger.\n`);
  }

  const optedOut = await loadOptedOutUserIds();

  // Open (and validate writability of) the ledger BEFORE the first send, so a
  // bad path or permission error fails fast rather than after emails go out.
  const ledger: FileHandle | null = opts.live ? await openLedger(opts.logPath) : null;

  // emailVerified gating is opt-in via --verified-only; email validity is always
  // enforced per row below. Rows come back encrypted (GDPR #965).
  const rows = await db
    .select({
      id: users.id,
      name: users.name,
      email: users.email,
    })
    .from(users)
    .where(opts.verifiedOnly ? isNotNull(users.emailVerified) : undefined);

  console.log(`👥 ${rows.length} user(s) returned from the database.\n`);

  let sentCount = 0;
  let attemptedCount = 0;
  const skipped = { 'already-sent': 0, suppressed: 0, 'opted-out': 0, 'invalid-email': 0 };
  let errorCount = 0;
  const errors: string[] = [];

  for (const encryptedUser of rows) {
    const user = await decryptUserRow(encryptedUser);
    const decision = decideRecipient({
      email: user.email,
      userId: user.id,
      isValidEmail,
      alreadySent,
      suppressed,
      optedOut,
    });

    if (decision.outcome !== 'send') {
      skipped[decision.outcome]++;
      continue;
    }

    const { email, emailKey } = decision;

    // Count ATTEMPTS, not just successes, against --limit: a provider outage must
    // not let a `--limit=25` canary still try the whole audience. Checked after the
    // skip filters so already-sent / suppressed rows don't consume the budget.
    if (opts.limit !== null && attemptedCount >= opts.limit) {
      console.log(`\n⏹️  Reached --limit=${opts.limit}; stopping.`);
      break;
    }
    attemptedCount++;

    const userName = user.name?.trim() || 'there';

    if (!opts.live) {
      // Render to HTML so the dry run exercises the real template path and
      // surfaces any rendering error, without contacting the provider or
      // minting a token (token generation is a DB write — dry runs stay clean).
      try {
        const html = await renderEmailToHtml(
          SdkCliLaunchEmail({
            userName,
            sdkDocsUrl,
            cliDocsUrl,
            unsubscribeUrl: `${baseUrl}/api/notifications/unsubscribe/<token>`,
          }),
        );
        console.log(`  [dry-run] → ${email} (${html.length} bytes)`);
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
      const token = await generateUnsubscribeToken(user.id, NOTIFICATION_TYPE);
      await sendEmail({
        to: email,
        subject: EMAIL_SUBJECT,
        react: SdkCliLaunchEmail({
          userName,
          sdkDocsUrl,
          cliDocsUrl,
          unsubscribeUrl: `${baseUrl}/api/notifications/unsubscribe/${token}`,
        }),
      });
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

    alreadySent.add(emailKey);
    sentCount++;
    console.log(`  ✓ ${email}`);
    if (opts.delayMs > 0) await sleep(opts.delayMs);
  }

  if (ledger) await ledger.close();

  console.log('\n📊 Summary:');
  console.log(`  ${opts.live ? 'Sent' : 'Would send'}:            ${sentCount}`);
  console.log(`  Skipped (already sent):  ${skipped['already-sent']}`);
  console.log(`  Skipped (suppressed):    ${skipped.suppressed}`);
  console.log(`  Skipped (opted out):     ${skipped['opted-out']}`);
  console.log(`  Skipped (invalid email): ${skipped['invalid-email']}`);
  console.log(`  Errors:                  ${errorCount}`);
  errors.forEach((err) => console.error(`    - ${err}`));

  if (!opts.live) {
    console.log('\n✅ Dry run complete — no emails sent, ledger untouched. Re-run with --live to send.');
  } else if (errorCount === 0) {
    console.log('\n✅ Broadcast complete.');
  } else {
    console.log('\n⚠️  Broadcast finished with errors; re-run to retry the failures.');
  }
}

if (import.meta.main) {
  main()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error('\n❌ Script failed:', error);
      process.exit(1);
    });
}
