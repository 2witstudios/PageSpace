import { NotificationEmail } from '../src/email-templates/NotificationEmail';

export default function NotificationEmailPreview() {
  return (
    <NotificationEmail
      userName="Alex Thompson"
      subject="New comment on your page"
      greeting="You have a new comment"
      message="Michael Rodriguez commented on your page 'Q4 Marketing Strategy': Great analysis! I think we should prioritize the social media campaign."
      actionUrl="https://app.pagespace.com/page/abc123"
      actionText="View Comment"
      unsubscribeUrl="https://app.pagespace.com/settings/notifications/unsubscribe?type=comments"
    />
  );
}
