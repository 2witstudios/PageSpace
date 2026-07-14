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
  verifiedOnly: boolean;
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
    verifiedOnly: false,
    limit: null,
    delayMs: 120,
    logPath: defaultLogPath,
  };

  for (const arg of argv) {
    if (arg === '--live') {
      opts.live = true;
    } else if (arg === '--dry-run') {
      opts.live = false;
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

export interface RecipientDecision {
  /** 'send' or the reason we're skipping this row. */
  outcome: 'send' | 'invalid-email' | 'already-sent' | 'suppressed' | 'opted-out';
}

/**
 * Decide whether one (decrypted) user should receive the broadcast. Ordered so
 * the cheapest, most absolute exclusions win: a suppressed address is never
 * mailed even if the ledger is empty, and an already-sent address is never
 * mailed twice even if it later lands in the suppression list.
 */
export function decideRecipient(input: {
  email: string | null | undefined;
  userId: string;
  isValidEmail: (email: string) => boolean;
  alreadySent: Set<string>;
  suppressed: Set<string> | null;
  optedOut: Set<string>;
}): RecipientDecision {
  const email = input.email?.trim();
  if (!email || !input.isValidEmail(email)) return { outcome: 'invalid-email' };

  const key = email.toLowerCase();
  if (input.alreadySent.has(key)) return { outcome: 'already-sent' };
  if (input.suppressed?.has(key)) return { outcome: 'suppressed' };
  if (input.optedOut.has(input.userId)) return { outcome: 'opted-out' };
  return { outcome: 'send' };
}
