# GDPR Sub-Processor DPA Inventory

Internal tracking doc for the data-processing terms that govern every sub-processor that
touches personal data on PageSpace's behalf. This is the factual source that the public
`/subprocessors` marketing page (`apps/marketing/src/app/subprocessors/page.tsx`) summarizes —
keep the two in sync when a vendor is added, removed, or its terms change. Closes #949.

Not legal advice. PageSpace is a US sole proprietorship (Jonathan Woodall) with no EU/UK
establishment; every vendor below is US-located, and international transfers rely on the EU SCCs
(Module 2) + UK Addendum incorporated in each vendor's DPA unless noted.

**Last reviewed:** 2026-09-09

## How each vendor's DPA binds us

Every vendor below except Fly.io and OpenRouter incorporates its DPA by reference into the
standard service terms accepted when the account was opened — no separate signature is needed.

| Vendor | Purpose | Data shared / processed | Data-processing terms | How it binds |
|---|---|---|---|---|
| Fly.io, Inc. | Hosting (web, realtime, processor, admin, cron, control-plane, Postgres on an encrypted volume in `iad`); Sprites sandboxes for agent sessions | Everything in the primary database and app servers | Fly.io ToS; GDPR DPA is **pre-signed by Fly.io and sent on request** (support@fly.io, subject "Privacy Concerns"); Fly.io adheres to the DPF principles (fly.io/legal/data-privacy-framework/) | **Action: request the pre-signed DPA and file it** |
| Tigris Data, Inc. | Object storage: uploaded files + encrypted daily pg_dump backups | Uploaded files; AES-256-encrypted DB dumps | https://www.tigrisdata.com/docs/legal/data-processing/ (SCC Modules 2+3, UK Addendum) | Schedule 1 of the Tigris Service Agreement |
| Namecheap, Inc. | Registrar + DNS (`dns1/dns2.registrar-servers.com`) | Domain names, DNS records — no personal data | https://www.namecheap.com/legal/universal/data-processing-addendum/ | Universal ToS |
| Let's Encrypt (ISRG) | TLS certs | Domain names — no personal data | https://letsencrypt.org/repository/ | Subscriber Agreement |
| Stripe, Inc. | Billing | Name, email, payment method, billing address, plan metadata | https://stripe.com/legal/dpa | Stripe Services Agreement |
| Resend, Inc. | Transactional + opted-in product email | Email, name, email content, delivery/unsubscribe status | https://resend.com/legal/dpa | Resend ToS |
| Functional Software, Inc. (Sentry) | Error reporting | Stack traces, request metadata, user ID; `SENTRY_SEND_DEFAULT_PII` is unset (false) in prod | https://sentry.io/legal/dpa/ | Sentry ToS |
| Apple Inc. (APNs) | iOS push | Device push token, payload | https://developer.apple.com/support/terms/ | Apple Developer Program License Agreement |
| Google LLC (FCM) | Android push | Device registration token, payload | https://firebase.google.com/terms/data-processing-terms | Firebase ToS |
| Anthropic, PBC | AI inference | Prompts + selected context | https://www.anthropic.com/legal/data-processing-addendum | Commercial Terms |
| OpenAI, L.L.C. | AI inference | Prompts + selected context | https://openai.com/policies/data-processing-addendum | Business/API Terms |
| Google LLC (Gemini API) | AI inference | Prompts + selected context | https://cloud.google.com/terms/data-processing-addendum | Gemini API / Cloud terms (paid tier) |
| xAI Corp. | AI inference | Prompts + selected context | https://x.ai/legal/data-processing-addendum | Enterprise ToS (applies automatically) |
| OpenRouter, Inc. | Routing to extra models (paid plans, user-selected) | Prompts + selected context, forwarded upstream | https://openrouter.ai/terms + per-provider retention docs | **No DPA on self-serve** — OpenRouter only signs DPAs for enterprise accounts. Public page discloses this honestly. See Open items |

### Independent controllers (not sub-processors)

| Vendor | Purpose | Notes |
|---|---|---|
| Google LLC (Sign in with Google, Calendar, Drive) | Optional OAuth integrations | User authorizes Google directly; Google API Services User Data Policy governs our use |
| GitHub, Inc. | Optional OAuth / repo integration | User authorizes GitHub directly; https://github.com/customer-terms/github-data-protection-agreement |

## Open items

1. **Fly.io DPA** — email support@fly.io for the pre-signed DPA and store it with the other
   contracts (outside version control).
2. **OpenRouter** — no self-serve DPA. Options: (a) restrict OpenRouter routing to its ZDR
   endpoints, (b) upgrade to enterprise for a signed DPA, or (c) drop OpenRouter models. Until one
   is chosen the public page discloses that OpenRouter models are optional and provider-retention
   applies.

## Maintenance

- Update this table whenever a sub-processor is added, removed, or replaced.
- Update `apps/marketing/src/app/subprocessors/page.tsx` in the same change — it's a public
  summary of this doc and must not drift from it.
- Re-review at least annually or whenever a new data category is introduced.
