-- Update default for new users
ALTER TABLE "users" ALTER COLUMN "currentAiModel" SET DEFAULT 'glm-4.5-air';

-- Fix existing users with uppercase model ID
UPDATE "users" SET "currentAiModel" = 'glm-4.5-air' WHERE "currentAiModel" = 'GLM-4.5-air';