-- Migrate existing PageSpace users for tier update:
-- - Pro tier: glm-4.7 -> glm-5
-- - Standard tier: glm-4.5-air -> glm-4.7
--
-- IMPORTANT: Order matters! Migrate Pro users FIRST, then Standard users,
-- to avoid double-migration (Standard users moving to glm-4.7 then immediately to glm-5)

-- Step 1: Migrate Pro users from glm-4.7 to glm-5
UPDATE users
SET "currentAiModel" = 'glm-5'
WHERE "currentAiProvider" = 'pagespace'
  AND "currentAiModel" = 'glm-4.7';

-- Step 2: Migrate Standard users from glm-4.5-air to glm-4.7
UPDATE users
SET "currentAiModel" = 'glm-4.7'
WHERE "currentAiProvider" = 'pagespace'
  AND "currentAiModel" = 'glm-4.5-air';

-- Note: Users using the 'glm' provider directly are unaffected (both models still exist there)
