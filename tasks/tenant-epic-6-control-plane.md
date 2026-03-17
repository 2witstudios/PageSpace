# Control Plane - Tenant Registry & API (Parent Epic)

**Status**: IN PROGRESS
**Goal**: The orchestration brain that provisions, monitors, and manages isolated tenant stacks

## Overview

This epic was too large for a single PR. It has been broken into 4 sub-epics that build progressively:

| Sub-Epic | Plan | Dependencies | Status |
|---|---|---|---|
| 6a - Scaffold & Schema | [tenant-epic-6a-control-plane-scaffold.md](tenant-epic-6a-control-plane-scaffold.md) | None | PLANNED |
| 6b - Repository & Validation | [tenant-epic-6b-tenant-repository.md](tenant-epic-6b-tenant-repository.md) | 6a | PLANNED |
| 6c - Provisioning Engine | [tenant-epic-6c-provisioning-engine.md](tenant-epic-6c-provisioning-engine.md) | 6a, 6b, Epic 5 | PLANNED |
| 6d - REST API | [tenant-epic-6d-rest-api.md](tenant-epic-6d-rest-api.md) | 6a, 6b, 6c | PLANNED |

**Approach**: Work progressively — complete 6a, evaluate, then 6b, evaluate, etc. Each sub-epic is a separate PR with its own evaluation gate. Re-scope downstream sub-epics based on what you learn implementing upstream ones.

**Dependencies for downstream epics**:
- Epic 7 (Stripe Billing) depends on 6d (REST API endpoints)
- Epic 9 (Operational Tooling) depends on 6d (REST API endpoints)
