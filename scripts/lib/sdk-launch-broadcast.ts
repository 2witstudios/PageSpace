/**
 * Filesystem ledger for the standalone SDK + CLI launch broadcast
 * (see scripts/send-sdk-launch-notifications.ts).
 *
 * The decision logic that used to live here — the send loop, the preflight guards, who we
 * refuse to mail — moved to `@pagespace/lib/services/broadcast/core` so the admin-console
 * broadcast worker can run the same guards instead of a copy of them. This module keeps
 * only the parts that are specific to running from a laptop against a local file: the CLI
 * flags and the JSONL ledger. The durable path records to `broadcast_recipients` instead.
 *
 * The moved functions are re-exported below, so this script (and its tests) import from
 * one place regardless of where a given piece now lives.
 */

import { promises as fs } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import type { SentLedgerEntry } from '@pagespace/lib/services/broadcast/core';

export {
  decideRecipient,
  findUnreachableUrls,
  isLocalhostUrl,
  LedgerWriteFailed,
  listUnsubscribeHeaders,
  preflight,
  resolveBaseUrl,
  resolveMarketingBase,
  runBroadcast,
} from '@pagespace/lib/services/broadcast/core';

export type {
  BroadcastResult,
  BroadcastUser,
  PreflightResult,
  RecipientDecision,
  SentLedgerEntry,
  SkipReason,
} from '@pagespace/lib/services/broadcast/core';

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