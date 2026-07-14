/**
 * Pure/IO-light core of the SDK + CLI launch broadcast
 * (see scripts/send-sdk-launch-notifications.ts).
 *
 * Everything here is decidable without a database or an email provider, which
 * is exactly the part that must be right before a mass send: who we refuse to
 * mail, which URLs we put in front of users, and whether the idempotency ledger
 * can be trusted. Kept separate from the script so it can be tested without
 * importing anything that talks to Postgres or Resend.
 */

import { promises as fs } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';

export interface CliOptions {
  live: boolean;
  /**
   * Mail users who never confirmed their address. Defaults to FALSE: an
   * unverified address was never proven to belong to the account holder, so a
   * blast to it may be mail to a stranger (or to a spam trap that damages the
   * sending domain we are about to depend on). Opting in is deliberate.
   */
  includeUnverified: boolean;
  limit: number | null;
  delayMs: number;
  logPath: string;
}

export interface SentLedgerEntry {
  email: string;
  userId: string;
  sentAt: string;
}

/**
 * Parse the CLI flags. Dry-run is the DEFAULT: a real send takes an explicit
 * `--live`. The blast radius here is "every user we have", so the safe mode is
 * the one you get by accident.
 */
export function parseArgs(argv: string[], defaultLogPath: string): CliOptions {
  // Checked against the raw args, not the parsed result: the flags are
  // last-one-wins, so `--live --dry-run` would otherwise resolve quietly to a
  // dry run and the operator would never learn their intent was ambiguous.
  if (argv.includes('--live') && argv.includes('--dry-run')) {
    throw new Error('Pass either --live or --dry-run, not both.');
  }

  const opts: CliOptions = {
    live: false,
    includeUnverified: false,
    limit: null,
    delayMs: 120,
    logPath: defaultLogPath,
  };

  for (const arg of argv) {
    if (arg === '--live') {
      opts.live = true;
    } else if (arg === '--dry-run') {
      opts.live = false;
    } else if (arg === '--include-unverified') {
      opts.includeUnverified = true;
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

/** True when the URL points at the local machine (unsafe for a broadcast link). */
export function isLocalhostUrl(url: string): boolean {
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
    // Unparseable → treat as unsafe so we never email a malformed link.
    return true;
  }
}

/**
 * Resolve the public app base URL (used for the unsubscribe link). Prefers the
 * first configured NON-localhost candidate, so a setup with only the server-side
 * WEB_APP_URL pointed at production (and a stale localhost NEXT_PUBLIC_APP_URL)
 * still produces working links.
 */
export function resolveBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const candidates = [env.NEXT_PUBLIC_APP_URL, env.WEB_APP_URL]
    .map((c) => c?.trim())
    .filter((c): c is string => Boolean(c));

  const live = candidates.find((c) => !isLocalhostUrl(c));
  const chosen = live ?? candidates[0] ?? 'http://localhost:3000';
  return chosen.replace(/\/+$/, '');
}

/**
 * Resolve and validate the marketing base URL for the docs links.
 * MARKETING_BASE_URL is operator-set; a malformed value (missing protocol, stray
 * path, trailing slash) would otherwise put a broken link in a mass email.
 * Returns the origin only.
 */
export function resolveMarketingBase(env: NodeJS.ProcessEnv = process.env): string {
  const fallback = 'https://pagespace.ai';
  const raw = env.MARKETING_BASE_URL?.trim();
  if (!raw) return fallback;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return fallback;
    return url.origin;
  } catch {
    return fallback;
  }
}

export class LedgerCorruptError extends Error {
  constructor(logPath: string, lineNumber: number, why: string, line: string) {
    super(
      `Malformed ledger entry at ${logPath}:${lineNumber} (${why}): ${line.slice(0, 120)}\n` +
        '   This line may record a recipient who was already emailed. Refusing to run rather than\n' +
        '   risk emailing them twice — repair or remove the line, then re-run.',
    );
    this.name = 'LedgerCorruptError';
  }
}

/**
 * Load the set of already-emailed addresses (normalized) from the ledger.
 *
 * A line we cannot read is the one case where the ledger turns dangerous: it is
 * evidence of a send whose recipient we can no longer identify (a torn write
 * from an interrupted run, a hand-edit gone wrong). Skipping it would let the
 * next run mail that person a second time — the exact failure the ledger exists
 * to prevent. So an unreadable line is fatal: an operator can repair or truncate
 * the file, but the script will not guess.
 */
export async function loadSentEmails(logPath: string): Promise<Set<string>> {
  const sent = new Set<string>();
  let raw: string;
  try {
    raw = await fs.readFile(logPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return sent;
    throw error;
  }

  const lines = raw.split('\n');
  for (const [index, line] of lines.entries()) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let entry: Partial<SentLedgerEntry> | undefined;
    try {
      entry = JSON.parse(trimmed) as Partial<SentLedgerEntry>;
    } catch {
      throw new LedgerCorruptError(logPath, index + 1, 'not valid JSON', trimmed);
    }
    if (typeof entry?.email !== 'string' || !entry.email.trim()) {
      throw new LedgerCorruptError(logPath, index + 1, 'missing "email"', trimmed);
    }
    sent.add(entry.email.trim().toLowerCase());
  }
  return sent;
}

/**
 * Open the ledger for appending, creating its parent directory first. Validating
 * writability UP FRONT (before any email is sent) turns a bad --log path or a
 * permission/disk problem into a clean pre-flight failure instead of a
 * mid-broadcast crash that leaves successful sends unrecorded.
 */
export async function openLedger(logPath: string): Promise<FileHandle> {
  await fs.mkdir(path.dirname(logPath), { recursive: true });
  return fs.open(logPath, 'a');
}

/**
 * Append one successful send and fsync it before returning, so the record is
 * durable the instant `sendEmail` is acknowledged. A failure here is fatal to
 * the caller: an unrecorded successful send would be re-sent on the next run.
 */
export async function recordSent(handle: FileHandle, entry: SentLedgerEntry): Promise<void> {
  await handle.write(`${JSON.stringify(entry)}\n`, null, 'utf8');
  await handle.sync();
}

/**
 * Headers that make the unsubscribe one-click at the mail-client level.
 *
 * Gmail's and Yahoo's bulk-sender rules require `List-Unsubscribe` plus
 * `List-Unsubscribe-Post` on bulk mail — a link in the body does not satisfy
 * them, and mail that omits these gets throttled or binned. The URL is the same
 * per-recipient token link the footer carries, so the header and the body agree.
 */
export function listUnsubscribeHeaders(unsubscribeUrl: string): Record<string, string> {
  return {
    'List-Unsubscribe': `<${unsubscribeUrl}>`,
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
  };
}

export type PreflightResult = { ok: true } | { ok: false; reason: string };

/**
 * The guards that stand between a mistake and an unrecoverable mass email.
 * Pure, so each one can be pinned by a test — they are the whole safety story,
 * and "we never actually ran the guard" is not something you learn afterwards.
 *
 * A dry run passes every check (it sends nothing); these only bind a live send.
 */
export function preflight(input: {
  live: boolean;
  baseUrl: string;
  /** null = the erasure-suppression audience could not be read. */
  suppressed: Set<string> | null;
  isOnPrem: boolean;
  /** process.env.FROM_EMAIL — unset means the send would use Resend's sandbox from-address. */
  fromEmail?: string;
  /** process.env.COMPANY_POSTAL_ADDRESS — legally required in commercial email. */
  postalAddress?: string;
}): PreflightResult {
  if (!input.live) return { ok: true };

  if (isLocalhostUrl(input.baseUrl)) {
    return {
      ok: false,
      reason:
        'app base URL resolves to localhost, which would email everyone a broken unsubscribe link.\n' +
        '   Set NEXT_PUBLIC_APP_URL (or WEB_APP_URL) to the public app URL and re-run.',
    };
  }

  if (input.suppressed === null) {
    return {
      ok: false,
      reason:
        'the Resend erasure-suppression audience could not be read, so erased users cannot be\n' +
        '   excluded. Set RESEND_API_KEY and RESEND_AUDIENCE_ID and re-run.',
    };
  }

  if (input.isOnPrem) {
    // sendEmail() is a silent no-op on-prem. A "successful" live run would print
    // a tick per recipient and fsync a ledger line for each, sending nothing and
    // permanently marking those people as already-mailed. Refuse instead.
    return {
      ok: false,
      reason:
        'DEPLOYMENT_MODE is on-prem, where sendEmail() silently drops mail. The run would send\n' +
        '   nothing while recording everyone as already-sent, poisoning the ledger for the real send.',
    };
  }

  if (!input.fromEmail?.trim()) {
    // email-service falls back to Resend's onboarding@resend.dev, which only
    // delivers to the account owner. Every send would fail, one at a time.
    return {
      ok: false,
      reason:
        'FROM_EMAIL is not set, so the send would fall back to Resend\'s sandbox address, which\n' +
        '   only delivers to the account owner. Set FROM_EMAIL to the public sender and re-run.',
    };
  }

  if (!input.postalAddress?.trim()) {
    // This is a COMMERCIAL email — a product announcement, not a transactional
    // notice — so CAN-SPAM requires the sender's physical postal address in the
    // message. We will not invent one, and it cannot be added after the send.
    return {
      ok: false,
      reason:
        'COMPANY_POSTAL_ADDRESS is not set. This is a commercial email, and CAN-SPAM requires a\n' +
        '   physical postal address in the footer. Set COMPANY_POSTAL_ADDRESS and re-run.',
    };
  }

  return { ok: true };
}

/**
 * Confirm the pages the email points at actually exist before mailing everyone.
 *
 * The CTA and the secondary link go to /docs/features/sdk and /docs/features/cli,
 * which ship in a SIBLING pull request. If this broadcast goes out first, every
 * recipient lands on a 404 — and you cannot un-send it. So the live run proves
 * the links resolve rather than trusting the deploy order.
 *
 * @returns the URLs that did not come back OK.
 */
export async function findUnreachableUrls(
  urls: string[],
  fetchImpl: typeof fetch = fetch,
): Promise<string[]> {
  const results = await Promise.all(
    urls.map(async (url) => {
      try {
        const head = await fetchImpl(url, { method: 'HEAD', redirect: 'follow' });
        if (head.ok) return null;

        // Plenty of hosts and CDNs answer 403/405 to HEAD on a page that serves
        // fine over GET. Don't block a launch on that — ask again properly.
        const get = await fetchImpl(url, { method: 'GET', redirect: 'follow' });
        return get.ok ? null : `${url} (HTTP ${get.status})`;
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return `${url} (${msg})`;
      }
    }),
  );
  return results.filter((r): r is string => r !== null);
}

export type SkipReason =
  | 'invalid-email'
  | 'already-sent'
  | 'suppressed'
  | 'opted-out'
  | 'rights-restricted';

export type RecipientDecision =
  /** Carries the trimmed address and its normalized ledger key, so the caller
   *  never has to re-derive (or re-assert the non-nullness of) what we validated. */
  | { outcome: 'send'; email: string; emailKey: string }
  | { outcome: SkipReason };

/**
 * Decide whether one (decrypted) user should receive the broadcast.
 *
 * Order matters: an address already in the ledger is never mailed twice even if
 * it later lands in the suppression list, and a suppressed address is never
 * mailed even when the ledger is empty.
 */
export function decideRecipient(input: {
  email: string | null | undefined;
  userId: string;
  isValidEmail: (email: string) => boolean;
  alreadySent: Set<string>;
  suppressed: Set<string> | null;
  optedOut: Set<string>;
  /**
   * userIds who have exercised a GDPR right that forbids marketing them:
   * an erasure they asked for that has not executed yet, or an objection /
   * restriction under Art 21/18. The Resend suppression audience only covers
   * erasures that already RAN — someone whose erasure is queued or blocked is
   * still a normal-looking row in `users`, and mailing them is the exact harm
   * the request was made to prevent.
   */
  rightsRestricted: Set<string>;
}): RecipientDecision {
  const email = input.email?.trim();
  if (!email || !input.isValidEmail(email)) return { outcome: 'invalid-email' };

  const emailKey = email.toLowerCase();
  if (input.alreadySent.has(emailKey)) return { outcome: 'already-sent' };
  if (input.suppressed?.has(emailKey)) return { outcome: 'suppressed' };
  if (input.rightsRestricted.has(input.userId)) return { outcome: 'rights-restricted' };
  if (input.optedOut.has(input.userId)) return { outcome: 'opted-out' };
  return { outcome: 'send', email, emailKey };
}

/**
 * Raised when a send succeeded but the ledger did not record it. Fatal by design:
 * the recipient has the email and nothing remembers that, so continuing would risk
 * mailing them again on the next run. Carries what the operator must write down.
 */
export class LedgerWriteFailed extends Error {
  constructor(
    readonly entry: SentLedgerEntry,
    readonly cause: unknown,
  ) {
    const why = cause instanceof Error ? cause.message : String(cause);
    super(
      `sent to ${entry.email} but failed to record it in the ledger: ${why}\n` +
        '   Add this line to the ledger before re-running, or that user will be emailed again:\n' +
        `   ${JSON.stringify(entry)}`,
    );
    this.name = 'LedgerWriteFailed';
  }
}

export interface BroadcastUser {
  id: string;
  name?: string | null;
  email?: string | null;
}

export interface BroadcastResult {
  sent: number;
  attempted: number;
  skipped: Record<SkipReason, number>;
  errors: string[];
}

/**
 * The send loop: decide, send, record — in that order, for every row.
 *
 * Every dependency that touches the outside world is injected, because this is
 * the code that can double-send someone and it must be testable without a
 * database or a mail provider. The orderings it encodes are the whole point:
 *
 *  - `--limit` counts ATTEMPTS, not successes: a provider outage must not let a
 *    25-person canary quietly walk the entire audience.
 *  - A send is recorded in the ledger IMMEDIATELY after it succeeds, and a
 *    failure to record is FATAL — an unrecorded send would go out twice.
 *  - A send that fails is NOT recorded, so a re-run retries exactly it.
 *  - An address that succeeds is added to `alreadySent` in-memory too, so two
 *    accounts sharing one address don't both get mailed in a single run.
 */
export async function runBroadcast(input: {
  live: boolean;
  limit: number | null;
  delayMs: number;
  rows: BroadcastUser[];
  decrypt: (row: BroadcastUser) => Promise<BroadcastUser>;
  isValidEmail: (email: string) => boolean;
  alreadySent: Set<string>;
  suppressed: Set<string> | null;
  optedOut: Set<string>;
  /** userIds whose GDPR rights request forbids marketing them (see decideRecipient). */
  rightsRestricted: Set<string>;
  /** Live send for one recipient (mints the token, builds the email, sends it). */
  sendOne: (r: { userId: string; userName: string; email: string }) => Promise<void>;
  /** Dry-run equivalent: render only, so template errors still surface. */
  renderOne: (r: { userId: string; userName: string; email: string }) => Promise<string>;
  /** Append one successful send to the ledger, durably. */
  record: (entry: SentLedgerEntry) => Promise<void>;
  now: () => string;
  sleep: (ms: number) => Promise<void>;
  log: (message: string) => void;
  logError: (message: string) => void;
}): Promise<BroadcastResult> {
  const skipped: Record<SkipReason, number> = {
    'already-sent': 0,
    suppressed: 0,
    'opted-out': 0,
    'rights-restricted': 0,
    'invalid-email': 0,
  };
  const errors: string[] = [];
  let sent = 0;
  let attempted = 0;

  for (const row of input.rows) {
    // One row whose PII will not decrypt (legacy or corrupt ciphertext) must not
    // abort a broadcast that is already part-way through sending.
    let user: BroadcastUser;
    try {
      user = await input.decrypt(row);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      errors.push(`user ${row.id}: could not decrypt PII: ${msg}`);
      input.logError(`  ✗ Skipping user ${row.id}: could not decrypt PII: ${msg}`);
      continue;
    }

    const decision = decideRecipient({
      email: user.email,
      userId: user.id,
      isValidEmail: input.isValidEmail,
      alreadySent: input.alreadySent,
      suppressed: input.suppressed,
      optedOut: input.optedOut,
      rightsRestricted: input.rightsRestricted,
    });

    if (decision.outcome !== 'send') {
      skipped[decision.outcome]++;
      continue;
    }

    const { email, emailKey } = decision;

    // Checked AFTER the skip filters, so already-sent / suppressed rows don't
    // consume the budget of a --limit=25 canary.
    if (input.limit !== null && attempted >= input.limit) {
      input.log(`\n⏹️  Reached --limit=${input.limit}; stopping.`);
      break;
    }
    attempted++;

    const recipient = { userId: user.id, userName: user.name?.trim() || 'there', email };

    if (!input.live) {
      try {
        const html = await input.renderOne(recipient);
        input.log(`  [dry-run] → ${email} (${html.length} bytes)`);
        sent++;
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        errors.push(`${email}: ${msg}`);
        input.logError(`  ✗ Render failed for ${email}: ${msg}`);
      }
      continue;
    }

    try {
      await input.sendOne(recipient);
    } catch (error) {
      // Retryable: nothing was written, so a re-run will try this address again.
      const msg = error instanceof Error ? error.message : String(error);
      errors.push(`${email}: ${msg}`);
      input.logError(`  ✗ Send failed for ${email}: ${msg}`);
      continue;
    }

    const entry: SentLedgerEntry = { email: emailKey, userId: user.id, sentAt: input.now() };
    try {
      await input.record(entry);
    } catch (error) {
      // The email is already gone. If we cannot remember that, we must stop.
      throw new LedgerWriteFailed(entry, error);
    }

    input.alreadySent.add(emailKey);
    sent++;
    input.log(`  ✓ ${email}`);
    if (input.delayMs > 0) await input.sleep(input.delayMs);
  }

  return { sent, attempted, skipped, errors };
}
