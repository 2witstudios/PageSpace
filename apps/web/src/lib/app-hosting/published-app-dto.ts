import { eq } from '@pagespace/db/operators';
import { db } from '@pagespace/db/db';
import { publishedApps, type PublishedApp } from '@pagespace/db/schema/published-apps';
import { resolvePublishedAppsApex } from '@pagespace/lib/services/app-hosting/routing-env';

export async function findPublishedAppByEnvId(envId: string): Promise<PublishedApp | null> {
  const [row] = await db.select().from(publishedApps).where(eq(publishedApps.envId, envId)).limit(1);
  return row ?? null;
}

export async function findPublishedAppById(id: string): Promise<PublishedApp | null> {
  const [row] = await db.select().from(publishedApps).where(eq(publishedApps.id, id)).limit(1);
  return row ?? null;
}

export interface PublishedAppDTO {
  id: string;
  envId: string;
  status: PublishedApp['status'];
  tier: PublishedApp['tier'];
  subdomain: string;
  url: string;
  flyAppName: string;
  lastError: string | null;
  createdAt: Date;
}

export function toPublishedAppDTO(app: PublishedApp): PublishedAppDTO {
  const apex = resolvePublishedAppsApex();
  return {
    id: app.id,
    envId: app.envId,
    status: app.status,
    tier: app.tier,
    subdomain: app.subdomain,
    url: `https://${app.subdomain}.${apex}`,
    flyAppName: app.flyAppName,
    lastError: app.lastError,
    createdAt: app.createdAt,
  };
}
