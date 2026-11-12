import type { Metadata } from 'next';
import { ReportContentForm } from '@/components/content-safety/ReportContentForm';

export const metadata: Metadata = {
  title: 'Report content · PageSpace',
  description: 'Report illegal or abusive content on a site published with PageSpace.',
  robots: { index: true, follow: false },
};

/**
 * Public: no account needed (see `isPublicPageRoute`). Linked from the Terms and
 * the marketing footer.
 */
export default function ReportPage() {
  return (
    <main className="min-h-screen bg-background px-4 py-12 text-foreground">
      <div className="mx-auto w-full max-w-lg space-y-6">
        <header className="space-y-2">
          <h1 className="text-2xl font-semibold tracking-tight">Report content</h1>
          <p className="text-sm text-muted-foreground">
            Found something illegal or abusive on a site published with PageSpace? Tell us the address and our team
            will review it. You don&rsquo;t need an account.
          </p>
        </header>
        <ReportContentForm />
      </div>
    </main>
  );
}
