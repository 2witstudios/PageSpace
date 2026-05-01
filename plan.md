# Plan

## Active Epics

- [Multiplayer AI Chat Streaming](tasks/multiplayer-ai-chat-streaming.md) — Socket-notified, HTTP-joined AI stream sharing: all page viewers see live ghost text and "X is waiting for AI response…" indicators in real-time.
- [AI Chat Send Flash Fix](tasks/ai-chat-send-flash-fix.md) — eliminate stream-abort and flash on send; stabilise `chatConfig` deps and extend `invalidateTree` guard to cover all active states.
- [E2E and Load Testing](tasks/e2e-and-load-testing.md) — Playwright e2e for core user journeys + k6 load scenarios with Grafana dashboard for API latency and Postgres pool monitoring.

## Recently Completed

- [BYOK Retirement](tasks/archive/2026-05-01-byok-retirement.md) — ✅ 2026-05-01 — Drop `user_ai_settings`, route all AI calls through `*_DEFAULT_API_KEY` env vars, broaden per-tier rate-limit gate to every managed provider; breaking change for self-hosters.
- [Deployment Mode Isolation Gaps](tasks/archive/2026-04-17-deployment-mode-isolation-gaps.md) — ✅ 2026-04-17 — Resend, Google Calendar, and AI provider guards for onprem mode; closes #944 #960 #964.
- [Files Empty-State CTA](tasks/archive/2026-04-17-files-empty-state-cta.md) — ✅ 2026-04-17 — discoverable Upload + Create actions for empty Files view with drag-and-drop and permission gating.
- [Settings Menu Contrast](tasks/archive/2026-04-17-settings-menu-contrast.md) — ✅ 2026-04-17 — WCAG AA dark-mode contrast fix for Personal settings rows via muted-foreground token bump + group hover pattern.
- [Notification Item Redesign](tasks/notification-item-redesign.md) — ✅ 2026-04-17 — shared `NotificationItem` grid layout + token-only theming + per-type compile-time coverage.
