/**
 * Which drive's commands a composer should offer (Universal Commands).
 *
 * The picker and the server must agree on this, or the picker hands the user
 * commands that come back `not_found` the moment the message is sent: a chip
 * is resolved against the drive the TURN resolves, never the drive the
 * composer happened to be scoped to.
 *
 * For a dual-mode surface (an agent selector over an otherwise
 * location-scoped assistant) those are two different drives:
 *
 * - agent mode  — `page-chat-turn` resolves chips with the AGENT PAGE's own
 *   `page.driveId`. An agent reached from another drive (via
 *   `drive_agent_members`) keeps its own drive; where the user is standing is
 *   irrelevant.
 * - assistant mode — `global-chat-turn` resolves them with the location
 *   context's drive, i.e. the route the user is on.
 *
 * Pure, and deliberately shared: the two surfaces that make this choice had
 * drifted apart, which is the whole reason drive commands went missing.
 */
export function commandDriveIdFor(
  selectedAgent: { driveId: string } | null | undefined,
  locationDriveId: string | null | undefined
): string | undefined {
  return selectedAgent?.driveId ?? locationDriveId ?? undefined;
}
