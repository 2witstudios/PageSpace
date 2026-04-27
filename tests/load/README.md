# Load Tests

k6 load tests for the PageSpace API. All scripts require a valid session token.

## Quick start

### 1. Generate the auth fixture

```bash
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/pagespace \
  node tests/load/scripts/create-k6-auth.mjs
```

This creates `tests/load/.k6-auth.json` (gitignored). It is idempotent — running it again reuses the same test user.

### 2. Run a script

```bash
# Baseline smoke test (5 VUs, 30 s)
docker run --rm --network host \
  -v "$PWD":/scripts \
  -e BASE_URL=http://localhost:3000 \
  grafana/k6 run /scripts/tests/load/auth-baseline.k6.js

# Drive-list focused scenario (20 VUs, 60 s)
docker run --rm --network host \
  -v "$PWD":/scripts \
  -e BASE_URL=http://localhost:3000 \
  grafana/k6 run /scripts/tests/load/scenarios/drive-list.k6.js
```

## Auth

Scripts support two auth modes:

| Mode | How |
|------|-----|
| **File (local dev)** | `tests/load/.k6-auth.json` — created by `create-k6-auth.mjs` |
| **Env vars (CI)** | `K6_SESSION_TOKEN=<token>` + optional `K6_DRIVE_ID=<id>` |

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `BASE_URL` | `http://localhost:3000` | Target server URL |
| `K6_VUS` | script default | Number of virtual users (auth-baseline only) |
| `K6_DURATION` | script default | Test duration (auth-baseline only) |
| `K6_SESSION_TOKEN` | — | Session token (overrides `.k6-auth.json`) |
| `K6_DRIVE_ID` | — | Drive ID fallback when drives list is empty |

## Scenarios

| Script | VUs | Duration | Tagged thresholds |
|--------|-----|----------|-------------------|
| `auth-baseline.k6.js` | 5 (env) | 30 s (env) | `http_req_duration p(95)<500ms` |
| `scenarios/drive-list.k6.js` | 20 | 60 s | `drives-list p(95)<300ms` |
| `scenarios/page-api.k6.js` | 10→25 ramp | 210 s | `drives-list p(95)<300ms`, `pages-list p(95)<500ms` |
| `scenarios/search.k6.js` | 10 | 60 s | `search p(95)<500ms` |

## Results

JSON results are written to `tests/load/results/run-<timestamp>.json` (gitignored).
