/**
 * The box kind → SUBSTRATE mapping, and the only place it is written down.
 *
 * A drive box runs on one of two very different things: dev and staging boxes
 * are Sprites (the session tooling already speaks Sprite end to end, and
 * hibernation is what makes "persistent" cheap), while a deploy box is a raw
 * Fly Machine reached through the app-hosting provisioner.
 *
 * `drive_boxes` deliberately stores NO substrate column. A stored copy would
 * be a second witness to a fact `kind` already states, free to disagree with
 * it after any partial write — and disagreement here is not cosmetic: it
 * decides which provisioner runs, which teardown path fires, and which reclaim
 * outbox a dying pointer lands in. So the mapping is derived, and it is
 * derived HERE, once, by a pure total function over a closed enum.
 *
 * The database enforces the same partition from the other side:
 * `drive_boxes_sprite_kind_check` forbids Sprite pointer columns on a
 * `kind='deploy'` row, so a caller that ignored this function and provisioned
 * a Sprite for a deploy box could not persist the result.
 */

/**
 * The three box kinds, mirroring the `drive_box_kind` Postgres enum.
 *
 * Written out rather than derived from `driveBoxKind.enumValues` so this
 * module stays free of a `@pagespace/db` import and remains pure. That makes
 * it a SECOND witness to the same fact, which is only safe because something
 * fails when the two disagree: `box-kind.test.ts` assigns the pgEnum's values
 * into `DriveBoxKind[]` (so widening the enum without widening this union is a
 * TYPE error, caught by `bun run typecheck`) and maps
 * `substrateForBoxKind` over every one of them (so a kind added to the enum
 * with no substrate decision THROWS there rather than in production).
 */
export type DriveBoxKind = 'dev' | 'staging' | 'deploy';

/** What a box of a given kind actually runs on. */
export type DriveBoxSubstrate = 'sprite' | 'fly';

/**
 * Resolve a box's substrate from its kind.
 *
 * Written as an exhaustive switch rather than a lookup object on purpose: a
 * fourth member added to `DriveBoxKind` fails to compile here (the `never` in
 * the default branch), which forces the substrate decision to be made at the
 * same time as the kind rather than defaulting silently to whichever branch an
 * object literal's fallback happened to pick.
 *
 * Note what that does and does not buy. It binds this function to the UNION;
 * the union is bound to the Postgres enum by the tests, not by the compiler
 * (see `DriveBoxKind`). So a kind added to the pgEnum alone is caught by
 * `bun run typecheck` and by this suite — not by this switch, which never sees
 * it.
 */
export function substrateForBoxKind(kind: DriveBoxKind): DriveBoxSubstrate {
  switch (kind) {
    case 'dev':
    case 'staging':
      return 'sprite';
    case 'deploy':
      return 'fly';
    default: {
      const unreachable: never = kind;
      throw new Error(`Unknown drive box kind: ${String(unreachable)}`);
    }
  }
}
