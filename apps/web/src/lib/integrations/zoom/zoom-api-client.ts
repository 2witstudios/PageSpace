const ZOOM_API_BASE = 'https://api.zoom.us/v2';

const TRUSTED_ZOOM_HOSTS = ['zoom.us'];
const TRUSTED_ZOOM_SUFFIX = '.zoom.us';

export type ZoomApiResult<T> =
  | { success: true; data: T }
  | { success: false; error: string; statusCode?: number; requiresReauth?: boolean };

export interface ZoomRecordingFile {
  id: string;
  file_type: string;
  download_url: string;
}

export interface ZoomRecordingsResponse {
  uuid: string;
  topic: string;
  start_time: string;
  duration: number;
  host_id: string;
  recording_files: ZoomRecordingFile[];
}

export const buildAuthHeader = (accessToken: string): Record<string, string> => ({
  Authorization: `Bearer ${accessToken}`,
});

export const buildRecordingsUrl = (meetingUuid: string): string =>
  `${ZOOM_API_BASE}/meetings/${encodeURIComponent(meetingUuid)}/recordings`;

export const getRecordings = async (
  accessToken: string,
  meetingUuid: string,
): Promise<ZoomApiResult<ZoomRecordingsResponse>> => {
  try {
    const url = buildRecordingsUrl(meetingUuid);
    const res = await fetch(url, {
      headers: buildAuthHeader(accessToken),
      signal: AbortSignal.timeout(30_000),
    });

    if (res.status === 401 || res.status === 403) {
      return { success: false, requiresReauth: true, error: `Auth error: ${res.status}` };
    }

    if (!res.ok) {
      return { success: false, error: `Zoom API error: ${res.status} ${res.statusText}`, statusCode: res.status };
    }

    const data = (await res.json()) as ZoomRecordingsResponse;
    return { success: true, data };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
};

const isTrustedZoomHost = (hostname: string): boolean =>
  TRUSTED_ZOOM_HOSTS.includes(hostname) || hostname.endsWith(TRUSTED_ZOOM_SUFFIX);

export const downloadTranscript = async (
  accessToken: string,
  downloadUrl: string,
): Promise<ZoomApiResult<string>> => {
  let parsed: URL;
  try {
    parsed = new URL(downloadUrl);
  } catch {
    return { success: false, error: 'Invalid download URL' };
  }

  if (!isTrustedZoomHost(parsed.hostname)) {
    return { success: false, error: `Untrusted download host: ${parsed.hostname}` };
  }

  try {
    const res = await fetch(downloadUrl, {
      headers: buildAuthHeader(accessToken),
      signal: AbortSignal.timeout(30_000),
    });

    if (!res.ok) {
      return { success: false, error: `Download failed: ${res.status}`, statusCode: res.status };
    }

    const text = await res.text();
    return { success: true, data: text };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
};
