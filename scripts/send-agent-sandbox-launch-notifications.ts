#!/usr/bin/env bun
/**
 * Broadcast the "agent sessions + panes + code-executing Workflows" launch
 * announcement to users.
 *
 * Structurally identical to scripts/send-sdk-launch-notifications.ts — same
 * shared broadcast core (`@pagespace/lib/services/broadcast/core`, imported
 * here via scripts/lib/sdk-launch-broadcast.ts, which is generic despite its
 * filename), same GDPR/suppression/opt-out exclusions, same fail-closed
 * safety posture, same JSONL idempotency ledger. See that script's own header
 * for the full rationale; this one only documents what differs.
 *
 * Usage:
 *   bun scripts/send-agent-sandbox-launch-notifications.ts                    # dry run (default)
 *   bun scripts/send-agent-sandbox-launch-notifications.ts --live --limit=25  # canary
 *   bun scripts/send-agent-sandbox-launch-notifications.ts --live
 *
 * Flags: identical to the SDK launch script — --live, --dry-run,
 * --include-unverified, --limit=N, --delay-ms=N, --log=PATH.
 *
 * DO NOT run this in a throwaway container without mounting the ledger onto
 * durable storage — see the SDK launch script's header for why.
 */

import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getMigrationDb } from '@pagespace/db/db';
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
import { AgentSandboxLaunchEmail } from '@pagespace/lib/email-templates/AgentSandboxLaunchEmail';
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

// One-shot ops script — runs on the unthrottled migration pool, not the
// app-throttled `db` (see getMigrationDb()'s doc comment in packages/db).
const db = getMigrationDb();

/** One person the broadcast is about to mail. */
interface Recipient {
  userId: string;
  userName: string;
  email: string;
}

const EMAIL_SUBJECT = 'Your agents can code now — in a real machine, in the cloud';

/** The opt-out channel this broadcast belongs to. */
const NOTIFICATION_TYPE = 'PRODUCT_UPDATE' as const;

/**
 * Namespace for the per-recipient Resend idempotency key. Stable across
 * re-runs ON PURPOSE — see the SDK launch script's identical field for why.
 * Bump it only if you ever genuinely intend to mail this audience again.
 */
const IDEMPOTENCY_PREFIX = 'agent-sandbox-launch-2026-08';

function defaultLogPath(): string {
  const fromEnv = process.env.AGENT_SANDBOX_LAUNCH_EMAIL_LOG_PATH?.trim();
  if (fromEnv) return path.resolve(fromEnv);
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.join(here, '..', '.agent-sandbox-launch-sent.jsonl');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** userIds we are forbidden to market to because of a GDPR rights request — see the SDK launch script's identical function for the full rationale. */
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
  const agentsUrl = `${baseUrl}/dashboard/agents`;
  const blogUrl = `${marketingBase}/blog/agents-get-a-computer`;
  const pricingUrl = `${marketingBase}/pricing`;

  console.log('📢 Agent sandbox + panes + Workflows launch broadcast');
  console.log(`  Mode:          ${opts.live ? 'LIVE SEND' : 'DRY RUN (no sends) — pass --live to send'}`);
  console.log(
    `  Audience:      ${opts.includeUnverified ? 'ALL users, including unverified addresses' : 'verified addresses only'}` +
      ' (suspended accounts always excluded)',
  );
  console.log(`  Ledger:        ${opts.logPath}`);
  console.log(`  Agents screen: ${agentsUrl}`);
  console.log(`  Blog:          ${blogUrl}`);
  console.log(`  Pricing:       ${pricingUrl}`);
  if (opts.limit) console.log(`  Limit:         ${opts.limit}`);
  console.log('');

  const suppressed = await listSuppressedEmails();
  const postalAddress = process.env.COMPANY_POSTAL_ADDRESS?.trim();

  const check = preflight({
    live: opts.live,
    baseUrl,
    suppressed,
    isOnPrem: isOnPrem(),
    fromEmail: process.env.FROM_EMAIL,
  });
  if (!check.ok) {
    console.error(`❌ Refusing live send: ${check.reason}`);
    process.exit(1);
  }

  // CAN-SPAM requires a valid physical postal address in commercial email.
  // The template only renders the footer address when one is provided, so an
  // empty env var would silently mail a non-compliant blast — refuse instead.
  if (opts.live && !postalAddress) {
    console.error(
      '❌ Refusing live send: COMPANY_POSTAL_ADDRESS is empty. CAN-SPAM requires a valid\n' +
        '   physical postal address in every commercial email — set it before sending.',
    );
    process.exit(1);
  }

  // Every page this email links to must be deployed before we mail a link to
  // it — the primary CTA (the Agents screen), the blog post and the pricing
  // page all need to be LIVE, not just merged. An unreachable CTA can't be
  // taken back once the blast goes out. (An anonymous probe of the Agents
  // screen follows the auth redirect; a 2xx sign-in page proves the deploy
  // carries the route, which is all this can and needs to verify.)
  if (opts.live) {
    const unreachable = await findUnreachableUrls([agentsUrl, blogUrl, pricingUrl]);
    if (unreachable.length > 0) {
      console.error(
        '❌ Refusing live send: the pages this email links to are not reachable, so every\n' +
          '   recipient would land on a broken page. Deploy the app/marketing site first.\n' +
          unreachable.map((u) => `     - ${u}`).join('\n'),
      );
      process.exit(1);
    }
    console.log('🔗 Agents screen + blog + pricing links verified reachable.\n');
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

  const rightsRestricted = await loadRightsRestrictedUserIds();
  if (rightsRestricted.size > 0) {
    console.log(`⚖️  ${rightsRestricted.size} user(s) excluded by a GDPR rights request.\n`);
  }

  const ledger: FileHandle | null = opts.live ? await openLedger(opts.logPath) : null;

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

  const sendOne = async ({ userId, userName, email }: Recipient): Promise<void> => {
    const token = await generateUnsubscribeToken(userId, NOTIFICATION_TYPE);
    const unsubscribeUrl = `${baseUrl}/api/notifications/unsubscribe/${token}`;
    await sendEmail({
      to: email,
      subject: EMAIL_SUBJECT,
      react: AgentSandboxLaunchEmail({ userName, agentsUrl, blogUrl, pricingUrl, postalAddress, unsubscribeUrl }),
      headers: listUnsubscribeHeaders(unsubscribeUrl),
      idempotencyKey: `${IDEMPOTENCY_PREFIX}:${userId}`,
    });
  };

  /** Dry-run: render the real template so a template error still surfaces, and send nothing. */
  const renderOne = ({ userName }: Recipient): Promise<string> =>
    renderEmailToHtml(
      AgentSandboxLaunchEmail({
        userName,
        agentsUrl,
        blogUrl,
        pricingUrl,
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
