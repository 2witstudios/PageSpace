# PageSpace Stripe Billing Flows

Complete documentation of every user experience, route, edge case, and situation for Stripe billing, subscriptions, and tier management.

---

## Table of Contents

1. [Subscription Tiers & Limits](#1-subscription-tiers--limits)
2. [API Routes Reference](#2-api-routes-reference)
3. [User Experience Flows](#3-user-experience-flows)
4. [Edge Cases & Error Handling](#4-edge-cases--error-handling)
5. [Webhook Event Handling](#5-webhook-event-handling)
6. [Database Schema](#6-database-schema)
7. [Frontend Components](#7-frontend-components)
8. [Rate Limiting & Usage Enforcement](#8-rate-limiting--usage-enforcement)
9. [Testing Scenarios](#9-testing-scenarios)

---

## 1. Subscription Tiers & Limits

### Plan Hierarchy (Lowest to Highest)

| Tier | Price | AI Calls/Day | Pro AI/Day | Storage | Max File | Badge |
|------|-------|--------------|------------|---------|----------|-------|
| **FREE** | $0 | 50 | 0 | 500 MB | 20 MB | - |
| **PRO** | $15/mo | 200 | 50 | 2 GB | 50 MB | "Most Popular" |
| **FOUNDER** | $50/mo | 500 | 100 | 10 GB | 50 MB | "Best Value" |
| **BUSINESS** | $100/mo | 1000 | 500 | 50 GB | 100 MB | - |

### Stripe Price IDs (Test Mode)

```
Pro:      price_1Sdbh6PCGvbSozob1IBfmSuv
Founder:  price_1SdbhePCGvbSozobuNjSn5j0
Business: price_1SdbhfPCGvbSozobpTMXfqkX
```

### Feature Availability by Tier

| Feature | Free | Pro | Founder | Business |
|---------|------|-----|---------|----------|
| Standard AI Models | ✅ | ✅ | ✅ | ✅ |
| Pro AI Models (Advanced Reasoning) | ❌ | ✅ | ✅ | ✅ |
| Priority Processing | ❌ | ✅ | ✅ | ✅ |
| Enterprise Processing | ❌ | ❌ | ❌ | ✅ |
| Priority Support | ❌ | ✅ | ✅ | ✅ |
| Enterprise Features | ❌ | ❌ | ❌ | ✅ |
| Max Concurrent Uploads | 2 | 3 | 3 | 10 |
| Max Files | 100 | 500 | 500 | 5000 |

---

## 2. API Routes Reference

### Subscription Management

| Method | Route | Purpose | Auth |
|--------|-------|---------|------|
| POST | `/api/stripe/create-subscription` | Create new subscription (free → paid) | JWT + CSRF |
| POST | `/api/stripe/update-subscription` | Change plan (upgrade/downgrade) | JWT + CSRF |
| POST | `/api/stripe/cancel-subscription` | Schedule cancellation at period end | JWT + CSRF |
| POST | `/api/stripe/reactivate-subscription` | Cancel pending cancellation | JWT + CSRF |
| GET | `/api/subscriptions/status` | Get current subscription + usage | JWT |
| GET | `/api/subscriptions/usage` | Get AI usage counts | JWT |

### Payment Methods

| Method | Route | Purpose | Auth |
|--------|-------|---------|------|
| GET | `/api/stripe/payment-methods` | List all cards | JWT |
| DELETE | `/api/stripe/payment-methods` | Remove a card | JWT + CSRF |
| PATCH | `/api/stripe/payment-methods` | Set default card | JWT + CSRF |
| POST | `/api/stripe/setup-intent` | Create SetupIntent for adding card | JWT + CSRF |

### Invoices & Billing

| Method | Route | Purpose | Auth |
|--------|-------|---------|------|
| GET | `/api/stripe/invoices` | List invoice history (paginated) | JWT |
| GET | `/api/stripe/upcoming-invoice` | Preview next invoice + proration | JWT |
| GET | `/api/stripe/billing-address` | Get billing address | JWT |
| PUT | `/api/stripe/billing-address` | Update billing address | JWT + CSRF |

### Customer & Portal

| Method | Route | Purpose | Auth |
|--------|-------|---------|------|
| GET | `/api/stripe/customer` | Get Stripe customer details | JWT + CSRF |
| POST | `/api/stripe/customer` | Create or get customer | JWT + CSRF |
| POST | `/api/stripe/portal` | Create billing portal session | JWT + CSRF |

### Webhooks

| Method | Route | Purpose | Auth |
|--------|-------|---------|------|
| POST | `/api/stripe/webhook` | Process Stripe events | Signature |

---

## 3. User Experience Flows

### 3.1 New User Signs Up (Free Tier)

```
1. User creates account
2. User assigned subscriptionTier = 'free'
3. No Stripe customer created yet
4. User has access to:
   - 50 AI calls/day (standard models only)
   - 500 MB storage
   - 20 MB max file size
   - Basic processing
```

### 3.2 Free User Upgrades to Paid Plan

```
User Action: Click "Upgrade" on Pro/Founder/Business plan

Flow:
1. Frontend calls POST /api/stripe/create-subscription
2. Backend validates user is on free tier
3. Backend creates Stripe customer (if not exists)
4. Backend creates subscription with status 'incomplete'
5. Backend returns clientSecret for PaymentElement
6. Frontend displays EmbeddedCheckoutForm
7. User enters card details
8. User clicks "Subscribe"
9. stripe.confirmPayment() called
10. Stripe processes payment
11. Webhook receives customer.subscription.updated
12. Webhook updates user.subscriptionTier
13. Webhook upserts subscription record
14. User redirected to /settings/plan?success=true
15. Frontend shows success message + refreshes data
```

**Success State:**
- User immediately has new tier limits
- Card saved as default payment method
- Subscription active, renews monthly

**Failure States:**
- Card declined → User remains on free tier
- 3D Secure failed → User remains on free tier
- Network error → User can retry

### 3.3 Paid User Upgrades to Higher Plan

```
User Action: Pro user clicks "Upgrade" on Founder plan

Flow:
1. PlanChangeConfirmation dialog opens
2. Frontend calls GET /api/stripe/upcoming-invoice?priceId=founder_price
3. Backend calculates proration preview
4. Dialog shows "Amount due today: $XX.XX"
5. User confirms upgrade
6. Frontend calls POST /api/stripe/update-subscription
   - body: { priceId: 'founder_price', isDowngrade: false }
7. Backend updates subscription with proration_behavior='always_invoice'
8. Stripe generates proration invoice
9. Stripe charges user immediately
10. Webhook updates subscription + tier
11. Dialog closes, data refreshes
```

**Proration Example:**
```
User: Pro ($15/mo) upgrading to Founder ($50/mo) on day 10 of 30-day cycle

Remaining days: 20 days
Pro credit: $15 × (20/30) = $10.00
Founder charge: $50 × (20/30) = $33.33
Amount due today: $33.33 - $10.00 = $23.33

Next full invoice (day 30): $50.00
```

### 3.4 Paid User Downgrades to Lower Plan

```
User Action: Founder user clicks "Downgrade" on Pro plan

Flow:
1. PlanChangeConfirmation dialog opens
2. No proration calculation (keeps current plan until period end)
3. Dialog shows alert: "You'll keep Founder features until [date]"
4. User confirms downgrade
5. Frontend calls POST /api/stripe/update-subscription
   - body: { priceId: 'pro_price', isDowngrade: true }
6. Backend creates/updates subscription schedule:
   - Phase 1: Founder plan until current_period_end
   - Phase 2: Pro plan from current_period_end onward
7. No immediate charge
8. Dialog shows success with effective date
9. At period end, Stripe automatically switches to Pro
10. Webhook updates subscription + tier
```

**Key Behavior:**
- User keeps ALL current tier features until period end
- No refund issued
- Next invoice will be at new (lower) price

### 3.5 Paid User Cancels Subscription (Downgrade to Free)

```
User Action: Click "Cancel Subscription" on billing page

Flow:
1. Confirmation dialog appears
2. User confirms cancellation
3. Frontend calls POST /api/stripe/cancel-subscription
4. Backend sets cancel_at_period_end = true
5. Backend updates local subscription record
6. UI shows "Canceling" badge on plan
7. UI shows "Reactivate" button
8. User keeps access until period end
9. At period end, webhook fires customer.subscription.deleted
10. Backend sets user.subscriptionTier = 'free'
11. Backend marks subscription status = 'canceled'
```

**Post-Cancellation State:**
- Storage quota drops to 500 MB (existing files NOT deleted)
- AI calls drop to 50/day standard, 0 pro
- Max file upload drops to 20 MB

### 3.6 Canceled User Reactivates

```
User Action: Click "Reactivate" while subscription pending cancellation

Precondition: subscription.cancelAtPeriodEnd = true

Flow:
1. Confirmation dialog appears
2. User confirms reactivation
3. Frontend calls POST /api/stripe/reactivate-subscription
4. Backend validates subscription is pending cancellation
5. Backend sets cancel_at_period_end = false
6. Backend updates local subscription record
7. UI removes "Canceling" badge
8. Subscription continues normally
9. Next renewal charges at current plan rate
```

### 3.7 Add Payment Method

```
User Action: Click "Add Payment Method" on billing page

Flow:
1. AddPaymentMethodForm dialog opens
2. Frontend calls POST /api/stripe/setup-intent
3. Backend creates/gets customer
4. Backend creates SetupIntent
5. Backend returns clientSecret
6. Dialog displays PaymentElement
7. User enters card details
8. User clicks "Add Card"
9. stripe.confirmSetup() called
10. Stripe attaches payment method to customer
11. Redirect to /settings/billing?pm_added=true
12. Success alert shown
13. Payment methods list refreshes
```

### 3.8 Set Default Payment Method

```
User Action: Click "Set Default" on a card

Flow:
1. Frontend calls PATCH /api/stripe/payment-methods
   - body: { paymentMethodId: 'pm_xxx' }
2. Backend validates ownership (card belongs to user's customer)
3. Backend updates customer.invoice_settings.default_payment_method
4. UI shows success
5. List refreshes with new default indicator
```

### 3.9 Remove Payment Method

```
User Action: Click delete icon on a card

Flow:
1. Confirmation dialog appears
2. User confirms deletion
3. Frontend calls DELETE /api/stripe/payment-methods
   - body: { paymentMethodId: 'pm_xxx' }
4. Backend validates ownership
5. Backend calls stripe.paymentMethods.detach()
6. UI shows success
7. List refreshes
```

**Edge Case:** Cannot delete only payment method if subscription requires it

### 3.10 Update Billing Address

```
User Action: Edit billing address form

Flow:
1. Click "Edit" on billing address section
2. Form appears with current values (or empty)
3. User fills required fields (line1, city, country)
4. User clicks "Save Address"
5. Frontend calls PUT /api/stripe/billing-address
6. Backend creates customer if needed
7. Backend updates customer address
8. Success alert shown (auto-clears after 3s)
9. Form closes
```

### 3.11 View Invoice History

```
User Action: Navigate to billing page

Flow:
1. Billing page loads
2. Frontend calls GET /api/stripe/invoices?limit=10
3. InvoiceList component renders table
4. Each invoice shows: date, description, amount, status
5. "View" opens hosted invoice URL
6. "Download" opens PDF
7. "Load More" calls API with starting_after=last_invoice_id
```

### 3.12 Preview Upgrade Cost

```
User Action: Click upgrade button (opens confirmation dialog)

Flow:
1. Dialog opens with loading state
2. Frontend calls GET /api/stripe/upcoming-invoice?priceId=new_price
3. Backend creates preview with proration
4. Response includes:
   - Total amount due
   - Proration line items
   - Next billing date
5. Dialog displays breakdown
6. User can confirm or cancel
```

---

## 4. Edge Cases & Error Handling

### 4.1 Authentication & Authorization

| Scenario | Response | User Experience |
|----------|----------|-----------------|
| No JWT token | 401 Unauthorized | Redirect to login |
| Expired JWT | 401 Unauthorized | Redirect to login |
| Missing CSRF token (POST/PATCH/DELETE) | 403 Forbidden | Show error, user can retry |
| User not found | 404 Not Found | Show error message |

### 4.2 Subscription State Errors

| Scenario | Response | Handling |
|----------|----------|----------|
| Free user calls update-subscription | 400 "No active subscription" | Show upgrade flow instead |
| Paid user calls create-subscription | 400 "Already subscribed" | Show change plan flow |
| Reactivate non-canceled subscription | 400 "Not scheduled for cancellation" | Button shouldn't be visible |
| Cancel already-canceled subscription | 400 "Already canceled" | Refresh UI state |
| Upgrade with same plan | 400 "Already on this plan" | Button shouldn't be visible |

### 4.3 Payment Failures

| Scenario | Webhook Event | User Impact |
|----------|---------------|-------------|
| Card declined on new subscription | None (incomplete) | Stays on free tier, can retry |
| Card declined on renewal | invoice.payment_failed | Subscription goes past_due |
| 3D Secure authentication failed | None | Payment not completed |
| Insufficient funds | invoice.payment_failed | Stripe retries per schedule |
| Card expired | invoice.payment_failed | User prompted to update card |

**Past Due Subscription Behavior:**
1. Stripe attempts retries (configurable schedule)
2. User keeps access during retry period
3. After all retries exhausted → subscription.deleted webhook
4. User downgraded to free tier

### 4.4 Stripe Customer Issues

| Scenario | Response | Handling |
|----------|----------|----------|
| No Stripe customer exists | Create one automatically | Transparent to user |
| Customer deleted in Stripe | 404 or create new | Clean up stale reference |
| Multiple customers (data issue) | Use first match | Should not happen |

### 4.5 Payment Method Issues

| Scenario | Response | User Experience |
|----------|----------|-----------------|
| Delete only payment method | Stripe may prevent | Show appropriate error |
| Payment method not found | 404 | Refresh list |
| Payment method belongs to different customer | 404 | Security protection |
| Set default on non-existent card | 404 | Refresh list |

### 4.6 Webhook Processing Issues

| Scenario | Response | Recovery |
|----------|----------|----------|
| Invalid signature | 400 | Event rejected, not processed |
| Duplicate event (idempotency) | 200 | Silently ignored |
| User not found by customer ID | 500 + log | Manual investigation |
| Unknown event type | 200 | Silently ignored |
| Processing error | 500 | Stripe retries |
| Database error | 500 | Stripe retries |

### 4.7 Proration Edge Cases

| Scenario | Behavior |
|----------|----------|
| Upgrade on first day of cycle | Full month proration |
| Upgrade on last day of cycle | Minimal proration |
| Multiple upgrades in same period | Each creates proration |
| Downgrade then upgrade before period end | Schedule replaced with upgrade |

### 4.8 Subscription Schedule Conflicts

| Scenario | Behavior |
|----------|----------|
| Existing downgrade schedule + new downgrade | New schedule replaces old |
| Existing downgrade schedule + upgrade | Upgrade executes immediately |
| Schedule exists from Stripe dashboard | Retrieved and modified |

### 4.9 Concurrent Operations

| Scenario | Protection |
|----------|------------|
| Two upgrade requests simultaneously | Stripe handles atomically |
| Cancel + reactivate race | Database transaction |
| Multiple webhook events for same subscription | Idempotency via event ID |

### 4.10 Storage Quota Exceeded

| Scenario | User Experience |
|----------|-----------------|
| Upload exceeds tier quota | 413 error, upload blocked |
| Downgrade with storage over new quota | Files NOT deleted, uploads blocked |
| File count exceeds tier limit | 413 error, upload blocked |
| Concurrent upload limit reached | 429 error, retry later |

---

## 5. Webhook Event Handling

### Events Processed

| Event | Handler | Action |
|-------|---------|--------|
| `customer.subscription.created` | `handleSubscriptionChange` | Create subscription record, set tier |
| `customer.subscription.updated` | `handleSubscriptionChange` | Update subscription record, update tier |
| `customer.subscription.deleted` | `handleSubscriptionDeleted` | Mark canceled, downgrade to free |
| `checkout.session.completed` | `handleCheckoutCompleted` | Link customer ID to user |
| `invoice.payment_failed` | `handlePaymentFailed` | Log warning |
| `invoice.paid` | `handleInvoicePaid` | Log success |

### Tier Detection from Price Amount

```javascript
// Price in cents → Tier mapping
10000 (or 19999 legacy) → 'business'
5000                     → 'founder'
1500 (or 2999 legacy)    → 'pro'
other paid               → 'pro' (fallback)
```

### Subscription Status Handling

| Stripe Status | Tier Assignment |
|---------------|-----------------|
| `active` | Based on price |
| `trialing` | Based on price |
| `past_due` | Keep current tier |
| `canceled` | 'free' |
| `unpaid` | Keep current tier |
| `incomplete` | No change |
| `incomplete_expired` | 'free' |

---

## 6. Database Schema

### Users Table (Subscription Fields)

```sql
stripeCustomerId    VARCHAR     NULLABLE    -- Stripe customer ID
subscriptionTier    VARCHAR     DEFAULT 'free'   -- free|pro|founder|business
storageUsedBytes    BIGINT      DEFAULT 0   -- Current storage usage
```

### Subscriptions Table

```sql
id                    CUID        PRIMARY KEY
userId                VARCHAR     FK → users.id CASCADE DELETE
stripeSubscriptionId  VARCHAR     UNIQUE NOT NULL
stripePriceId         VARCHAR     NOT NULL
status                VARCHAR     -- active|trialing|past_due|canceled|unpaid|incomplete|incomplete_expired
currentPeriodStart    TIMESTAMP   NOT NULL
currentPeriodEnd      TIMESTAMP   NOT NULL
cancelAtPeriodEnd     BOOLEAN     DEFAULT FALSE
createdAt             TIMESTAMP   AUTO
updatedAt             TIMESTAMP   AUTO
```

### Stripe Events Table (Idempotency)

```sql
id            VARCHAR     PRIMARY KEY  -- Stripe event ID
type          VARCHAR     NOT NULL     -- Event type
processedAt   TIMESTAMP   NOT NULL
error         VARCHAR     NULLABLE     -- Error message if failed
createdAt     TIMESTAMP   AUTO
```

---

## 7. Frontend Components

### Component Hierarchy

```
/settings/billing (BillingPage)
├── SubscriptionCard
│   ├── Plan name + status badge
│   ├── Usage progress bars (AI calls, storage)
│   └── Manage/Change Plan button
├── PaymentMethodsList
│   ├── Card list with last4, brand, expiry
│   ├── Default indicator
│   ├── Set Default button
│   ├── Delete button → Confirmation dialog
│   └── Add Payment Method button → AddPaymentMethodForm
├── UpcomingInvoice
│   ├── Amount due
│   ├── Next payment date
│   └── Line items preview
├── InvoiceList
│   ├── Table with date, description, amount, status
│   ├── View/Download buttons
│   └── Load More pagination
└── BillingAddressForm
    ├── View mode (read-only)
    └── Edit mode (form)

/settings/plan (PlanPage)
├── PlanCard × 4 (Free, Pro, Founder, Business)
│   ├── Plan details + price
│   ├── Current Plan badge (if applicable)
│   └── Upgrade/Downgrade/Manage buttons
├── PlanChangeConfirmation (dialog)
│   ├── Plan comparison
│   ├── Proration preview (upgrades)
│   ├── Effective date notice (downgrades)
│   └── Confirm/Cancel buttons
└── EmbeddedCheckoutForm (new subscriptions)
    ├── Plan summary
    ├── PaymentElement
    └── Subscribe button
```

### Key State Flows

**Subscription Status Display:**
```
active → Green "Active" badge
trialing → Blue "Trial" badge
past_due → Yellow "Past Due" badge
cancelAtPeriodEnd=true → Orange "Canceling" badge
canceled → Red "Canceled" badge
```

**Usage Warning Thresholds:**
```
> 80% of limit → Yellow warning
100% of limit → Red "Limit Reached"
```

---

## 8. Rate Limiting & Usage Enforcement

### AI Call Enforcement

```typescript
// Before AI API call:
const result = await incrementUsage(userId, providerType);
if (!result.success) {
  // Free user accessing pro model: limit=0
  // Limit exceeded: currentCount >= limit
  throw new Error('Usage limit exceeded');
}
```

### Storage Enforcement

```typescript
// Before file upload:
const check = await checkStorageQuota(userId, fileSize);
if (!check.allowed) {
  // Quota exceeded
  // File too large
  // File count exceeded
  // Concurrent upload limit
  throw new Error(check.reason);
}
```

### Daily Reset Behavior

- AI calls reset at midnight UTC
- Uses Redis with 24-hour TTL
- Atomic increment prevents race conditions

---

## 9. Testing Scenarios

### Happy Path Tests

| # | Scenario | Expected Outcome |
|---|----------|------------------|
| 1 | Free user subscribes to Pro | Subscription created, tier=pro |
| 2 | Pro user upgrades to Founder | Proration charged, tier=founder |
| 3 | Founder user downgrades to Pro | Schedule created, tier changes at period end |
| 4 | User cancels subscription | cancelAtPeriodEnd=true, tier unchanged until end |
| 5 | User reactivates canceled subscription | cancelAtPeriodEnd=false |
| 6 | User adds payment method | Card attached to customer |
| 7 | User sets default payment method | Customer updated |
| 8 | User removes payment method | Card detached |
| 9 | User updates billing address | Customer address updated |

### Error Path Tests

| # | Scenario | Expected Outcome |
|---|----------|------------------|
| 10 | Card declined on subscription | User stays free, error shown |
| 11 | Upgrade with invalid price ID | 400 error |
| 12 | Cancel non-existent subscription | 400 error |
| 13 | Reactivate active subscription | 400 error |
| 14 | Delete another user's payment method | 404 error |
| 15 | Webhook with invalid signature | 400 error |
| 16 | Duplicate webhook event | 200 (idempotent) |

### Edge Case Tests

| # | Scenario | Expected Outcome |
|---|----------|------------------|
| 17 | Upgrade + downgrade in same billing cycle | Downgrade schedule overwrites upgrade |
| 18 | Multiple rapid plan changes | Each processed sequentially |
| 19 | Payment failure on renewal | past_due status, retries |
| 20 | Storage over quota after downgrade | Files kept, new uploads blocked |
| 21 | AI calls at exactly 100% limit | Last call succeeds, next blocked |
| 22 | Concurrent file uploads at limit | 429 for excess uploads |

### Webhook Integration Tests

| # | Event | Verification |
|---|-------|--------------|
| 23 | subscription.created | DB record created, tier updated |
| 24 | subscription.updated | DB record updated, tier updated |
| 25 | subscription.deleted | Status=canceled, tier=free |
| 26 | invoice.payment_failed | Warning logged |
| 27 | checkout.session.completed | Customer ID linked |

---

## Appendix: Environment Variables

```bash
# Required
STRIPE_SECRET_KEY=sk_test_xxx        # Stripe secret key
STRIPE_WEBHOOK_SECRET=whsec_xxx      # Webhook endpoint secret

# Optional
NEXT_PUBLIC_STRIPE_MODE=test         # test or live
WEB_APP_URL=http://localhost:3000    # For redirect URLs
```

## Appendix: Stripe API Version

The integration uses Stripe API version `2025-08-27.basil` which includes:
- `expand: ['items']` on subscriptions for period dates
- `confirmation_secret` on invoices for payment confirmation

---

*Last Updated: December 2024*
