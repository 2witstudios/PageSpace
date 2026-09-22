-- Registers the smoke SPA as a third-party public client, the way the developer
-- console (Phase 1b) will. Run against the LOCAL database only:
--   psql "$DATABASE_URL" -f prototypes/pagespace-signin-smoke/seed-client.sql
INSERT INTO oauth_clients (
  "id", "clientId", "name", "clientType", "redirectUris", "allowedGrantTypes", "allowedScopes",
  "description", "verified", "isFirstParty", "createdAt", "updatedAt"
) VALUES (
  'signin_smoke_client_row', 'signin-smoke', 'Sign-in smoke test', 'public',
  '["https://127.0.0.1:5173/auth/pagespace/callback"]'::jsonb,
  '["authorization_code", "refresh_token"]'::jsonb,
  '["profile", "offline_access", "drive", "drive:admin", "drive:member", "drive:role"]'::jsonb,
  'Phase 3 real-browser smoke test for Sign in with PageSpace.', false, false,
  (now() at time zone 'utc'), (now() at time zone 'utc')
)
ON CONFLICT ("clientId") DO UPDATE SET
  "redirectUris" = EXCLUDED."redirectUris",
  "allowedGrantTypes" = EXCLUDED."allowedGrantTypes",
  "allowedScopes" = EXCLUDED."allowedScopes",
  "disabledAt" = NULL,
  "updatedAt" = (now() at time zone 'utc');
