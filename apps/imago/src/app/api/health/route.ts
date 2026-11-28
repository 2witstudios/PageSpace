// Liveness only: imago holds no state of its own, so "the server answers" is
// the whole check. Readiness of web, realtime and the database is theirs to report.
export function GET(): Response {
  return Response.json(
    { status: 'ok' },
    { status: 200, headers: { 'Cache-Control': 'no-store' } },
  );
}
