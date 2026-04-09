# Provisioning Engine & Admin Seeder Epic

**Status**: COMPLETE
**Goal**: Core orchestration that provisions, suspends, resumes, and destroys tenant stacks

## Overview

The provisioning engine is the heart of the control plane. It orchestrates the full tenant lifecycle: generate env -> write to disk -> docker compose up -> poll health -> seed admin user -> update status. All shell interactions go through an abstraction layer that's mockable in tests.

**Dependencies**: Epic 6a (app scaffold), Epic 6b (repository + validation), Epic 5 (compose template + env generator script)

---

## Standards & Rules

Read and follow these before writing any code. They apply to every task in this epic.

- **TDD Process** (`.claude/rules/tdd.mdc`): Write the test FIRST. Run it. Watch it fail. Then implement ONLY the code needed to make it pass. Repeat for each requirement. Do not write implementation before tests.
- **Test Rubric** (`.pu/templates/rubric-review.md`): Score each test file against the rubric before committing. Tests must be contract-first, mock only at boundaries, and assert observable outcomes.
- **Deferred Work Policy** (`.claude/rules/deferred-work-policy.mdc`): Complete all requirements. Update this plan if you deviate. No silent substitutions.
- **Commit Convention** (`.claude/rules/commit.mdc`): Use conventional commits (`feat:`, `fix:`, `test:`, `chore:`).
- **Pre-Merge Audit** (`.claude/rules/pre-merge-audit.mdc`): Before opening a PR, audit every requirement in this plan against your diff.

---

## Shell Executor Abstraction

A mockable wrapper around child_process for docker compose and script execution.

**Requirements**:
- Given `ShellExecutor.exec(command, options)`, should run a shell command and return `{ stdout, stderr, exitCode }`
- Given a timeout option, should kill the process after the timeout
- Given the executor, should log all commands and their exit codes for audit trail
- Given the abstraction, should be injectable (constructor parameter) so tests can provide a mock

**TDD Approach**:
- Write executor tests (`apps/control-plane/src/services/__tests__/shell-executor.test.ts`)
- Test the interface contract, not actual shell execution
- Given a mock executor, should record commands and return configured responses
- The real executor is a thin wrapper — integration tested manually, not in CI

**Key files to create**:
- `apps/control-plane/src/services/shell-executor.ts`

---

## Provisioning Pipeline

The end-to-end flow for creating a new tenant stack.

**Requirements**:
- Given a provisioning request with slug and ownerEmail, should execute these steps in order:
  1. Validate slug (via Epic 6b validation)
  2. Create tenant record with status `provisioning` (via repository)
  3. Generate env file by calling `infrastructure/scripts/generate-tenant-env.sh {slug}`
  4. Write env to `tenants/{slug}/.env`
  5. Run `docker compose -p ps-{slug} -f infrastructure/docker-compose.tenant.yml --env-file tenants/{slug}/.env up -d`
  6. Poll health endpoint until all services are healthy (timeout 120s, poll every 5s)
  7. Seed admin user (see Admin Seeder below)
  8. Update tenant status to `active`
  9. Record a `provisioned` event
- Given a failure at any step, should update status to `failed`, record error event with step name and error message
- Given a failure after docker compose up, should attempt cleanup: `docker compose -p ps-{slug} down --volumes`
- Given a slug that already exists as a tenant, should reject with conflict error before starting

**TDD Approach**:
- Write provisioning tests (`apps/control-plane/src/services/__tests__/provisioning-engine.test.ts`)
- Mock: ShellExecutor, repository, filesystem (fs.writeFile)
- Given valid request, should call steps in order and end with status `active`
- Given docker compose failure, should update status to `failed` and attempt cleanup
- Given health timeout, should update status to `failed`
- Given duplicate slug, should throw conflict error without calling shell

**Key files to create**:
- `apps/control-plane/src/services/provisioning-engine.ts`

---

## Tenant Lifecycle Operations

Suspend, resume, upgrade, and destroy operations.

**Requirements**:
- Given `suspend(slug)`, should stop web+realtime+processor containers (keep postgres+redis for data), update status to `suspended`
- Given `resume(slug)`, should start stopped containers, poll health, update status to `active`
- Given `upgrade(slug, imageTag)`, should pull new images and recreate containers one at a time (rolling)
- Given `destroy(slug)`, should backup database, stop all containers, remove volumes, update status to `destroyed`
- Given any operation on a nonexistent slug, should throw not found error
- Given an invalid status transition (e.g., suspend on a suspended tenant), should throw conflict error

**TDD Approach**:
- Write lifecycle tests (`apps/control-plane/src/services/__tests__/tenant-lifecycle.test.ts`)
- Mock ShellExecutor and repository
- Given suspend on active tenant, should stop specific containers and update status
- Given resume on suspended tenant, should start containers and poll health
- Given destroy, should call backup, docker compose down --volumes, and update status

**Key files to create**:
- `apps/control-plane/src/services/tenant-lifecycle.ts`

---

## Admin User Seeder

Create the initial admin user inside a tenant's database after provisioning.

**Requirements**:
- Given a newly provisioned tenant, should create an admin user with the owner's email and a generated temporary password
- Given the seeder, should connect to the tenant's postgres using the tenant's DATABASE_URL from their env file
- Given the admin user creation, should hash the password with bcrypt (12 rounds)
- Given the seed output, should return `{ email, temporaryPassword }` so the control plane can notify the owner
- Given an existing user with that email, should skip creation and return existing info (idempotent)

**TDD Approach**:
- Write seeder tests (`apps/control-plane/src/services/__tests__/admin-seeder.test.ts`)
- Mock the database connection and bcrypt
- Given valid email, should call db insert with hashed password
- Given existing user, should not insert and return existing user info
- Given bcrypt, should call with salt rounds = 12

**Key files to create**:
- `apps/control-plane/src/services/admin-seeder.ts`

---

## Evaluation Gate

Before moving to Epic 6d:
1. Can you provision a tenant end-to-end (with mocked shell)?
2. Does failure at each step correctly rollback?
3. Do suspend/resume/destroy work with correct status transitions?
4. Is the shell executor abstraction clean enough to mock easily in API route tests?
