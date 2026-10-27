# Onprem AI Provider Region Guidance

**Issue:** #961 · **Articles:** GDPR Art 44–49 (transfers), Art 32 · **Audience:** Onprem operators, engineering

## Context

Onprem deployments (`DEPLOYMENT_MODE=onprem`, `packages/lib/src/deployment-mode.ts`)
allow three AI providers: Ollama and LM Studio (both local runtimes — no
third-party transfer) and Azure OpenAI (a BAA-covered cloud provider,
`ONPREM_ALLOWED_PROVIDERS` in `apps/web/src/lib/ai/core/ai-providers-config.ts`).

Azure OpenAI configuration is exactly two env vars — `AZURE_OPENAI_API_KEY` and
`AZURE_OPENAI_ENDPOINT` (`.env.onprem.example`). The endpoint is a full URL
including the Azure resource name and deployment path
(`https://your-resource.openai.azure.com/openai/deployments/your-deployment/`);
there is no separate region field.

`apps/web/src/lib/ai/core/provider-factory.ts` reads that endpoint and validates
it through `validateLocalProviderURL`
(`packages/lib/src/security/url-validator.ts`) before use. That check is a
**pure SSRF guard** — it blocks localhost, private IPs, link-local addresses,
and cloud metadata endpoints (`169.254.169.254`, `metadata.azure.com`,
`168.63.129.16`). It has no concept of Azure region at all. In other words: an
operator can point `AZURE_OPENAI_ENDPOINT` at any Azure OpenAI resource in any
Azure region worldwide, and nothing in the codebase notices or cares.

## Recommendation

Onprem operators serving EU data subjects should provision their Azure OpenAI
resource in an **EU region** (e.g. `swedencentral`, `westeurope`) so that
prompt/content data processed via Azure OpenAI stays within the EEA, rather
than relying on Azure's cross-border transfer mechanisms (Standard Contractual
Clauses / EU Data Boundary) as the only control.

This is operator-facing guidance, not a code change — see the pointer added to
`.env.onprem.example` next to the Azure OpenAI variables.

[TODO: confirm whether the product should enforce this via config validation
(e.g. rejecting non-EU Azure OpenAI hostnames when an EU-residency flag is set)
or continue to document it as operator guidance only — this is a product
decision, not something this doc should decide unilaterally]

## Cross-references

- `.env.onprem.example` — where the Azure OpenAI env vars are configured
- `docs/security/encryption-in-transit.md` — §2 covers the related self-host/
  multi-host TLS requirement for onprem/tenant deployments
