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
 *  2. Addresses in the Resend erasure-suppression audience are EXCLUDED, and so
 *     are users with an erasure that has been REQUESTED but not yet executed (it
 *     may be queued or blocked for days) and anyone who has objected to or
 *     restricted processing. A live send refuses to start if the audience can't
 *     be read — failing closed is the only safe direction when the alternative
 *     is mailing someone who asked us to stop.
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
 *   bun scripts/send-sdk-launch-notifications.ts --live
 *
 * Flags:
 *   --live                Actually send. Without it, nothing leaves the building.
 *   --dry-run             Explicit form of the default; send nothing, write nothing.
 *   --include-unverified  Also mail users who never confirmed their address. Off by
 *                         default: an unverified address was never proven to belong
 *                         to the account holder, so a blast to it may be mail to a
 *                         stranger (or a spam trap). Opt in deliberately.
 *   --limit=N             Cap the number of (not-yet-sent) recipients this run.
 *   --delay-ms=N          Pause between real sends (default 120ms). Ignored in dry runs.
 *   --log=PATH            Override the idempotency ledger path.
 *
 * DO NOT run this in a throwaway container (e.g. `docker compose run --rm migrate`)
 * without mounting the ledger onto durable storage: the `migrate` service declares
 * no volume, so the ledger would die with the container and a resumed run would
 * re-mail everyone it had already reached. If you must run it containerized, point
 * SDK_LAUNCH_EMAIL_LOG_PATH at a mounted host path.
 */

import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db } from '@pagespace/db/db';
import { users } from '@pagespace/db/schema/auth';
import { emailNotificationPreferences } from '@pagespace/db/schema/email-notifications';
import { dataSubjectRequests } from '@pagespace/db/schema/data-subject-requests';
import { and, eq, inArray, isNotNull, isNull, ne, or } from '@pagespace/db/operators';
import { sendEmail } from '@pagespace/lib/services/email-service';
import { generateUnsubscribeToken } from '@pagespace/lib/services/notification-email-service';
import { listSuppressedEmails } from '@pagespace/lib/compliance/erasure/resend-suppression-client';
import { decryptUserRow } from '@pagespace/lib/auth/user-repository';
import { isValidEmail } from '@pagespace/lib/validators/email';
import { isOnPrem } from '@pagespace/lib/deployment-mode';
import { SdkCliLaunchEmail } from '@pagespace/lib/email-templates/SdkCliLaunchEmail';
import { renderEmailToHtml } from '@pagespace/lib/email-templates/render-email';
import {
  findUnreachableUrls,
  isLocalhostUrl,
  LedgerWriteFailed,
  listUnsubscribeHeaders,
  loadSentEmails,
  openLedger,
  parseArgs,
  preflight,
  recordSent,
  resolveBaseUrl,
  resolveMarketingBase,
  runBroadcast,
} from './lib/sdk-launch-broadcast';

/** One person the broadcast is about to mail. */
interface Recipient {
  userId: string;
  userName: string;
  email: string;
}

const EMAIL_SUBJECT = 'Build on PageSpace: the SDK and CLI are here';

/** The opt-out channel this broadcast belongs to. */
const NOTIFICATION_TYPE = 'PRODUCT_UPDATE' as const;

/**
 * Namespace for the per-recipient Resend idempotency key. Stable across re-runs
 * ON PURPOSE — that is what makes a retry after a lost response collapse into the
 * original send instead of delivering a second copy. Bump it only if you ever
 * genuinely intend to mail this audience a second time.
 */
const IDEMPOTENCY_PREFIX = 'sdk-cli-launch-2026-07';

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

/**
 * userIds we are forbidden to market to because of a GDPR rights request.
 *
 * The Resend suppression audience only holds erasures that already EXECUTED.
 * An erasure that is still pending, queued, in progress, blocked (e.g. on
 * sole-owner drive disposition) or failed leaves a completely normal-looking row
 * in `users` — verified, unsuspended, absent from the audience. Mailing that
 * person a marketing blast is precisely the harm they asked us to prevent, and
 * it cannot be undone.
 *
 * Objections (Art 21) and restrictions (Art 18) are excluded even when
 * COMPLETED: honouring an objection to direct marketing is what makes it
 * completed. Only a cancelled request releases us.
 */
async function loadRightsRestrictedUserIds(): Promise<Set<string>> {
  const rows = await db
    .select({ userId: dataSubjectRequests.userId })
    .from(dataSubjectRequests)
    .where(
      or(
        and(
          eq(dataSubjectRequests.requestType, 'erasure'),
          inArray(dataSubjectRequests.status, ['pending', 'queued', 'in_progress', 'blocked', 'failed']),
        ),
        and(
          inArray(dataSubjectRequests.requestType, ['objection', 'restriction']),
          ne(dataSubjectRequests.status, 'cancelled'),
        ),
      ),
    );

  return new Set(rows.map((r) => r.userId).filter((id): id is string => id !== null));
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

/** @returns the process exit code (non-zero if any send failed). */
async function main(): Promise<number> {
  const opts = parseArgs(process.argv.slice(2), defaultLogPath());
  const baseUrl = resolveBaseUrl();
  const marketingBase = resolveMarketingBase();
  const sdkDocsUrl = `${marketingBase}/docs/features/sdk`;
  const cliDocsUrl = `${marketingBase}/docs/features/cli`;
  const agentApiUrl = `${marketingBase}/docs/features/agent-api`;
  const blogUrl = `${marketingBase}/blog/build-a-chat-app-on-pagespace`;

  console.log('📢 SDK + CLI launch announcement broadcast');
  console.log(`  Mode:          ${opts.live ? 'LIVE SEND' : 'DRY RUN (no sends) — pass --live to send'}`);
  console.log(
    `  Audience:      ${opts.includeUnverified ? 'ALL users, including unverified addresses' : 'verified addresses only'}` +
      ' (suspended accounts always excluded)',
  );
  console.log(`  Ledger:        ${opts.logPath}`);
  console.log(`  Docs:          ${sdkDocsUrl}`);
  if (opts.limit) console.log(`  Limit:         ${opts.limit}`);
  console.log('');

  // Reading the suppression audience can THROW (a partial read is worse than no
  // read — see listSuppressedEmails). null means "not configured".
  const suppressed = await listSuppressedEmails();

  const postalAddress = process.env.COMPANY_POSTAL_ADDRESS?.trim();

  const check = preflight({
    live: opts.live,
    baseUrl,
    suppressed,
    isOnPrem: isOnPrem(),
    fromEmail: process.env.FROM_EMAIL,
    postalAddress,
  });
  if (!check.ok) {
    console.error(`❌ Refusing live send: ${check.reason}`);
    process.exit(1);
  }

  // Every page this email links to must be deployed before we mail a link to it —
  // an unreachable CTA or guide would 404 for the whole audience, and that can't
  // be taken back. Checks the docs pages and the blog post.
  if (opts.live) {
    const unreachable = await findUnreachableUrls([sdkDocsUrl, cliDocsUrl, agentApiUrl, blogUrl]);
    if (unreachable.length > 0) {
      console.error(
        '❌ Refusing live send: the pages this email links to are not reachable, so every\n' +
          '   recipient would land on a broken page. Deploy the docs first.\n' +
          unreachable.map((u) => `     - ${u}`).join('\n'),
      );
      process.exit(1);
    }
    console.log('🔗 Docs links verified reachable.\n');
  }

  if (suppressed === null) {
    console.warn('  ⚠️  Suppression audience unavailable (unconfigured) — a live send would refuse to start.\n');
  } else {
    console.log(`🚫 ${suppressed.size} address(es) in the erasure-suppression audience will be skipped.\n`);
  }
  if (!opts.live && isLocalhostUrl(baseUrl)) {
    console.warn('  ⚠️  Base URL resolves to localhost — set NEXT_PUBLIC_APP_URL or WEB_APP_URL before a real send.\n');
  }

  const alreadySent = await loadSentEmails(opts.logPath);
  if (alreadySent.size > 0) {
    console.log(`↩️  Resuming: ${alreadySent.size} recipient(s) already recorded in the ledger.\n`);
  }

  const optedOut = await loadOptedOutUserIds();

  // GDPR rights requests that forbid marketing (pending/blocked erasures,
  // objections, restrictions). The suppression audience only covers erasures
  // that already ran, so this is the gap that would otherwise mail someone who
  // has actively asked us to stop.
  const rightsRestricted = await loadRightsRestrictedUserIds();
  if (rightsRestricted.size > 0) {
    console.log(`⚖️  ${rightsRestricted.size} user(s) excluded by a GDPR rights request.\n`);
  }

  // Open (and validate writability of) the ledger BEFORE the first send, so a
  // bad path or permission error fails fast rather than after emails go out.
  const ledger: FileHandle | null = opts.live ? await openLedger(opts.logPath) : null;

  // Two exclusions are enforced in the QUERY because they are properties of the
  // account, not the address: an unverified address was never proven to belong to
  // the account holder, and a suspended account is one we've administratively cut
  // off — neither should receive marketing. Email validity is checked per row.
  // Rows come back encrypted (GDPR #965).
  const audience = [
    isNull(users.suspendedAt),
    ...(opts.includeUnverified ? [] : [isNotNull(users.emailVerified)]),
  ];
  const rows = await db
    .select({
      id: users.id,
      name: users.name,
      email: users.email,
    })
    .from(users)
    .where(and(...audience));

  console.log(`👥 ${rows.length} user(s) returned from the database.\n`);

  /** Build and send one real email: mint the opt-out token, then hand it to Resend. */
  const sendOne = async ({ userId, userName, email }: Recipient): Promise<void> => {
    const token = await generateUnsubscribeToken(userId, NOTIFICATION_TYPE);
    const unsubscribeUrl = `${baseUrl}/api/notifications/unsubscribe/${token}`;
    await sendEmail({
      to: email,
      subject: EMAIL_SUBJECT,
      react: SdkCliLaunchEmail({ userName, sdkDocsUrl, cliDocsUrl, agentApiUrl, blogUrl, postalAddress, unsubscribeUrl }),
      // Bulk mail must offer a client-level one-click unsubscribe, not just a body
      // link. The unsubscribe route answers POST for exactly this.
      headers: listUnsubscribeHeaders(unsubscribeUrl),
      // If Resend accepts a send but the response is lost in transit, the operator
      // is told to re-run — this key lets Resend collapse that retry into the
      // original send, within its idempotency window (~24h). The LEDGER, not this
      // key, is what protects a re-run days later.
      idempotencyKey: `${IDEMPOTENCY_PREFIX}:${userId}`,
    });
  };

  /** Dry-run: render the real template so a template error still surfaces, and send nothing. */
  const renderOne = ({ userName }: Recipient): Promise<string> =>
    renderEmailToHtml(
      SdkCliLaunchEmail({
        userName,
        sdkDocsUrl,
        cliDocsUrl,
        agentApiUrl,
        blogUrl,
        postalAddress,
        // A dry run mints no token: that would be a DB write.
        unsubscribeUrl: `${baseUrl}/api/notifications/unsubscribe/<token>`,
      }),
    );

  let result;
  try {
    result = await runBroadcast({
      live: opts.live,
      limit: opts.limit,
      delayMs: opts.delayMs,
      rows,
      decrypt: decryptUserRow,
      isValidEmail,
      alreadySent,
      suppressed,
      optedOut,
      rightsRestricted,
      sendOne,
      renderOne,
      record: (entry) => recordSent(ledger!, entry),
      now: () => new Date().toISOString(),
      sleep,
      log: (msg) => console.log(msg),
      logError: (msg) => console.error(msg),
    });
  } catch (error) {
    if (error instanceof LedgerWriteFailed) {
      // The email went out but nothing remembers it. Stop before anyone else is
      // mailed, and tell the operator exactly what to write down.
      console.error(`\n❌ FATAL: ${error.message}\n   Ledger: ${opts.logPath}`);
      if (ledger) await ledger.close();
      return 1;
    }
    throw error;
  }

  if (ledger) await ledger.close();

  const { sent, skipped, errors } = result;
  console.log('\n📊 Summary:');
  console.log(`  ${opts.live ? 'Sent' : 'Would send'}:            ${sent}`);
  console.log(`  Skipped (already sent):  ${skipped['already-sent']}`);
  console.log(`  Skipped (suppressed):    ${skipped.suppressed}`);
  console.log(`  Skipped (opted out):     ${skipped['opted-out']}`);
  console.log(`  Skipped (GDPR request):  ${skipped['rights-restricted']}`);
  console.log(`  Skipped (invalid email): ${skipped['invalid-email']}`);
  console.log(`  Errors:                  ${errors.length}`);
  errors.forEach((err) => console.error(`    - ${err}`));
  const errorCount = errors.length;

  if (!opts.live) {
    console.log('\n✅ Dry run complete — no emails sent, ledger untouched. Re-run with --live to send.');
  } else if (errorCount === 0) {
    console.log('\n✅ Broadcast complete.');
  } else {
    console.log('\n⚠️  Broadcast finished with errors; re-run to retry the failures.');
  }

  // A partly-failed blast must not look like a success to whatever ran us.
  return errorCount === 0 ? 0 : 1;
}

if (import.meta.main) {
  main()
    .then((code) => process.exit(code))
    .catch((error) => {
      console.error('\n❌ Script failed:', error);
      process.exit(1);
    });
}
