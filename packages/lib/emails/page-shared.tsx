import { PageSharedEmail } from '../src/email-templates/PageSharedEmail';

export default function PageSharedPreview() {
  return (
    <PageSharedEmail
      userName="Morgan Lee"
      sharerName="Jamie Foster"
      pageTitle="2025 Product Roadmap"
      permissions={['view', 'comment', 'edit']}
      viewUrl="https://app.pagespace.com/page/roadmap-2025"
      unsubscribeUrl="https://app.pagespace.com/settings/notifications/unsubscribe?type=page-sharing"
    />
  );
}
