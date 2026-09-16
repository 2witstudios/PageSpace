# Stripe ground truth (round 4, independent review + point-guard)

Captured against Stripe **test mode** (`sk_test_...`) on 2026-09-16 by creating
and immediately deleting disposable Stripe objects: a coupon, a tax rate, a
customer, and two subscriptions on the test-mode Founder price
(`price_1SdbhePCGvbSozobuNjSn5j0`). All test objects were deleted/canceled
after capture; nothing here is a real customer.

Files:
- `01`/`02` — a Founder subscription with a `once`-duration 20% coupon and a
  tax rate, right after creation (plain and `expand`ed).
- `03` — a schedule created `from_subscription`, before any phase update
  (the "crashed between create and update" state).
- `04`/`05` — the same schedule after `updateSchedulePhases([Founder→cpe,
  Pro→], end_behavior: 'release')` (the "crashed between update and the
  local write" state) — plain and expanded.
- `06` — the subscription after a schedule is attached.
- `07` — a second subscription created with a future `trial_end`.
- `08` — the same subscription with `pause_collection` set.

## Findings that changed the implementation

1. **Stripe fills in `end_date` on the final phase.** `04`/`05` phase 1 (the
   Pro phase) shows `end_date: 1794849172` — exactly `currentPeriodEnd +
   one billing interval` — even though our `updateSchedulePhases` call never
   set one. A byte-for-byte `JSON.stringify` comparison against a builder
   that never sets `end_date` on the final phase refuses FOREVER, even on
   the schedule the script itself just created — a crashed run could never
   complete its local write on retry. Fixed: `phasesEqual` now compares an
   explicit list of builder-defined fields per phase (items, start_date,
   phase-level discounts, default_tax_rates) and ignores `end_date` ONLY on
   the final phase; every other phase's `end_date` still must match exactly.

2. **`default_settings` (automatic_tax, collection_method, ...) is inherited
   automatically** when a schedule is created `from_subscription` (`03`'s
   `default_settings.automatic_tax`/`collection_method` already match the
   source subscription) and is untouched by a `phases`-only update (`04`
   still shows the same `default_settings`). We never send `default_settings`
   in `updateSchedulePhases`, so these values are carried through by
   construction — no extra code needed to "not silently drop" them. The
   positive-match check in `planExistingScheduleAction` reads them back and
   requires them to still equal the subscription's current values, so a
   schedule where they've drifted (edited via the dashboard, say) refuses
   rather than being accepted.

3. **`default_tax_rates` is NOT part of `default_settings`** — it lives on
   each phase and is not auto-copied to a phase we add ourselves. The
   builder now sets it explicitly on both phases from the subscription's
   current `default_tax_rates`.

4. **Subscription-level `discounts` is an array of Discount-object ID
   strings** (`di_...`), not `{coupon, discount, promotion_code}` objects —
   confirmed by a `duration: 'forever'` coupon (`sub.discounts` populated)
   vs a `duration: 'once'` coupon already consumed on the first invoice
   (`sub.discounts` empty, correctly — nothing recurs). The existing
   `idOf`-based mapping already handled the string-id case correctly; no
   change needed there. A schedule PHASE's own `discounts`, by contrast, IS
   the `{coupon, discount, promotion_code}` object shape (`04`/`05` show
   `{"coupon": "Y4xgiyJe", "discount": null, "promotion_code": null}`),
   confirming the id lives in `coupon` on read for a coupon-based discount —
   resolving the ambiguity the reviewer flagged.

5. **A trialing subscription's `status` is `'trialing'`, not `'active'`**
   (`07`) — already refused by the existing `status === 'active'` check.
   `trial_end` is read and refused-on anyway (explicit, belt-and-suspenders,
   per point-guard) in case a future subscription shape has `status:
   'active'` with a still-future `trial_end`.
