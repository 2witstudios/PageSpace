import { DocsMarkdown } from "@/components/DocsContent";
import { createMetadata } from "@/lib/metadata";

export const metadata = createMetadata({
  title: "Drives & Workspaces",
  description: "A drive is a PageSpace workspace — the top-level container that holds a page tree, members, roles, integrations, and backups.",
  path: "/docs/how-it-works/drives",
  keywords: ["drives", "workspaces", "members", "roles", "invitations", "integrations", "backups"],
});

const content = `
# Drives & Workspaces

A drive is a PageSpace workspace — the top-level container that holds a page tree and a set of people. Every page you create lives inside exactly one drive, and everything about access, sharing, and integrations is scoped to that drive.

## What you can do

- Create a new drive for a team, project, or client, and build its page tree from scratch.
- Keep a private drive for yourself; the name \`Personal\` is reserved so no other drive can take it.
- Invite people by email and pick what they land on — full drive access, admin rights, or access to specific pages.
- Define custom roles like "Editor" or "Reviewer" with preset view, edit, and share permissions, then hand out that role when inviting people.
- Connect a drive to Google Drive, GitHub, a calendar, or another OAuth provider once, and every member can use that connection through AI.
- Write a drive prompt — custom AI instructions that AI Chat pages in the drive can opt into.
- Take a snapshot backup of a drive before a risky import, rename, or restructure.
- See who accessed the drive recently and jump back into the ones you touched today.
- Move a drive to the trash and restore it later, or open its history feed to see what changed and when.

## How it works

A drive owns a tree of pages and a list of members. When you create a drive you become its owner. The drive has its own URL slug, its own trash, its own [search](/docs/how-it-works/search), its own integrations list, and its own history feed.

There are four distinct ways to have access to a drive, and the difference matters:

- **Owner** — the account that created the drive. Exactly one per drive. Automatic full access to every page, and some drive-level operations are owner-only.
- **Admin** — a member with the admin role. Automatic full access to every page, can invite and remove members, can run backups.
- **Member** — listed on the drive's member roster with the member role or a custom role. Can be assigned tasks. Which specific pages they can see and edit is chosen when they're invited — you pick the pages they get. Unlike admins, members don't automatically see every page in the tree.
- **Page-level collaborator** — someone who was granted access to specific pages but not added to the drive itself. They can navigate to those pages, but they aren't on the member list, can't be selected as a task assignee, and can't be used as a scope for a drive-level service token. They have a keyhole into the drive, not a key to the whole building.

Invitations are a two-step handshake. When someone is invited, a pending membership is created — they appear on the member list but their access isn't active until they accept. Until then, permission checks treat them as if they're not there.

Integrations (Google Drive, GitHub, calendars, and so on) are attached to the drive, not to you personally. You connect your Google account to the drive once, and from that point any member can use that connection — an AI agent pulling a file from Drive uses the drive's connection, not whoever happens to be chatting. Detaching the connection removes that ability for everyone in the drive at the same time.

Backups are point-in-time snapshots of the drive — every page, every permission grant, every member, every custom role, and every file reference. Only owners and admins can trigger or view them. A backup gives you a rollback point before a risky change.

## What it doesn't do

- **A page can't belong to two drives.** If you need the same content in two places, use an @-mention or move the page — there's no multi-home for pages.
- **Page-level collaborators are not drive members.** They can't create pages in the drive, can't be chosen as task assignees, and can't be used as a scope for a drive-level service token. If someone needs to be part of the drive, invite them to the drive, not just one page.
- **The member role does not automatically see every page.** Members see the pages they were explicitly granted access to when invited. If you want someone to see the whole tree automatically, invite them as an admin.
- **Members don't inherit your personal integrations.** Your Google Drive connection on your account doesn't flow through to a drive you created — you attach the connection to the drive explicitly, and that's what members use.
- **Invitations that haven't been accepted don't confer access.** A pending invite sits on the member list, but permission checks treat them as if they're not there yet.
- **Deleting a drive isn't permanent by default.** A deleted drive goes to the drive trash with all its pages intact, and stays there until you restore it.
- **The \`Personal\` name is reserved.** You can't create a second drive called Personal.

## Related

- [Pages](/docs/how-it-works/pages) — what lives inside a drive.
- [Sharing & Permissions](/docs/how-it-works/sharing) — how roles, page grants, and invitations combine in practice.
- [AI in your Workspace](/docs/how-it-works/ai) — how the drive prompt and drive-scoped integrations shape what AI can see and do.
`;

export default function HowItWorksDrivesPage() {
  return <DocsMarkdown content={content} />;
}
