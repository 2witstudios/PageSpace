/**
 * Wallet READ operations (Spec X-1, narrowed by [D-OW-26]): `wallets.getDriveWallet`,
 * `wallets.list`, `wallets.getConversationSource`.
 *
 * Route-verified against `apps/web/src/app/api/drives/[driveId]/wallet/route.ts` GET,
 * `apps/web/src/app/api/wallets/route.ts` GET and
 * `apps/web/src/app/api/wallets/conversations/[conversationId]/route.ts` GET (all three
 * `allow: session, mcp`; OAuth access tokens are not admitted).
 *
 * READS ONLY, deliberately. [D-OW-26]: an MCP/CLI token never moves money or changes a
 * spend source, so the wallet writes (create, change, delete, top-up, donate, the personal
 * default source, a conversation's source) are not operations here at all — the server
 * refuses a token on every one of them by name (`mcp_token_cannot_move_money`,
 * `mcp_token_cannot_change_spend_source`), and an operation that can only ever fail has no
 * place in the registry or on the MCP tool surface.
 *
 * What a token reads is always the CONSUMER projection, whatever the person's role
 * (`viewerForCredential` in `packages/lib/src/permissions/wallet-access.ts`): the wallet's
 * remaining amount and the caller's own cap, never the org pool, the allocation, or anyone
 * else's spend (`CONSUMER_WALLET_FIELDS` in `packages/lib/src/billing/wallet-views.ts`).
 *
 * Output strictness. Output objects stay open-world, as ADR 0001 D5 requires of every
 * operation (an unknown field is stripped, not rejected, so an additive server change is
 * never de-facto breaking) — but the token invariants are CLOSED, so a response that breaks
 * [D-OW-26] fails as a `ResponseValidationError` instead of being passed through or quietly
 * trimmed: `viewer` is only `member`/`guest`, `actions` holds nothing but `view`, the lead
 * and org-admin fields (`pool`, `spendByConsumer`, `allocationCents`, …) are declared
 * absent, and `funds.pools` must be empty. None of those is an additive change: each is the
 * server showing a token something it must not.
 *
 * Amounts are cents of CREDIT value (not money). Each comes with its credit count already
 * rendered by the server's money model (`…Credits`, e.g. "1,200"): display that string and
 * never convert cents in a client — a credit is converted in one module only (MON-5). Never
 * with a currency symbol (UI-12).
 *
 * The enum vocabularies are inlined rather than imported from `@pagespace/lib` (the
 * published SDK never runtime- or type-imports it); `__tests__/wallets-drift-guard.test.ts`
 * pins them to lib's canonical types.
 */
import { z } from 'zod';
import { defineOperation } from '../registry/define.js';

/** `SpendSourceKind` (`packages/lib/src/billing/wallet-core.ts`). */
const spendSourceKindSchema = z.enum(['drive_wallet', 'seat_allowance', 'own_credits']);
/** `WalletStatus` (`packages/lib/src/billing/wallet-core.ts`). */
const walletStatusSchema = z.enum(['active', 'paused', 'over']);
/** `SubscriptionTier` (`packages/lib/src/billing/subscription-tiers.ts`). */
const subscriptionTierSchema = z.enum(['free', 'pro', 'business']);
/** `RefusalReason` (`packages/lib/src/billing/wallet-core.ts`). */
const refusalReasonSchema = z.enum([
  'no_source_chosen',
  'source_empty',
  'source_paused',
  'source_unavailable',
  'guest_drive_wallet_off',
  'chosen_wallet_unavailable',
]);
/** `SkipReason` (`packages/lib/src/billing/wallet-core.ts`). */
const skipReasonSchema = z.enum(['drive_wallet_empty', 'drive_wallet_paused', 'no_drive_wallet']);

/** A wallet a person may pick for a call: `SpendOption` / `SpendChoice` in lib. */
const spendOptionSchema = z.object({ source: spendSourceKindSchema, walletId: z.string() });

/** The two viewers a token can ever be ([D-OW-26]); `lead`/`org_admin` is a contract violation. */
const tokenViewerSchema = z.enum(['member', 'guest']);

/**
 * Fields only the lead and org-admin projections carry (`LeadWalletView`,
 * `OrgAdminWalletView`). Declared ABSENT: present at all, the response is refused.
 */
const absent = z.never().optional();
const LEAD_AND_ADMIN_ONLY_FIELDS = {
  allocationCents: absent,
  spentCents: absent,
  topupRemainingCents: absent,
  debtCents: absent,
  periodStart: absent,
  periodEnd: absent,
  fallbackRule: absent,
  spendByConsumer: absent,
  pool: absent,
} as const;

/** `ConsumerWalletView` (`packages/lib/src/billing/wallet-views.ts`) — the only view a token gets. */
const consumerWalletViewSchema = z.object({
  viewer: tokenViewerSchema,
  walletId: z.string(),
  driveId: z.string(),
  status: walletStatusSchema,
  remainingCents: z.number(),
  /** `remainingCents` as a credit count ("1,200"), rendered by the server's money model (MON-5). */
  remainingCredits: z.string(),
  /** Null = no cap of that kind (unlimited within the wallet). */
  myCap: z.object({
    dailyRemainingCents: z.number().nullable(),
    monthlyRemainingCents: z.number().nullable(),
    dailyRemainingCredits: z.string().nullable(),
    monthlyRemainingCredits: z.string().nullable(),
  }),
  donationsEnabled: z.boolean(),
  /** The drive's default source (SPEND-3): what a new conversation here preselects. */
  defaultSpendSource: spendSourceKindSchema.nullable(),
  ...LEAD_AND_ADMIN_ONLY_FIELDS,
});

export type ConsumerWalletView = z.infer<typeof consumerWalletViewSchema>;

/** The keys a consumer view carries — the SDK's copy of lib's `CONSUMER_WALLET_FIELDS` (drift-guarded). */
export const CONSUMER_WALLET_VIEW_KEYS = [
  'viewer',
  'walletId',
  'driveId',
  'status',
  'remainingCents',
  'remainingCredits',
  'myCap',
  'donationsEnabled',
  'defaultSpendSource',
] as const;

/** `MyWallets` (`packages/lib/src/services/drive-wallet-service.ts`), as a token reads it. */
const myWalletsSchema = z.object({
  personal: z.object({
    walletId: z.string(),
    remainingCents: z.number(),
    remainingCredits: z.string(),
    defaultSpendSource: spendSourceKindSchema.nullable(),
  }),
  /** Drive wallets of drives the caller can open: the consumer amount only (SPEND-9). */
  driveWallets: z.array(
    z.object({ driveId: z.string(), walletId: z.string(), status: walletStatusSchema, remainingCents: z.number(), remainingCredits: z.string() }),
  ),
  /** A seat on each org the caller belongs to (their own cap only, never the pool). */
  seats: z.array(z.object({ orgId: z.string(), walletId: z.string() })),
  funds: z.object({
    driveWallets: z.array(z.object({ driveId: z.string(), walletId: z.string() })),
    /** Always empty for a token ([D-OW-26]): a pool's balance is session-only (SPEND-10). */
    pools: z.array(z.never()).max(0),
    donations: z.array(
      z.object({
        walletId: z.string(),
        driveId: z.string().nullable(),
        originalCents: z.number(),
        originalCredits: z.string(),
        remainingCents: z.number(),
        remainingCredits: z.string(),
        createdAt: z.string(),
      }),
    ),
  }),
});

export type MyWallets = z.infer<typeof myWalletsSchema>;

/** `CallSpendDecision` (`packages/lib/src/billing/spend-target.ts`), discriminated on `kind`. */
const callSpendDecisionSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('spend'),
    source: spendSourceKindSchema,
    walletId: z.string(),
    fallbackApplied: z.boolean(),
    fallbackFrom: spendSourceKindSchema.nullable(),
    /** The tier whose entitlements (the pro-model gate) apply to the call (WAL-8). */
    entitlementTier: subscriptionTierSchema,
  }),
  z.object({
    kind: z.literal('refuse'),
    source: spendSourceKindSchema.nullable(),
    reason: refusalReasonSchema,
    options: z.array(spendOptionSchema),
    chargeCents: z.literal(0),
  }),
  z.object({
    kind: z.literal('skip'),
    reason: skipReasonSchema,
    walletId: z.string().nullable(),
    chargeCents: z.literal(0),
  }),
]);

export type CallSpendDecision = z.infer<typeof callSpendDecisionSchema>;

export const getDriveWallet = defineOperation({
  name: 'wallets.getDriveWallet',
  method: 'GET',
  path: '/api/drives/:driveId/wallet',
  inputSchema: z.strictObject({ driveId: z.string().min(1) }),
  outputSchema: z.object({
    viewer: tokenViewerSchema,
    /** A token may take no wallet write: `view` is the only action it is ever offered. */
    actions: z.array(z.literal('view')),
    /** Null when the drive has no wallet. */
    wallet: consumerWalletViewSchema.nullable(),
  }),
  requiredScope: 'drive',
  description:
    "Read a drive's wallet as a consumer: its status, remaining credit (in cents of credit value), your own remaining daily/monthly cap (null = no cap), whether donations are on, and the drive's default spend source. `wallet` is null when the drive has none. Read-only — an access token can never create, change, fund or donate to a wallet (sign in to the web app for that). Not found for a drive you cannot open or while organizations are off.",
});

export const listMyWallets = defineOperation({
  name: 'wallets.list',
  method: 'GET',
  path: '/api/wallets',
  inputSchema: z.strictObject({}),
  outputSchema: myWalletsSchema,
  requiredScope: 'account',
  description:
    'List everything you spend from and fund: your own wallet and default spend source, the wallets of drives you can open (remaining amount only), your org seats, the drive wallets your wallet funds, and your donations. Amounts are cents of credit value. Requires a key with no drive restriction (a drive-scoped key is refused, since this lists drives outside its scope). Org pool balances are never returned to a key.',
});

export const getConversationSpendSource = defineOperation({
  name: 'wallets.getConversationSource',
  method: 'GET',
  path: '/api/wallets/conversations/:conversationId',
  inputSchema: z.strictObject({
    conversationId: z.string().min(1),
    /** Only read for a GLOBAL conversation (which has no drive of its own): the drive you are choosing for. */
    driveId: z.string().min(1).max(64).optional(),
  }),
  outputSchema: z.object({
    conversationId: z.string(),
    /** The conversation's own drive (or `driveId` for a global conversation); null when none. */
    driveId: z.string().nullable(),
    /** The wallet stored as this conversation's choice; null = none chosen. */
    chosenWalletId: z.string().nullable(),
    /** The wallets you may pick here. */
    options: z.array(spendOptionSchema),
    /** What the next AI call would spend, as the gate decides it now (nothing reserved). */
    resolved: callSpendDecisionSchema,
  }),
  requiredScope: 'account',
  description:
    "Read which wallet one of your own conversations spends from: the stored choice, the wallets you may pick there, and what the next AI call would spend as decided now (kind 'spend' with the source and wallet, 'refuse' with the reason and the options that could cover it, or 'skip'). Pass driveId only for a global conversation, to list options for that drive. Read-only — changing the source needs a signed-in session. Requires a key with no drive restriction.",
});
