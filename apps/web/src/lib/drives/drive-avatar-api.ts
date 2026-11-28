import type { MarkColor } from '@pagespace/lib/avatars/avatar-core';
import { del, patch } from '@/lib/auth/auth-fetch';
import { uploadAvatar } from '@/lib/avatars/avatar-api';

type DriveAvatarResponse = { drive: { id: string; avatarUrl: string | null } };

/** Upload the drive's avatar image (Owner and Admins). A refusal throws ApiRequestError with the route's message. */
export const uploadDriveAvatar = (driveId: string, file: File) =>
  uploadAvatar<DriveAvatarResponse>(`/api/drives/${driveId}/avatar`, file);

export const removeDriveAvatar = (driveId: string) => del<DriveAvatarResponse>(`/api/drives/${driveId}/avatar`);

/** The color the drive's initial sits on; null for the default tile. */
export const setDriveColor = (driveId: string, color: MarkColor | null) => patch(`/api/drives/${driveId}`, { color });
