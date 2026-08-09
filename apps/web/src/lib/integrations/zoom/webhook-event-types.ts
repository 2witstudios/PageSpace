/**
 * Zoom event types that may be wired to a workflow trigger. Server-side
 * allow-list — POST /api/integrations/zoom/triggers rejects anything else.
 */
export const ZOOM_TRIGGER_EVENT_TYPES = [
  'meeting.ended',
  'recording.transcript_completed',
  'recording.completed',
] as const;
