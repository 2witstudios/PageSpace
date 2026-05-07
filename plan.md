# Plan

## Active Epics

- [Inline Quote Replies](tasks/inline-quote-replies.md) — Slack/Twitter-style inline quote-reply embeds in channels and DMs via additive `quotedMessageId` self-FK + read-time enrichment helper; orthogonal to the just-shipped thread panel.
- [Slack DM Support](tasks/slack-dm-support.md) — extend the Slack provider adapter with `im:*` + `mpim:*` scopes and default `conversations.list` to all conversation types so agents can read 1:1 and group DMs alongside channels.
- [DM File Attachments](tasks/dm-file-attachments.md) — bring DM conversations to channel parity for file attachments via a `fileConversations` join table, nullable `files.driveId`, and shared upload/token/processor/composer/renderer infrastructure.
- [Multiplayer AI Chat Streaming](tasks/multiplayer-ai-chat-streaming.md) — Socket-notified, HTTP-joined AI stream sharing: all page viewers see live ghost text and "X is waiting for AI response…" indicators in real-time.
- [AI Chat Send Flash Fix](tasks/ai-chat-send-flash-fix.md) — eliminate stream-abort and flash on send; stabilise `chatConfig` deps and extend `invalidateTree` guard to cover all active states.
- [E2E and Load Testing](tasks/e2e-and-load-testing.md) — Playwright e2e for core user journeys + k6 load scenarios with Grafana dashboard for API latency and Postgres pool monitoring.
- [Task List Agent Triggers Follow-up](tasks/task-list-agent-triggers-followup.md) — close PR #1177 post-merge gaps: cross-surface discoverability via TaskDetailSheet, page-scoped task broadcasts for collaborative real-time, agent-parity (instructionPageId + contextPageIds) in the trigger dialog, "anchored to" clarity in the page-level Workflows dialog, and small polish + correctness fixes.

## Drive Invites by Email — followups

Follow-up authz queries on `drive_members` discovered during Epic 1 gate
hardening. These were left out of Epic 1 to keep the PR tight (security
hardening only); each callsite is allow-listed in
`apps/web/src/app/api/__tests__/drive-member-gate-coverage.test.ts` with a
justification, and should be revisited as a follow-up:

- `apps/web/src/app/api/account/drives-status/route.ts` — admin lookup for the
  drive-transfer UI; should gate on `acceptedAt` so a pending admin can't be
  offered as a transfer target.
- `apps/web/src/app/api/account/handle-drive/route.ts` — drive-transfer POST
  validates the new owner is an admin; same gate needed so transfer to a
  pending admin is rejected.
- `apps/web/src/app/api/admin/global-prompt/route.ts` — admin tool listing
  member drives for global-prompt scoping; gate so pending invitations don't
  surface in the admin's drive picker.
- `apps/web/src/app/api/channels/[pageId]/messages/route.ts` — admin
  membership lookup for mention notifications; pending admins shouldn't
  receive @mentions before accepting.
- `apps/web/src/app/api/pages/bulk-copy/route.ts`,
  `apps/web/src/app/api/pages/bulk-move/route.ts` — target-drive membership
  check used to authorise cross-drive copy/move; gate so a pending member
  can't pull pages into a drive they haven't accepted into.
- `apps/web/src/app/api/pages/tree/route.ts` — drive membership lookup for
  the tree-rendering authz check; same gate.
- `packages/lib/src/services/drive-role-service.ts` — `checkDriveAccessForRoles`
  membership lookup; same `acceptedAt` gate needed so a pending member
  can't read or modify drive roles before accepting their invitation.

## Recently Completed

- [BYOK Retirement](tasks/archive/2026-05-01-byok-retirement.md) — ✅ 2026-05-01 — Drop `user_ai_settings`, route all AI calls through `*_DEFAULT_API_KEY` env vars, broaden per-tier rate-limit gate to every managed provider; breaking change for self-hosters.
- [Deployment Mode Isolation Gaps](tasks/archive/2026-04-17-deployment-mode-isolation-gaps.md) — ✅ 2026-04-17 — Resend, Google Calendar, and AI provider guards for onprem mode; closes #944 #960 #964.
- [Files Empty-State CTA](tasks/archive/2026-04-17-files-empty-state-cta.md) — ✅ 2026-04-17 — discoverable Upload + Create actions for empty Files view with drag-and-drop and permission gating.
- [Settings Menu Contrast](tasks/archive/2026-04-17-settings-menu-contrast.md) — ✅ 2026-04-17 — WCAG AA dark-mode contrast fix for Personal settings rows via muted-foreground token bump + group hover pattern.
- [Notification Item Redesign](tasks/notification-item-redesign.md) — ✅ 2026-04-17 — shared `NotificationItem` grid layout + token-only theming + per-type compile-time coverage.
