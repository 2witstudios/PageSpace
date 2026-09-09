# Instant Machine Project and Branch Preparation Epic

**Status**: 📋 PLANNED
**Goal**: Make project and branch creation acknowledge instantly while remote preparation remains durable, observable, retryable, cancellable, and safe.

## Overview

Why this matters: Machine users currently wait in an apparently frozen modal while authentication, Sprite preparation, cloning, checkout, cleanup, and SWR refreshes run synchronously; this epic separates sub-second durable acknowledgement from remote readiness, preserves branch isolation and credential safety, and makes every pending, failed, retried, cancelled, and completed outcome truthful across reloads.

---

## Provisioning Timing Telemetry

Add one correlated operation span with stage timings across acceptance, remote execution, cleanup, and client refresh.

**Requirements**:
- Given a project or branch preparation request, should record acceptance and readiness latency separately under one correlation identifier
- Given remote preparation work, should expose stage timings for authorization, credential resolution, Sprite acquisition, clone, checkout, persistence, cleanup, and revalidation
- Given production measurements, should support p50, p95, and p99 analysis by resource kind, repository cohort, Sprite warmth, and outcome
- Given durable acceptance, should measure against p95 250 ms and p99 500 ms acknowledgement objectives

---

## Provisioning State Core

Define the shared project and branch preparation state machine as pure, exhaustively tested domain logic.

**Requirements**:
- Given any provisioning state, should permit only the documented forward, retry, cancellation, cleanup, and terminal transitions
- Given a stale generation or lease, should reject finalization and cleanup mutations
- Given cancellation racing with completion, should report exactly one truthful terminal outcome

---

## Resource Provisioning Columns

Extend project and branch records with durable readiness, stage, generation, failure, cancellation, and completion facts.

**Requirements**:
- Given an existing completed project or branch, should migrate it to ready without changing its runtime identity
- Given an accepted resource without completed preparation, should persist enough state to render and recover it after reload
- Given a pending branch, should retain its derived session identity without claiming that a live Sprite already exists

---

## Provision Job Table

Add the durable job, idempotency, attempt, lease, and retry schedule records required for at-least-once execution.

**Requirements**:
- Given the same idempotency key, should identify one existing operation
- Given one resource generation, should allow at most one active provisioning job
- Given an interrupted worker, should retain sufficient execution metadata for another worker to resume or reconcile safely

---

## Provisioning Repositories

Create typed persistence operations for atomic resource snapshots, job lifecycle changes, and guarded generation updates.

**Requirements**:
- Given a resource and job mutation, should preserve their state-machine invariants transactionally
- Given a worker mutation, should apply it only when resource, generation, and lease token still match
- Given a client read, should return a canonical resource and operation snapshot without exposing credential material

---

## Leased Job Claiming

Implement DB-clock leases with opaque tokens for safe concurrent worker claims and expiry recovery.

**Requirements**:
- Given multiple workers, should allow only one live lease to control a job generation
- Given an expired lease, should allow a successor to claim work without accepting later writes from the stale worker
- Given no eligible work, should avoid waking or provisioning remote infrastructure

---

## Durable Worker Dispatch

Host a durable polling or scheduled worker loop that survives request and process lifetimes.

**Requirements**:
- Given an accepted job, should make it claimable without depending on request-local background execution
- Given worker restart, should reclaim expired leases and continue or reconcile safely
- Given worker or cleanup health degradation, should stop unsafe new execution while retaining already accepted jobs

---

## Project Acceptance Transaction

Reserve a normalized project and its provisioning job atomically before remote work starts.

**Requirements**:
- Given a valid project request, should durably reserve the canonical resource and operation before acknowledging it
- Given the same idempotency key, should return the existing project operation without cloning again
- Given the same canonical name with different intent, should return a conflict without creating another operation

---

## Branch Acceptance Transaction

Reserve a normalized isolated branch and its provisioning job atomically before remote work starts.

**Requirements**:
- Given a valid branch request, should persist its canonical name, project relationship, session identity, and pending operation before acknowledging it
- Given the same idempotency key, should return the existing branch operation without provisioning another Sprite
- Given a pending branch, should not expose it as runtime-ready to any consumer

---

## Accepted Creation Routes

Change project and branch creation endpoints to return durable `202 Accepted` snapshots after bounded validation and reservation.

**Requirements**:
- Given a valid creation request, should acknowledge the durable operation without waiting for Sprite or Git work
- Given invalid access, containment, billing, quota, name, or repository input, should reject before creating a pending resource
- Given an accepted request, should return the canonical resource, operation identifier, state, stage, and correlation identifier

---

## Provisioning Read Surface

Expose authorized pending, running, failed, cancelled, and ready snapshots for reload and cross-client convergence.

**Requirements**:
- Given a reload during remote work, should reconstruct the same canonical pending resource and current stage
- Given an access change, should prevent unauthorized users from reading or acting on the operation
- Given known-good ready data and a refresh failure, should preserve the data while reporting refresh failure separately

---

## Project Provisioning Worker

Move Machine acquisition, cloning, persistence, and finalization into an idempotent leased project worker.

**Requirements**:
- Given a claimed project job, should revalidate access, containment, billing, and quota before costly execution
- Given a worker retry, should reconcile existing staged or completed work before cloning again
- Given successful preparation, should atomically promote the checkout and mark the resource ready

---

## Branch Provisioning Worker

Move Sprite provisioning, cloning, checkout, persistence, and finalization into an idempotent leased branch worker.

**Requirements**:
- Given a claimed branch job, should preserve one isolated Sprite filesystem per branch
- Given Sprite provisioning success, should durably record Sprite name and instance identity before clone starts
- Given an upstream branch, should check it out; given no upstream branch, should preserve the current new-branch-from-default-HEAD behavior

---

## Generation-Specific Checkout Promotion

Stage each clone in a generation-owned path and atomically promote only a validated checkout.

**Requirements**:
- Given concurrent or retried work, should prevent one generation from deleting or promoting another generation's checkout
- Given a completed clone, should validate remote origin and checked-out ref before readiness
- Given a partial or invalid checkout, should keep every runtime consumer outside that path

---

## Credential Execution Boundary

Resolve Git credentials at execution time and keep them out of durable state and persistent Git configuration.

**Requirements**:
- Given project or branch preparation, should resolve credentials once per operation and inject them only into command-scoped environment
- Given logs, rows, snapshots, command arguments, or Git configuration, should contain no access token or decrypted credential
- Given credential rotation before a retry, should use the current credential rather than persisted stale material

---

## Cleanup Reconciler

Reconcile partial checkouts, uncertain Sprite deletion, abandoned leases, and failed jobs without losing durable identity pointers.

**Requirements**:
- Given failed project preparation, should clean only the failed generation's staging path
- Given a billable Sprite with uncertain deletion, should retain its durable instance pointer and retry cleanup
- Given dependency recovery, should converge retryable failures without permitting untracked live Sprites

---

## Safe Failure Classification

Map worker and provider failures to stable sanitized codes, retryability, and user-safe diagnostic references.

**Requirements**:
- Given preparation failure, should distinguish access, policy, provision, timeout, clone, checkout, cancellation, and cleanup outcomes
- Given untrusted provider output, should retain a diagnostic reference without exposing secrets or unsafe detail
- Given an uncertain remote outcome, should classify it for reconciliation rather than falsely declaring success or cancellation

---

## Retry Scheduling

Add bounded automatic retry attempts with backoff before an operation requires explicit recovery.

**Requirements**:
- Given a transient retryable failure, should schedule another attempt within a bounded retry budget
- Given exhausted retries or terminal failure, should stop automatic work and require explicit user action
- Given dependency recovery, should converge without duplicating resources, Sprites, or active generations

---

## Idempotent Retry

Add guarded retry semantics that reuse the same resource intent and create a fenced successor attempt.

**Requirements**:
- Given a retryable failure, should start one visible successor attempt without duplicating the resource or Sprite
- Given a terminal failure, should require corrected input or a new explicit intent rather than automatic retry
- Given concurrent retry requests, should accept only one active successor generation

---

## Truthful Cancellation

Add cancellation intent, remote interruption where supported, cleanup, and race-safe terminal results.

**Requirements**:
- Given queued work, should cancel without provisioning remote infrastructure
- Given running work, should report cancellation only after eligible work stops and partial resources are reconciled
- Given completion winning the race, should report ready and offer normal removal rather than claiming cancellation succeeded

---

## Shared Readiness Guard

Create one authoritative readiness decision for every project- and branch-scoped runtime resolver.

**Requirements**:
- Given a non-ready resource, should refuse runtime resolution with a stable preparation status rather than entering partial state
- Given a ready resource, should preserve current routing and isolation behavior
- Given a failed or cancelled resource, should return recovery semantics without implicitly restarting work

---

## Runtime Readiness Enforcement

Apply the shared readiness guard to terminal, agent, Files, Diff, workspace, and project-promotion entry points.

**Requirements**:
- Given a pending resource, should prevent every runtime surface from attaching, reading, diffing, spawning, or promoting it
- Given a resource becoming ready, should make all consumers converge without requiring recreation
- Given a stale client, should receive the same authoritative readiness outcome as a newly loaded client

---

## Project Hook Acceptance Semantics

Update project data flow to model durable acceptance separately from readiness and list refresh.

**Requirements**:
- Given a `202` project response, should expose the accepted pending resource immediately
- Given creation acceptance followed by revalidation failure, should keep creation successful and report only refresh failure
- Given operation progress after reload, should converge the cached project snapshot to server truth

---

## Branch Hook Acceptance Semantics

Update branch data flow to model durable acceptance, readiness, retry, cancellation, and branch outcome.

**Requirements**:
- Given a `202` branch response, should expose the accepted isolated branch immediately
- Given completion, should communicate whether an upstream branch was checked out or a new branch was created
- Given retry or cancellation, should update the same canonical branch rather than inserting a duplicate

---

## Immediate Local Confirmation

Represent pre-acknowledgement submission locally without claiming that durable acceptance already occurred.

**Requirements**:
- Given locally valid input, should close the modal and expose a focused confirming state before the network promise resolves
- Given a durable `202` response, should reconcile confirming state in place to the canonical accepted resource
- Given network uncertainty or rejection, should preserve the idempotency key and user input without claiming remote preparation started

---

## Machine Tree Provisioning Rows

Render pending, running, failed, cancelled, and ready resources as stable tree entries with recovery actions.

**Requirements**:
- Given accepted preparation, should reveal the canonical resource and meaningful current stage without blocking unrelated navigation
- Given terminal failure, should retain a safe reason and retry or dismiss actions until the user resolves it
- Given a list fetch failure, should show retryable failure while preserving previously loaded resources

---

## Instant Palette Hand-Off

Make valid structural submissions close promptly after durable acceptance and transfer feedback to the tree.

**Requirements**:
- Given durable server acknowledgement, should close the modal and expose the pending resource within the defined interaction SLO
- Given validation or acceptance failure, should keep the user's input available for correction
- Given remote work after acknowledgement, should not depend on the modal or component remaining mounted

---

## Accessible Preparation Feedback

Add focus, busy, live-region, error, keyboard, and reduced-motion semantics to preparation status.

**Requirements**:
- Given accepted work, should provide visible status text and announce meaningful transitions without repeating polling noise
- Given modal closure, should move focus predictably to the accepted resource or its status action
- Given failure, retry, dismissal, or cancellation, should expose keyboard-operable controls and an assertive terminal error announcement

---

## Operation Context Reuse

Reuse request-scoped authorization, credential, and Machine/Sprite handle results within each worker attempt.

**Requirements**:
- Given one preparation attempt, should avoid repeating equivalent authorization, credential decryption, and attachment work
- Given resume-time execution, should still perform the required fresh authorization and policy checks
- Given context reuse, should preserve existing quota, audit, credential, and isolation boundaries

---

## Non-Critical Readiness Work

Dispatch credential propagation and storage measurement outside readiness finalization when checkout correctness does not require them.

**Requirements**:
- Given a valid promoted checkout, should mark readiness without waiting for unrelated best-effort work
- Given background propagation or measurement failure, should record telemetry without relabelling creation as failed
- Given a consumer that requires propagated state, should preserve its current correctness guard before removing work from the readiness path

---

## Remote Operation Deadlines

Add explicit stage deadlines, abort behavior where supported, and a bounded total attempt budget around Sprite control-plane work.

**Requirements**:
- Given a stalled remote dependency, should transition to a classified retryable or terminal outcome within a defined budget
- Given client request abortion after durable acceptance, should continue or cancel according to operation state rather than HTTP connection lifetime
- Given timeout cleanup, should preserve durable pointers until cleanup is confirmed

---

## Clone Optimization Experiment

Evaluate filtered or single-branch cloning behind measured compatibility controls without weakening Git semantics.

**Requirements**:
- Given private repositories, history operations, and new-branch fallback, should preserve current correctness before enabling an optimization
- Given an optimization cohort, should measure transferred bytes, readiness latency, later object-fetch latency, and failure rate
- Given no proven compatibility and material latency improvement, should retain full clone behavior

---

## Worker Recovery Verification

Prove leases, generations, retries, cancellation, cleanup, access revocation, and crash recovery under integration tests.

**Requirements**:
- Given duplicate delivery or worker restart at any stage, should converge to one resource and one truthful terminal state
- Given stale workers, should prevent finalization or cleanup of successor work
- Given partial clone, uncertain persistence, or unknown Sprite deletion, should preserve recoverability and eliminate untracked billing resources

---

## Client State Verification

Prove immediate acknowledgement, durable reload, refresh-error separation, recovery actions, and accessibility in component tests.

**Requirements**:
- Given delayed remote readiness, should close after acknowledgement and keep the rest of the tree interactive
- Given reload, failure, retry, cancellation, or completion, should render the server-authoritative state without duplicate rows
- Given keyboard or screen-reader use, should provide predictable focus, busy state, live announcements, alerts, and actions

---

## Async Creation Rollout Gate

Enable durable async creation only after workers, readiness guards, recovery, and observability are healthy.

**Requirements**:
- Given pending resources becoming externally visible, should deploy readiness guards before enabling async acceptance
- Given `202` creation routes, should health-check durable worker claiming and cleanup before routing production traffic
- Given rollout regression, should disable new async acceptance without abandoning already accepted jobs

---

## End-to-End Readiness SLO

Exercise delayed and failing project and branch preparation end to end and enforce separate acknowledgement and readiness measures.

**Requirements**:
- Given a clone delayed near the command ceiling, should acknowledge promptly and preserve visible progress across navigation and reload
- Given provider failure and recovery, should demonstrate truthful failure, idempotent retry, cleanup, and eventual convergence
- Given the defined repository cohort, should report acknowledgement, queue claim, readiness, and cleanup SLO results separately
- Given a healthy provider and standard repository cohort, should verify project-ready p95 15 seconds and branch-ready p95 30 seconds as measured objectives
- Given accepted work, should verify pending visibility p95 100 ms after acknowledgement, queue claim p95 1 second, and failed billable Sprite cleanup p99 5 minutes

---
