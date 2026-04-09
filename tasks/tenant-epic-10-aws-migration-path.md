# AWS Migration Path Epic

**Status**: PLANNED (FUTURE - Design only, no implementation in initial scope)
**Goal**: Architecture design for migrating from single VPS to AWS for horizontal scalability

## Overview

The initial per-tenant infrastructure runs on a single VPS with Docker Compose. This works for 18-20 tenants but has a ceiling. This epic documents the migration path to AWS where each tenant gets managed infrastructure (ECS/Fargate, RDS, ElastiCache, S3/EFS) orchestrated by the same control plane. The same Docker images are used; only the orchestration layer changes. This is a design-only epic - no implementation until VPS capacity is exhausted.

---

## Architecture Decision Record

Document the AWS target architecture and migration strategy.

**Requirements**:
- Given the ADR document, should describe: ECS Fargate for container orchestration (no EC2 management), RDS PostgreSQL for per-tenant databases, ElastiCache Redis for per-tenant caching, S3 or EFS for file storage, ALB with wildcard cert for routing
- Given the control plane changes, should describe how provisioning switches from `docker compose up` to ECS task definition creation + RDS instance creation
- Given cost analysis, should compare: VPS ($X/tenant) vs AWS ($Y/tenant) at 10, 20, 50, 100 tenants
- Given the migration timeline, should describe phased approach: VPS for first 20 tenants, AWS for 20+

**TDD Approach**:
- Write ADR validation test (`infrastructure/__tests__/aws-adr.test.ts`)
- Given the ADR markdown file, should contain sections: "Context", "Decision", "Consequences", "Cost Analysis", "Migration Timeline"
- Given the ADR, should reference all 5 AWS services: ECS, RDS, ElastiCache, S3/EFS, ALB

---

## Control Plane Provisioner Interface

Design the abstraction layer that lets the control plane switch between Docker Compose and AWS provisioners.

**Requirements**:
- Given a `Provisioner` interface, should define: `provision(tenant)`, `suspend(tenant)`, `resume(tenant)`, `destroy(tenant)`, `upgrade(tenant, imageTag)`, `healthCheck(tenant)`
- Given `DockerComposeProvisioner`, should implement the interface using docker compose commands (current Epic 6 logic)
- Given `AwsProvisioner`, should implement the interface using AWS SDK (future)
- Given the control plane, should select provisioner based on `PROVISIONER_TYPE` env var
- Given the interface, should be designed so both provisioners can coexist (some tenants on VPS, some on AWS)

**TDD Approach**:
- Write interface contract tests (`apps/control-plane/src/services/__tests__/provisioner-interface.test.ts`)
- Define the TypeScript interface with all methods
- Given a mock provisioner implementing the interface, should satisfy TypeScript type checking
- Given the DockerComposeProvisioner, should delegate to the existing shell commands
- This is primarily a design task - the test ensures the interface is correct
