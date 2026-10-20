'use client';

import { useRef, useState } from 'react';
import { toast } from 'sonner';
import { Check } from 'lucide-react';
import { AVATAR_MIME_TYPES, MARK_COLORS, isMarkColor, type MarkColor } from '@pagespace/lib/avatars/avatar-core';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { DriveMark } from '@/components/drives/DriveMark';
import { MARK_COLOR_CLASSES } from '@/components/marks/Mark';
import { ApiRequestError } from '@/lib/auth/auth-fetch';
import { removeDriveAvatar, setDriveColor, uploadDriveAvatar } from '@/lib/drives/drive-avatar-api';
import { cn } from '@/lib/utils';

const AVATAR_ACCEPT = AVATAR_MIME_TYPES.filter((type) => type !== 'image/jpg').join(',');

const colorName = (color: MarkColor): string => color.charAt(0).toUpperCase() + color.slice(1);

interface DriveAppearanceCardProps {
  drive: { id: string; name: string; avatarUrl?: string | null; color?: string | null };
  /** The owning org, whose mark stands in until the drive has one of its own. */
  org?: { name: string; avatarUrl?: string | null } | null;
  /** Called after a change is saved, so the drive list (and every mark drawn from it) refetches. */
  onChanged: () => void;
}

/**
 * How the drive appears in the switcher and the header: an uploaded image (JPEG, PNG, GIF or WebP,
 * up to 5 MB, stored and served by PageSpace), or its initial on a palette color. Owner and Admins.
 */
export function DriveAppearanceCard({ drive, org, onChanged }: DriveAppearanceCardProps) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const color = isMarkColor(drive.color) ? drive.color : null;
  const hasAvatar = Boolean(drive.avatarUrl);

  const run = async (work: () => Promise<unknown>, failure: string) => {
    setBusy(true);
    try {
      await work();
      onChanged();
    } catch (error) {
      // The avatar route's refusals are written for people (type, size); anything else gets the fallback.
      toast.error(error instanceof ApiRequestError && error.status === 400 ? error.message : failure);
    } finally {
      setBusy(false);
      if (input.current) input.current.value = '';
    }
  };

  const onFile = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) void run(() => uploadDriveAvatar(drive.id, file), 'The image could not be uploaded.');
  };

  const pickColor = (next: MarkColor | null) => {
    if (next === color) return;
    void run(() => setDriveColor(drive.id, next), 'The color could not be saved.');
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Appearance</CardTitle>
        <CardDescription>How this drive appears in the drive switcher and the header</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center gap-3">
          <DriveMark drive={drive} org={org} size="lg" decorative />
          <div className="flex flex-wrap items-center gap-2">
            <input ref={input} id="drive-appearance-avatar" type="file" accept={AVATAR_ACCEPT} className="sr-only" aria-label="Upload drive image" onChange={onFile} disabled={busy} />
            <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => input.current?.click()}>
              {hasAvatar ? 'Change image' : 'Upload image'}
            </Button>
            {hasAvatar ? (
              <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => void run(() => removeDriveAvatar(drive.id), 'The image could not be removed.')}>
                Remove image
              </Button>
            ) : null}
            <p className="w-full text-xs text-muted-foreground">JPEG, PNG, GIF or WebP, up to 5 MB.</p>
          </div>
        </div>
        <div className="space-y-2">
          <p className="text-sm font-medium" id="drive-appearance-color">Color</p>
          <p className="text-xs text-muted-foreground">The tile behind the drive&apos;s initial when it has no image.</p>
          <div role="group" aria-labelledby="drive-appearance-color" className="flex flex-wrap gap-2">
            <button
              type="button"
              aria-pressed={color === null}
              aria-label="Default"
              title="Default"
              disabled={busy}
              onClick={() => pickColor(null)}
              className={cn(
                'flex h-7 w-7 items-center justify-center rounded-md bg-primary text-primary-foreground ring-offset-2 ring-offset-background',
                color === null && 'ring-2 ring-ring',
              )}
            >
              {color === null ? <Check className="h-3.5 w-3.5" aria-hidden="true" /> : null}
            </button>
            {MARK_COLORS.map((option) => (
              <button
                key={option}
                type="button"
                aria-pressed={color === option}
                aria-label={colorName(option)}
                title={colorName(option)}
                disabled={busy}
                onClick={() => pickColor(option)}
                className={cn(
                  'flex h-7 w-7 items-center justify-center rounded-md ring-offset-2 ring-offset-background',
                  MARK_COLOR_CLASSES[option],
                  color === option && 'ring-2 ring-ring',
                )}
              >
                {color === option ? <Check className="h-3.5 w-3.5" aria-hidden="true" /> : null}
              </button>
            ))}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
