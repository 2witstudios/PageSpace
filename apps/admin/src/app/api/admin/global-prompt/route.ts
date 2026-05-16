import { withAdminAuth } from '@/lib/auth';

export const GET = withAdminAuth(async (_adminUser, _request) => {
  return Response.json({
    message: 'The global prompt viewer is served by the main web app.',
    webAppUrl: process.env.NEXT_PUBLIC_WEB_APP_URL ?? 'http://localhost:3000',
    adminPath: '/admin/global-prompt',
  });
});
