# Review Vector: Queue Management

## Standards
- review.mdc (always)
- javascript.mdc (always)
- please.mdc (always)

## Scope
**Files**: `apps/processor/src/**`
**Level**: service

## Context
File processing jobs are queued and executed with retry logic to handle transient failures in image optimization and text extraction. Review that the queue correctly limits concurrency, implements exponential backoff on retries, and moves permanently failed jobs to a dead-letter state. Ensure that job status is accurately reported back to the web app.
