import { redirect } from 'next/navigation';
import { getHomeDrive } from '@pagespace/lib/services/drive-service';
import { getViewer } from '@/lib/auth/get-viewer';
import { webAppOrigin } from '@/lib/auth/sign-in-url';

/** Classic's landing page, outside imago's basePath. */
const CLASSIC_HOME = '/dashboard';

// Bare /imago has no stage of its own: chat replaces Home (D3), so it opens
// the viewer's Home drive chat. A relative redirect gets the /imago basePath
// from Next; classic is outside it, so that one is absolute.
export default async function ImagoIndex(): Promise<never> {
  const viewer = await getViewer();
  const home = await getHomeDrive(viewer.userId);
  if (home) redirect(`/${encodeURIComponent(home.id)}`);
  // Only until the Home backfill (IMG-4.3/4.4) reaches every user: classic
  // works without a Home drive, imago's stages all need a drive.
  redirect(`${webAppOrigin()}${CLASSIC_HOME}`);
}
