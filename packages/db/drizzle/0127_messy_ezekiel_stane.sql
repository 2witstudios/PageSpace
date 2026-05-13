UPDATE "pages" SET "toolAccessScope" = 'drive' WHERE "toolAccessScope" IS NULL;
ALTER TABLE "pages" ADD CONSTRAINT "pages_toolAccessScope_check" CHECK ("toolAccessScope" IN ('drive', 'subtree'));
ALTER TABLE "pages" ALTER COLUMN "toolAccessScope" SET NOT NULL;
