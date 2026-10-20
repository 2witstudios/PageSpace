import { redirectToHomeSection } from '@/lib/home-section';
import type { SearchParams } from '@/lib/home-section-path';

/** Moved to Home, the dashboard: an old link lands on Home's messages. */
export default async function Page({ searchParams }: { searchParams: Promise<SearchParams> }): Promise<never> {
  return redirectToHomeSection('messages', searchParams);
}
