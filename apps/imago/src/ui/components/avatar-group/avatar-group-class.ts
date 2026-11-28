/* Nothing here hides overflow: each face's canvas ring is what separates
   it from the one it overlaps, so the faces must overlap whole. */
export const avatarGroupClass = 'flex flex-none items-center';

/** Pulls every face after the first back over its neighbour. */
export const avatarGroupFaceClass = 'flex -ml-avatar-overlap first:ml-0';

export const avatarGroupRestClass = 'ml-1 text-2xs text-ink-faint tabular-nums';
