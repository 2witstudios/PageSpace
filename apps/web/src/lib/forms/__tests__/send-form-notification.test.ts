import { describe, it, expect, beforeEach, vi } from 'vitest';

const mockSendEmail = vi.hoisted(() => vi.fn());
const mockResolveAppUrl = vi.hoisted(() => vi.fn());
const mockLoggerError = vi.hoisted(() => vi.fn());

vi.mock('@pagespace/lib/services/email-service', () => ({
  sendEmail: mockSendEmail,
  resolveAppUrl: mockResolveAppUrl,
}));

vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: {
    api: { info: vi.fn(), warn: vi.fn(), error: mockLoggerError, debug: vi.fn() },
  },
}));

import { sendFormSubmissionNotification } from '../send-form-notification';
import type { FormTarget } from '@pagespace/db/schema/form-targets';

const formTarget = {
  id: 'ft-1',
  notificationEmail: 'owner@example.com',
  driveId: 'drive-1',
  pageId: 'sheet-1',
  fields: [
    { name: 'name', label: 'Name', type: 'text', required: true },
    { name: 'subscribe', label: 'Subscribe?', type: 'checkbox', required: false },
  ],
} as unknown as FormTarget;

describe('sendFormSubmissionNotification', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveAppUrl.mockReturnValue('https://app.example.com');
    mockSendEmail.mockResolvedValue(undefined);
  });

  it('sends to the configured recipient, skipping the shared per-recipient rate limit', async () => {
    await sendFormSubmissionNotification({
      formTarget,
      values: { name: 'Ada', subscribe: true },
      submittedAt: new Date('2026-05-04T12:00:00Z'),
    });

    const args = mockSendEmail.mock.calls[0][0];
    expect(args.to).toBe('owner@example.com');
    expect(args.subject).toBe('New form submission');
    expect(args.skipRateLimit).toBe(true);
  });

  it('maps field labels and stringifies checkbox values into email entries', async () => {
    await sendFormSubmissionNotification({
      formTarget,
      values: { name: 'Ada', subscribe: true },
      submittedAt: new Date('2026-05-04T12:00:00Z'),
    });

    const { react } = mockSendEmail.mock.calls[0][0];
    const entries = react.props.entries;
    expect(entries).toEqual([
      { label: 'Name', value: 'Ada' },
      { label: 'Subscribe?', value: 'Yes' },
    ]);
  });

  it('falls back to an empty string for a field missing from the submitted values', async () => {
    await sendFormSubmissionNotification({
      formTarget,
      values: { name: 'Ada' },
      submittedAt: new Date('2026-05-04T12:00:00Z'),
    });

    const { react } = mockSendEmail.mock.calls[0][0];
    expect(react.props.entries).toEqual(
      expect.arrayContaining([{ label: 'Subscribe?', value: '' }]),
    );
  });

  it('builds the sheet link from resolveAppUrl and the target drive/page ids', async () => {
    await sendFormSubmissionNotification({
      formTarget,
      values: { name: 'Ada', subscribe: true },
      submittedAt: new Date('2026-05-04T12:00:00Z'),
    });

    const { react } = mockSendEmail.mock.calls[0][0];
    expect(react.props.sheetUrl).toBe('https://app.example.com/dashboard/drive-1/sheet-1');
  });

  it('resolves (does not throw or reject) when sendEmail rejects, and logs with the form target id', async () => {
    mockSendEmail.mockRejectedValue(new Error('Resend timeout'));

    await expect(
      sendFormSubmissionNotification({
        formTarget,
        values: { name: 'Ada', subscribe: true },
        submittedAt: new Date('2026-05-04T12:00:00Z'),
      }),
    ).resolves.toBeUndefined();

    expect(mockLoggerError).toHaveBeenCalledWith(
      'Failed to send form submission notification',
      expect.any(Error),
      { formTargetId: 'ft-1' },
    );
  });

  it('resolves (does not throw or reject) when building the email throws synchronously, e.g. a misconfigured app URL', async () => {
    mockResolveAppUrl.mockImplementation(() => {
      throw new Error('WEB_APP_URL must be configured');
    });

    await expect(
      sendFormSubmissionNotification({
        formTarget,
        values: { name: 'Ada', subscribe: true },
        submittedAt: new Date('2026-05-04T12:00:00Z'),
      }),
    ).resolves.toBeUndefined();

    expect(mockSendEmail).not.toHaveBeenCalled();
    expect(mockLoggerError).toHaveBeenCalledWith(
      'Failed to send form submission notification',
      expect.any(Error),
      { formTargetId: 'ft-1' },
    );
  });
});
