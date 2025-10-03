import { DriveInvitationEmail } from '../src/email-templates/DriveInvitationEmail';

export default function DriveInvitationPreview() {
  return (
    <DriveInvitationEmail
      userName="Jordan Williams"
      inviterName="Emma Davis"
      driveName="Product Design Team"
      acceptUrl="https://app.pagespace.com/invitations/accept?token=inv_xyz789abc123"
      unsubscribeUrl="https://app.pagespace.com/settings/notifications/unsubscribe?type=drive-invitations"
    />
  );
}
