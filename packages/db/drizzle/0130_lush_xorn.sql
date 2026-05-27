ALTER TABLE "conversations" ADD COLUMN "isShared" boolean DEFAULT false NOT NULL;

-- Preserve current drive-visible behaviour: all pre-existing conversation rows were
-- implicitly shared with all drive members, so mark them shared on migration.
UPDATE "conversations" SET "isShared" = true;