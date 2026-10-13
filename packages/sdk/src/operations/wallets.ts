/**
 * Wallet READ operations (Spec X-1, narrowed by [D-OW-26]): `wallets.getDriveWallet`,
 * `wallets.list`, `wallets.getConversationSource`, `wallets.getAlwaysOwnCredits`.
 *
 * Route-verified against `apps/web/src/app/api/drives/[driveId]/wallet/route.ts` GET,
 * `apps/web/src/app/api/wallets/route.ts` GET,
 * `apps/web/src/app/api/wallets/conversations/[conversationId]/route.ts` GET and
 * `apps/web/src/app/api/wallets/always-own-credits/route.ts` GET (all four
 * `allow: session, mcp`; OAuth access tokens are not admitted).
 *
 * READS ONLY, deliberately. [D-OW-26]: an MCP/CLI token may read wallet views but never moves
 * money or changes a spend source, so the wallet writes (create, allocate, pause, delete,
 * top-up, donate, caps, the personal default source, a conversation's source, the
 * always-own-credits switches) are not operations here at all — the server refuses a token on
 * every one of them by name (`mcp_token_cannot_move_money`,
 * `mcp_token_cannot_change_spend_source`), and an operation that can only ever fail has no
 * place in the registry or on the MCP tool surface. For the same reason the per-person caps
 * list (GET /api/drives/[driveId]/wallet/caps) and the org pool and seat-cap views are not
 * operations: they are admin money views, and a token only ever reads the consumer projection.
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
  'source_cap_reached',
  'chosen_wallet_unavailable',
]);
/** `SkipReason` (`packages/lib/src/billing/wallet-core.ts`). */
const skipReasonSchema = z.enum(['drive_wallet_empty', 'drive_wallet_paused', 'no_drive_wallet', 'creator_departed', 'guest_drive_wallet_off', 'source_cap_reached']);

/** A wallet a person may pick for a call: `SpendOption` / `SpendChoice` in lib. */
const spendOptionSchema = z.object({ source: spendSourceKindSchema, walletId: z.string() });

/**
 * A conversation's pickable source (`SpendChoice` in lib): named, and what the caller can still
 * spend from it (SPEND-9: a seat shows their own remaining allowance, never the pool). The extra
 * fields are optional so an older server still parses.
 */
const spendChoiceSchema = spendOptionSchema.extend({
  label: z.string().optional(),
  driveName: z.string().nullable().optional(),
  orgName: z.string().nullable().optional(),
  /** Null when the source sets no limit of its own on this person. */
  remainingCents: z.number().nullable().optional(),
  remainingCredits: z.string().nullable().optional(),
});

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
  overshootChoice: absent,
  guestSpendEnabled: absent,
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

/**
 * `DriveWalletListEntry` (`packages/lib/src/billing/wallet-views.ts`): a drive wallet the caller
 * spends from — what is left, and what the caller spent from it this period (UI-10). Never the
 * allocation or anyone else's spend (SPEND-9). `mySpent…` is optional so an older server parses.
 */
const driveWalletListEntrySchema = z.object({
  driveId: z.string(),
  driveName: z.string().nullable().optional(),
  walletId: z.string(),
  status: walletStatusSchema,
  remainingCents: z.number(),
  remainingCredits: z.string(),
  mySpentCents: z.number().optional(),
  /** `mySpentCents` as a credit count, rendered by the server's money model (MON-5). */
  mySpentCredits: z.string().optional(),
});

/** The keys of a drive wallet list entry — the SDK's copy of lib's `DRIVE_WALLET_LIST_FIELDS` (drift-guarded). */
export const DRIVE_WALLET_LIST_ENTRY_KEYS = Object.keys(driveWalletListEntrySchema.shape) as (keyof z.infer<typeof driveWalletListEntrySchema>)[];

/** `MyWallets` (`packages/lib/src/services/drive-wallet-service.ts`), as a token reads it. */
const myWalletsSchema = z.object({
  personal: z.object({
    walletId: z.string(),
    remainingCents: z.number(),
    remainingCredits: z.string(),
    defaultSpendSource: spendSourceKindSchema.nullable(),
  }),
  /** Drive wallets of drives the caller can open: the consumer amount and their own spend only (SPEND-9, UI-10). */
  driveWallets: z.array(driveWalletListEntrySchema),
  /** A seat on each org the caller belongs to (their own cap only, never the pool). */
  seats: z.array(z.object({ orgId: z.string(), orgName: z.string().nullable().optional(), walletId: z.string() })),
  funds: z.object({
    driveWallets: z.array(driveWalletListEntrySchema.partial({ status: true, remainingCents: true, remainingCredits: true })),
    /** Always empty for a token ([D-OW-26]): a pool's balance is session-only (SPEND-10). */
    pools: z.array(z.never()).max(0),
    donations: z.array(
      z.object({
        walletId: z.string(),
        driveId: z.string().nullable(),
        driveName: z.string().nullable().optional(),
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
    /** The chosen source's wallet a fallback moved the call off, else null (WAL-6b). */
    fallbackFromWalletId: z.string().nullable(),
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
    options: z.array(spendChoiceSchema),
    /** What the next AI call would spend, as the gate decides it now (nothing reserved). */
    resolved: callSpendDecisionSchema,
  }),
  requiredScope: 'account',
  description:
    "Read which wallet one of your own conversations spends from: the stored choice, the wallets you may pick there, and what the next AI call would spend as decided now (kind 'spend' with the source and wallet, 'refuse' with the reason and the options that could cover it, or 'skip'). Pass driveId only for a global conversation, to list options for that drive. Read-only — changing the source needs a signed-in session. Requires a key with no drive restriction.",
});

/**
 * GET /api/wallets/drives/:driveId (SPEND-2) — what you would spend from in a drive with no
 * conversation open (the header chip's "while inside a drive"). Read-only: nothing is reserved.
 */
export const getDriveSpendSource = defineOperation({
  name: 'wallets.getDriveSource',
  method: 'GET',
  path: '/api/wallets/drives/:driveId',
  inputSchema: z.strictObject({ driveId: z.string().min(1) }),
  outputSchema: z.object({
    driveId: z.string(),
    /** The wallets you may pick in this drive. */
    options: z.array(spendChoiceSchema),
    /** What a new conversation's first AI call here would spend, as the gate decides it now (nothing reserved). */
    resolved: callSpendDecisionSchema,
  }),
  requiredScope: 'drive',
  description:
    "Read which wallet a new conversation in a drive would spend from: the wallets you may pick there and what its first AI call would spend as decided now (kind 'spend' with the source and wallet, 'refuse' with the reason and the options that could cover it, or 'skip'). Read-only — choosing a source needs a signed-in session. Not found for a drive you cannot open.",
});

/**
 * GET /api/wallets/always-own-credits (SPEND-5) — the caller's "Always my own credits" switches.
 * Reading them is not a spend-source change; SETTING them is, so the PUT stays session-only
 * ([D-OW-26]) and is not an operation.
 */
export const getAlwaysOwnCredits = defineOperation({
  name: 'wallets.getAlwaysOwnCredits',
  method: 'GET',
  path: '/api/wallets/always-own-credits',
  inputSchema: z.strictObject({
    /** Also read the switch for this drive. */
    driveId: z.string().min(1).max(64).optional(),
  }),
  outputSchema: z.object({
    /** The global switch: every AI call spends your own credits or is refused. */
    alwaysOwnCredits: z.boolean(),
    /** The switch for `driveId` (false when no driveId was given). */
    alwaysOwnCreditsInDrive: z.boolean(),
  }),
  requiredScope: 'account',
  description:
    'Read your "Always my own credits" switches: the global one and, with driveId, the one for that drive. Either makes every AI call spend your own credits or be refused, never another wallet. Read-only — changing them needs a signed-in session. Requires a key with no drive restriction.',
});
