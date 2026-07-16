import { maskEmail } from '../../audit/mask-email';

/**
 * Mask an address wherever it appears in text we did not write.
 *
 * Masking our own prefix and then appending a provider's message verbatim defeats the
 * whole exercise: `email-service` throws `Too many emails sent to ada@example.com` — the
 * single most likely failure on a broadcast — and that string lands in `errors`, which the
 * durable path writes to the broadcast row's `lastError`/`stepResults`. So the address is
 * redacted out of the message body too, not just the part we control.
 *
 * The address is escaped before it becomes a pattern (it can legitimately contain `.` and
 * `+`), and the resulting regex is a literal alternation-free string — nothing to
 * backtrack on.
 *
 * The replacement is a FUNCTION, not a string, and that is not style. `String.replace`
 * expands `$&` in a string replacement to the matched text — and `$`/`&` are legal in a
 * local part (this repo's own `isValidEmail` accepts `$&x@example.com`), so masking such
 * an address yields `$&***@…` and a string replacement would paste the whole raw address
 * back in. The redaction would leak the exact thing it exists to remove, only for the
 * users whose addresses look most unusual. A function return is used verbatim.
 */
function redactRecipient(text: string, email: string): string {
  const literal = email.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const masked = maskEmail(email);
  return text.replace(new RegExp(literal, 'gi'), () => masked);
}

/**
 * Pure core of an email broadcast: the decisions that must be right before a mass send.
 *
 * Everything here is decidable without a database or an email provider — who we refuse
 * to mail, which URLs we put in front of users, and the ordering that keeps a send from
 * happening twice. Kept free of I/O so each guard can be pinned by a test that imports
 * nothing talking to Postgres or Resend.
 *
 * Promoted out of `scripts/lib/sdk-launch-broadcast.ts` (which still re-exports it, so
 * the standalone launch script keeps working) because the admin-console broadcast worker
 * needs exactly the same guards. The fs-backed JSONL ledger stayed behind in the script:
 * this module is deliberately storage-agnostic, and the durable path records to
 * `broadcast_recipients` instead (see `record-adapter.ts`).
 */

/**
 * True when the URL points at the local machine (unsafe for a broadcast link).
 *
 * Matches on shape rather than a list of spellings, because the spellings are numerous and
 * each one that slips through mails a dead unsubscribe link to everybody: the whole
 * `127.0.0.0/8` block is loopback (not just `127.0.0.1`), a trailing dot is a legal
 * fully-qualified form of the same name (`localhost.`), and an IPv4-mapped IPv6 address
 * reaches loopback while looking nothing like it — `[::ffff:127.0.0.1]` is even normalized
 * to `[::ffff:7f00:1]` on the way through `URL`.
 */
export function isLocalhostUrl(url: string): boolean {
  let hostname: string;
  try {
    ({ hostname } = new URL(url));
  } catch {
    // Unparseable → treat as unsafe so we never email a malformed link.
    return true;
  }

  // A trailing dot is the explicit root; `localhost.` and `localhost` are the same host.
  const host = stripTrailing(hostname.toLowerCase(), '.');

  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host === '0.0.0.0' || host === '::' || host === '[::]') return true;
  if (host === '::1' || host === '[::1]') return true;

  // Any 127.x.x.x, not just 127.0.0.1.
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return true;

  // IPv4-mapped IPv6, in both the dotted and the normalized hex forms.
  const v6 = host.replace(/^\[|\]$/g, '');
  if (/^::ffff:127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(v6)) return true;
  if (/^::ffff:7f[0-9a-f]{0,2}:[0-9a-f]{1,4}$/.test(v6)) return true;

  return false;
}

/**
 * Drop trailing slashes so a base URL concatenates cleanly with a path.
 *
 * Scans backwards instead of using `/\/+$/`. That regex is quadratic on a long run of
 * slashes (the greedy `+` re-scans the run from each start position before `$` fails),
 * and the input here is operator-set environment config — exactly the "uncontrolled
 * input" a polynomial-ReDoS check flags. This does the same job in one linear pass.
 */
function stripTrailing(value: string, char: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === char) end--;
  return value.slice(0, end);
}

const stripTrailingSlashes = (url: string) => stripTrailing(url, '/');

/**
 * Reduce an operator-set URL to something safe to concatenate a path onto, or null if it
 * is not usable as a base at all.
 *
 * `resolveMarketingBase` has always done this; this one did not, and the asymmetry was the
 * bug: an `NEXT_PUBLIC_APP_URL` carrying a query or fragment (`https://app.test/?ref=x`)
 * concatenates into `https://app.test/?ref=x/api/notifications/unsubscribe/<token>` — a
 * dead opt-out link in front of the entire audience, which `preflight`'s localhost check
 * would happily wave through. A non-HTTP scheme (`ftp://`, `javascript:`) is likewise not
 * localhost and would otherwise pass.
 *
 * Keeps origin + path, drops query and fragment: a base URL legitimately has a path
 * (`https://app.test/app`) but nothing after it can survive having a path appended.
 */
function canonicalizeBaseUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;

  url.search = '';
  url.hash = '';
  // Credentials must not survive into a link we mail. `URL.toString()` keeps
  // `user:pass@`, and an operator pointing this at a basic-auth-protected preview origin
  // is not far-fetched — it is where you would run a canary. That password would then sit
  // in the footer link and the List-Unsubscribe header of every copy, unretractable, and
  // most mail clients refuse userinfo URLs outright, so the opt-out would be dead for the
  // whole audience. (`resolveMarketingBase` avoids this only by taking `.origin`.)
  url.username = '';
  url.password = '';
  return stripTrailingSlashes(url.toString());
}

/**
 * Resolve the public app base URL (used for the unsubscribe link). Prefers the
 * first configured NON-localhost candidate, so a setup with only the server-side
 * WEB_APP_URL pointed at production (and a stale localhost NEXT_PUBLIC_APP_URL)
 * still produces working links.
 *
 * Unusable candidates are discarded rather than repaired — an operator who set a garbage
 * URL gets the localhost fallback, which `preflight` then refuses loudly on a live send.
 * That is the intended path: fail closed and say so, rather than guess at what they meant
 * and mail everyone the guess.
 */
export function resolveBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const candidates = [env.NEXT_PUBLIC_APP_URL, env.WEB_APP_URL]
    .map((c) => c?.trim())
    .filter((c): c is string => Boolean(c))
    .map(canonicalizeBaseUrl)
    .filter((c): c is string => c !== null);

  const live = candidates.find((c) => !isLocalhostUrl(c));
  return live ?? candidates[0] ?? 'http://localhost:3000';
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
    // a tick per recipient and record a ledger entry for each, sending nothing and
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

  return { ok: true };
}

/**
 * Confirm the pages the email points at actually exist before mailing everyone.
 *
 * A CTA that 404s reaches the whole audience at once, and you cannot un-send it. So a
 * live run proves the links resolve rather than trusting that whatever ships them was
 * deployed first.
 *
 * @returns the URLs that did not come back OK.
 */
export const URL_PROBE_TIMEOUT_MS = 10_000;

export async function findUnreachableUrls(
  urls: string[],
  fetchImpl: typeof fetch = fetch,
  timeoutMs: number = URL_PROBE_TIMEOUT_MS,
): Promise<string[]> {
  const results = await Promise.all(
    urls.map(async (url) => {
      // `fetch` waits forever by default. A host that accepts the connection and then goes
      // quiet would leave this Promise.all pending for the life of the process, so the
      // broadcast would neither send nor fail — it would just stop, with no diagnostic.
      // An unanswered probe IS an unreachable page for our purposes; time it out and say so.
      const probe = (method: 'HEAD' | 'GET') =>
        fetchImpl(url, { method, redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) });

      // Plenty of hosts and CDNs mistreat HEAD on a page that serves fine over GET. Some
      // answer 403/405; a WAF may simply blackhole it until the probe times out. Both are
      // "HEAD is unreliable here", so neither should decide the answer — swallow either and
      // ask again properly. Only the GET's verdict counts.
      let head: Response | null = null;
      try {
        head = await probe('HEAD');
      } catch {
        head = null;
      }
      if (head?.ok) return null;

      try {
        const get = await probe('GET');
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

export interface SentLedgerEntry {
  email: string;
  userId: string;
  sentAt: string;
}

/**
 * Raised when a send succeeded but the ledger did not record it. Fatal by design:
 * the recipient has the email and nothing remembers that, so continuing would risk
 * mailing them again on the next run. Carries what the operator must write down.
 *
 * `remediation` exists because the two ledgers need different instructions, and an
 * instruction that does not match the storage in front of the operator is worse than
 * none: the file-ledger script wants a JSONL line appended, while the durable path wants
 * a `broadcast_recipients` row. The default is the script's, which is the caller that
 * cannot supply its own (it hands `record` to `runBroadcast` and never sees this class).
 *
 * The message masks the address it REPORTS, but the default remediation deliberately
 * prints `entry` verbatim — do not "fix" that. The JSONL line IS the address: an operator
 * pastes it, and `loadSentEmails` reads `entry.email` straight into the already-sent set
 * that `decideRecipient` checks. A masked line would never match the real address, so the
 * next run would mail that person a SECOND time — the exact failure this class exists to
 * prevent. It is also the one message that goes to an operator's terminal rather than a
 * log sink, which is why the durable path (whose message does reach a log aggregator and
 * the broadcast row) passes its own remediation with placeholders instead.
 */
export class LedgerWriteFailed extends Error {
  constructor(
    readonly entry: SentLedgerEntry,
    readonly cause: unknown,
    remediation?: string,
  ) {
    const rawWhy = cause instanceof Error ? cause.message : String(cause);
    const why = redactRecipient(rawWhy, entry.email);
    super(
      `sent to ${maskEmail(entry.email)} but failed to record it in the ledger: ${why}\n` +
        (remediation ??
          '   Add this line to the ledger before re-running, or that user will be emailed again:\n' +
            `   ${JSON.stringify(entry)}`),
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
  /**
   * Recipients another worker had already claimed, so this run left them alone.
   *
   * Deliberately NOT a `SkipReason`: a skip is a decision about the recipient that gets
   * persisted against them, whereas this is a fact about which worker is mailing them.
   * The winner records the real outcome; counting it here too would double-count the
   * person across the two runs. Always 0 without a `claim` hook.
   */
  claimedElsewhere: number;
  errors: string[];
}

/**
 * The send loop: decide, send, record — in that order, for every row.
 *
 * Every dependency that touches the outside world is injected, because this is
 * the code that can double-send someone and it must be testable without a
 * database or a mail provider. The orderings it encodes are the whole point:
 *
 *  - `limit` counts ATTEMPTS, not successes: a provider outage must not let a
 *    25-person canary quietly walk the entire audience.
 *  - A send is recorded in the ledger IMMEDIATELY after it succeeds, and a
 *    failure to record is FATAL — an unrecorded send would go out twice.
 *  - A send that fails is NOT recorded, so a re-run retries exactly it.
 *  - An address that succeeds is added to `alreadySent` in-memory too, so two
 *    accounts sharing one address don't both get mailed in a single run. That guard is
 *    per-process; across workers, `users.emailBidx`'s unique index is what stops two
 *    accounts holding one address to begin with (`claim` keys on userId, not address).
 *  - A recipient is CLAIMED before the provider call, not after it, when a durable
 *    caller supplies `claim` — the in-memory set above cannot stop a second worker.
 *  - Addresses are MASKED in every log line and in `errors` (`maskEmail`, the same helper
 *    the auth flows use). These strings reach a log aggregator and the broadcast row's
 *    `lastError`/`stepResults`, and an address copied there in the clear outlives the
 *    encryption that protects it in `users` and the erasure that is supposed to remove it.
 *    The one exception is `LedgerWriteFailed`'s DEFAULT remediation, which must print the
 *    ledger line verbatim or the operator cannot repair the ledger — see that class.
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
  /**
   * Optional: atomically take ownership of a recipient before mailing them, returning
   * false when another worker already has them. Supplied by durable (multi-instance)
   * callers; the single-process script has no rival to race and omits it.
   */
  claim?: (r: { userId: string; email: string }) => Promise<boolean>;
  /** Append one successful send to the ledger, durably. */
  record: (entry: SentLedgerEntry) => Promise<void>;
  now: () => string;
  sleep: (ms: number) => Promise<void>;
  log: (message: string) => void;
  logError: (message: string) => void;
  /**
   * Optional: called for every row we decline to mail, so a durable caller can
   * persist WHY someone was skipped instead of only counting it. A failure here is
   * swallowed by the caller's own adapter if it wants to be lenient — unlike
   * `record`, a missing skip note cannot cause a double-send.
   */
  onSkip?: (skip: {
    userId: string;
    email: string | null;
    reason: SkipReason;
  }) => Promise<void>;
  /**
   * Optional: called for every send that failed, so a durable caller can persist the
   * error for the admin UI. The recipient is deliberately NOT recorded as sent, so a
   * retry picks them up again.
   */
  onFailure?: (failure: {
    userId: string;
    email: string;
    error: string;
  }) => Promise<void>;
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
  let claimedElsewhere = 0;

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
      if (input.onSkip) {
        await input.onSkip({
          userId: user.id,
          email: user.email?.trim() ?? null,
          reason: decision.outcome,
        });
      }
      continue;
    }

    const { email, emailKey } = decision;

    // Checked AFTER the skip filters, so already-sent / suppressed rows don't
    // consume the budget of a limit=25 canary.
    if (input.limit !== null && attempted >= input.limit) {
      input.log(`\n⏹️  Reached limit=${input.limit}; stopping.`);
      break;
    }

    // Take ownership BEFORE the provider call, not after it.
    //
    // `alreadySent` is an in-memory set, so it only speaks for THIS process: two workers
    // (overlapping retries, or two instances) can both pass every check above and both
    // mail the same person, and the ledger's unique constraint would then coalesce two
    // rows that represent two emails already sent. A durable caller supplies `claim` to
    // decide ownership in the database instead — see record-adapter.claimRecipient.
    //
    // Losing a claim is not a skip and not an attempt: the winner is mailing them, and
    // counting it either way would double-count the recipient across the two workers.
    if (input.live && input.claim) {
      let claimed: boolean;
      try {
        claimed = await input.claim({ userId: user.id, email: emailKey });
      } catch (error) {
        // Fail CLOSED: an unreadable claim means we cannot prove nobody else is mailing
        // this person, and the irreversible mistake is sending, not skipping.
        const msg = error instanceof Error ? error.message : String(error);
        const safe = redactRecipient(msg, email);
        errors.push(`${maskEmail(email)}: could not claim recipient: ${safe}`);
        input.logError(`  ✗ Could not claim ${maskEmail(email)}: ${safe}`);
        continue;
      }

      if (!claimed) {
        claimedElsewhere++;
        input.log(`  ⤳ ${maskEmail(email)} is claimed by another worker; leaving it to them.`);
        continue;
      }
    }

    attempted++;

    const recipient = { userId: user.id, userName: user.name?.trim() || 'there', email };

    if (!input.live) {
      try {
        const html = await input.renderOne(recipient);
        input.log(`  [dry-run] → ${maskEmail(email)} (${html.length} bytes)`);
        sent++;
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        const safe = redactRecipient(msg, email);
        errors.push(`${maskEmail(email)}: ${safe}`);
        input.logError(`  ✗ Render failed for ${maskEmail(email)}: ${safe}`);
      }
      continue;
    }

    try {
      await input.sendOne(recipient);
    } catch (error) {
      // Retryable: nothing was written, so a re-run will try this address again.
      const msg = error instanceof Error ? error.message : String(error);
      // The provider quotes the address back at us on the likeliest error of all (the
      // per-recipient rate limit), so redact it out of their message as well as ours.
      const safe = redactRecipient(msg, email);
      errors.push(`${maskEmail(email)}: ${safe}`);
      input.logError(`  ✗ Send failed for ${maskEmail(email)}: ${safe}`);
      if (input.onFailure) {
        // `error` is persisted to broadcast_recipients.errorMessage, so it is redacted
        // too; the recipient is already identified by the row's own userId.
        await input.onFailure({ userId: user.id, email, error: safe });
      }
      continue;
    }

    const entry: SentLedgerEntry = { email: emailKey, userId: user.id, sentAt: input.now() };
    try {
      await input.record(entry);
    } catch (error) {
      // The email is already gone. If we cannot remember that, we must stop.
      //
      // A `record` that already raised this (the durable adapter does, with its own
      // remediation) is rethrown untouched: wrapping it again would nest the message and
      // bury that remediation under this one's — which names the wrong ledger.
      if (error instanceof LedgerWriteFailed) throw error;
      throw new LedgerWriteFailed(entry, error);
    }

    input.alreadySent.add(emailKey);
    sent++;
    input.log(`  ✓ ${maskEmail(email)}`);
    if (input.delayMs > 0) await input.sleep(input.delayMs);
  }

  return { sent, attempted, skipped, claimedElsewhere, errors };
}