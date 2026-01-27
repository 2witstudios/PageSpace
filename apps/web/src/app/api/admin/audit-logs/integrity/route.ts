import { loggers } from '@pagespace/lib/server';
import {
  verifyHashChain,
  quickIntegrityCheck,
  getHashChainStats,
  verifyEntry,
} from '@pagespace/lib/monitoring/hash-chain-verifier';
import { isValidId } from '@pagespace/lib/validators';
import { verifyAdminAuth } from '@/lib/auth';

/**
 * Hash Chain Integrity Check API Endpoint
 *
 * Provides integrity verification for the audit log hash chain.
 * Supports multiple verification modes:
 * - full: Complete chain verification (slowest, most thorough)
 * - quick: Fast structural check (faster, less thorough)
 * - stats: Hash chain statistics only (fastest)
 * - entry: Verify a specific entry by ID
 *
 * GET /api/admin/audit-logs/integrity
 *
 * Query Parameters:
 * - mode: 'full' | 'quick' | 'stats' | 'entry' (default: 'quick')
 * - entryId: Entry ID to verify (required for mode=entry)
 * - limit: Max entries to verify for full mode (optional)
 * - dateFrom: Start date for full verification (optional, ISO 8601)
 * - dateTo: End date for full verification (optional, ISO 8601)
 * - stopOnFirstBreak: Stop at first break point (default: true)
 * - batchSize: Batch size for full verification (default: 1000)
 */
export async function GET(request: Request) {
  try {
    // Verify user is authenticated and is an admin
    const adminUser = await verifyAdminAuth(request);

    if (!adminUser) {
      return Response.json(
        { error: 'Unauthorized: Admin access required' },
        { status: 403 }
      );
    }

    // Parse query parameters
    const url = new URL(request.url);
    const mode = url.searchParams.get('mode') || 'quick';
    const entryId = url.searchParams.get('entryId');
    const limit = url.searchParams.get('limit');
    const dateFrom = url.searchParams.get('dateFrom');
    const dateTo = url.searchParams.get('dateTo');
    const stopOnFirstBreak = url.searchParams.get('stopOnFirstBreak') !== 'false';
    const batchSize = parseInt(url.searchParams.get('batchSize') || '1000', 10);

    switch (mode) {
      case 'full': {
        // Full chain verification
        const options: {
          limit?: number;
          fromTimestamp?: Date;
          toTimestamp?: Date;
          stopOnFirstBreak: boolean;
          batchSize: number;
        } = {
          stopOnFirstBreak,
          batchSize: Math.min(5000, Math.max(100, batchSize)),
        };

        if (limit) {
          const parsedLimit = parseInt(limit, 10);
          if (!isNaN(parsedLimit) && parsedLimit > 0) {
            options.limit = parsedLimit;
          }
        }

        if (dateFrom) {
          const fromDate = new Date(dateFrom);
          if (!isNaN(fromDate.getTime())) {
            options.fromTimestamp = fromDate;
          }
        }

        if (dateTo) {
          const toDate = new Date(dateTo);
          if (!isNaN(toDate.getTime())) {
            // Include entire day
            toDate.setHours(23, 59, 59, 999);
            options.toTimestamp = toDate;
          }
        }

        const result = await verifyHashChain(options);

        return Response.json({
          mode: 'full',
          result: {
            isValid: result.isValid,
            totalEntries: result.totalEntries,
            entriesVerified: result.entriesVerified,
            validEntries: result.validEntries,
            invalidEntries: result.invalidEntries,
            entriesWithoutHash: result.entriesWithoutHash,
            chainSeed: result.chainSeed ? `${result.chainSeed.substring(0, 16)}...` : null,
            firstEntryId: result.firstEntryId,
            lastEntryId: result.lastEntryId,
            durationMs: result.durationMs,
            breakPoint: result.breakPoint
              ? {
                  entryId: result.breakPoint.entryId,
                  timestamp: result.breakPoint.timestamp.toISOString(),
                  position: result.breakPoint.position,
                  description: result.breakPoint.description,
                }
              : null,
          },
          verifiedAt: new Date().toISOString(),
        });
      }

      case 'quick': {
        // Quick structural check
        const result = await quickIntegrityCheck();

        return Response.json({
          mode: 'quick',
          result: {
            isLikelyValid: result.isLikelyValid,
            hasChainSeed: result.hasChainSeed,
            lastEntriesValid: result.lastEntriesValid,
            sampleValid: result.sampleValid,
            details: result.details,
          },
          verifiedAt: new Date().toISOString(),
        });
      }

      case 'stats': {
        // Hash chain statistics
        const stats = await getHashChainStats();

        return Response.json({
          mode: 'stats',
          result: {
            totalEntries: stats.totalEntries,
            entriesWithHash: stats.entriesWithHash,
            entriesWithoutHash: stats.entriesWithoutHash,
            hashCoverage:
              stats.totalEntries > 0
                ? Math.round((stats.entriesWithHash / stats.totalEntries) * 100 * 100) / 100
                : 0,
            hasChainSeed: stats.hasChainSeed,
            firstEntryTimestamp: stats.firstEntryTimestamp?.toISOString() || null,
            lastEntryTimestamp: stats.lastEntryTimestamp?.toISOString() || null,
          },
          verifiedAt: new Date().toISOString(),
        });
      }

      case 'entry': {
        // Verify specific entry - validate entryId format before passing to query
        if (!entryId) {
          return Response.json(
            { error: 'entryId parameter is required for mode=entry' },
            { status: 400 }
          );
        }

        // Validate entryId format (CUID2)
        if (!isValidId(entryId)) {
          return Response.json(
            { error: 'Invalid entryId format' },
            { status: 400 }
          );
        }

        const result = await verifyEntry(entryId);

        if (!result) {
          return Response.json(
            { error: 'Entry not found' },
            { status: 404 }
          );
        }

        return Response.json({
          mode: 'entry',
          result: {
            id: result.id,
            timestamp: result.timestamp.toISOString(),
            isValid: result.isValid,
            storedHash: result.storedHash ? `${result.storedHash.substring(0, 16)}...` : null,
            computedHash: `${result.computedHash.substring(0, 16)}...`,
            previousHashUsed: result.previousHashUsed
              ? `${result.previousHashUsed.substring(0, 16)}...`
              : '(none)',
          },
          verifiedAt: new Date().toISOString(),
        });
      }

      default:
        return Response.json(
          {
            error: `Invalid mode: ${mode}. Valid modes are: full, quick, stats, entry`,
          },
          { status: 400 }
        );
    }
  } catch (error) {
    loggers.api.error('Error checking hash chain integrity:', error as Error);
    return Response.json(
      { error: 'Failed to check hash chain integrity' },
      { status: 500 }
    );
  }
}
