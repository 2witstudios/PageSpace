import { redirectToHomeSection } from '@/lib/home-section';

/** Moved to Home, the dashboard: an old link lands on Home's calendar. */
export default async function Page(): Promise<never> {
  return redirectToHomeSection('calendar');
}
