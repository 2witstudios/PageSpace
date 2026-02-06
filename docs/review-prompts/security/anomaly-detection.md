# Review Vector: Anomaly Detection

## Standards
- review.mdc (always)
- javascript.mdc (always)
- please.mdc (always)
- security.mdc

## Scope
**Files**: `packages/lib/src/monitoring/**`, `apps/web/src/app/api/monitoring/**`, `apps/web/src/app/api/pulse/**`
**Level**: service

## Context
The monitoring and pulse subsystems track system health metrics and access patterns that can surface anomalous behavior such as brute force attempts, unusual geographic access, or abnormal data access volumes. Review how failed authentication attempts are tracked and whether thresholds trigger alerts or automatic lockouts. Examine whether the monitoring data itself is protected from unauthorized access and whether the detection logic covers the most impactful attack patterns for a collaborative document platform.
