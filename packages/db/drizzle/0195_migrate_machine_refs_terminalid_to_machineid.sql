-- Migrate persisted MachineRef JSON from the legacy `terminalId` key to
-- `machineId`, matching the PageType TERMINAL -> MACHINE rename (0194).
--
-- The `machines` jsonb column on `pages` (AI_CHAT page agents) and
-- `global_assistant_config` (per-user global assistant) stores a
-- MachineRef[]: `{"kind":"own"}` or `{"kind":"existing","terminalId":"..."}`.
-- The 0194 schema rename only touched the enum value and the relational FK
-- columns, NOT these jsonb blobs. The `isMachineRef` guard now requires
-- `machineId`, and `isMachineRefArray` is all-or-nothing (`.every(...)`), so a
-- single legacy `terminalId` entry would make an entire configured list read
-- back as `[]` and get overwritten on the next save. Rewrite the blobs once
-- (hard cutover — the Machine feature is experimental/admin-gated and never
-- shipped GA, so there is no ongoing legacy-shape read path to keep).
--
-- Per element: rename `terminalId` -> `machineId`, preserving value + `kind`
-- and any other keys; `{"kind":"own"}` elements are left untouched. The WHERE
-- guard scopes the rewrite to rows that actually contain a legacy element, so
-- it is idempotent and never nulls out an empty/`{"kind":"own"}`-only array.

UPDATE "pages"
SET "machines" = (
  SELECT jsonb_agg(
    CASE WHEN elem ? 'terminalId'
      THEN (elem - 'terminalId') || jsonb_build_object('machineId', elem -> 'terminalId')
      ELSE elem
    END
  )
  FROM jsonb_array_elements("machines") AS elem
)
WHERE "machines" IS NOT NULL
  AND jsonb_typeof("machines") = 'array'
  AND EXISTS (
    SELECT 1 FROM jsonb_array_elements("machines") AS e WHERE e ? 'terminalId'
  );
--> statement-breakpoint
UPDATE "global_assistant_config"
SET "machines" = (
  SELECT jsonb_agg(
    CASE WHEN elem ? 'terminalId'
      THEN (elem - 'terminalId') || jsonb_build_object('machineId', elem -> 'terminalId')
      ELSE elem
    END
  )
  FROM jsonb_array_elements("machines") AS elem
)
WHERE "machines" IS NOT NULL
  AND jsonb_typeof("machines") = 'array'
  AND EXISTS (
    SELECT 1 FROM jsonb_array_elements("machines") AS e WHERE e ? 'terminalId'
  );
