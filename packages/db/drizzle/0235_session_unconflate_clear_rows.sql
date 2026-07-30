-- Custom SQL migration file, put your code below! --

-- Session ≠ conversation un-conflation, step 1 of 2: clear the unreleased rows.
--
-- The next migration rebuilds `agent_sessions` identity: `conversationId`
-- (the current PRIMARY KEY) is removed and a self-owned `id` PK takes its
-- place, because a session is a drive-level workspace hosting MANY
-- conversations — not a property of one chat thread. Adding a NOT NULL id
-- column with no server-side default is only legal on an empty table, and the
-- feature is UNRELEASED, so there is deliberately NO data migration: rows are
-- cleared, not converted.
--
-- DELETE, not TRUNCATE, and shells first: per-row AFTER DELETE triggers do not
-- fire on TRUNCATE, and `agent_sessions_sprite_reclaim` (0233) is what rescues
-- any live Sprite pointer into the reclaim outbox on the way out. A cleared
-- row with a live Sprite must leave a pointer behind or the VM bills forever.
DELETE FROM "agent_session_shells";--> statement-breakpoint
DELETE FROM "agent_sessions";
