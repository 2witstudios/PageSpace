import { resolveInviteContext } from "@/lib/auth/invite-resolver";
import { SignUpClient } from "./SignUpClient";

interface PageProps {
  searchParams: Promise<{ invite?: string }>;
}

export default async function SignUp({ searchParams }: PageProps) {
  const { invite } = await searchParams;

  if (!invite) {
    return <SignUpClient inviteContext={null} inviteToken={null} />;
  }

  const resolution = await resolveInviteContext({ token: invite, now: new Date() });
  // Failed resolution still renders signup — the user may have arrived here
  // outside the consent screen, and signup itself doesn't depend on a valid
  // invite. Acceptance is independent (handled post-signup); a stale invite
  // surfaces as a non-blocking dashboard toast.
  const inviteContext = resolution.ok
    ? {
        driveName: resolution.data.driveName,
        inviterName: resolution.data.inviterName,
        email: resolution.data.email,
      }
    : null;

  return <SignUpClient inviteContext={inviteContext} inviteToken={invite} />;
}
