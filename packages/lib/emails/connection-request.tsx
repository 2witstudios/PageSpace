import React from 'react';
import { ConnectionRequestEmail } from '../src/email-templates/ConnectionRequestEmail';

export default function ConnectionRequestPreview() {
  return (
    <ConnectionRequestEmail
      userName="Casey Brown"
      requesterName="Riley Johnson"
      requestMessage="Hi Casey! I saw your presentation at the design conference last month and would love to connect. I'm working on similar projects and think we could exchange some great insights."
      viewUrl="https://app.pagespace.com/connections/requests/req_abc123"
      unsubscribeUrl="https://app.pagespace.com/settings/notifications/unsubscribe?type=connection-requests"
    />
  );
}
