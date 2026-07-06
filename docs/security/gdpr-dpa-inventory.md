# GDPR Sub-Processor DPA Inventory

Internal tracking doc for the Data Processing Agreement (DPA) status of every sub-processor
that touches personal data on PageSpace's behalf. This is the factual source that the public
`/subprocessors` marketing page summarizes — keep the two in sync when a vendor is added,
removed, or its DPA status changes. Closes #949.

Not legal advice. Every `DPA Status` cell below is a `TODO` because signed-DPA status isn't
tracked anywhere in this repo (contracts live outside version control) — someone with access to
the vendor agreements needs to fill these in and update the last-reviewed date.

**Last reviewed:** `[TODO: date of last inventory review]`

| Vendor | Purpose | Data Shared / Processed | DPA Status |
|---|---|---|---|
| Stripe, Inc. | Payment processing, subscription billing | Customer name, email, payment method, billing address, subscription/plan metadata | `[TODO: confirm signed DPA on file — Y/N/date]` |
| Google (OAuth + Calendar API) | "Sign in with Google"; optional Google Calendar/Drive integration | Email, profile name, OAuth tokens (encrypted at rest, AES-256-GCM), calendar/file metadata the user chooses to connect | `[TODO: confirm signed DPA on file — Y/N/date]` |
| GitHub, Inc. | OAuth sign-in / repository integration | Email, profile name, OAuth tokens (encrypted at rest, AES-256-GCM), repo metadata the user chooses to connect | `[TODO: confirm signed DPA on file — Y/N/date]` |
| Apple Inc. (APNs) | Push notifications to iOS app | Device push token, notification payload (no message content beyond what's needed to render the notification) | `[TODO: confirm signed DPA on file — Y/N/date]` |
| Let's Encrypt (ISRG) | TLS certificate issuance for custom domains | Domain name, certificate validation records — no end-user personal data | `[TODO: confirm signed DPA on file — Y/N/date]` |
| DNS provider(s) | DNS resolution for pagespace.ai and customer custom domains | Domain names, DNS records — no end-user personal data | `[TODO: identify current DNS provider(s) and confirm signed DPA on file — Y/N/date]` |
| Control-plane host | Hosts the control-plane service: tenant provisioning, Stripe billing orchestration, lifecycle management | Tenant owner email, Stripe customer IDs, tenant metadata | `[TODO: confirm current control-plane hosting provider (Fly.io per project deployment history — verify still accurate) and signed DPA on file — Y/N/date]` |

## AI model providers

AI model providers (Anthropic, OpenAI, Google, xAI, OpenRouter) are covered separately in the
Privacy Policy's Third-Party AI Services section and the `/subprocessors` page — they receive
prompts/context on a per-request basis, not a standing data-processing relationship in the same
sense as the vendors above. `[TODO: confirm DPA status for each AI provider if required by legal
review]`.

## Maintenance

- Update this table whenever a sub-processor is added, removed, or replaced.
- Update `apps/marketing/src/app/subprocessors/page.tsx` in the same change — it's a public
  summary of this doc and must not drift from it.
- Re-review at least annually or whenever a new data category is introduced.
