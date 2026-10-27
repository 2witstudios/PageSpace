'use client';

/**
 * Renders every attachment on a message.
 *
 * A message used to hold exactly one file, so a batch of photos arrived as N
 * separate messages and read as N separate bubbles. Now one send is one
 * message, and its images stack into a single gallery with one lightbox you
 * can page through — the behaviour every other messaging app has.
 *
 * Images get the grid; video and generic files keep their existing single-file
 * cards, rendered beneath and delegated to `MessageAttachment` so there is only
 * one definition of what a file card looks like.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, ImageOff } from 'lucide-react';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import { MessageAttachment, ZoomableImage } from './MessageAttachment';
import {
  type MessageAttachmentLike,
  type MessageWithAttachment,
  getAttachments,
  isImageAttachment,
  getFileId,
  getAttachmentName,
} from '@/lib/attachment-utils';

interface MessageAttachmentsProps {
  message: MessageWithAttachment;
}

const viewUrl = (fileId: string) => `/api/files/${fileId}/view`;

/**
 * Identity of one tile, stable across the optimistic-to-confirmed swap.
 *
 * Deliberately NOT the attachment row's id: an optimistic row has none, and
 * the server echo brings real cuid2 ids, so keying on the id would change
 * every key when the send confirms — React would unmount and remount every
 * `<img>` in the batch (a visible reload flash on the sender's own screen) and
 * the `failed` set below would silently reset. (fileId, position) is what both
 * shapes agree on, and it stays unique when the same file is attached twice,
 * because file ids are content hashes but positions are not.
 */
const tileKey = (attachment: MessageAttachmentLike, index: number) =>
  `${getFileId(attachment) ?? 'missing'}-${attachment.position ?? index}`;

export function MessageAttachments({ message }: MessageAttachmentsProps) {
  const attachments = getAttachments(message);
  const images = attachments.filter(isImageAttachment);
  const others = attachments.filter((a) => !isImageAttachment(a));

  // The OPEN IMAGE is held by key, not by index. `images` is re-derived from
  // props on every render, so an index would silently point at a different
  // photo if the message changed while the viewer was open — the server echo
  // replacing the optimistic row, an edit, or a hard-deleted file dropping a
  // tile out of the list.
  const [lightboxKey, setLightboxKey] = useState<string | null>(null);
  const [failed, setFailed] = useState<Set<string>>(new Set());

  const imageKeys = images.map(tileKey);
  const openAt = lightboxKey === null ? -1 : imageKeys.indexOf(lightboxKey);
  const activeIndex = openAt === -1 ? null : openAt;

  // Read through a ref so paging stays a stable callback: `imageKeys` is a new
  // array every render, and putting it in the dependency list would re-create
  // `step` each time and churn the keydown listener below.
  const imageKeysRef = useRef<string[]>([]);
  imageKeysRef.current = imageKeys;

  const close = useCallback(() => setLightboxKey(null), []);
  const step = useCallback((delta: number) => {
    setLightboxKey((current) => {
      const keys = imageKeysRef.current;
      if (current === null || keys.length === 0) return current;
      // Wrap, so paging past either end continues round the gallery.
      const at = keys.indexOf(current);
      // A key that has left the list normally closes the viewer on the next
      // render (`activeIndex` goes null), so this is only reachable if a props
      // update and a keypress land in the same batch. Start from the top there
      // rather than doing arithmetic on -1.
      const from = at === -1 ? 0 : at;
      return keys[(from + delta + keys.length) % keys.length];
    });
  }, []);

  // Arrow keys page the lightbox. Registered only while it is open so the
  // channel's own keyboard handling is untouched the rest of the time.
  useEffect(() => {
    if (activeIndex === null) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'ArrowLeft') step(-1);
      if (event.key === 'ArrowRight') step(1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [activeIndex, step]);

  if (attachments.length === 0) return null;

  const active = activeIndex === null ? null : images[activeIndex];
  const activeFileId = active ? getFileId(active) : null;
  // A single image keeps the roomier standalone treatment; two or more tile.
  const isSingle = images.length === 1;

  return (
    <div className="mt-2 flex flex-col">
      {images.length > 0 && (
        <div className={cn('flex flex-wrap gap-1.5', isSingle && 'max-w-sm')}>
          {images.map((attachment, index) => {
            const fileId = getFileId(attachment);
            const name = getAttachmentName(attachment);
            const key = tileKey(attachment, index);

            if (!fileId || failed.has(key)) {
              return (
                <div
                  key={key}
                  className="flex h-[120px] w-[120px] items-center justify-center rounded-lg border border-border bg-muted/50"
                  title={name}
                >
                  <ImageOff className="h-5 w-5 text-muted-foreground" />
                </div>
              );
            }

            return (
              <button
                key={key}
                type="button"
                onClick={() => setLightboxKey(key)}
                className={cn(
                  'cursor-zoom-in overflow-hidden rounded-lg border border-border/50',
                  isSingle ? 'block max-w-sm' : 'h-[120px] w-[120px]',
                )}
              >
                {/* eslint-disable-next-line @next/next/no-img-element -- auth-gated API route; processor already optimizes on upload */}
                <img
                  src={viewUrl(fileId)}
                  alt={name}
                  onError={() => setFailed((prev) => new Set(prev).add(key))}
                  className={cn(
                    isSingle ? 'max-h-64 object-contain' : 'h-full w-full object-cover',
                  )}
                />
              </button>
            );
          })}
        </div>
      )}

      {/* Video and generic-file tiles keep their existing single-file cards,
          each of which brings its own top margin. */}
      {others.map((attachment, index) => (
        <MessageAttachment
          key={tileKey(attachment, index)}
          message={attachment}
        />
      ))}

      <Dialog open={activeIndex !== null} onOpenChange={(open) => !open && close()}>
        {/* sm:max-w-[92vw] overrides shadcn DialogContent's default sm:max-w-lg
            (~512px), which would otherwise clamp the viewer to a tiny window. */}
        <DialogContent className="flex h-[90vh] w-[92vw] flex-col gap-0 p-4 sm:max-w-[92vw]">
          <DialogTitle className="sr-only">
            {active ? getAttachmentName(active) : 'Image preview'}
          </DialogTitle>

          {activeFileId && (
            <ZoomableImage
              // Remount on navigation so pan/zoom resets between images
              // instead of carrying one image's transform onto the next.
              key={activeFileId}
              src={viewUrl(activeFileId)}
              alt={active ? getAttachmentName(active) : ''}
            />
          )}

          {images.length > 1 && activeIndex !== null && (
            <div className="flex items-center justify-center gap-3 pt-2">
              <button
                type="button"
                onClick={() => step(-1)}
                aria-label="Previous image"
                className="rounded-md border border-border p-1.5 hover:bg-muted"
              >
                <ChevronLeft className="h-4 w-4" />
              </button>
              <span className="text-xs tabular-nums text-muted-foreground">
                {`${activeIndex + 1} / ${images.length}`}
              </span>
              <button
                type="button"
                onClick={() => step(1)}
                aria-label="Next image"
                className="rounded-md border border-border p-1.5 hover:bg-muted"
              >
                <ChevronRight className="h-4 w-4" />
              </button>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
