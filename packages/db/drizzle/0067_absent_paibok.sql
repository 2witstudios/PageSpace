WITH duplicate_rows AS (
  SELECT
    "id",
    ROW_NUMBER() OVER (
      PARTITION BY "createdById", "googleCalendarId", "googleEventId"
      ORDER BY "updatedAt" DESC NULLS LAST, "createdAt" DESC NULLS LAST, "id" DESC
    ) AS row_num
  FROM "calendar_events"
  WHERE "googleCalendarId" IS NOT NULL
    AND "googleEventId" IS NOT NULL
)
DELETE FROM "calendar_events"
WHERE "id" IN (
  SELECT "id"
  FROM duplicate_rows
  WHERE row_num > 1
);

ALTER TABLE "calendar_events"
ADD CONSTRAINT "calendar_events_google_source_per_user_key"
UNIQUE("createdById","googleCalendarId","googleEventId");
