import { DocsMarkdown } from "@/components/DocsContent";
import { createMetadata } from "@/lib/metadata";

export const metadata = createMetadata({
  title: "Sharing & Permissions",
  description: "Who sees what in PageSpace — drive membership, role templates, and per-page grants, in plain English.",
  path: "/docs/features/sharing",
  keywords: ["sharing", "permissions", "access", "collaboration", "roles", "drive members"],
});

const content = `
# Sharing & Permissions

Who sees what in PageSpace. Every page is protected by two layers: a drive-level role that covers everyone in the workspace, and per-page grants that cover individual pages. Four flags — **View**, **Edit**, **Share**, **Delete** — describe what each person can do. View is the foundation; Edit, Share, and Delete only make sense on top of it.

## What you can do

- Invite someone to a drive as a member or admin. Admins get full access to every page in the drive, the same as the owner.
- Share a single page with a specific person using the four flags: View, Edit, Share, Delete. Edit, Share, and Delete require View to be on; otherwise you combine them however you like. A person can have View + Share without Edit, for example.
- Create role templates (like "Editor" or "Reviewer") that bundle view, edit, and share across many pages at once, pick a color for the badge, and optionally make one the default role for new members.
- See who has access to a page from the **Share** dialog, and see every page a given member can reach from the drive-level members view.
- Revoke any grant instantly. The person loses access the next time they load the page.

## How it works

Access is resolved in order, and the first answer wins.

If you're the drive **owner**, you can see, edit, share, and delete every page in that drive. Nothing else overrides this, and no grant can take it away.

If you're a drive **admin** who has accepted the invitation, you get the same full access as the owner across every page in the drive.

If you're a drive **member** — the default role — you start with nothing. You only see pages where someone has explicitly granted you access, or where a role template you're assigned includes those pages. Membership is the ticket to the drive; it isn't the ticket to the pages inside.

Every per-page grant is one record per person per page, with four flags. **There is no inheritance.** A grant on a folder does not imply anything for the pages inside it — each page is checked on its own. This is deliberate: it stops the common "I shared one subfolder and accidentally gave away the whole tree" mistake.

Role templates are a convenience layer for owners and admins. A template says "people with this role get View + Edit on this set of pages" — it saves you from wiring up the same grants by hand every time you onboard a new person. Templates don't change the resolution order; they're just a tidy way to produce the same per-page grants.

## What it doesn't do

- **No public or link-only sharing.** Access is tied to a PageSpace account. You invite by email, and if the person doesn't have an account yet, they sign up before you can grant them anything. There are no "anyone with the link can view" URLs.
- **No folder inheritance.** Granting access to a folder does not grant access to any page inside it. If you want someone to see a folder and its contents, you grant each one — or put them in a role template that covers the set.
- **No domain-wide rules.** There is no "everyone at acme.com gets view" switch. Every person is added individually, either directly or through a role template.
- **No bundled delete.** Role templates and the drive-invite flow cover view, edit, and share only. Delete access is granted one person at a time from each page's **Share** dialog — it can't be baked into a role.

## Related

- [Drives & Workspaces](/docs/features/drives) — how drives group pages and members.
- [Pages](/docs/features/pages) — the thing you're actually sharing.
- [Security → Permissions](/docs/security/permissions) — the formal access model and exact resolution rules.
`;

export default function HowItWorksSharingPage() {
  return <DocsMarkdown content={content} />;
}
