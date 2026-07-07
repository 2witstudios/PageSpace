# Metered Sandbox Remediation

Follow-ups from the 2026-07-07 terminal/sandbox metering audit (branch
`pu/audit-metered-sandboxes`). Prod findings: 2,390 usage rows ($74.41 of billed
spend) invisible on the usage page behind a stale billing-period window; PTY
sessions settle only at session end from an in-memory map, so any realtime
deploy/crash mid-session silently loses the whole session's billing.

## Requirements

### 1. Usage breakdown window (stale billing period)

- Given a user whose `credit_balances.monthlyPeriodEnd` is in the past, the
  usage breakdown should fall back to the trailing 30 days ending now, so
  current usage is never hidden behind a stale period window.
- Given a user whose `monthlyPeriodEnd` is in the future (a normal current
  period), the breakdown should keep using `[monthlyPeriodStart, monthlyPeriodEnd]`.
- Given a user with a balance row but no `monthlyPeriodEnd`, the breakdown
  should keep using `[monthlyPeriodStart, now)` (open-ended), unchanged.
- Given a user with no balance row at all, the breakdown should keep the
  existing trailing-30-day fallback, unchanged.

### 2. Gate-driven period roll for accounts without live Stripe renewals

- Given a paid-tier user whose monthly window has expired and who has NO
  subscription in a renewal-capable status (`active`, `trialing`, `past_due`),
  the credit gate should roll their window and refill their tier allowance —
  the same reset free users get (no invoice will ever arrive to do it).
- Given a paid-tier user whose window has expired but who HAS a subscription in
  a renewal-capable status, the gate should NOT roll — `invoice.paid` remains
  authoritative (rolling would double-grant when the invoice lands or replays).
- Given a free-tier user, the existing gate-driven reset should be unchanged
  (no subscription lookup added to that path).

### 4. Renewal invoices must stamp the NEW service period (root cause of #1/#2's stale windows for subscribers)

- Given a renewal `invoice.paid` whose invoice-level `period_start`/`period_end`
  describe the just-ended cycle (Stripe semantics), the refill should stamp the
  balance window from the LINE ITEM's service period — the cycle actually paid
  for — so a subscriber's window is current, not expired-on-arrival. (Prod
  evidence: all 4 live subscribers had windows stamped to the ended cycle; one
  first-invoice user had start == end.)
- Given a plan-change invoice with multiple lines (prorations + new plan), the
  refill should stamp the line with the latest period end.
- Given an invoice with no line periods at all, the refill should keep the
  invoice-level fallback.

### 3. Agent-terminal heartbeat settle (deploy-time revenue loss)

- Given a metered agent-terminal session that stays open longer than the settle
  heartbeat interval, the handler should settle the accrued active window at
  each heartbeat (usage recorded, hold consumed) and place a fresh hold with the
  window start rebased — so a realtime restart loses at most one heartbeat
  interval of billing, not the whole session.
- Given the fresh-hold gate is denied at a heartbeat (payer out of credits),
  the session should be torn down the same way a failed re-auth tears it down,
  after the accrued window has been settled.
- Given a metered session whose gate placed no hold (billing pipeline in a
  no-hold mode), session end should still record its usage — settle keys on
  payer + window start, with the hold optional (matches tool-runners).

## Out of scope

- ~~Why `invoice.paid` refills stopped landing~~ RESOLVED: they never stopped —
  the June 13 refill landed; requirement #4's invoice-period stamping bug made
  the window expired-on-arrival. Remaining oddity: `subscriptions.currentPeriodEnd`
  is stale (Jun 13) for 2 of 4 live subscribers, so `customer.subscription.updated`
  after renewal appears not to be processed for some accounts — investigate
  separately. Existing stale balance windows self-heal at each account's next
  renewal now that stamping is fixed; the usage-page fallback covers the gap.
- Backfilling June's unmetered machine runtime/storage (predates metering).

## Review follow-ups (accepted, not in this change)

- **Deploy tail loss**: the heartbeat bounds a realtime restart's loss to one
  interval, but the final partial interval of every live session is still lost
  on deploy (plus its fresh hold lingers to TTL). Deeper fix: persist per-session
  `billedThrough` and reconcile on boot, or a SIGTERM settle sweep.
- **Comped as inferred state**: `hasRenewalCapableSubscription` infers "comped"
  from the absence of a live subscriptions row (webhook-maintained). A missed
  webhook makes a real subscriber look comped (double-grant window); a
  first-class comped/billing-mode flag on the account would key on declared
  intent. The in-tx re-check narrows but does not eliminate this.
- **Gifted subscriptions**: a `gifted=true` subscription with status `active`
  counts as renewal-capable; if gift flows don't deliver `invoice.paid` to the
  recipient, those accounts still never refill. Verify the gift funding path
  and exclude gifted rows if so.
- **Predicate drift**: window-expiry staleness is now computed in three places
  (credit-gate, credit-balance display, usage-breakdown) with intentionally
  different null semantics; converge on shared helpers in packages/lib/billing.
  Same for `RENEWAL_CAPABLE_STATUSES` (now exported) vs the six apps/web routes
  that inline `['active','trialing','past_due']`.
- **Stuck past-due hot path**: a paid user whose window is expired but whose
  subscription is still renewal-capable pays one extra subscriptions SELECT per
  gate call until the renewal lands. Fold into the balance read if it shows up
  in metrics.
