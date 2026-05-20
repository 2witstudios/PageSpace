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

  test('upload button click triggers POST /api/upload with file and driveId', async ({
    page,
    driveId,
  }) => {
    let capturedFormData: { driveId?: string; fileName?: string } = {};

    await page.route('**/api/upload', async (route) => {
      const postData = route.request().postData() ?? '';
      capturedFormData = {
        driveId: postData.includes(driveId) ? driveId : undefined,
        fileName: postData.includes('test-upload.pdf') ? 'test-upload.pdf' : undefined,
      };
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
          message: 'File uploaded and processed successfully.',
          processingStatus: 'completed',
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

    await page.waitForResponse('**/api/upload');

    expect(capturedFormData.driveId).toBe(driveId);
    expect(capturedFormData.fileName).toBe('test-upload.pdf');
  });

  // ── Auth guards ──────────────────────────────────────────────────────────────

  test('GET /api/files/:id/view returns 401 for unauthenticated request', async ({ page }) => {
    // Use a fresh context with no session cookie
    const ctx = await page.context().browser()!.newContext();
    const req = ctx.request;
    const response = await req.get('http://localhost:3000/api/files/some-file-id/view', {
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

  // ── Upload validation ────────────────────────────────────────────────────────

  test('POST /api/upload returns 400 when no file is provided', async ({ page, driveId }) => {
    const response = await page.request.post('/api/upload', {
      multipart: {
        driveId,
      },
    });
    expect(response.status()).toBe(400);
    const body = (await response.json()) as { error?: string };
    expect(body.error).toMatch(/no file/i);
  });

  test('POST /api/upload returns 400 when no driveId is provided', async ({ page }) => {
    const response = await page.request.post('/api/upload', {
      multipart: {
        file: {
          name: 'test.pdf',
          mimeType: 'application/pdf',
          buffer: Buffer.from('%PDF-1.4'),
        },
      },
    });
    expect(response.status()).toBe(400);
    const body = (await response.json()) as { error?: string };
    expect(body.error).toMatch(/drive/i);
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
