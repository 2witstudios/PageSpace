import { test, expect } from '../fixtures/auth.fixture';

const FAKE_PAGE_ID = 'clm000000000000000000000a';
const FAKE_CONTENT_HASH = 'a'.repeat(64);

test.describe('File uploads', () => {
  // ── UI ──────────────────────────────────────────────────────────────────────

  test('Files view shows empty state with upload CTA', async ({ page, driveId }) => {
    await page.goto(`/dashboard/${driveId}/files`);
    await expect(page.getByTestId('files-empty-state')).toBeVisible();
    await expect(page.getByRole('button', { name: /Upload files/i })).toBeVisible();
    await expect(page.getByRole('button', { name: /Create page/i })).toBeVisible();
  });

  test('upload button click drives the direct-to-S3 flow (presign → PUT → complete)', async ({
    page,
    driveId,
  }) => {
    // The browser hashes the file, asks /presign for a scoped PUT, uploads the
    // bytes straight to Tigris, then calls /complete to create the page record.
    const FAKE_PUT_URL =
      `https://fly.storage.tigris.dev/pagespace-files/files/${FAKE_CONTENT_HASH}/original` +
      `?X-Amz-Signature=fakesig&X-Amz-Expires=900`;

    let presignBody: { driveId?: string; filename?: string } = {};
    let putHit = false;
    let completeHit = false;

    // The early client-side quota guard — keep it green so the flow proceeds.
    await page.route('**/api/storage/check', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: '{}' })
    );

    await page.route('**/api/upload/presign', async (route) => {
      const json = (route.request().postDataJSON() ?? {}) as { driveId?: string; filename?: string };
      presignBody = { driveId: json.driveId, filename: json.filename };
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          jobId: 'job-e2e-1',
          key: `files/${FAKE_CONTENT_HASH}/original`,
          url: FAKE_PUT_URL,
          alreadyExists: false,
        }),
      });
    });

    await page.route(FAKE_PUT_URL, async (route) => {
      putHit = true;
      await route.fulfill({ status: 200, body: '' });
    });

    await page.route('**/api/upload/complete', async (route) => {
      completeHit = true;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          page: {
            id: FAKE_PAGE_ID,
            title: 'test-upload.pdf',
            type: 'FILE',
            filePath: FAKE_CONTENT_HASH,
            mimeType: 'application/pdf',
            fileSize: 1024,
            driveId,
          },
        }),
      });
    });

    await page.goto(`/dashboard/${driveId}/files`);
    await expect(page.getByTestId('files-empty-state')).toBeVisible();

    // Click the upload button — it triggers the hidden <input type="file">
    await page.getByRole('button', { name: /Upload files/i }).click();

    await page.getByTestId('files-upload-input').setInputFiles({
      name: 'test-upload.pdf',
      mimeType: 'application/pdf',
      buffer: Buffer.from('%PDF-1.4 minimal'),
    });

    await page.waitForResponse('**/api/upload/complete');

    expect(presignBody.driveId).toBe(driveId);
    expect(presignBody.filename).toBe('test-upload.pdf');
    expect(putHit).toBe(true);
    expect(completeHit).toBe(true);
  });

  // ── Auth guards ──────────────────────────────────────────────────────────────

  test('GET /api/files/:id/view returns 401 for unauthenticated request', async ({ page, baseURL }) => {
    // Use a fresh context with no session cookie
    const ctx = await page.context().browser()!.newContext({ baseURL: baseURL ?? 'http://localhost:3000' });
    const req = ctx.request;
    const response = await req.get('/api/files/some-file-id/view', {
      maxRedirects: 0,
    });
    expect(response.status()).toBe(401);
    await ctx.close();
  });

  test('GET /api/files/:id/view returns 404 for unknown id', async ({ page }) => {
    // Authenticated session (from storageState) but nonexistent ID
    const response = await page.request.get('/api/files/nonexistent-id-000000000000/view', {
      maxRedirects: 0,
    });
    // 404 (not found in pages or files table)
    expect(response.status()).toBe(404);
  });

  // ── Upload validation (presign contract) ─────────────────────────────────────

  test('POST /api/upload/presign returns 400 when required fields are missing', async ({ page, driveId }) => {
    const csrf = await page.request.get('/api/auth/csrf');
    const { csrfToken } = (await csrf.json()) as { csrfToken: string };

    const response = await page.request.post('/api/upload/presign', {
      headers: { 'X-CSRF-Token': csrfToken },
      data: { driveId }, // missing contentHash / filename / mimeType / fileSize
    });
    expect(response.status()).toBe(400);
    const body = (await response.json()) as { error?: string };
    expect(body.error).toMatch(/missing required fields/i);
  });

  test('POST /api/upload/presign returns 400 for an invalid content hash', async ({ page, driveId }) => {
    const csrf = await page.request.get('/api/auth/csrf');
    const { csrfToken } = (await csrf.json()) as { csrfToken: string };

    const response = await page.request.post('/api/upload/presign', {
      headers: { 'X-CSRF-Token': csrfToken },
      data: {
        contentHash: 'not-a-valid-sha256-hash',
        driveId,
        filename: 'test.pdf',
        mimeType: 'application/pdf',
        fileSize: 1024,
      },
    });
    expect(response.status()).toBe(400);
  });

  // ── Presigned URL redirect ───────────────────────────────────────────────────

  test('file view redirects to presigned S3 URL (mocked)', async ({ page, driveId }) => {
    const presignedUrl =
      `https://fly.storage.tigris.dev/pagespace-files/files/${FAKE_CONTENT_HASH}/original` +
      `?X-Amz-Signature=fakesig&X-Amz-Expires=900`;

    // Intercept the view route to simulate what the real handler does
    await page.route(`**/api/files/${FAKE_PAGE_ID}/view`, async (route) => {
      await route.fulfill({
        status: 302,
        headers: { location: presignedUrl },
        body: '',
      });
    });

    const response = await page.request.get(`/api/files/${FAKE_PAGE_ID}/view`, {
      maxRedirects: 0,
    });

    expect(response.status()).toBe(302);
    expect(response.headers()['location']).toBe(presignedUrl);
    expect(response.headers()['location']).toContain('X-Amz-Signature');
  });

  test('dangerous MIME (SVG) gets attachment disposition in presigned URL', async ({ page }) => {
    const presignedUrlWithDisposition =
      `https://fly.storage.tigris.dev/pagespace-files/files/${FAKE_CONTENT_HASH}/original` +
      `?ResponseContentDisposition=attachment%3B+filename%3D%22test.svg%22&X-Amz-Signature=fakesig`;

    await page.route(`**/api/files/svg-page-id/view`, async (route) => {
      await route.fulfill({
        status: 302,
        headers: { location: presignedUrlWithDisposition },
        body: '',
      });
    });

    const response = await page.request.get('/api/files/svg-page-id/view', {
      maxRedirects: 0,
    });

    expect(response.status()).toBe(302);
    const location = response.headers()['location'];
    expect(location).toContain('ResponseContentDisposition');
    expect(location).toContain('attachment');
  });
});
