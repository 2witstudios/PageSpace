import { CollaboratorAddedEmail } from '../src/email-templates/CollaboratorAddedEmail';

export default function CollaboratorAddedPreview() {
  return (
    <CollaboratorAddedEmail
      userName="Sam Patel"
      adderName="Alex Kim"
      pageTitle="Engineering Architecture Documentation"
      viewUrl="https://app.pagespace.com/page/eng-architecture-docs"
      unsubscribeUrl="https://app.pagespace.com/settings/notifications/unsubscribe?type=collaborator-added"
    />
  );
}
