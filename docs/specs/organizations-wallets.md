<!-- SNAPSHOT of PageSpace page drc7x34unhc0ty1dc0u1j3gy ("Organizations & Wallets — Spec").
     Source of truth is the page. scripts/check-spec-coverage.ts reads the page via the
     pagespace CLI when a credential is present and falls back to this file otherwise (CI).
     Refresh: pagespace pages read drc7x34unhc0ty1dc0u1j3gy | sed -E "s/^ *[0-9]+ \| ?//" > docs/specs/organizations-wallets.md
     (the orchestrator refreshes it; lanes do not hand-edit requirement lines). -->

# Organizations & Wallets — Spec

Status: DRAFT for confirmation (2026-09-15). One epic. Design canvas: https://claude.ai/artifact/U7gbxtYgXUj4UWBGfjSxg9 (page 1 Organizations, page 2 Wallets & allocations).

## Purpose

Teams need a way to own drives together, pay for them once, and set rules inside them. Individuals and teams both need a deliberate answer to "what am I spending from" every time AI runs. Today every drive is owned by one person, every dollar is keyed to one user, and the drive owner silently pays for compute. This epic adds an organization as a second kind of owner and a wallet as the unit AI spend draws from, and it makes the source of every spend visible before it happens.

## The model in three sentences

1. An organization is a drive owner that is not a person. A drive keeps everything it has today; an org-owned drive only answers three questions differently: who pays, which rules apply, and who in the org can see it.
2. A wallet is a balance that can allocate into child wallets. A personal balance, an org pool, a seat allowance, and a drive wallet are all rows of one table; the difference is who owns the row and what it is attached to.
3. Every AI call names its wallet before it runs, the person sees it, and the gate never switches wallets silently.

## Relationship to prior decisions

The Public Platform Program's Phase 1 (Credit Provisioning, unbuilt) already decided the pool primitive: ADR D17-final (pool-first, absolute own-credits override, funder entitlement), D18 (consumers see remaining allotment only), D20 (fine-grain: owner-only funding, debt as self-spend, UTC windows, any authenticated consumer, 10-credit daily and 100-credit monthly defaults, 80/100% alerts, global override switch, passive chip disclosure). This spec adopts that primitive as the wallet and generalizes it: a subject can be a drive, an agent page, or an org pool; a funder can be a user or an org; and donations add funders beyond the owner. Where this spec differs, it says so under Decisions. Two unmerged March branches (ppg/orgs-schema, ppg/orgs-billing) hold an org schema, drives.orgId, org-visible drives, and Stripe seat-quantity logic; they are reference material, not a base.


## Requirements

Each line must be true for the epic to be complete. IDs are stable for task lists and prompts.

### ORG — Organization core
- ORG-1 An organization exists with name, slug, avatar, and one human Owner. Ownership is transferable.
- ORG-2 Org membership roles: Owner, Admin, Member. A user may belong to many orgs. A user in no org sees no org UI.
- ORG-3 Org invitations by email with expiry, resend, revoke, and acceptance for new and existing accounts. A pending invite counts as a seat.
- ORG-4 Org Owner and Admins resolve to full access on every org-owned drive through the existing permission resolver, as one branch beside the drive-admin branch. Using it on a Private drive writes an audit event.
- ORG-5 Every org mutation is authorized by one shared org permission function used by web routes, CLI, and MCP.
- ORG-6 Deleting an org transfers its drives to a person or trashes them; nothing is orphaned. An Owner cannot delete their account while owning an org.

### DRV — Org-owned drives
- DRV-1 A drive can be owned by an org (drives.orgId). Home drives never can. The human drive lead keeps the Owner role on the drive.
- DRV-2 A person can move a drive they own into an org; an org Admin can move it out. Members, roles, pages, envs, and publishing survive the move.
- DRV-3 Drives created in an org context are org-owned from creation, subject to the "who can create org drives" policy.
- DRV-4 Each org drive has a visibility: Open, Restricted, Private. New org drives default to Open.
- DRV-5 Open: every org member resolves as an implicit member with the drive's default role; no membership row required. Sidebar, picker, and accessible-drives include it.
- DRV-6 Restricted: listed only in the org Drives directory; never in the picker or sidebar until joined. A member requests to join; the drive lead or an org Admin approves.
- DRV-7 Private: invite only; today's behaviour.
- DRV-8 A guest is a drive member whose user is not in the org. Guests hold no seat, see only the drives they were invited to, and are labeled as guests on the drive Members page.
- DRV-9 The drive picker groups drives under org headers and a Personal group, from the same accessible-drives source; it shows nothing the person cannot already open.

### SEAT — Seats and billing
- SEAT-1 An org has its own Stripe customer and subscription, separate from any member's personal plan.
- SEAT-2 The canonical tier table (packages/lib/src/billing/subscription-tiers.ts) becomes Free, Pro ($15 a month, personal), Business ($50 a month, an organization with 5 seats included, $10 per extra seat). Founder is removed (A-9). Business is the org plan: buying it creates the org, and it is not sold to a lone user without one. Every consumer of the table (web plans, admin, marketing pricing page, control-plane bridge, e2e seeds) follows from the one edit. The March per-seat vocabulary is not adopted.


- SEAT-3 Seat quantity = accepted members + pending invites; never guests, agents, or apps.
- SEAT-4 Auto-add on: inviting past the purchased count raises the Stripe quantity pro rata. Auto-add off: the invite is refused with a clear message.
- SEAT-5 Removing a member frees the seat at period end; re-adding within the period reuses it without a charge.
- SEAT-6 Plan, seat count, invoices, billing email, and portal are visible to Owner and Admins only; hidden entirely in onprem and tenant modes by the existing billing gate.
- SEAT-7 Org subscription webhooks are idempotent and routed before the personal-tier handler, as dedicated-hosting subscriptions already are.
- SEAT-8 There is no free org tier. Creating an org starts Business ($50 a month, 5 seats included) with a trial; a card is required before the trial ends.

- SEAT-9 A lapsed org (trial expired, unpaid, or canceled) keeps every org drive readable to its members and blocks org-only capabilities: inviting, creating org drives, the org pool and allocations, policies changes, publishing from org drives, and sandbox or environments in org drives. Owner and Admins see a reactivate banner on every org surface; members see a read-only notice. Nothing is deleted.


### WAL — Wallets and allocations (generalizes Phase 1 credit provisioning)
- WAL-1 One table. A wallet has: owner (user or org), optional subject (drive or agent page), optional parent wallet, monthly allocation, spent, top-up remainder (never expires), UTC period, status (active, paused, over). The existing per-user credit balance becomes the personal root wallet.
- WAL-2 An org pool is a wallet owned by the org with no subject and no parent. A seat allowance is the per-consumer monthly cap on the pool's own leg (D17.4), not a separate row. A drive wallet has a drive subject; its parent is the org pool for org drives or the owner's personal wallet for personal drives.
- WAL-3 An allocation is a budget drawn against the parent as spend happens; unspent allocation never leaves the parent. A top-up moves funds into the wallet and lasts until spent.
- WAL-4 Donations: any authenticated user can add funds to a drive wallet they can see, from their own balance, as a one-off amount. A donation is a funder leg on that wallet, recorded with the donor, and the drive lead can turn donations off for the drive. Supersedes D20.1 owner-only funding.
- WAL-5 Every AI usage row records the wallet charged. Holds are per wallet. Ledger, reconciliation, and monthly reset are keyed on wallet.
- WAL-6 Overages carry over today's rules rather than inventing new ones. (a) The gate reserves an estimate against the chosen wallet before the call and refuses when the reservation is not covered, so a wallet is never spent past zero by design; only actual-cost overshoot on a covered reservation can exceed it (existing hold and settle path, unchanged). (b) Overshoot never lands on the consumer unless they chose their own credits. (c) Where it lands is set by the wallet's funder: absorb into the parent's debt (the org pool or the owner's balance, D20.2, default) or carry as wallet debt netted from the next allocation. (d) Parent debt is forgiven at renewal exactly as personal debt is today; wallet debt clears when the next allocation lands. (e) A wallet with debt shows the "over" state and the funder is notified once per period. (f) Per-consumer caps and the kill switch (WAL-7) remain the only preventive controls.

- WAL-7 Per-consumer caps (daily and monthly, UTC) exist on every wallet leg; unset means unlimited within the wallet. Defaults on enable: 10 credits a day, 100 credits a month (D20.5, restated in credits). Alerts to the funder at 80% and 100% (D20.6). A kill switch pauses a wallet.

- WAL-8 Tier entitlement follows the wallet's root owner: the org's tier inside org drives, the funder's tier on a personal-drive wallet leg, the consumer's own tier on a self-funded leg (D17.3).
- WAL-9 Storage, sandbox runtime, environments, and published apps in an org drive bill the org: the payer seam answers "org if drives.orgId, else owner". Wallets do not change compute billing.

### MON — Money model: price, credits, and the ratio between them
- MON-1 A credit is not a dollar. One module defines the money model: MARKUP_BPS (exists), CREDITS_PER_DOLLAR (the purchase and display rate), and INCLUDED_CREDIT_RATIO_BPS per paid tier (the share of a subscription's price that is granted as credit value). No other file may state an allowance, a pack size, or a credit-to-money conversion.
- MON-2 The monthly allowance is derived, never tabulated: allowanceCents = paidCents × ratio. It is computed from the amount the invoice actually paid (Stripe invoice.paid), so a price change, a promo, or a partial period flows through without a table edit. TIER_MONTHLY_ALLOWANCE_CENTS is deleted; a test asserts the derivation for every tier.
- MON-3 The org pool refill follows the same rule: (Business base + extra-seat items) paid × ratio. More seats means a bigger pool without a second constant.
- MON-4 Top-ups buy credits at CREDITS_PER_DOLLAR with no ratio applied; packs are defined as credit counts and priced from the rate. The ratio may make a subscription's effective credit rate differ from a top-up's; that is intended and shown honestly on the plan card.
- MON-5 One definition of a credit, one source of truth: a credit is CREDITS_PER_DOLLAR⁻¹ of a dollar of credit value, defined once in the money-model module and consumed by the lib formatter, the web formatter, the marketing mirror, admin, and the CLI. formatCreditCount renders an integer count with thousands separators. toDisplayCredits (the 0–100 percent-of-allowance scale) and formatCreditUnits are removed with their callers. A test greps for any second conversion and fails on it.

- MON-6 Plan and marketing copy say "N credits included" and never a dollar figure for credits (UI-12). The plan card shows price, included credits, and the top-up rate as three separate facts.
- MON-7 Admin billing keeps margin as charged value versus provider cost; it gains "included credit liability" = grants outstanding, distinct from cash, as the current revenue split already implies.
- MON-8 Free tier: the one-time starter grant is a plain credit count constant, not derived from a price.


### SPEND — What a person is spending from
- SPEND-1 Every AI call inside a drive has exactly one source chosen before the call: the drive wallet, the caller's seat allowance, or the caller's own credits. Guests and personal drives simply have fewer options.
- SPEND-2 The source is shown before the first message of a conversation and in the header chip while inside a drive. The chip replaces the personal-credits chip only where more than one source exists (D20.8 passive disclosure).
- SPEND-3 Switching source is per conversation and persists for it. Preselection comes from the drive's default, then the person's own default in Settings.
- SPEND-4 The gate never picks a different wallet silently. An empty chosen source refuses the call, names the source, offers the remaining options, and charges nothing. Fallback happens only when the drive's rule allows it and the chip and strip show the new source.
- SPEND-5 "Always my own credits" is an absolute per-user override, per drive and as one global switch (D17.2, D20.7).
- SPEND-6 Automations, triggers, scheduled workflows, and channel mentions spend the drive wallet only, never a person's credits or allowance. Consumer key is the drive. An empty wallet skips the run and logs it.
- SPEND-7 An agent's spend is attributed to the drive of the session it runs in, not the drive the agent page lives in.
- SPEND-8 The global assistant with no drive spends personal credits.
- SPEND-9 Consumers see the drive wallet's remaining amount and their own remaining cap; never the org pool, never the funder's balance, never other consumers' spend (D18 as refined).
- SPEND-10 The drive lead sees spend by member and automation for their drive. Org Admins see every wallet, the pool, and the unallocated balance.

### POL — Policies (org-wide, enforced at existing seams)
- POL-1 Policies are stored once per org and read through one function; no route reads the org row directly. A change applies immediately; anything newly forbidden is suspended, not deleted, and listed in the audit log.
- POL-2 Guests from outside: off, admins approve, on. Enforced in the drive invite route and share-link redemption.
- POL-3 Public share links on or off. Enforced at creation and redemption; off suspends existing links.
- POL-4 Publishing to the web and custom domains. Enforced in the publish and domain routes.
- POL-5 Who can invite members; who can create org drives. Enforced in those routes.
- POL-6 Default role in Open drives. Read by the implicit-membership resolver.
- POL-7 Seat allowance amount; wallet fallback rule (seat allowance, own credits, refuse). Read by the credit gate. A drive may only be stricter.
- POL-8 Models available and provider allowlist. Enforced in the existing pro-model gate, payer-aware per WAL-8.
- POL-9 Agents may run autonomously; agents from other drives may be added. Enforced in the mention responder, triggers, workflows, and agent membership route.
- POL-10 Cloud sandbox, persistent environments, published apps. Enforced in sandbox eligibility and the env and app routes.
- POL-11 Service connections allowlist. Enforced in the drive integrations route.

### SEC — Security
- SEC-1 Verified email domains (DNS or email verification) with auto-join for new signups on a verified domain, subject to seats.
- SEC-2 Require two-step sign-in for org members; enforcement blocks org drive access, not the account.
- SEC-3 Session maximum age for org members.
- SEC-4 SSO and SCIM are out of scope and named as such in the org Security page.

### AUD — Audit log
- AUD-1 Org-scoped events: membership, seats, invites, policy changes, visibility changes, drive moves, admin access to a Private drive, wallet allocation changes, donations, billing events.
- AUD-2 Written through the existing security audit chain; no new table.
- AUD-3 Filterable by type, drive, and time; CSV export; visible to Owner and Admins.

### UI — Surfaces (each matches the canvas or flips to blocked with the divergence)
- UI-1 Org settings hub at /orgs/[orgId]/settings using the SettingsRow list pattern; reachable from the picker's org header, Account Settings › Organizations, and the drive General page.
- UI-2 Account Settings gains an Organizations section listing memberships plus Create.
- UI-3 Header crumb stays one chip: the org or the drive.
- UI-4 Drive General gains the Organization card: owner, billing summary, visibility, drive lead, move in or out.
- UI-5 Drive Members labels guests; the invite flow offers guest versus seat for an outsider.
- UI-6 Create-organization dialog: name, slug, move owned drives (Home excluded), invite people, plan summary, trial.
- UI-7 Members & seats, Drives, Policies, Security, Plan & seats, Audit log pages per canvas page 1.
- UI-8 Spending-from chip and popover, composer strip, refusal card, automation state per canvas page 2.
- UI-9 Drive Settings › Wallet page: allocation, top-up, donate, who spends, fallback, spend this month.
- UI-10 Settings › Usage › Wallets: everything I spend from, everything I fund, my default.
- UI-11 Every surface degrades correctly for a plain Member, who sees no org settings beyond leaving the org.
- UI-12 Credit amounts never carry a currency symbol anywhere in the product: they render as integer counts with thousands separators through the one formatter in the money-model module ("1,482 credits", "192 credits left"). The dollar sign appears only on plan prices, seat prices, invoices, and top-up purchase prices, which are real money. The rate (100 credits per dollar) and the formatter are unconditional. The included-credit ratio is selected by a CODE CONSTANT in the money-model module, flipped by one migration commit deployed to every app together — never by a runtime environment variable (D-OW-17). Legal text such as the Terms of Service states no credit figure and refers to the pricing page (D-OW-18); the FAQ and pricing page source figures from the module.




### X — Cross-cutting
- X-1 CLI and MCP expose orgs, members, drives, policies, and wallets where the web does.
- X-2 GDPR export and account deletion account for org membership, wallets, and donations.
- X-3 Backups and restore preserve orgId, visibility, and wallet rows.
- X-4 Realtime events for membership, visibility, and wallet state so sidebar, picker, and chip update without refresh.
- X-5 Migration: credit_balances BECOMES the wallets table — each existing per-user balance row is migrated in place into that user's personal root wallet in one backfill (decided by Jono at Standup 0, 2026-09-16). There is never a second balance store and no dual-read aliasing; ledger and holds gain walletId in the same migration. The backfill is idempotent, has a dry-run, and is verified by a row-count equality test plus a sum-of-balances equality test before and after.

- X-6 Negative tests: a non-member cannot see an Open drive of another org; a guest cannot see a second drive; a policy set to off refuses; an empty chosen wallet charges nothing; an automation never charges a person.

## Decisions

Answered in conversation (2026-09-15):
- A-1 Org pool allocates into seat allowances and drive wallets; individuals do the same one level down. One mechanism, two owners.
- A-2 Donate path exists (WAL-4). Supersedes D20.1 owner-only funding.
- A-3 Overages are handled by the mechanisms already in place, carried over to wallets: reservation before the call, debt on overshoot, forgiveness at renewal. An overage in a drive never auto-charges the consumer; who absorbs it is the funder's choice per wallet (WAL-6).

- A-4 Picker is access-only; Restricted drives are discovered in the org directory only.
- A-5 Pricing: personal Pro stays $15 a month. The org plan is Business at $50 a month with 5 seats included (SEAT-2). The canvas shows these numbers.


- A-6 All of this is one epic.
- A-7 No free org tier. An organization exists only on a paid plan or its trial; the org itself is the upsell (SEAT-8, SEAT-9).
- A-8 Seats beyond the 5 included cost $10 per seat per month, billed as a second subscription item with quantity = max(0, seats − 5).
- A-9 Founder is removed from the tier vocabulary outright; its single subscriber (Jono) is migrated by this epic. Existing $100 Business personal subscribers are grandfathered at their price with Business entitlements and no new signups.
- A-10 The subscription price and the metered credit allowance are decoupled: the allowance is a ratio of the price paid, and a credit has its own unit distinct from cents (MON-1..MON-8). The numbers are A-11.

- A-11 Money model numbers: INCLUDED_CREDIT_RATIO 60% for Pro and Business; CREDITS_PER_DOLLAR 100; top-ups at the full rate with no ratio. So Pro includes 900 credits a month, Business 3,000 plus 600 per extra seat, and a 10-dollar pack is 1,000 credits. The canvas uses these numbers; every credit surface must fit them (UI-12).





Open, with recommendation:
- O-1 Security (SEC-1..3) in this epic or deferred. Recommend: SEC-1 verified domains in; SEC-2 and SEC-3 deferred to a follow-on, since neither changes the data model.
- O-2 Restricted visibility at launch. Recommend: in, since the directory and join request are small once Open exists.
- O-3 Whether a seat holder needs a personal plan. Recommend: no; a seat grants Business entitlements inside org drives, and the person's personal drives stay on their own tier (Free or Pro).

- O-4 Guests spending a drive wallet. Recommend: off by default, per-drive switch.
- O-5 D18 refinement: consumers may see the drive wallet's remaining amount, not only their own cap. Recommend: yes, because an empty wallet is visible anyway and the pool stays hidden.
- O-6 Implicit membership: materialize drive_members rows for org members (source column: org | invite), maintained on join, leave, and visibility change, versus one enumeration function every caller must use. Recommend: materialize, because channel recipients, mention search, usersShareDrive, realtime rooms, notifications, and backups all enumerate rows today and one missed call site fails open.
- O-7 Drive lead leaves the org or deletes their account. drives.ownerId cascades on user delete today. Recommend: the lead must be an org member; on leave or delete the drive reassigns to the org Owner with an audit event.
- O-8 Leaving an org cascades: agent memberships the person granted, share links they created, MCP token drive rows they own, and their org-sourced membership rows are revoked. Recommend: yes, one leave function.
- O-9 Storage attribution: files.createdBy charges the uploader's personal quota. Recommend: org drives attribute bytes to the drive and bill the org (WAL-9); moving a drive in or out re-attributes.
- O-10 Moving a drive out of an org drops implicit access. Recommend: with materialized rows, the move offers "keep as invited members" or "remove", visibly.
- O-11 Default role in Open drives: custom roles are per drive, so the default is a drive setting; the org policy sets only the floor. Recommend: yes; amend POL-6.
- O-12 Allocation period: D20 chose UTC calendar months, but the pool refills on the Stripe renewal date. Recommend: org allocations reset on the pool's refill date; personal wallets on the personal renewal.
- O-13 Donation exit rule when a wallet is deleted or its drive leaves the org. Recommend: donation legs tracked separately and non-refundable, stated on the donate dialog.
- O-14 Entitlement with several funders (D17.3). Recommend: the wallet owner's tier governs, never a donor's.
- O-15 Drive slug uniqueness is per owner today. Recommend: unique per org for org drives.






## Out of scope
SSO and SCIM. Public drives and the visitor principal (Phase 2 of the Public Platform Program) remain their own work and consume the wallet primitive unchanged. App hosting economics.

