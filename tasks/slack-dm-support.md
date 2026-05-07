# Slack DM Support Epic

**Status**: 📋 PLANNED
**Goal**: Let agents read and send 1:1 and group DMs through the existing Slack provider adapter.

## Overview

The Slack provider adapter shipped with channel scopes only (`channels:*`, `groups:*`), so agents can list and read public/private channels but every DM in the workspace is invisible. This epic adds the four DM scopes and updates `list_channels` to default to all conversation types — `list_messages` and `send_message` already accept DM channel IDs unchanged. Existing connected users (none in production yet) must disconnect and reconnect to pick up the new scopes; that re-auth UX is out of scope for this epic and tracked as a follow-up.

---

## Add DM scopes and conversation type filter to Slack provider

Extend `packages/lib/src/integrations/providers/slack.ts` scope array with `im:read`, `im:history`, `mpim:read`, `mpim:history`, and add `types=public_channel,private_channel,mpim,im` as the default `queryParams.types` on the `list_channels` tool so DMs surface alongside channels.

**Requirements**:
- Given a fresh Slack OAuth flow after this change, the consent screen should request all four DM scopes in addition to the existing seven.
- Given an agent calling `list_channels` without arguments, the request should include `types=public_channel,private_channel,mpim,im` so 1:1 and group DMs appear in the result.
- Given an agent calling `list_channels` with an explicit `types` argument, the agent's value should override the default rather than being concatenated to it.
- Given an agent calling `list_messages` against an `im` or `mpim` channel ID, the existing `conversations.history` request should succeed without per-channel-type branching in the tool config.
- Given a workspace with no DM history, `list_channels` should still return successfully with channel-only results rather than failing on missing DM scopes (Slack returns `ok:true` with a partial list).
- Given a Slack token that lacks DM scopes (legacy connection), `list_channels` filtered to `im,mpim` should surface Slack's `missing_scope` error verbatim through the existing `$.error` validation path so the caller can see why DMs are empty.

---
