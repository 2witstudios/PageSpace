"use client";

import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import { PagePickerPopover } from '@/components/common/PagePickerPopover';
import { PageType } from '@pagespace/lib/utils/enums';

/** Author-supplied SEO overrides for a published page. */
export interface PublishSettings {
  title: string;
  description: string;
  ogImageUrl: string;
  noindex: boolean;
}

export const EMPTY_SETTINGS: PublishSettings = {
  title: '',
  description: '',
  ogImageUrl: '',
  noindex: false,
};

/** PublishSettings plus a transient "picked an uploaded file" alternative to
 *  pasting a URL — resolved server-side, never persisted as its own field. */
export interface PublishOverrides extends PublishSettings {
  ogImageFileId?: string;
}

interface PublishSettingsFieldsProps {
  value: PublishSettings;
  onChange: (next: PublishSettings) => void;
  pickedImageId: string | null;
  onPickedImageIdChange: (id: string | null) => void;
  driveId?: string;
  /** Disables every field — used inline (e.g. the canvas Settings category)
   *  before a page has ever been published, when there's nothing to save yet. */
  disabled?: boolean;
  /** Distinguishes DOM ids when the dialog and an inline panel could both
   *  exist in the tree (defaults to the dialog's original ids). */
  idPrefix?: string;
}

/**
 * The shared SEO/appearance override fields for a published page — title,
 * description, share image, noindex, and the theme-bridge toggle. Rendered
 * both inside `PublishSettingsDialog` (documents/sheets/code, gated behind
 * already-published) and inline inside the canvas Settings "Publish" category.
 */
export function PublishSettingsFields({
  value,
  onChange,
  pickedImageId,
  onPickedImageIdChange,
  driveId,
  disabled = false,
  idPrefix = 'publish',
}: PublishSettingsFieldsProps) {
  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor={`${idPrefix}-title`}>Title</Label>
        <Input
          id={`${idPrefix}-title`}
          value={value.title}
          onChange={(e) => onChange({ ...value, title: e.target.value })}
          placeholder="Defaults to the page title"
          disabled={disabled}
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={`${idPrefix}-description`}>Description</Label>
        <Textarea
          id={`${idPrefix}-description`}
          value={value.description}
          onChange={(e) => onChange({ ...value, description: e.target.value })}
          placeholder="Shown in search results and link unfurls"
          rows={3}
          disabled={disabled}
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={`${idPrefix}-og-image`}>Share image URL</Label>
        <Input
          id={`${idPrefix}-og-image`}
          type="url"
          value={value.ogImageUrl}
          onChange={(e) => onChange({ ...value, ogImageUrl: e.target.value })}
          placeholder="https://… (1200×630 recommended)"
          disabled={disabled || !!pickedImageId}
        />
      </div>
      {driveId && (
        pickedImageId ? (
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>Using an uploaded image for this page&apos;s share image</span>
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-xs"
              onClick={() => onPickedImageIdChange(null)}
              disabled={disabled}
            >
              Remove
            </Button>
          </div>
        ) : (
          <div className="space-y-1.5">
            <Label>Or pick an uploaded image</Label>
            <PagePickerPopover
              driveId={driveId}
              value={null}
              onChange={onPickedImageIdChange}
              pageType={PageType.FILE}
              imageOnly
              placeholder="Browse uploaded images…"
            />
          </div>
        )
      )}
      <div className="flex items-center justify-between gap-4">
        <div className="space-y-0.5">
          <Label htmlFor={`${idPrefix}-noindex`}>Hide from search engines</Label>
          <p className="text-xs text-muted-foreground">
            Adds a noindex tag and keeps the page out of the sitemap.
          </p>
        </div>
        <Switch
          id={`${idPrefix}-noindex`}
          checked={value.noindex}
          onCheckedChange={(checked) => onChange({ ...value, noindex: checked })}
          disabled={disabled}
        />
      </div>
    </div>
  );
}
