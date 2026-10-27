// Relocated to @pagespace/lib/db/bounded-query so packages/lib and apps/web
// share one implementation (packages/lib depends on packages/db, not the
// other way around, so this couldn't live in packages/db without an inverted
// dependency). Re-exported here to keep the existing import path stable.
export { parseBoundedIntParam } from '@pagespace/lib/db/bounded-query';
