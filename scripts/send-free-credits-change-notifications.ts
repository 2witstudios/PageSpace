#!/usr/bin/env bun
/**
 * Notify every FREE-plan account that free credits are now a one-time starter
 * grant rather than a monthly, accumulating allowance (PR #2547).
 *
 * Structurally the same as scripts/send-agent-sandbox-launch-notifications.ts —
 * same shared broadcast core (`@pagespace/lib/services/broadcast/core`, via
 * scripts/lib/sdk-launch-broadcast.ts), same GDPR/suppression exclusions, same
 * fail-closed safety posture, same JSONL idempotency ledger. What differs:
 *
 *   - AUDIENCE is `users.subscriptionTier = 'free'` only. Paid tiers are not
 *     affected and are not mailed.
 *   - This is a RELATIONSHIP message (a notice of a change to the recipient's
 *     existing plan), not a marketing broadcast. CAN-SPAM exempts it from the
 *     commercial requirements, and it has to reach every affected account, so
 *     it does NOT honour the PRODUCT_UPDATE opt-out and carries no unsubscribe
 *     link. The GDPR rights-request and erasure-suppression exclusions still
 *     apply — those are legal must-skips, not preferences.
 *   - Each email quotes the recipient's CURRENT spendable balance (one LEFT JOIN
 *     on credit_balances), so "what you keep" is a number, not a promise.
 *
 * Usage:
 *   bun scripts/send-free-credits-change-notifications.ts                    # dry run (default)
 *   bun scripts/send-free-credits-change-notifications.ts --live --limit=25  # canary
 *   bun scripts/send-free-credits-change-notifications.ts --live
 *
 * Flags: --live, --dry-run, --include-unverified, --limit=N, --delay-ms=N, --log=PATH.
 *
 * Run this AFTER the PR is deployed: the email says "starting today" and links
 * to the plan page whose copy the same PR changes.
 *
 * DO NOT run this in a throwaway container without mounting the ledger onto
 * durable storage — see the SDK launch script's header for why.
 */

import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getMigrationDb } from '@pagespace/db/db';
import { users } from '@pagespace/db/schema/auth';
import { creditBalances } from '@pagespace/db/schema/credits';
import { dataSubjectRequests } from '@pagespace/db/schema/data-subject-requests';
import { and, eq, inArray, isNotNull, isNull, ne, or } from '@pagespace/db/operators';
import { sendEmail } from '@pagespace/lib/services/email-service';
import { listSuppressedEmails } from '@pagespace/lib/compliance/erasure/resend-suppression-client';
import { decryptUserRow } from '@pagespace/lib/auth/user-repository';
import { isValidEmail } from '@pagespace/lib/validators/email';
import { isOnPrem } from '@pagespace/lib/deployment-mode';
import {
  TIER_MONTHLY_ALLOWANCE_CENTS,
  CREDIT_TOPUP_MIN_CENTS,
} from '@pagespace/lib/billing/credit-pricing';
import { FreeCreditsChangeEmail } from '@pagespace/lib/email-templates/FreeCreditsChangeEmail';
import { renderEmailToHtml } from '@pagespace/lib/email-templates/render-email';
import {
  findUnreachableUrls,
  isLocalhostUrl,
  LedgerWriteFailed,
  loadSentEmails,
  openLedger,
  parseArgs,
  preflight,
  recordSent,
  resolveBaseUrl,
  runBroadcast,
} from './lib/sdk-launch-broadcast';

// One-shot ops script — runs on the unthrottled migration pool, not the
// app-throttled `db` (see getMigrationDb()'s doc comment in packages/db).
const db = getMigrationDb();

/** One person the notice is about to mail. */
interface Recipient {
  userId: string;
  userName: string;
  email: string;
}

const EMAIL_SUBJECT = 'A change to credits on your Free plan';

/**
 * Namespace for the per-recipient Resend idempotency key. Stable across
 * re-runs ON PURPOSE so a resumed run can never double-send. Bump it only if
 * you ever genuinely intend to mail this audience again.
 */
const IDEMPOTENCY_PREFIX = 'free-credits-change-2026-09';

/** Whole cents → credit units for display ("5", "3.2"). Mirrors apps/web's formatCreditCount. */
function formatCredits(cents: number): string {
  const units = cents / 100;
  return Number.isInteger(units) ? `${units}` : units.toFixed(1);
}

function formatDollars(cents: number): string {
  const dollars = cents / 100;
  return Number.isInteger(dollars) ? `$${dollars}` : `$${dollars.toFixed(2)}`;
}

function defaultLogPath(): string {
  const fromEnv = process.env.FREE_CREDITS_CHANGE_EMAIL_LOG_PATH?.trim();
  if (fromEnv) return path.resolve(fromEnv);
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.join(here, '..', '.free-credits-change-sent.jsonl');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** userIds we are forbidden to contact because of a GDPR rights request — see the SDK launch script's identical function for the full rationale. */
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

/** @returns the process exit code (non-zero if any send failed). */
async function main(): Promise<number> {
  const opts = parseArgs(process.argv.slice(2), defaultLogPath());
  const baseUrl = resolveBaseUrl();
  const planUrl = `${baseUrl}/settings/plan`;
  const usageUrl = `${baseUrl}/settings/usage`;
  const starterCredits = formatCredits(TIER_MONTHLY_ALLOWANCE_CENTS.free);
  const proMonthlyCredits = formatCredits(TIER_MONTHLY_ALLOWANCE_CENTS.pro);
  const minTopup = formatDollars(CREDIT_TOPUP_MIN_CENTS);

  console.log('📢 Free-plan credits change notice');
  console.log(`  Mode:          ${opts.live ? 'LIVE SEND' : 'DRY RUN (no sends) — pass --live to send'}`);
  console.log(
    `  Audience:      FREE tier, ${opts.includeUnverified ? 'including unverified addresses' : 'verified addresses only'}` +
      ' (suspended accounts always excluded; PRODUCT_UPDATE opt-out NOT applied — plan-change notice)',
  );
  console.log(`  Ledger:        ${opts.logPath}`);
  console.log(`  Plan page:     ${planUrl}`);
  console.log(`  Usage page:    ${usageUrl}`);
  console.log(`  Starter grant: ${starterCredits} credits · Pro: ${proMonthlyCredits}/mo · min top-up: ${minTopup}`);
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

  // A relationship notice is exempt from CAN-SPAM's postal-address rule, so an
  // empty COMPANY_POSTAL_ADDRESS is a warning here, not a refusal.
  if (opts.live && !postalAddress) {
    console.warn('  ⚠️  COMPANY_POSTAL_ADDRESS is empty — the footer will carry no postal address.\n');
  }

  // The pages this email links to must be DEPLOYED (with the new "5 credits to
  // start" copy) before we mail a link to them. An anonymous probe follows the
  // auth redirect; a 2xx sign-in page proves the deploy carries the route.
  if (opts.live) {
    const unreachable = await findUnreachableUrls([planUrl, usageUrl]);
    if (unreachable.length > 0) {
      console.error(
        '❌ Refusing live send: the pages this email links to are not reachable.\n' +
          '   Deploy the app first.\n' +
          unreachable.map((u) => `     - ${u}`).join('\n'),
      );
      process.exit(1);
    }
    console.log('🔗 Plan + usage links verified reachable.\n');
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

  const rightsRestricted = await loadRightsRestrictedUserIds();
  if (rightsRestricted.size > 0) {
    console.log(`⚖️  ${rightsRestricted.size} user(s) excluded by a GDPR rights request.\n`);
  }

  const ledger: FileHandle | null = opts.live ? await openLedger(opts.logPath) : null;

  const audience = [
    eq(users.subscriptionTier, 'free'),
    isNull(users.suspendedAt),
    ...(opts.includeUnverified ? [] : [isNotNull(users.emailVerified)]),
  ];
  const rows = await db
    .select({
      id: users.id,
      name: users.name,
      email: users.email,
      monthlyRemainingCents: creditBalances.monthlyRemainingCents,
      topupRemainingCents: creditBalances.topupRemainingCents,
      debtCents: creditBalances.debtCents,
    })
    .from(users)
    .leftJoin(creditBalances, eq(creditBalances.userId, users.id))
    .where(and(...audience));

  console.log(`👥 ${rows.length} free-tier user(s) returned from the database.\n`);

  // Spendable, the same arithmetic as credit-balance's display read: funded buckets
  // minus debt, clamped at 0 when there is no debt. No row (never used AI) → undefined,
  // and the template says the starter credits are still waiting.
  const creditsByUserId = new Map<string, string | undefined>();
  for (const r of rows) {
    if (r.monthlyRemainingCents === null || r.topupRemainingCents === null) {
      creditsByUserId.set(r.id, undefined);
      continue;
    }
    const debt = r.debtCents ?? 0;
    const funded = r.monthlyRemainingCents + r.topupRemainingCents;
    const spendable = debt > 0 ? funded - debt : Math.max(0, funded);
    creditsByUserId.set(r.id, formatCredits(spendable));
  }

  const propsFor = ({ userId, userName }: Recipient) => ({
    userName,
    currentCredits: creditsByUserId.get(userId),
    starterCredits,
    proMonthlyCredits,
    minTopup,
    planUrl,
    usageUrl,
    postalAddress,
  });

  const sendOne = async (recipient: Recipient): Promise<void> => {
    await sendEmail({
      to: recipient.email,
      subject: EMAIL_SUBJECT,
      react: FreeCreditsChangeEmail(propsFor(recipient)),
      idempotencyKey: `${IDEMPOTENCY_PREFIX}:${recipient.userId}`,
    });
  };

  /** Dry-run: render the real template so a template error still surfaces, and send nothing. */
  const renderOne = (recipient: Recipient): Promise<string> =>
    renderEmailToHtml(FreeCreditsChangeEmail(propsFor(recipient)));

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
      // Plan-change notice: reaches every Free account regardless of the
      // PRODUCT_UPDATE preference (see the file header).
      optedOut: new Set<string>(),
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
  console.log(`  Skipped (GDPR request):  ${skipped['rights-restricted']}`);
  console.log(`  Skipped (invalid email): ${skipped['invalid-email']}`);
  console.log(`  Errors:                  ${errors.length}`);
  errors.forEach((err) => console.error(`    - ${err}`));
  const errorCount = errors.length;

  if (!opts.live) {
    console.log('\n✅ Dry run complete — no emails sent, ledger untouched. Re-run with --live to send.');
  } else if (errorCount === 0) {
    console.log('\n✅ Notice sent.');
  } else {
    console.log('\n⚠️  Finished with errors; re-run to retry the failures.');
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
