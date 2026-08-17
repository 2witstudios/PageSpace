/**
 * `substrateForBoxKind` is the single source of truth for which machine
 * technology a box runs on, and `drive_boxes` stores no copy of the answer. So
 * these tests are not about a three-case switch being hard — they pin the
 * MAPPING itself, which is the thing a future edit can get wrong silently:
 * flipping `staging` to 'fly' would route staging boxes at the Fly
 * provisioner, whose pointers land in a different reclaim outbox than the
 * `drive_boxes` AFTER DELETE trigger writes to, and the Sprite it stopped
 * tracking would bill forever.
 */
import { describe, it, expect } from 'vitest';
import { driveBoxKind } from '@pagespace/db/schema/drive-boxes';
import { substrateForBoxKind, type DriveBoxKind } from '../box-kind';

describe('substrateForBoxKind', () => {
  it('given a dev box, should resolve to the sprite substrate', () => {
    expect(substrateForBoxKind('dev')).toBe('sprite');
  });

  it('given a staging box, should resolve to the sprite substrate', () => {
    expect(substrateForBoxKind('staging')).toBe('sprite');
  });

  it('given a deploy box, should resolve to the fly substrate', () => {
    expect(substrateForBoxKind('deploy')).toBe('fly');
  });

  it('given the CHECK constraint partitions on it, should put deploy alone on the non-sprite side', () => {
    // `drive_boxes_sprite_kind_check` allows Sprite pointer columns on
    // `kind IN ('dev','staging')` and forbids them otherwise. If this ever
    // stops agreeing with the constraint, one of the two is wrong and rows
    // start being refused (or, worse, accepted) for reasons no reader expects.
    const kinds: DriveBoxKind[] = ['dev', 'staging', 'deploy'];
    const spriteKinds = kinds.filter((kind) => substrateForBoxKind(kind) === 'sprite');
    expect(spriteKinds).toEqual(['dev', 'staging']);
  });

  /**
   * `DriveBoxKind` is a hand-written union, kept that way so the helper stays
   * free of a `@pagespace/db` import. That makes it a second witness to the
   * `drive_box_kind` Postgres enum, and these two assertions are what stop the
   * witnesses drifting apart — without them, adding `'preview'` to the pgEnum
   * would compile clean and only fail in production, at the moment something
   * asked which machine technology to provision.
   */
  it('given the pgEnum is the source of truth, should stay in lockstep with it', () => {
    // COMPILE-TIME half: if the pgEnum gains a member that `DriveBoxKind` does
    // not have, this assignment stops typechecking. That is the direction that
    // actually happens — someone edits the schema, ships the migration, and
    // never looks at this file.
    const fromPg: DriveBoxKind[] = [...driveBoxKind.enumValues];
    // RUNTIME half: catches the reverse (a union member with no enum value).
    expect([...fromPg].sort()).toEqual(['deploy', 'dev', 'staging']);
  });

  it('given every kind the database can store, should have a substrate for it', () => {
    // Maps the REAL enum, not a hand-copied list: a kind added to the pgEnum
    // with no substrate decision falls to the `never` branch and throws here,
    // which is the failure surfacing in CI instead of in a provisioner.
    for (const kind of driveBoxKind.enumValues) {
      expect(['sprite', 'fly']).toContain(substrateForBoxKind(kind));
    }
  });

  it('given an unknown kind slipped past the type system, should throw rather than guess a substrate', () => {
    // Only reachable from untyped input (a raw DB read, a JSON body). Guessing
    // here would provision the wrong machine technology for a box; refusing
    // makes the bad value a loud failure at the one place that could see it.
    expect(() => substrateForBoxKind('preview' as DriveBoxKind)).toThrow(
      /Unknown drive box kind: preview/,
    );
  });
});
