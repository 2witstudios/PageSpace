import { DocsMarkdown } from "@/components/DocsContent";
import { createMetadata } from "@/lib/metadata";

export const metadata = createMetadata({
  title: "Accounts & Sign In",
  description: "How accounts work in PageSpace — passkeys, magic links, Google and Apple sign-in, devices, and why there's no password to forget.",
  path: "/docs/how-it-works/accounts",
  keywords: ["accounts", "sign in", "passkeys", "magic links", "Google sign in", "Apple sign in", "devices", "passwordless"],
});

const content = `
# Accounts & Sign In

PageSpace is passwordless. You sign in with a passkey, a one-time email link, or — on the hosted pagespace.ai service — your Google or Apple account. There is no password to set, forget, or reset.

## What you can do

- Sign in with a passkey using Touch ID, Face ID, Windows Hello, or a phone scanning a QR code.
- Sign in with a one-time link sent to your email.
- Sign in with Google or Apple on the hosted service.
- Add, rename, and remove passkeys from **Settings → Account**.
- Stay signed in on the desktop and mobile apps without signing in again every day.
- See every device currently signed in to your account, and revoke any of them.
- "Log out everywhere" to kill every active session at once.
- Create an MCP token from **Settings → MCP** so Claude Desktop, Cursor, or another MCP client can act on your behalf.
- Verify your email address and delete your account from **Settings → Account**.

## How it works

You don't have a password. There is no password stored for your account — there's nothing to type, nothing to reset, nothing a database leak could expose. Signing in means proving you hold something: a device that can use a passkey, control of your email inbox, or a valid Google or Apple account.

**Passkeys** are the preferred method. Your browser or OS stores a private key bound to your device's biometric or hardware security; the matching public key lives on our side. When you sign in, your device signs a fresh challenge — the private key never leaves it. That means a passkey can't be phished, reused on the wrong site, or leaked in a database breach.

**Magic links** are the fallback. Ask for one, and PageSpace emails a signed URL that's valid for 5 minutes and works exactly once. Click it and the browser you clicked from is signed in.

**Google and Apple sign-in** use OAuth. You prove to Google or Apple that you're you, they confirm it to us, and we issue a session. PageSpace never sees your Google or Apple password.

**Sessions** are stored in a secure browser cookie that lasts 7 days. Signing out revokes the session immediately on the server — it isn't just cleared on your machine, so someone who copied the cookie beforehand still can't use it.

**Desktop and mobile apps** don't use the web cookie. When you sign in inside the app, it trades your sign-in for a long-lived **device token** that rotates every time it refreshes. If a token ever leaks, the old one is already retired.

**Too many failed attempts** against the same account — ten in a row — lock the account for 15 minutes, regardless of which IP the attempts came from. A successful sign-in clears the counter.

**Deployment changes what's on the sign-in screen.** On the hosted pagespace.ai service you see passkey, magic link, Google, and Apple, and anyone can create an account. On a self-hosted install, Google and Apple sign-in aren't available and self-signup is turned off — your administrator creates the account and you sign in with a passkey or magic link. Self-hosted installs also idle sessions out after 15 minutes of inactivity by default.

## What it doesn't do

- **It doesn't let you set a password.** There's no password field on the account. "Forgot password" doesn't exist because there's nothing to forget — if you lose access to your passkey and your email, you lose access to the account.
- **It doesn't let you self-sign-up on a self-hosted install.** If your team runs its own PageSpace, an administrator has to create your account before you can sign in. Visiting the signup page just redirects you with a "contact your administrator" message.
- **It doesn't offer Google or Apple sign-in on self-hosted installs.** Those providers are only wired up on the hosted pagespace.ai service. If you're running your own PageSpace, you sign in with a passkey or a magic link.
- **It doesn't keep magic links alive.** A link is good for 5 minutes and one click. If your email provider delays delivery past that window, the link is dead when it arrives and you'll need to request another.
- **It doesn't sync passkeys between devices for you.** Platform passkeys (iCloud Keychain, Google Password Manager) sync within their own ecosystem, but a passkey registered only on one laptop stays on that laptop. Register a second passkey per device if you want redundancy.

## Related

- [Sharing & Permissions](/docs/how-it-works/sharing) — what signing in actually lets you see once you're in.
- [Authentication (Security)](/docs/security/authentication) — the architecture behind passkeys, opaque tokens, account lockout, and the audit log.
`;

export default function HowItWorksAccountsPage() {
  return <DocsMarkdown content={content} />;
}
