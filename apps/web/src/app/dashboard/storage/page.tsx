import { redirect } from 'next/navigation';

/**
 * The storage dashboard was folded into the unified usage view on the billing page
 * (AI credits, usage breakdown, automations, and storage in one place). This route
 * is kept only to redirect existing links/bookmarks.
 */
export default function StorageRedirectPage() {
  redirect('/settings/usage');
}
