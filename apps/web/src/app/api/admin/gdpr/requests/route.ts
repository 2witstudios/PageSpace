import { withAdminAuth } from '@/lib/auth';
import { dataSubjectRequestRepository } from '@pagespace/lib/repositories/data-subject-request-repository';
import { computeSlaStatus, summarizeSlaCompliance } from '@pagespace/lib/compliance/dsr/sla';

/**
 * Admin visibility into Data Subject Requests + SLA standing (#919).
 *
 * Evidences Art 12(3) compliance: every request with its computed SLA status
 * (met / on_track / due_soon / overdue / breached) so overdue erasures surface
 * for action. SLA math comes from the pure `compliance/dsr/sla` module.
 */
export const GET = withAdminAuth(async () => {
  const requests = await dataSubjectRequestRepository.listRecent(500);
  const now = new Date();

  const items = requests.map((r) => ({
    id: r.id,
    userId: r.userId,
    subjectEmail: r.subjectEmail,
    requestType: r.requestType,
    status: r.status,
    forceDelete: r.forceDelete,
    requestedByType: r.requestedByType,
    receivedAt: r.receivedAt,
    slaDeadline: r.slaDeadline,
    completedAt: r.completedAt,
    blockedReason: r.blockedReason,
    attempts: r.attempts,
    lastError: r.lastError,
    slaStatus: computeSlaStatus(
      { status: r.status, slaDeadline: r.slaDeadline, completedAt: r.completedAt },
      now
    ),
  }));

  const summary = summarizeSlaCompliance(
    requests.map((r) => ({ status: r.status, slaDeadline: r.slaDeadline, completedAt: r.completedAt })),
    now
  );

  return Response.json({ summary, requests: items });
});
