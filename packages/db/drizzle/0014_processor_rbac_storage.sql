CREATE TABLE IF NOT EXISTS "files" (
    "id" text PRIMARY KEY,
    "driveId" text NOT NULL REFERENCES "drives"("id") ON DELETE CASCADE,
    "sizeBytes" bigint NOT NULL,
    "mimeType" text,
    "storagePath" text,
    "checksumVersion" integer NOT NULL DEFAULT 1,
    "createdAt" timestamp with time zone NOT NULL DEFAULT now(),
    "updatedAt" timestamp with time zone NOT NULL DEFAULT now(),
    "createdBy" text REFERENCES "users"("id") ON DELETE SET NULL,
    "lastAccessedAt" timestamp with time zone
);

CREATE INDEX IF NOT EXISTS "files_drive_id_idx" ON "files" ("driveId");

CREATE TABLE IF NOT EXISTS "file_pages" (
    "fileId" text NOT NULL REFERENCES "files"("id") ON DELETE CASCADE,
    "pageId" text NOT NULL REFERENCES "pages"("id") ON DELETE CASCADE,
    "linkedBy" text REFERENCES "users"("id") ON DELETE SET NULL,
    "linkedAt" timestamp with time zone NOT NULL DEFAULT now(),
    "linkSource" text,
    CONSTRAINT "file_pages_pk" PRIMARY KEY ("fileId", "pageId"),
    CONSTRAINT "file_pages_page_id_key" UNIQUE ("pageId")
);

CREATE INDEX IF NOT EXISTS "file_pages_file_id_idx" ON "file_pages" ("fileId");
CREATE INDEX IF NOT EXISTS "file_pages_page_id_idx" ON "file_pages" ("pageId");
