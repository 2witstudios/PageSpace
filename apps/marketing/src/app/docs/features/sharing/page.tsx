import { DocsMarkdown } from "@/components/DocsContent";
import { createMetadata } from "@/lib/metadata";

export const metadata = createMetadata({
  title: "Sharing & Permissions",
  description: "Who sees what in PageSpace — open-by-default drive membership, page privacy, custom roles, email and link invites, and per-page grants, in plain English.",
  path: "/docs/features/sharing",
  keywords: ["sharing", "permissions", "access", "collaboration", "roles", "drive members"],
});

const content = `
# Sharing & Permissions

Who sees what in PageSpace. Access is open within a drive and private by exception: members see the drive's pages by default, you mark individual pages **private** to lock them down, and per-page grants extend access to specific pages or to people who aren't drive members. Four flags — **View**, **Edit**, **Share**, **Delete** — describe what each person can do. View is the foundation; Edit, Share, and Delete only make sense on top of it.

## What you can do

- Invite someone to a drive as a member or admin — by email, even if they don't have an account yet. The invite waits for them and becomes access the moment they sign up. Members see the whole drive except pages marked private; admins get full access, the same as the owner.
- Share a drive or a single page with a link. Opening either link adds the person to the drive — a drive link with the role you set, a page link as a member with that page's permissions — so they'll also see the drive's other non-private pages; mark anything sensitive private first. Links are revocable and can carry an expiry.
- Share a single page with a specific person using the four flags: View, Edit, Share, Delete. Edit, Share, and Delete require View to be on; otherwise you combine them however you like. A person can have View + Share without Edit, for example.
- Create custom roles (like "Editor" or "Reviewer") that carry their own view/edit/share permissions, pick a color for the badge, optionally make one the default for new members, and assign a role right from an invite or share link.
- See who has access to a page from the **Share** dialog, and see every page a given member can reach from the drive-level members view.
- Revoke any grant, share link, or pending invite instantly.

## How it works

Access is resolved in order, and the first answer wins.

If you're the drive **owner**, you can see, edit, share, and delete every page in that drive. Nothing else overrides this, and no grant can take it away.

If you're a drive **admin** who has accepted the invitation, you get the same full access as the owner across every page in the drive.

If you're a drive **member** — the default role — you can see every page in the drive that isn't marked **private**, and post in its channels, without anyone granting each page one by one. To hide a page from the membership, mark it private; then only the owner, admins, and the people or roles explicitly granted access can reach it. Editing, sharing, or deleting other pages still needs a grant or a role.

Per-page grants are how you reach a *private* page, or how someone who isn't a drive member gets in. Each grant is one record per person per page, with four flags, and **explicit grants don't inherit** — a grant on a folder says nothing about the pages inside it; each is checked on its own. (Drive-wide visibility for members is the separate open-by-default baseline above, not an inherited grant.)

Custom roles let owners and admins bundle access under a name. A role carries its own per-page view/edit/share map, and the access check consults it directly — so assigning someone the "Reviewer" role grants exactly what that role defines, and a role can also explicitly withhold view on a page. Assign a role when you invite someone or hand it out later.

## Good to know

- **Invite by email, share by link, or grant per-person.** You can invite someone who has no account yet — the invite is held against their email and becomes access on signup. A share link adds whoever opens it to the drive — a drive link with the role you choose, a page link as a member with that page's permissions — so they also see the drive's non-private pages; mark sensitive pages private first. Links stay revocable.
- **Explicit grants don't cascade to children.** Granting access to a folder lets someone open the folder page itself; each child page is checked on its own grants. Drive members already see non-private pages across the tree — that's the membership baseline, separate from explicit grants.

## Related

- [Drives & Workspaces](/docs/features/drives) — how drives group pages and members.
- [Pages](/docs/features/pages) — the thing you're actually sharing.
- [Security → Permissions](/docs/security/permissions) — the formal access model and exact resolution rules.
`;

export default function HowItWorksSharingPage() {
  return <DocsMarkdown content={content} />;
}
