import { isMarkColor } from '@pagespace/lib/avatars/avatar-core';
import { Mark, type MarkProps } from '@/retained/components/marks/Mark';
import { OrgMark } from '@/retained/components/orgs/OrgMark';

export interface DriveMarkDrive {
  name: string;
  avatarUrl?: string | null;
  color?: string | null;
}

/** Whether the drive has a mark of its own (an avatar or a color), rather than only its name. */
export const hasOwnDriveMark = (drive: DriveMarkDrive): boolean => Boolean(drive.avatarUrl) || isMarkColor(drive.color);

export interface DriveMarkProps extends Omit<MarkProps, 'name' | 'avatarUrl' | 'color' | 'fallbackLabel'> {
  drive: DriveMarkDrive;
  /** The org that owns the drive, whose mark stands in when the drive has none of its own. */
  org?: { name: string; avatarUrl?: string | null } | null;
}

/**
 * A drive's mark: what the drive chose for itself first (its avatar, else its initial on its color),
 * then its org's mark, then its initial on the primary color.
 */
export function DriveMark({ drive, org, ...props }: DriveMarkProps) {
  if (!hasOwnDriveMark(drive) && org) return <OrgMark name={org.name} avatarUrl={org.avatarUrl} {...props} />;
  return (
    <Mark
      name={drive.name}
      avatarUrl={drive.avatarUrl}
      color={isMarkColor(drive.color) ? drive.color : null}
      fallbackLabel="Drive"
      {...props}
    />
  );
}
