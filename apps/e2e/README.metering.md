# Metering & billing e2e

End-to-end coverage that **metering cannot be bypassed** and that **billing works** —
exercised against the real Next.js app, real Postgres, and the real credit pipeline, with
only the model provider and Stripe (webhook side) faked.

## What it covers

| Spec | Proves |
|------|--------|
| `09-metering-no-bypass.spec.ts` | With enforcement ON, an out-of-credits user is refused at **every** AI entry point (chat, global chat, page-agent consult, voice synthesize, pulse generate, MCP `/v1/chat/completions`, **pulse cron**) → 402 and **no usage/billing row**. For OpenRouter-backed routes it also asserts the mock model was **never hit**. |
| `10-metering-billing.spec.ts` | A funded chat call hits the model once and debits **exactly `cost × 1.5`** (mock returns 2¢ → 3¢ charged); a usage ledger row is written and the in-flight hold settles. |
| `11-metering-limits.spec.ts` | `402 out_of_credits` at the reserve floor; `429 too_many_in_flight` at the free-tier concurrency cap. |
| `12-token-packs.spec.ts` | Credit-pack checkout validation (400s) and the funding webhook: a paid `checkout.session.completed` (`metadata.kind=credit_pack`) credits the never-expiring top-up bucket **exactly once** (idempotent on event id). |

Meter-only mode (`CREDITS_ENFORCEMENT_ENABLED=false`) and the cost-extraction/settlement
math are covered by unit tests in `packages/lib/src/billing/__tests__/` — they aren't
re-run here because the flag is read in the app process and is fixed at app launch.

## Running

1. Start the **web app** with this env (the mock server is started for you by Playwright on :4998):

   ```
   DATABASE_URL=postgres://…@localhost:5432/…   # local DB only — seeders refuse non-local hosts
   CREDITS_ENFORCEMENT_ENABLED=true             # enforcement is OFF by default — turn it ON for this run
   OPENROUTER_DEFAULT_API_KEY=sk-e2e            # any non-empty value; enables the openrouter branch
   OPENROUTER_BASE_URL=http://127.0.0.1:4998/api/v1
   WEB_APP_URL=http://localhost:3000
   CRON_SECRET=<shared>
   STRIPE_WEBHOOK_SECRET=<shared>
   CSRF_SECRET=<shared>
   ```

   `CRON_SECRET`, `STRIPE_WEBHOOK_SECRET`, and `CSRF_SECRET` must be the **same** values the
   Playwright process sees (both load `.env`), so the test can forge valid signatures/tokens.

2. Run the suite:

   ```
   bun run --filter '@pagespace/e2e' test:e2e -- tests/09-metering-no-bypass.spec.ts \
     tests/10-metering-billing.spec.ts tests/11-metering-limits.spec.ts tests/12-token-packs.spec.ts
   ```

## How the model is faked

`support/mock-openrouter.ts` is an OpenAI/OpenRouter-compatible `/chat/completions` stub
that returns a deterministic completion carrying `usage.cost` (the value PageSpace bills
on). Users are seeded with `currentAiProvider='openrouter'` so their calls route to it via
the `OPENROUTER_BASE_URL` override added in `provider-factory.ts`. The stub records hits
(`GET /__calls`, `POST /__reset`) so a test can prove a blocked request never reached it.
