import { beforeEach, describe, expect, it, vi, afterEach } from 'vitest';

// Mock pg-boss
const mockBossStart = vi.fn().mockResolvedValue(undefined);
const mockBossStop = vi.fn().mockResolvedValue(undefined);
const mockBossWork = vi.fn().mockResolvedValue(undefined);
const mockBossCreateQueue = vi.fn().mockResolvedValue(undefined);
const mockBossSend = vi.fn().mockResolvedValue('job-id-123');
const mockBossGetJobById = vi.fn();
const mockBossOn = vi.fn();

const mockBossInstance = {
  start: mockBossStart,
  stop: mockBossStop,
  work: mockBossWork,
  createQueue: mockBossCreateQueue,
  send: mockBossSend,
  getJobById: mockBossGetJobById,
  on: mockBossOn,
};

vi.mock('pg-boss', () => ({
  default: vi.fn().mockImplementation(() => mockBossInstance),
}));

// Mock db functions
vi.mock('../../db', () => ({
  setPageProcessing: vi.fn().mockResolvedValue(undefined),
  setPageCompleted: vi.fn().mockResolvedValue(undefined),
  setPageFailed: vi.fn().mockResolvedValue(undefined),
  setPageVisual: vi.fn().mockResolvedValue(undefined),
}));

// Mock workers
vi.mock('../text-extractor', () => ({
  needsTextExtraction: vi.fn().mockReturnValue(false),
  extractText: vi.fn().mockResolvedValue({ success: true, text: 'extracted', textLength: 9 }),
}));

vi.mock('../image-processor', () => ({
  processImage: vi.fn().mockResolvedValue({ success: true, cached: false, url: '/cache/hash/preset' }),
}));

vi.mock('../ocr-processor', () => ({
  processOCR: vi.fn().mockResolvedValue({ success: true, cached: false, text: 'ocr text', provider: 'tesseract' }),
}));

import { QueueManager, mapJobState } from '../queue-manager';
import { setPageProcessing, setPageCompleted, setPageFailed, setPageVisual } from '../../db';
import { needsTextExtraction, extractText } from '../text-extractor';
import { processImage } from '../image-processor';
import { processOCR } from '../ocr-processor';

const VALID_HASH = 'a'.repeat(64);

describe('QueueManager', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv, DATABASE_URL: 'postgresql://localhost/test' };
    vi.clearAllMocks();
    mockBossStart.mockResolvedValue(undefined);
    mockBossStop.mockResolvedValue(undefined);
    mockBossWork.mockResolvedValue(undefined);
    mockBossCreateQueue.mockResolvedValue(undefined);
    mockBossSend.mockResolvedValue('job-id-123');
    mockBossOn.mockReturnValue(undefined);
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('constructor', () => {
    it('throws when DATABASE_URL is not set', () => {
      delete process.env.DATABASE_URL;
      expect(() => new QueueManager()).toThrow('DATABASE_URL environment variable is required for QueueManager');
    });

    it('creates instance when DATABASE_URL is set', () => {
      process.env.DATABASE_URL = 'postgresql://localhost/test';
      expect(() => new QueueManager()).not.toThrow();
    });
  });

  describe('initialize', () => {
    it('starts pg-boss and sets up workers', async () => {
      const qm = new QueueManager();
      await qm.initialize();

      expect(mockBossStart).toHaveBeenCalled();
      expect(mockBossWork).toHaveBeenCalled();
      expect(mockBossCreateQueue).toHaveBeenCalled();
    });

    it('handles queue creation errors gracefully', async () => {
      mockBossCreateQueue.mockRejectedValue(new Error('Queue already exists'));

      const qm = new QueueManager();
      await expect(qm.initialize()).resolves.not.toThrow();
    });

    it('registers monitor-states event handler', async () => {
      const qm = new QueueManager();
      await qm.initialize();

      expect(mockBossOn).toHaveBeenCalledWith('monitor-states', expect.any(Function));
    });

    it('updates cachedStates when monitor-states fires', async () => {
      let monitorHandler: (states: unknown) => void = () => {};
      mockBossOn.mockImplementation((event: string, handler: (states: unknown) => void) => {
        if (event === 'monitor-states') monitorHandler = handler;
      });

      const qm = new QueueManager();
      await qm.initialize();

      const mockStates = { queues: { 'ingest-file': { created: 1, retry: 0, active: 0, completed: 5, cancelled: 0, failed: 0 } } };
      monitorHandler(mockStates);

      const status = qm.getQueueStatus();
      expect(status['ingest-file'].pending).toBe(1);
      expect(status['ingest-file'].completed).toBe(5);
    });
  });

  describe('addJob', () => {
    it('adds job to queue and returns jobId', async () => {
      const qm = new QueueManager();
      await qm.initialize();

      const jobId = await qm.addJob('ingest-file', {
        contentHash: VALID_HASH,
        fileId: 'page-1',
        mimeType: 'application/pdf',
        originalName: 'test.pdf',
      });

      expect(jobId).toBe('job-id-123');
      expect(mockBossSend).toHaveBeenCalledWith(
        'ingest-file',
        expect.objectContaining({ contentHash: VALID_HASH }),
        expect.objectContaining({ retryLimit: 3, retryDelay: 5 })
      );
    });

    it('throws when boss not initialized', async () => {
      const qm = new QueueManager();
      await expect(qm.addJob('ingest-file', {
        contentHash: VALID_HASH,
        mimeType: 'application/pdf',
        originalName: 'test.pdf',
      })).rejects.toThrow('Queue manager not initialized');
    });

    it('throws when boss.send returns null (duplicate/rejected)', async () => {
      mockBossSend.mockResolvedValue(null);
      const qm = new QueueManager();
      await qm.initialize();

      await expect(qm.addJob('ingest-file', {
        contentHash: VALID_HASH,
        mimeType: 'application/pdf',
        originalName: 'test.pdf',
      })).rejects.toThrow('Failed to queue job on ingest-file');
    });

    it('sets higher priority for image-optimize queue', async () => {
      const qm = new QueueManager();
      await qm.initialize();

      await qm.addJob('image-optimize', { contentHash: VALID_HASH, preset: 'ai-chat' });

      expect(mockBossSend).toHaveBeenCalledWith(
        'image-optimize',
        expect.any(Object),
        expect.objectContaining({ priority: 100 })
      );
    });

    it('sets medium priority for text-extract queue', async () => {
      const qm = new QueueManager();
      await qm.initialize();

      await qm.addJob('text-extract', {
        contentHash: VALID_HASH,
        fileId: 'page-1',
        mimeType: 'text/plain',
        originalName: 'test.txt',
      });

      expect(mockBossSend).toHaveBeenCalledWith(
        'text-extract',
        expect.any(Object),
        expect.objectContaining({ priority: 50 })
      );
    });

    it('sets ingest-file priority correctly', async () => {
      const qm = new QueueManager();
      await qm.initialize();

      await qm.addJob('ingest-file', {
        contentHash: VALID_HASH,
        mimeType: 'application/pdf',
        originalName: 'test.pdf',
      });

      expect(mockBossSend).toHaveBeenCalledWith(
        'ingest-file',
        expect.any(Object),
        expect.objectContaining({ priority: 60 })
      );
    });

    it('sets low priority for ocr-process queue', async () => {
      const qm = new QueueManager();
      await qm.initialize();

      await qm.addJob('ocr-process', { contentHash: VALID_HASH, fileId: 'page-1' });

      expect(mockBossSend).toHaveBeenCalledWith(
        'ocr-process',
        expect.any(Object),
        expect.objectContaining({ priority: 10 })
      );
    });
  });

  describe('getJob', () => {
    it('throws when boss not initialized', async () => {
      const qm = new QueueManager();
      await expect(qm.getJob('job-1')).rejects.toThrow('Queue manager not initialized');
    });

    it('returns null when job not found', async () => {
      mockBossGetJobById.mockResolvedValue(null);
      const qm = new QueueManager();
      await qm.initialize();

      const result = await qm.getJob('nonexistent');
      expect(result).toBeNull();
    });

    it('returns ProcessingJob when job found', async () => {
      const mockJob = {
        id: 'job-1',
        name: 'ingest-file',
        state: 'active',
        data: { contentHash: VALID_HASH, fileId: 'page-1' },
        output: null,
        createdOn: new Date('2024-01-01'),
        completedOn: null,
      };
      mockBossGetJobById.mockResolvedValue(mockJob);

      const qm = new QueueManager();
      await qm.initialize();

      const result = await qm.getJob('job-1');
      expect(result).not.toBeNull();
      expect(result?.id).toBe('job-1');
      expect(result?.type).toBe('ingest-file');
      expect(result?.status).toBe('processing');
      expect(result?.contentHash).toBe(VALID_HASH);
    });

    it('extracts error from output when present', async () => {
      const mockJob = {
        id: 'job-1',
        name: 'ingest-file',
        state: 'failed',
        data: { contentHash: VALID_HASH, fileId: 'page-1' },
        output: { error: 'Processing failed' },
        createdOn: new Date('2024-01-01'),
        completedOn: new Date('2024-01-01'),
      };
      mockBossGetJobById.mockResolvedValue(mockJob);

      const qm = new QueueManager();
      await qm.initialize();

      const result = await qm.getJob('job-1');
      expect(result?.error).toBe('Processing failed');
      expect(result?.status).toBe('failed');
    });
  });

  describe('getQueueStatus', () => {
    it('returns empty stats when no cached states', async () => {
      const qm = new QueueManager();
      await qm.initialize();

      const status = qm.getQueueStatus();
      expect(status['ingest-file']).toEqual({ active: 0, pending: 0, completed: 0, failed: 0 });
      expect(status['image-optimize']).toEqual({ active: 0, pending: 0, completed: 0, failed: 0 });
      expect(status['text-extract']).toEqual({ active: 0, pending: 0, completed: 0, failed: 0 });
      expect(status['ocr-process']).toEqual({ active: 0, pending: 0, completed: 0, failed: 0 });
    });

    it('maps queue states correctly', async () => {
      let monitorHandler: (states: unknown) => void = () => {};
      mockBossOn.mockImplementation((event: string, handler: (states: unknown) => void) => {
        if (event === 'monitor-states') monitorHandler = handler;
      });

      const qm = new QueueManager();
      await qm.initialize();

      monitorHandler({
        queues: {
          'ingest-file': { created: 2, retry: 1, active: 3, completed: 10, cancelled: 1, failed: 2 },
        },
      });

      const status = qm.getQueueStatus();
      expect(status['ingest-file'].pending).toBe(3); // created + retry
      expect(status['ingest-file'].active).toBe(3);
      expect(status['ingest-file'].completed).toBe(10);
      expect(status['ingest-file'].failed).toBe(3); // cancelled + failed
    });
  });

  describe('shutdown', () => {
    it('stops pg-boss and sets it to null', async () => {
      const qm = new QueueManager();
      await qm.initialize();
      await qm.shutdown();

      expect(mockBossStop).toHaveBeenCalled();
    });

    it('is safe to call when not initialized', async () => {
      const qm = new QueueManager();
      await expect(qm.shutdown()).resolves.not.toThrow();
    });
  });

  describe('ingest-file worker', () => {
    let ingestWorker: (jobs: unknown[]) => Promise<unknown>;

    beforeEach(async () => {
      mockBossWork.mockImplementation((queueName: string, handler: (jobs: unknown[]) => Promise<unknown>) => {
        if (queueName === 'ingest-file') {
          ingestWorker = handler;
        }
        return Promise.resolve(undefined);
      });
    });

    it('processes image MIME types', async () => {
      const qm = new QueueManager();
      await qm.initialize();

      const job = {
        id: 'job-1',
        data: { contentHash: VALID_HASH, fileId: 'page-1', mimeType: 'image/jpeg', originalName: 'photo.jpg' },
      };

      const result = await ingestWorker([job]);
      expect(setPageProcessing).toHaveBeenCalledWith('page-1');
      expect(setPageVisual).toHaveBeenCalledWith('page-1');
      expect(result).toEqual({ success: true, status: 'visual' });
    });

    it('queues OCR for images when ENABLE_OCR=true', async () => {
      process.env.ENABLE_OCR = 'true';
      const qm = new QueueManager();
      await qm.initialize();

      const job = {
        id: 'job-1',
        data: { contentHash: VALID_HASH, fileId: 'page-1', mimeType: 'image/jpeg', originalName: 'photo.jpg' },
      };

      await ingestWorker([job]);
      expect(mockBossSend).toHaveBeenCalledWith('ocr-process', expect.any(Object), expect.any(Object));

      delete process.env.ENABLE_OCR;
    });

    it('processes documents with text extraction', async () => {
      (needsTextExtraction as ReturnType<typeof vi.fn>).mockReturnValue(true);
      (extractText as ReturnType<typeof vi.fn>).mockResolvedValue({
        success: true,
        text: 'Extracted document text',
        textLength: 22,
        metadata: { title: 'Doc' },
      });

      const qm = new QueueManager();
      await qm.initialize();

      const job = {
        id: 'job-1',
        data: { contentHash: VALID_HASH, fileId: 'page-1', mimeType: 'application/pdf', originalName: 'doc.pdf' },
      };

      const result = await ingestWorker([job]);
      expect(setPageCompleted).toHaveBeenCalled();
      expect(result).toEqual({ success: true, status: 'completed', textLength: 22 });
    });

    it('handles document with no text (scanned PDF)', async () => {
      (needsTextExtraction as ReturnType<typeof vi.fn>).mockReturnValue(true);
      (extractText as ReturnType<typeof vi.fn>).mockResolvedValue({
        success: true,
        text: '   ',
        textLength: 3,
      });

      const qm = new QueueManager();
      await qm.initialize();

      const job = {
        id: 'job-1',
        data: { contentHash: VALID_HASH, fileId: 'page-1', mimeType: 'application/pdf', originalName: 'scan.pdf' },
      };

      const result = await ingestWorker([job]);
      expect(setPageVisual).toHaveBeenCalled();
      expect(result).toEqual({ success: true, status: 'visual' });
    });

    it('queues OCR for scanned PDFs when ENABLE_OCR=true', async () => {
      process.env.ENABLE_OCR = 'true';
      (needsTextExtraction as ReturnType<typeof vi.fn>).mockReturnValue(true);
      (extractText as ReturnType<typeof vi.fn>).mockResolvedValue({ success: true, text: '', textLength: 0 });

      const qm = new QueueManager();
      await qm.initialize();

      const job = {
        id: 'job-1',
        data: { contentHash: VALID_HASH, fileId: 'page-1', mimeType: 'application/pdf', originalName: 'scan.pdf' },
      };

      await ingestWorker([job]);
      expect(mockBossSend).toHaveBeenCalledWith('ocr-process', expect.any(Object), expect.any(Object));

      delete process.env.ENABLE_OCR;
    });

    it('handles unsupported file types with visual fallback', async () => {
      (needsTextExtraction as ReturnType<typeof vi.fn>).mockReturnValue(false);

      const qm = new QueueManager();
      await qm.initialize();

      const job = {
        id: 'job-1',
        data: { contentHash: VALID_HASH, fileId: 'page-1', mimeType: 'application/zip', originalName: 'archive.zip' },
      };

      const result = await ingestWorker([job]);
      expect(setPageVisual).toHaveBeenCalled();
      expect(result).toEqual({ success: true, status: 'visual' });
    });

    it('throws and calls setPageFailed on error', async () => {
      (setPageProcessing as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('DB error'));

      const qm = new QueueManager();
      await qm.initialize();

      const job = {
        id: 'job-1',
        data: { contentHash: VALID_HASH, fileId: 'page-1', mimeType: 'image/jpeg', originalName: 'photo.jpg' },
      };

      await expect(ingestWorker([job])).rejects.toThrow('DB error');
      expect(setPageFailed).toHaveBeenCalledWith('page-1', 'DB error');
    });

    it('throws for missing fileId or contentHash', async () => {
      const qm = new QueueManager();
      await qm.initialize();

      const job = {
        id: 'job-1',
        data: { contentHash: null, fileId: null, mimeType: 'image/jpeg', originalName: 'photo.jpg' },
      };

      await expect(ingestWorker([job])).rejects.toThrow('Invalid ingest-file job');
    });
  });

  describe('image-optimize worker', () => {
    let imageWorker: (jobs: unknown[]) => Promise<unknown>;

    beforeEach(async () => {
      mockBossWork.mockImplementation((queueName: string, handler: (jobs: unknown[]) => Promise<unknown>) => {
        if (queueName === 'image-optimize') {
          imageWorker = handler;
        }
        return Promise.resolve(undefined);
      });
    });

    it('calls processImage with job data', async () => {
      const qm = new QueueManager();
      await qm.initialize();

      const job = {
        id: 'job-1',
        data: { contentHash: VALID_HASH, preset: 'ai-chat', fileId: 'page-1' },
      };

      const result = await imageWorker([job]);
      expect(processImage).toHaveBeenCalledWith(job.data);
      expect(result).toEqual({ success: true, cached: false, url: '/cache/hash/preset' });
    });
  });

  describe('text-extract worker', () => {
    let textWorker: (jobs: unknown[]) => Promise<unknown>;

    beforeEach(async () => {
      mockBossWork.mockImplementation((queueName: string, handler: (jobs: unknown[]) => Promise<unknown>) => {
        if (queueName === 'text-extract') {
          textWorker = handler;
        }
        return Promise.resolve(undefined);
      });
    });

    it('calls extractText with job data', async () => {
      const qm = new QueueManager();
      await qm.initialize();

      const job = {
        id: 'job-1',
        data: { contentHash: VALID_HASH, fileId: 'page-1', mimeType: 'application/pdf', originalName: 'test.pdf' },
      };

      await textWorker([job]);
      expect(extractText).toHaveBeenCalledWith(job.data);
    });
  });

  describe('ocr-process worker', () => {
    let ocrWorker: (jobs: unknown[]) => Promise<unknown>;

    beforeEach(async () => {
      mockBossWork.mockImplementation((queueName: string, handler: (jobs: unknown[]) => Promise<unknown>) => {
        if (queueName === 'ocr-process') {
          ocrWorker = handler;
        }
        return Promise.resolve(undefined);
      });
    });

    it('calls processOCR with job data', async () => {
      const qm = new QueueManager();
      await qm.initialize();

      const job = {
        id: 'job-1',
        data: { contentHash: VALID_HASH, fileId: 'page-1' },
      };

      await ocrWorker([job]);
      expect(processOCR).toHaveBeenCalledWith(job.data);
    });
  });
});
