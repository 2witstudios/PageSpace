import http from 'http';

/**
 * In-memory S3 stand-in for the browser specs, in the role mock-openrouter.ts plays for the AI
 * provider: object storage is a third-party service, not what the specs test, and CI has none.
 *
 * apps/web writes every page's content to S3 (packages/lib/src/services/page-content-store.ts):
 * a page create or save through `/api/pages` stores a version there, so without a bucket those
 * routes 500. Start web with AWS_ENDPOINT_URL_S3 pointing here (plus any static keys, which are
 * not checked) and they work as they do against Tigris.
 *
 * It speaks the path-style requests the AWS SDK sends to an IP endpoint (`/<bucket>/<key>`), and
 * only the five calls the content store makes: PutObject, HeadObject, GetObject, CopyObject (a
 * PUT with x-amz-copy-source) and DeleteObject. Objects live in memory for the server's life.
 */

type Stored = { readonly body: Buffer; readonly contentType: string; readonly lastModified: Date };

const xml = (res: http.ServerResponse, status: number, body: string): void => {
  res.writeHead(status, { 'Content-Type': 'application/xml' });
  res.end(`<?xml version="1.0" encoding="UTF-8"?>\n${body}`);
};

const noSuchKey = (res: http.ServerResponse, key: string): void =>
  xml(res, 404, `<Error><Code>NoSuchKey</Code><Message>The specified key does not exist.</Message><Key>${key}</Key></Error>`);

const readBody = (req: http.IncomingMessage): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });

/**
 * The payload of an `aws-chunked` body: `<hex size>[;chunk-signature=…]\r\n<bytes>\r\n` repeated,
 * ending with a zero-size chunk and any trailing checksum headers.
 */
export const decodeAwsChunked = (raw: Buffer): Buffer => {
  const parts: Buffer[] = [];
  let at = 0;
  while (at < raw.length) {
    const lineEnd = raw.indexOf('\r\n', at);
    if (lineEnd === -1) break;
    const size = parseInt(raw.subarray(at, lineEnd).toString('latin1').split(';')[0], 16);
    if (!Number.isFinite(size) || size === 0) break;
    parts.push(raw.subarray(lineEnd + 2, lineEnd + 2 + size));
    at = lineEnd + 2 + size + 2;
  }
  return Buffer.concat(parts);
};

const isAwsChunked = (req: http.IncomingMessage): boolean =>
  (req.headers['content-encoding'] ?? '').includes('aws-chunked') ||
  String(req.headers['x-amz-content-sha256'] ?? '').startsWith('STREAMING-');

/** `/<bucket>/<key>` → its parts; null for anything else. */
const objectOf = (url: string): { readonly id: string; readonly key: string } | null => {
  const path = decodeURIComponent(new URL(url, 'http://s3.local').pathname);
  const match = /^\/([^/]+)\/(.+)$/.exec(path);
  return match === null ? null : { id: `${match[1]}/${match[2]}`, key: match[2] };
};

export function createMockS3(): http.Server {
  const objects = new Map<string, Stored>();

  return http.createServer((req, res) => {
    void (async () => {
      if (req.url === '/__health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, objects: objects.size }));
        return;
      }
      const target = objectOf(req.url ?? '/');
      if (target === null) {
        xml(res, 400, '<Error><Code>InvalidRequest</Code><Message>Only path-style object requests.</Message></Error>');
        return;
      }
      const method = req.method ?? 'GET';

      if (method === 'PUT') {
        const raw = await readBody(req);
        const copySource = req.headers['x-amz-copy-source'];
        if (typeof copySource === 'string') {
          const from = objects.get(decodeURIComponent(copySource).replace(/^\//, ''));
          if (from === undefined) return noSuchKey(res, target.key);
          const lastModified = new Date();
          objects.set(target.id, {
            body: from.body,
            contentType: String(req.headers['content-type'] ?? from.contentType),
            lastModified,
          });
          return xml(
            res,
            200,
            `<CopyObjectResult><LastModified>${lastModified.toISOString()}</LastModified><ETag>"e2e"</ETag></CopyObjectResult>`,
          );
        }
        objects.set(target.id, {
          body: isAwsChunked(req) ? decodeAwsChunked(raw) : raw,
          contentType: String(req.headers['content-type'] ?? 'application/octet-stream'),
          lastModified: new Date(),
        });
        res.writeHead(200, { ETag: '"e2e"' });
        res.end();
        return;
      }

      if (method === 'DELETE') {
        objects.delete(target.id);
        res.writeHead(204);
        res.end();
        return;
      }

      if (method === 'GET' || method === 'HEAD') {
        const stored = objects.get(target.id);
        if (stored === undefined) {
          if (method === 'HEAD') {
            res.writeHead(404);
            res.end();
            return;
          }
          return noSuchKey(res, target.key);
        }
        res.writeHead(200, {
          'Content-Type': stored.contentType,
          'Content-Length': stored.body.length,
          'Last-Modified': stored.lastModified.toUTCString(),
          ETag: '"e2e"',
        });
        res.end(method === 'HEAD' ? undefined : stored.body);
        return;
      }

      xml(res, 405, '<Error><Code>MethodNotAllowed</Code><Message>Not supported.</Message></Error>');
    })().catch((error: unknown) => {
      xml(res, 500, `<Error><Code>InternalError</Code><Message>${String(error)}</Message></Error>`);
    });
  });
}
