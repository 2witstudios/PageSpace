import React from 'react';
import { DirectMessageEmail } from '../src/email-templates/DirectMessageEmail';

export default function DirectMessagePreview() {
  return (
    <DirectMessageEmail
      userName="Taylor Martinez"
      senderName="Chris Anderson"
      messagePreview="Hey Taylor! I reviewed your latest design proposal and I think it's fantastic. The user flow improvements are exactly what we need. Can we schedule a quick call tomorrow to discuss the implementation timeline?"
      viewUrl="https://app.pagespace.com/messages/msg_abc123xyz"
      unsubscribeUrl="https://app.pagespace.com/settings/notifications/unsubscribe?type=direct-messages"
    />
  );
}
