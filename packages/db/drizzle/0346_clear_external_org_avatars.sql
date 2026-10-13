-- ORG-1: an org avatar is only ever the org's own uploaded file. Clear any other stored value
-- (an outside URL from before the upload-only cutover) so organizations_avatar_url_chk, added by
-- the next migration, can be created. The same rule as that constraint.
UPDATE "organizations"
SET "avatarUrl" = NULL
WHERE "avatarUrl" IS NOT NULL
  AND "avatarUrl" !~ ('^/api/orgs/' || "id" || '/avatar/avatar-[a-z0-9]{1,32}\.(png|jpg|gif|webp)$');
