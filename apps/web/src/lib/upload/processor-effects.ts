import { createUploadServiceToken } from '@pagespace/lib/services/validated-service-token';

const PROCESSOR_URL = process.env.PROCESSOR_URL || 'http://processor:3003';

export async function enqueueProcessorJob(
  userId: string,
  driveId: string,
  pageId: string,
): Promise<void> {
  const { token } = await createUploadServiceToken({ userId, driveId, pageId });
  // /pull runs the zero-trust pull-verify pipeline (re-hash + Magika gate) rather
  // than /by-page, which trusts the page's declared mimeType.
  const res = await fetch(`${PROCESSOR_URL}/api/ingest/pull/${pageId}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({})) as { error?: string };
    throw new Error(err.error || `Processor ingest failed with status ${res.status}`);
  }
}
