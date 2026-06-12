import { describe, it, expect } from 'vitest';
import {
  HOME_DRIVE_NAME,
  RESERVED_DRIVE_NAMES,
  isReservedDriveName,
  isHomeDrive,
  homeDriveActionError,
  resolveUniqueSlug,
  type HomeDriveAction,
} from '../drive-guards';

describe('drive-guards constants', () => {
  it('exposes the canonical Home drive name', () => {
    expect(HOME_DRIVE_NAME).toBe('Home');
  });

  it('reserves both personal and home', () => {
    expect(RESERVED_DRIVE_NAMES).toEqual(['personal', 'home']);
  });
});

describe('isReservedDriveName', () => {
  it.each(['Home', 'HOME', ' home ', 'Personal', 'personal', 'PERSONAL', '  Personal  '])(
    'returns true for reserved name %j',
    (name) => {
      expect(isReservedDriveName(name)).toBe(true);
    }
  );

  it.each(['Homely', 'My Home', 'Personally', 'Work', '', '  ', 'home base'])(
    'returns false for non-reserved name %j',
    (name) => {
      expect(isReservedDriveName(name)).toBe(false);
    }
  );
});

describe('isHomeDrive', () => {
  it('returns true only for kind === "HOME"', () => {
    expect(isHomeDrive({ kind: 'HOME' })).toBe(true);
  });

  it.each([
    { kind: undefined },
    { kind: null },
    { kind: 'STANDARD' },
    {},
  ])('returns false for %j', (drive) => {
    expect(isHomeDrive(drive)).toBe(false);
  });

  it('does not treat lowercase or unknown kinds as Home', () => {
    expect(isHomeDrive({ kind: 'home' })).toBe(false);
    expect(isHomeDrive({ kind: 'SOMETHING_ELSE' })).toBe(false);
  });
});

describe('homeDriveActionError', () => {
  const homeDrive = { kind: 'HOME' };
  const actions: HomeDriveAction[] = ['rename', 'trash', 'invite', 'share', 'publish'];

  const expectedMessages: Record<HomeDriveAction, string> = {
    rename: 'Your Home drive cannot be renamed.',
    trash: 'Your Home drive cannot be moved to trash or deleted.',
    invite: 'Your Home drive is private and cannot be shared.',
    share: 'Your Home drive is private and cannot be shared.',
    publish: 'Pages in your Home drive cannot be published.',
  };

  it.each(actions)('returns the canonical message for %s on a Home drive', (action) => {
    expect(homeDriveActionError(homeDrive, action)).toBe(expectedMessages[action]);
  });

  it.each(actions)('returns null for %s on a STANDARD drive', (action) => {
    expect(homeDriveActionError({ kind: 'STANDARD' }, action)).toBeNull();
  });

  it.each(actions)('returns null for %s when kind is undefined', (action) => {
    expect(homeDriveActionError({}, action)).toBeNull();
  });

  it.each(actions)('returns null for %s when kind is null', (action) => {
    expect(homeDriveActionError({ kind: null }, action)).toBeNull();
  });
});

describe('resolveUniqueSlug', () => {
  it('returns the base when there is no collision', () => {
    expect(resolveUniqueSlug([], 'home')).toBe('home');
  });

  it('appends -2 on first collision', () => {
    expect(resolveUniqueSlug(['home'], 'home')).toBe('home-2');
  });

  it('appends -3 when base and -2 are taken', () => {
    expect(resolveUniqueSlug(['home', 'home-2'], 'home')).toBe('home-3');
  });

  it('fills the lowest free suffix', () => {
    expect(resolveUniqueSlug(['home', 'home-3'], 'home')).toBe('home-2');
  });

  it('ignores order of existing slugs', () => {
    expect(resolveUniqueSlug(['home-3', 'home', 'home-2'], 'home')).toBe('home-4');
    expect(resolveUniqueSlug(['home-2', 'home'], 'home')).toBe('home-3');
  });

  it('ignores unrelated entries', () => {
    expect(resolveUniqueSlug(['work', 'projects', 'home-base'], 'home')).toBe('home');
    expect(resolveUniqueSlug(['home', 'homely', 'work-2'], 'home')).toBe('home-2');
  });

  it('works for bases other than home', () => {
    expect(resolveUniqueSlug(['work'], 'work')).toBe('work-2');
    expect(resolveUniqueSlug([], 'work')).toBe('work');
  });
});
