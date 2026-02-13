# AI Memory Architecture Benchmarking Roadmap

## Goal

Create a measurable roadmap for improving PageSpace AI memory quality, cross-drive awareness, and transparency of the exact context sent to the model.

This plan focuses on value-adds that can be benchmarked with repeatable tests and production telemetry, rather than subjective prompt tweaks.

---

## Current Architecture Baseline (What Exists Today)

### Strengths

- **Database-first conversation state** is already in place (messages are loaded from DB, not trusted from client memory).
- **Prompt transparency tooling** exists via admin global prompt endpoint/viewer that assembles full payload and token estimates.
- **Token/context estimation utilities** are available for system prompt, tool schemas, and message parts.
- **Memory pipeline** exists for user personalization (`discovery -> integration -> compaction`).

### Gaps to Close

- Memory is still mostly long-form text fields (`bio`, `writingStyle`, `rules`, and per-drive `drivePrompt`) instead of structured retrievable memory.
- Drive disambiguation is heuristic and current-context biased.
- No formal benchmark harness for cross-drive recall / wrong-drive actions.
- No first-class "what context was actually sent" audit record per request.

---

## Ranked Value-Adds (Highest ROI First)

Each value-add includes: **impact**, **benchmark metric**, and **transparency surface**.

## 1) Request Context Snapshot Logging (P0)

**Value:** Highest confidence boost with low implementation risk.

### What to add

Persist a compact "context snapshot" for each AI call:

- request id, user id, conversation id
- selected context type (`dashboard | drive | page`)
- drive/page ids in scope
- system prompt hash + token estimate
- top retrieved pages/drives (ids only + score)
- tool list included
- truncation info (if any)

### Benchmarkable metrics

- **Context completeness rate**: `% of requests with full snapshot fields populated`.
- **Traceability SLA**: `% of user-visible responses that can be fully reconstructed`.
- **Snapshot overhead**: median additional request latency.

### Transparency surface

- Admin table: "what AI received" with drill-down by request id.
- Deterministic replay endpoint for offline analysis.

---

## 2) Cross-Drive Disambiguation Resolver (P0)

**Value:** Directly addresses similar-drive-name confusion and wrong assumptions.

### What to add

Before retrieval/tool calls, run a resolver that scores candidate drives/entities using:

- lexical name match
- recency from user activity
- current location prior
- entity alias/link confidence
- mention references in current message

Add a thresholded policy:

- **high confidence:** auto-execute in top drive(s)
- **medium confidence:** run top-2 read-only retrieval then decide
- **low confidence:** ask one concise clarification question

### Benchmarkable metrics

- **Wrong-drive action rate** (primary)
- **Clarification precision**: fraction of clarifications that were truly necessary
- **Cross-drive recall@k** for tasks that span 2+ drives

### Transparency surface

Log resolver candidate list + score breakdown + selected policy branch.

---

## 3) Structured Memory Layer over Personalization/Drive Context (P1)

**Value:** Converts memory from prose blobs into queryable facts.

### What to add

Introduce structured memory records while keeping legacy text fields for compatibility:

- user memory facts (preference, workflow, project, rule)
- drive memory facts (purpose, conventions, key locations)
- confidence, source, last-seen timestamp, decay/expiry
- optional derived `rendered_text` for prompt injection

### Benchmarkable metrics

- **Memory precision@topN** from labeled eval prompts
- **Contradiction rate** between returned memory facts and recent activity
- **Staleness rate**: facts not touched in N days but still injected

### Transparency surface

Memory inspector UI:

- fact cards with confidence and provenance
- why included / why excluded from this request

---

## 4) Benchmark Harness + Gold Dataset (P1)

**Value:** Turns architecture changes into measurable regressions/improvements.

### What to add

Create an offline benchmark suite with canonical scenarios:

1. Similar drive names, different projects
2. Similar drive names, same project split across drives
3. Current page in Drive A but relevant spec in Drive B
4. User asks "what am I working on" across week of edits
5. Conflicting old vs new personalization preference

Each scenario should have:

- ground truth expected drives/pages
- expected clarification behavior
- expected retrieved context snippets

### Benchmarkable metrics

- Drive selection accuracy
- Cross-drive retrieval recall/precision
- Clarification behavior accuracy
- Token efficiency (quality per context token)

### Transparency surface

CI-readable benchmark report + trend chart by commit SHA.

---

## 5) Retrieval Explainability + Context Budgeting (P2)

**Value:** Improves quality/cost and makes failures diagnosable.

### What to add

For each request, expose:

- context token budget by section (system/tools/history/retrieval)
- retrieval score contributions (path, recency, semantic, permissions)
- dropped candidates due to budget

### Benchmarkable metrics

- **Useful context density** (accepted supporting evidence per 1k tokens)
- **Budget waste rate** (tokens spent on unused/irrelevant context)
- **Response quality vs token slope** across models

### Transparency surface

"Prompt budget waterfall" in admin prompt viewer.

---

## 6) Auto-Eval in Production (Shadow Judging) (P2)

**Value:** Detects quality drift without blocking user flow.

### What to add

Sample completed requests and run async judges to score:

- Was the chosen drive/page likely correct?
- Did response acknowledge cross-drive ambiguity when needed?
- Did assistant overfit to current context?

### Benchmarkable metrics

- Judge agreement rate with human labels
- Weekly trend in contextual correctness
- Regression alert count per release

### Transparency surface

Weekly quality digest dashboard with links to trace snapshots.

---

## Measurement Framework

## Core KPI Stack

### Decision Quality

- Drive selection accuracy
- Wrong-drive action rate
- Cross-drive recall@k
- Clarification precision/recall

### Memory Quality

- Memory precision@N
- Contradiction rate
- Memory staleness rate

### Observability & Trust

- Traceability SLA
- % requests with full context snapshot
- Time-to-root-cause for AI misfires

### Efficiency

- Avg context tokens per successful task
- Cost per resolved task
- Latency p50/p95 after instrumentation

---

## "What AI Received" Transparency Contract

For every AI request, provide a stable, inspectable record with:

1. **Input Envelope**
   - system prompt hash + rendered prompt
   - tool names + schema hashes
   - message ids included
2. **Retrieval Envelope**
   - candidate drives/pages + scores
   - selected items + reasons
3. **Memory Envelope**
   - personalization facts selected
   - drive context facts selected
   - exclusion reasons (stale, low confidence, budget)
4. **Budget Envelope**
   - token allocation and truncation notes

If any envelope is missing, request is marked **non-auditable**.

---

## Recommended Delivery Sequence (90-Day)

### Weeks 1-2

- Ship Request Context Snapshot Logging (P0)
- Add minimal resolver scoring telemetry (no behavior change yet)

### Weeks 3-5

- Enable Cross-Drive Disambiguation Resolver (P0)
- Add first gold benchmark scenarios and baseline report

### Weeks 6-8

- Introduce structured memory layer + compatibility rendering (P1)
- Start memory quality metrics

### Weeks 9-12

- Add budget waterfall and retrieval explainability (P2)
- Enable shadow judging with weekly drift report (P2)

---

## Minimum Success Criteria

A release is considered successful only if all are met:

- Wrong-drive action rate reduced by **>= 40%** from baseline
- Cross-drive recall@k improved by **>= 25%**
- > = **95%** of responses have auditable context snapshots
- No > **10%** p95 latency regression from instrumentation

---

## Implementation Notes for PageSpace

- Keep system prompt compact; use it for policy/routing, not as the primary memory store.
- Maintain DB-first architecture and add context snapshots adjacent to existing AI usage logs.
- Reuse existing admin global prompt surfaces for explainability before creating new UI.
- Keep all new retrieval/memory features behind feature flags for controlled rollout.
