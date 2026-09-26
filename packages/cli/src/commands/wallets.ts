/**
 * `pagespace wallets drive|list|source` — READ-ONLY wallet verbs (Spec X-1, narrowed by
 * [D-OW-26]). Thin projections over the `wallets.*` SDK operations; argv parsing and
 * rendering are pure, `ctx.sdk` is the only I/O edge.
 *
 * There is deliberately no wallet write here: an access key never moves money or changes a
 * spend source (create, allocate, pause, top up, donate, set a default or a conversation's
 * source all need a signed-in session in the web app), and the server refuses a key on every
 * one of them by name. A key always reads the consumer view: remaining amounts and your own
 * cap, never an org pool or anyone else's spend.
 *
 * Every amount arrives as cents of credit value WITH its credit count already rendered by
 * the server's money model (`…Credits`, e.g. "1,200"). The CLI prints that string and never
 * converts cents itself: a credit is converted in one module only (MON-5), and a second
 * definition here would drift from it. Never a currency symbol (UI-12).
 */
import type { PageSpaceClient } from '@pagespace/sdk';
import { EXIT_RUNTIME_ERROR, EXIT_SUCCESS, EXIT_USAGE_ERROR } from '../exit-codes.js';
import type { CommandHandler } from '../router/router.js';
import { callSdk } from './sdk-error.js';

type DriveWalletResult = Awaited<ReturnType<PageSpaceClient['wallets']['getDriveWallet']>>;
type MyWalletsResult = Awaited<ReturnType<PageSpaceClient['wallets']['list']>>;
type ConversationSourceResult = Awaited<ReturnType<PageSpaceClient['wallets']['getConversationSource']>>;
type SpendSourceKind = ConversationSourceResult['options'][number]['source'];

const SOURCE_LABELS: Readonly<Record<SpendSourceKind, string>> = {
  drive_wallet: 'drive wallet',
  seat_allowance: 'seat allowance',
  own_credits: 'own credits',
};

/** Pure: a spend source kind as words; null reads as "(none)". */
export function sourceLabel(source: SpendSourceKind | null): string {
  return source === null ? '(none)' : SOURCE_LABELS[source];
}

/** Pure: a server-rendered credit count with its unit ("1,200 credits", "1 credit"). No conversion. */
export function creditsLabel(count: string): string {
  return `${count} ${count === '1' ? 'credit' : 'credits'}`;
}

function capLine(label: string, remainingCredits: string | null): string {
  return remainingCredits === null ? `no ${label} cap` : `${creditsLabel(remainingCredits)} left ${label === 'daily' ? 'today' : 'this month'}`;
}

/** Pure: no I/O. */
export function renderDriveWallet(driveId: string, value: DriveWalletResult): string {
  const wallet = value.wallet;
  if (wallet === null) return `Drive ${driveId} has no wallet.\n`;
  return [
    `Drive wallet ${wallet.walletId} (drive ${wallet.driveId})  [${wallet.status}]`,
    `  remaining: ${creditsLabel(wallet.remainingCredits)}`,
    `  your cap: ${capLine('daily', wallet.myCap.dailyRemainingCredits)} · ${capLine('monthly', wallet.myCap.monthlyRemainingCredits)}`,
    `  donations: ${wallet.donationsEnabled ? 'on' : 'off'}`,
    `  default source: ${sourceLabel(wallet.defaultSpendSource)}`,
    `  viewing as: ${value.viewer}`,
    '',
  ].join('\n');
}

function section(title: string, lines: readonly string[]): string[] {
  return [title, ...(lines.length === 0 ? ['  (none)'] : lines)];
}

/** Pure: no I/O. */
export function renderMyWallets(value: MyWalletsResult): string {
  const { personal, driveWallets, seats, funds } = value;
  return [
    `Your wallet ${personal.walletId}  remaining: ${creditsLabel(personal.remainingCredits)}  default source: ${sourceLabel(personal.defaultSpendSource)}`,
    ...section(
      'Drive wallets you can spend from:',
      driveWallets.map((w) => `  ${w.driveId}  ${w.walletId}  [${w.status}]  remaining: ${creditsLabel(w.remainingCredits)}`),
    ),
    ...section('Org seats:', seats.map((s) => `  ${s.orgId}  ${s.walletId}`)),
    ...section('Drive wallets your wallet funds:', funds.driveWallets.map((w) => `  ${w.driveId}  ${w.walletId}`)),
    ...section(
      'Your donations:',
      funds.donations.map(
        (d) =>
          `  ${d.walletId}  drive: ${d.driveId ?? '(none)'}  ${creditsLabel(d.remainingCredits)} left of ${creditsLabel(d.originalCredits)}  ${d.createdAt.slice(0, 10)}`,
      ),
    ),
    '',
  ].join('\n');
}

/** Pure: what the next call would do, in one line. */
export function renderResolvedSpend(resolved: ConversationSourceResult['resolved']): string {
  switch (resolved.kind) {
    case 'spend':
      return `spends from ${sourceLabel(resolved.source)} (${resolved.walletId})${
        resolved.fallbackApplied ? `, falling back from ${sourceLabel(resolved.fallbackFrom)}` : ''
      }`;
    case 'refuse':
      return `refused: ${resolved.reason}${resolved.options.length > 0 ? ` (could spend: ${resolved.options.map((o) => sourceLabel(o.source)).join(', ')})` : ''}`;
    case 'skip':
      return `not charged: ${resolved.reason}`;
  }
}

/** Pure: no I/O. */
export function renderConversationSource(value: ConversationSourceResult): string {
  return [
    `Conversation ${value.conversationId}  drive: ${value.driveId ?? '(none)'}`,
    `  chosen wallet: ${value.chosenWalletId ?? '(none)'}`,
    `  next call: ${renderResolvedSpend(value.resolved)}`,
    ...section('  options:', value.options.map((o) => `    ${sourceLabel(o.source)}  ${o.walletId}`)),
    '',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// argv (pure)
// ---------------------------------------------------------------------------

const DRIVE_USAGE = 'Usage: pagespace wallets drive <driveId>';
const LIST_USAGE = 'Usage: pagespace wallets list';
const SOURCE_USAGE = 'Usage: pagespace wallets source <conversationId> [--drive <driveId>]';

export type ExtractWalletArgsResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly message: string };

/** Pure: exactly one `<driveId>`, nothing else. */
export function extractDriveWalletArgs(args: readonly string[]): ExtractWalletArgsResult<{ readonly driveId: string }> {
  if (args.length !== 1 || args[0].startsWith('-') || args[0].length === 0) return { ok: false, message: DRIVE_USAGE };
  return { ok: true, value: { driveId: args[0] } };
}

/** Pure: `<conversationId> [--drive <driveId>]` (the drive only matters for a global conversation). */
export function extractConversationSourceArgs(
  args: readonly string[],
): ExtractWalletArgsResult<{ readonly conversationId: string; readonly driveId?: string }> {
  let conversationId: string | undefined;
  let driveId: string | undefined;
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    if (token === '--drive') {
      const value = args[i + 1];
      if (value === undefined || value.length === 0 || value.startsWith('-')) return { ok: false, message: 'Flag --drive requires a value.' };
      driveId = value;
      i += 1;
    } else if (token.startsWith('-')) {
      return { ok: false, message: `Unknown flag: ${token}\n${SOURCE_USAGE}` };
    } else if (conversationId === undefined && token.length > 0) {
      conversationId = token;
    } else {
      return { ok: false, message: SOURCE_USAGE };
    }
  }
  if (conversationId === undefined) return { ok: false, message: SOURCE_USAGE };
  return { ok: true, value: { conversationId, ...(driveId !== undefined ? { driveId } : {}) } };
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

export const walletsDriveHandler: CommandHandler = async (ctx, intent) => {
  const parsed = extractDriveWalletArgs(intent.args);
  if (!parsed.ok) {
    ctx.stderr.write(`${parsed.message}\n`);
    return EXIT_USAGE_ERROR;
  }
  const result = await callSdk(ctx.stderr, () => ctx.sdk.wallets.getDriveWallet({ driveId: parsed.value.driveId }));
  if (!result.ok) return EXIT_RUNTIME_ERROR;
  ctx.stdout.write(intent.flags.json ? `${JSON.stringify(result.value)}\n` : renderDriveWallet(parsed.value.driveId, result.value));
  return EXIT_SUCCESS;
};

export const walletsListHandler: CommandHandler = async (ctx, intent) => {
  if (intent.args.length > 0) {
    ctx.stderr.write(`${LIST_USAGE}\n`);
    return EXIT_USAGE_ERROR;
  }
  const result = await callSdk(ctx.stderr, () => ctx.sdk.wallets.list({}));
  if (!result.ok) return EXIT_RUNTIME_ERROR;
  ctx.stdout.write(intent.flags.json ? `${JSON.stringify(result.value)}\n` : renderMyWallets(result.value));
  return EXIT_SUCCESS;
};

export const walletsSourceHandler: CommandHandler = async (ctx, intent) => {
  const parsed = extractConversationSourceArgs(intent.args);
  if (!parsed.ok) {
    ctx.stderr.write(`${parsed.message}\n`);
    return EXIT_USAGE_ERROR;
  }
  const result = await callSdk(ctx.stderr, () => ctx.sdk.wallets.getConversationSource(parsed.value));
  if (!result.ok) return EXIT_RUNTIME_ERROR;
  ctx.stdout.write(intent.flags.json ? `${JSON.stringify(result.value)}\n` : renderConversationSource(result.value));
  return EXIT_SUCCESS;
};
