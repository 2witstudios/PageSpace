/**
 * The Zoom transcript webhook's AI enrichment (summary + action items) is a
 * trigger with no person present, so on the org-wallets branch it spends the
 * TARGET DRIVE's wallet or is skipped, never the connection owner's credits
 * (SPEND-6). Those model calls must pass the credit gate FIRST:
 * an exhausted balance gets no enrichment and no charge, but the meeting page is
 * still created — "never blocks page creation" stays true. The real
 * generate-summary / extract-action-items helpers run here; only the model,
 * provider and billing seams are faked.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ZoomConnection } from '@pagespace/db/schema/zoom';

const {
  mockCanConsumeAI,
  mockReleaseHold,
  mockGenerateText,
  mockCreateAIProvider,
  mockTrackUsage,
  mockCreatePage,
  mockSelectWhere,
  walletsLive,
} = vi.hoisted(() => ({
  mockCanConsumeAI: vi.fn(),
  mockReleaseHold: vi.fn(),
  mockGenerateText: vi.fn(),
  mockCreateAIProvider: vi.fn(),
  mockTrackUsage: vi.fn(),
  mockCreatePage: vi.fn(),
  mockSelectWhere: vi.fn(),
  walletsLive: { orgs: false, billing: true },
}));

vi.mock('@pagespace/db/db', () => ({
  db: {
    select: vi.fn(() => ({ from: vi.fn(() => ({ where: mockSelectWhere })) })),
    query: { zoomConnections: { findFirst: vi.fn() } },
  },
}));
vi.mock('@pagespace/db/operators', () => ({ and: vi.fn(), eq: vi.fn() }));
vi.mock('@pagespace/db/schema/zoom', () => ({ zoomConnections: {} }));
vi.mock('@pagespace/db/schema/auth', () => ({ users: { id: 'id', subscriptionTier: 'subscriptionTier' } }));
vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: { api: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } },
}));
vi.mock('@pagespace/lib/billing/credit-gate', () => ({ canConsumeAI: mockCanConsumeAI }));
vi.mock('@pagespace/lib/organizations/orgs-enabled', () => ({
  get ORGS_ENABLED() { return walletsLive.orgs; },
}));
vi.mock('@pagespace/lib/deployment-mode', () => ({ isBillingEnabled: () => walletsLive.billing }));
vi.mock('@pagespace/lib/billing/credit-consume', () => ({ releaseHold: mockReleaseHold }));
vi.mock('@pagespace/lib/monitoring/ai-monitoring', () => ({
  AIMonitoring: { trackUsage: mockTrackUsage },
  discardUsageOutcome: vi.fn(),
}));
vi.mock('ai', () => ({ generateText: mockGenerateText }));
vi.mock('@/lib/ai/core/provider-factory', () => ({
  createAIProvider: mockCreateAIProvider,
  isProviderError: (p: unknown) => typeof p === 'object' && p !== null && 'error' in p,
}));
vi.mock('@/services/api', () => ({ pageService: { createPage: mockCreatePage } }));
vi.mock('../token-refresh', () => ({
  getValidZoomAccessToken: vi.fn(async () => ({ success: true, accessToken: 'tok' })),
}));
vi.mock('../zoom-api-client', () => ({
  getRecordings: vi.fn(async () => ({
    success: true,
    data: { recording_files: [{ file_type: 'TRANSCRIPT', download_url: 'https://zoom.example/t.vtt' }] },
  })),
  downloadTranscript: vi.fn(async () => ({
    success: true,
    data: 'WEBVTT\n\n1\n00:00:01.000 --> 00:00:02.000\nAda: We ship Friday.\n',
  })),
}));

import { processZoomWebhook } from '../process-webhook';

const connection = {
  userId: 'user-1',
  zoomUserId: 'zoom-host',
  zoomAccountId: 'acct',
  targetDriveId: 'drive-1',
  targetFolderId: null,
  status: 'active',
  includeTranscript: false,
  includeAiSummary: true,
  includeActionItems: true,
} as unknown as ZoomConnection;

const event = {
  event: 'recording.transcript_completed',
  payload: {
    account_id: 'acct',
    object: {
      uuid: 'meeting-uuid',
      host_id: 'zoom-host',
      host_email: 'host@example.com',
      topic: 'Standup',
      start_time: '2026-09-01T10:00:00Z',
      duration: 15,
    },
  },
};

const createdContent = () => mockCreatePage.mock.calls[0][1].content as string;
const createdMetadata = () => mockCreatePage.mock.calls[0][2].context.metadata as Record<string, unknown>;

const DRIVE_AUTOMATION = { kind: 'automation', driveId: 'drive-1' };

beforeEach(() => {
  vi.clearAllMocks();
  walletsLive.orgs = false;
  walletsLive.billing = true;
  mockSelectWhere.mockResolvedValue([{ subscriptionTier: 'free' }]);
  mockCreatePage.mockResolvedValue({ success: true, page: { id: 'page-1' } });
  mockCreateAIProvider.mockResolvedValue({ model: {}, provider: 'pagespace', modelName: 'm' });
  mockGenerateText.mockImplementation(async ({ system }: { system: string }) => ({
    text: system.startsWith('Extract') ? '[{"text":"Ship it"}]' : '- Decided to ship Friday',
    usage: { inputTokens: 10, outputTokens: 5 },
  }));
  mockTrackUsage.mockResolvedValue(undefined);
  mockReleaseHold.mockResolvedValue(undefined);
});

describe('processZoomWebhook AI enrichment credit gate', () => {
  it('given an exhausted balance, should create the page with no AI enrichment and no charge', async () => {
    mockCanConsumeAI.mockResolvedValue({ allowed: false, reason: 'out_of_credits' });

    await processZoomWebhook(event, connection);

    // SPEND-6: the target drive is the consumer, never the connection owner's credits.
    expect(mockCanConsumeAI).toHaveBeenCalledWith(
      'user-1',
      'free',
      expect.objectContaining({ spend: DRIVE_AUTOMATION, skipDailyCap: true }),
    );
    expect(mockCreateAIProvider).not.toHaveBeenCalled();
    expect(mockGenerateText).not.toHaveBeenCalled();
    expect(mockTrackUsage).not.toHaveBeenCalled();
    expect(mockCreatePage).toHaveBeenCalledTimes(1);
    expect(createdContent()).not.toContain('Decided to ship Friday');
    expect(createdContent()).not.toContain('Ship it');
    expect(createdMetadata()).toMatchObject({ aiEnrichmentSkipped: 'out_of_credits' });
  });

  it('given a funded balance, should enrich the page, bill each model call and release the hold once', async () => {
    mockCanConsumeAI.mockResolvedValue({ allowed: true, reason: 'ok', holdId: 'hold-1', walletId: 'w-drive-1' });

    await processZoomWebhook(event, connection);

    // Each call settles on the wallet the hold reserved, never re-derived from the owner.
    expect(mockTrackUsage.mock.calls.map(([usage]) => usage.walletId)).toEqual(['w-drive-1', 'w-drive-1']);

    // One reservation sized for both enrichment calls.
    expect(mockCanConsumeAI).toHaveBeenCalledTimes(1);
    expect(mockCanConsumeAI.mock.calls[0][2].estCostCents).toBeGreaterThan(0);
    expect(mockGenerateText).toHaveBeenCalledTimes(2);
    expect(mockTrackUsage).toHaveBeenCalledTimes(2);
    expect(mockReleaseHold).toHaveBeenCalledTimes(1);
    expect(mockReleaseHold).toHaveBeenCalledWith('hold-1');
    expect(createdContent()).toContain('Decided to ship Friday');
    expect(createdContent()).toContain('Ship it');
    expect(createdMetadata()).not.toHaveProperty('aiEnrichmentSkipped');
  });

  it('given a model call that throws, should still release the hold exactly once', async () => {
    mockCanConsumeAI.mockResolvedValue({ allowed: true, reason: 'ok', holdId: 'hold-2' });
    mockGenerateText.mockRejectedValue(new Error('provider down'));

    await processZoomWebhook(event, connection);

    expect(mockReleaseHold).toHaveBeenCalledTimes(1);
    expect(mockReleaseHold).toHaveBeenCalledWith('hold-2');
    expect(mockCreatePage).toHaveBeenCalledTimes(1);
  });

  it('given the credit gate itself throws, should still create the page without enrichment or charge', async () => {
    mockCanConsumeAI.mockRejectedValue(new Error('lock timeout'));

    await expect(processZoomWebhook(event, connection)).resolves.toBeUndefined();

    expect(mockCreateAIProvider).not.toHaveBeenCalled();
    expect(mockGenerateText).not.toHaveBeenCalled();
    expect(mockTrackUsage).not.toHaveBeenCalled();
    expect(mockReleaseHold).not.toHaveBeenCalled();
    expect(mockCreatePage).toHaveBeenCalledTimes(1);
    expect(createdContent()).not.toContain('Decided to ship Friday');
    expect(createdMetadata()).toMatchObject({ aiEnrichmentSkipped: 'gate_error' });
  });

  it('given the tier lookup throws, should still create the page without enrichment', async () => {
    mockSelectWhere.mockRejectedValue(new Error('db down'));

    await expect(processZoomWebhook(event, connection)).resolves.toBeUndefined();

    expect(mockCanConsumeAI).not.toHaveBeenCalled();
    expect(mockGenerateText).not.toHaveBeenCalled();
    expect(mockTrackUsage).not.toHaveBeenCalled();
    expect(mockCreatePage).toHaveBeenCalledTimes(1);
    expect(createdMetadata()).toMatchObject({ aiEnrichmentSkipped: 'gate_error' });
  });

  it('SPEND-6 given wallets are live and the gate reserved no drive wallet, should skip the enrichment rather than bill the owner', async () => {
    walletsLive.orgs = true;
    mockCanConsumeAI.mockResolvedValue({ allowed: true, reason: 'ok', holdId: 'hold-3' });

    await processZoomWebhook(event, connection);

    expect(mockCreateAIProvider).not.toHaveBeenCalled();
    expect(mockGenerateText).not.toHaveBeenCalled();
    expect(mockTrackUsage).not.toHaveBeenCalled();
    expect(mockReleaseHold).toHaveBeenCalledTimes(1);
    expect(mockReleaseHold).toHaveBeenCalledWith('hold-3');
    expect(mockCreatePage).toHaveBeenCalledTimes(1);
    expect(createdMetadata()).toMatchObject({ aiEnrichmentSkipped: 'no_drive_wallet' });
  });

  it('SPEND-6 given wallets are live and a drive wallet reserved, should enrich on that wallet', async () => {
    walletsLive.orgs = true;
    mockCanConsumeAI.mockResolvedValue({ allowed: true, reason: 'ok', holdId: 'hold-4', walletId: 'w-drive-1' });

    await processZoomWebhook(event, connection);

    expect(mockGenerateText).toHaveBeenCalledTimes(2);
    expect(mockTrackUsage.mock.calls.map(([usage]) => usage.walletId)).toEqual(['w-drive-1', 'w-drive-1']);
    expect(createdMetadata()).not.toHaveProperty('aiEnrichmentSkipped');
  });

  it('given no AI enrichment is enabled, should not gate or reserve anything', async () => {
    await processZoomWebhook(event, { ...connection, includeAiSummary: false, includeActionItems: false });

    expect(mockCanConsumeAI).not.toHaveBeenCalled();
    expect(mockGenerateText).not.toHaveBeenCalled();
    expect(mockCreatePage).toHaveBeenCalledTimes(1);
  });
});
