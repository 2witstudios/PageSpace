# Org policies: suspend, never delete

Spec POL-1 to POL-5 and POL-8 to POL-11. Vision principle 7: a rule change suspends what it newly forbids, lists it, and
turning the rule back on restores it. Nothing is destroyed to enforce a rule, and a policy change never widens access.

## Where each kind of content is held

A marker on a row only works when every reader of the row honours it. Each kind is held where the EFFECT happens:

| Content | Held by | Why there |
|---|---|---|
| Drive and page share links | `suspended_by_policy` on the link, AND the live policy, both checked at redemption and preview | Only the share-link service reads these rows; both checks live in one function (`linkUsableNow`) |
| Published pages, custom domains | **Moved** in the public bucket from `published/<prefix>/` to `suspended/<prefix>/`; restored by moving back | The edge serves the bucket and never reads the database, so only the bucket can pause a site. The bucket policy grants public read to `published/*` (and the asset prefix) only. Visibility is a function of the LIVE policy, never a marker |
| Integration connections | `suspended_by_policy` on the connection, AND the live allowlist, both checked on every tool call (`executeToolSaga`), when offering tools to an agent, and when granting | Every call to a provider funnels through one saga; the resolvers and the grant route repeat the marker so a suspended connection is never offered or granted |
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
| Who can invite (POL-5) | the invitation transaction, for create AND resend, on the inviter's org role and the role being offered (a Member never invites an Admin) |
| Who can create drives (POL-5) | creating an org drive AND moving a personal drive into the org, both inside the transaction that does it |
| Models and providers (POL-8) | the one provider factory, on every model call, for BOTH the resolved pair and the pair that was asked for; a refused selection is an error, never silently replaced by an allowed default. Saving a disallowed model is also refused up front |
| Agents run autonomously (POL-9) | the start of a workflow run from any non-manual source, and the channel mention responder, before any credit hold or model call. A run a person pressed is never blocked |
| Agents from other drives (POL-9) | attaching one (`addAgentToDrive`) AND every agent access decision for an agent already attached (`fetchAgentMembership`) |
| Cloud sandbox (POL-10) | `canRunCode`, the one gate every sandbox run, terminal and tool passes (after the drive access check, so an outsider learns nothing) |
| Persistent environments (POL-10) | creating one, AND every provision or start of an existing one |
| Published apps (POL-10) | the publish route (before the snapshot), the provisioner, the wake gate, and the routing edge on every request |
| Service connections (POL-11) | connecting (drive route and OAuth callback), and every tool call through the saga |

An approval the policy no longer allows is refused: `approve` while guests are off changes nothing.

## Decisions recorded for the switch policies (POL-8 to POL-11)

- **No marker for a switch.** Cross-drive agents, autonomy, sandboxes, environments and published apps are judged from the
  LIVE policy at the moment of use. Nothing is written when a policy turns off, so nothing can be stale, and turning it back
  on restores everything at once. The rows (agent memberships, environments, app rows) are never touched.
- **Running things are not killed.** A sandbox session, environment machine or app machine that is already running when
  its policy turns off is not interrupted, but it can no longer run code (the next run is refused), no new start is allowed,
  and an app receives no traffic (the edge refuses it) so it idles out and stops through the normal idle reaper.
- **An integration call is judged by the drive it runs IN.** A connection that belongs to another drive, or to a person,
  cannot carry a call past an org's allowlist: the org that owns the drive the agent works in decides which services act
  there. A call with no drive at all (a personal context) is not restricted.
- **Not covered by the allowlist:** a person's own connections used outside any org drive, and Google Calendar and Zoom,
  which are per-person account integrations and not drive connections.
- **Models are refused, never substituted.** An allowlist that swapped a refused choice for an allowed one would run a model
  the org never allowed and report success. Not done in this leaf: the model list offered to pickers is the public catalog
  and is not filtered per org (UI lane), and model writes through the page-agent config are refused at run time, not at save.
