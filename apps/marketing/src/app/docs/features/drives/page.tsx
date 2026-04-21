import { DocsMarkdown } from "@/components/DocsContent";
import { createMetadata } from "@/lib/metadata";

export const metadata = createMetadata({
  title: "Drives & Workspaces",
  description: "A drive is a PageSpace workspace — the top-level container that holds a page tree, members, roles, integrations, and backups.",
  path: "/docs/features/drives",
  keywords: ["drives", "workspaces", "members", "roles", "invitations", "integrations", "backups"],
});

const content = `
# Drives & Workspaces

A drive is a PageSpace workspace — the top-level container that holds a page tree and a set of people. Every page you create lives inside exactly one drive, and everything about access, sharing, and integrations is scoped to that drive.

## What you can do

- Create a new drive for a team, project, or client, and build its page tree from scratch.
- Invite people by email and pick what they land on — full drive access, admin rights, or access to specific pages.
- Define custom roles like "Editor" or "Reviewer" with preset view, edit, and share permissions, then hand out that role when inviting people.
- Attach [integrations](/docs/integrations) to a drive so agents working inside it can reach external tools.
- Write a drive prompt — custom AI instructions that AI Chat pages in the drive can opt into.
- Take a snapshot backup of a drive before a risky import, rename, or restructure.
- See who accessed the drive recently and jump back into the ones you touched today.
- Open a drive's history feed to see what changed, when, and by whom.

## How it works

A drive owns a tree of pages and a list of members. When you create a drive you become its owner. The drive has its own URL slug, its own trash, its own [search](/docs/features/search), its own integrations list, and its own history feed.

There are four distinct ways to have access to a drive, and the difference matters:

- **Owner** — the account that created the drive. Exactly one per drive. Automatic full access to every page, and some drive-level operations are owner-only.
- **Admin** — a member with the admin role. Automatic full access to every page, can invite and remove members, can run backups.
- **Member** — listed on the drive's member roster with the member role or a custom role. Can be assigned tasks. Which specific pages they can see and edit is chosen when they're invited — you pick the pages they get. Unlike admins, members don't automatically see every page in the tree.
- **Page-level collaborator** — someone who was granted access to specific pages but not added to the drive itself. They can navigate to those pages, but they aren't on the member list, can't be selected as a task assignee, and can't be used as a scope for a drive-level service token. They have a keyhole into the drive, not a key to the whole building.

Invitations are a two-step handshake. When someone is invited, a pending membership is created — they appear on the member list but their access isn't active until they accept. Until then, permission checks treat them as if they're not there.

Backups are point-in-time snapshots of the drive — every page, every permission grant, every member, every custom role, and every file reference. Only owners and admins can trigger or view them. A backup gives you a rollback point before a risky change.

## Good to know

- **The member role sees only what's granted.** Unlike owners and admins, a plain member doesn't automatically see every page in the drive — they see the pages they were explicitly added to when invited. Invite someone as an admin if you want them to have full tree access.
- **Deleting a drive goes to trash first.** A deleted drive sits in the drive trash with all its pages intact, and stays there until you restore or purge it.

## Related

- [Pages](/docs/features/pages) — what lives inside a drive.
- [Sharing & Permissions](/docs/features/sharing) — how roles, page grants, and invitations combine in practice.
- [AI in your Workspace](/docs/features/ai) — how the drive prompt shapes what AI can see and do.
- [Integrations](/docs/integrations) — the external tools a drive can connect to.
`;

export default function HowItWorksDrivesPage() {
  return <DocsMarkdown content={content} />;
}
