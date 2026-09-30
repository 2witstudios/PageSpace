# Org policies: suspend, never delete

Spec POL-1, POL-2, POL-3, POL-4. Vision principle 7: a rule change suspends what it newly forbids, lists it, and
turning the rule back on restores it. Nothing is destroyed to enforce a rule, and a policy change never widens access.

## Where each kind of content is held

A marker on a row only works when every reader of the row honours it. Each kind is held where the EFFECT happens:

| Content | Held by | Why there |
|---|---|---|
| Drive and page share links | `suspended_by_policy` on the link, AND the live policy, both checked at redemption and preview | Only the share-link service reads these rows; both checks live in one function (`linkUsableNow`) |
| Published pages, custom domains | **Moved** in the public bucket from `published/<prefix>/` to `suspended/<prefix>/`; restored by moving back | The edge serves the bucket and never reads the database, so only the bucket can pause a site. The bucket policy grants public read to `published/*` (and the asset prefix) only. Visibility is a function of the LIVE policy, never a marker |
| Integration connections | `suspended_by_policy` on the connection | (enforced by leaf 3) |
| Guests | The member row and page grants are **parked** in `org_guest_holds` (full snapshot) and removed from the live tables; restore re-inserts them | A guest's page access comes from `page_permissions`, which the resolver reads without the member row, in dozens of queries; parking makes every reader see no access with no condition to forget |

The `drive_members.suspended_by_policy` column from milestone 1 is deprecated and unused (kept, not dropped, so no data is lost).

## What an export carries

- **Tenant export** (`scripts/lib/tenant-export-columns.ts`) carries drives, members, pages and the rest of its table
  list. Share links, published pages, custom domains and integration connections are not in it, so a suspended link,
  page or domain does not travel: nothing arrives at the destination, suspended or not. Published and parked bucket
  objects are not bundled either. A PARKED guest is not in `drive_members` and not exported, so a guest the org suspended
  does not gain access by moving (fail closed). The deprecated marker column is excluded with that reason.
- **GDPR export**: `org_guest_holds` is registered as a temporary exclusion under X-2 (Phase 6 adds the collector);
  account deletion removes it (`userId` cascades).

## What moving a drive out of an org does

A hold whose drive LEFT the org stays parked: the policy was about org content, so the person does not regain access on a
drive the org no longer owns (fail closed), and the org Owner still lists it. Suspended published pages of a drive that
left are restored by the next reconcile, because visibility follows the drive's CURRENT org.

## Enforcement is at the effect, not only at admission

| Policy | Checked where the effect happens |
|---|---|
| Public share links (POL-3) | creation (both link kinds), redemption (both), preview, approval replay |
| Publishing, custom domains (POL-4) | every write into `published/<prefix>/` (`assertPrefixWritable` in the storage layer), plus the publish and domain routes for a clear refusal |
| Guests (POL-2) | the invite by user id, the invite by email (before it is stored or sent), acceptance of a pending invite (before it is consumed), drive-link and page-link redemption, and approval replay |

An approval the policy no longer allows is refused: `approve` while guests are off changes nothing.
