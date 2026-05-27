'use client';

import { useState, useRef, useCallback } from 'react';
import { FileIcon, FileText, Download, Video, Plus, Minus, RotateCcw } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import {
  type MessageWithAttachment,
  isImageAttachment,
  isVideoAttachment,
  getFileId,
  getAttachmentName,
  getAttachmentMimeType,
  getAttachmentSize,
  formatFileSize,
  hasAttachment,
} from '@/lib/attachment-utils';

interface MessageAttachmentProps {
  message: MessageWithAttachment;
}

interface ViewState {
  zoom: number;
  x: number;
  y: number;
}

const MIN_ZOOM = 1;
const MAX_ZOOM = 8;

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function ZoomableImage({ src, alt }: { src: string; alt: string }) {
  const [view, setView] = useState<ViewState>({ zoom: 1, x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ px: number; py: number; vx: number; vy: number } | null>(null);
  const pinchRef = useRef<{ dist: number; zoom: number; focalX: number; focalY: number; vx: number; vy: number } | null>(null);

  function getFocal(clientX: number, clientY: number) {
    if (!containerRef.current) return { x: 0, y: 0 };
    const rect = containerRef.current.getBoundingClientRect();
    return {
      x: clientX - rect.left - rect.width / 2,
      y: clientY - rect.top - rect.height / 2,
    };
  }

  function applyZoomAt(prevState: ViewState, nextZoom: number, focalX: number, focalY: number): ViewState {
    const z = clamp(nextZoom, MIN_ZOOM, MAX_ZOOM);
    if (z <= 1) return { zoom: 1, x: 0, y: 0 };
    const scale = z / prevState.zoom;
    return {
      zoom: z,
      x: focalX - (focalX - prevState.x) * scale,
      y: focalY - (focalY - prevState.y) * scale,
    };
  }

  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    const focal = getFocal(e.clientX, e.clientY);
    const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
    setView((prev: ViewState) => applyZoomAt(prev, prev.zoom * factor, focal.x, focal.y));
  }, []);

  function handleMouseDown(e: React.MouseEvent) {
    if (view.zoom <= 1) return;
    setDragging(true);
    dragRef.current = { px: e.clientX, py: e.clientY, vx: view.x, vy: view.y };
  }

  function handleMouseMove(e: React.MouseEvent) {
    if (!dragRef.current) return;
    const dx = e.clientX - dragRef.current.px;
    const dy = e.clientY - dragRef.current.py;
    setView((prev: ViewState) => ({ ...prev, x: dragRef.current!.vx + dx, y: dragRef.current!.vy + dy }));
  }

  function handleMouseUp() {
    setDragging(false);
    dragRef.current = null;
  }

  function handleDoubleClick() {
    setView({ zoom: 1, x: 0, y: 0 });
  }

  function handleTouchStart(e: React.TouchEvent) {
    if (e.touches.length === 2) {
      e.preventDefault();
      const t0 = e.touches[0];
      const t1 = e.touches[1];
      const dist = Math.hypot(t1.clientX - t0.clientX, t1.clientY - t0.clientY);
      const mx = (t0.clientX + t1.clientX) / 2;
      const my = (t0.clientY + t1.clientY) / 2;
      const focal = getFocal(mx, my);
      pinchRef.current = { dist, zoom: view.zoom, focalX: focal.x, focalY: focal.y, vx: view.x, vy: view.y };
    } else if (e.touches.length === 1 && view.zoom > 1) {
      const t = e.touches[0];
      dragRef.current = { px: t.clientX, py: t.clientY, vx: view.x, vy: view.y };
    }
  }

  function handleTouchMove(e: React.TouchEvent) {
    if (e.touches.length === 2 && pinchRef.current) {
      e.preventDefault();
      const t0 = e.touches[0];
      const t1 = e.touches[1];
      const dist = Math.hypot(t1.clientX - t0.clientX, t1.clientY - t0.clientY);
      const factor = dist / pinchRef.current.dist;
      const nextZoom = clamp(pinchRef.current.zoom * factor, MIN_ZOOM, MAX_ZOOM);
      const { focalX, focalY, vx, vy, zoom: startZoom } = pinchRef.current;
      if (nextZoom <= 1) {
        setView({ zoom: 1, x: 0, y: 0 });
        return;
      }
      const scale = nextZoom / startZoom;
      setView({ zoom: nextZoom, x: focalX - (focalX - vx) * scale, y: focalY - (focalY - vy) * scale });
    } else if (e.touches.length === 1 && dragRef.current) {
      const t = e.touches[0];
      const dx = t.clientX - dragRef.current.px;
      const dy = t.clientY - dragRef.current.py;
      setView((prev: ViewState) => ({ ...prev, x: dragRef.current!.vx + dx, y: dragRef.current!.vy + dy }));
    }
  }

  function handleTouchEnd() {
    pinchRef.current = null;
    dragRef.current = null;
  }

  function zoomBy(factor: number) {
    setView((prev: ViewState) => {
      const nextZoom = clamp(prev.zoom * factor, MIN_ZOOM, MAX_ZOOM);
      if (nextZoom <= 1) return { zoom: 1, x: 0, y: 0 };
      return { ...prev, zoom: nextZoom };
    });
  }

  const isZoomed = view.zoom > 1;

  return (
    <div className="flex flex-col items-center gap-2">
      <div
        ref={containerRef}
        className="overflow-hidden flex items-center justify-center w-full"
        style={{
          maxHeight: '78vh',
          cursor: isZoomed ? (dragging ? 'grabbing' : 'grab') : 'zoom-in',
        }}
        onWheel={handleWheel}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
        onDoubleClick={handleDoubleClick}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={src}
          alt={alt}
          draggable={false}
          style={{
            transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom})`,
            transformOrigin: 'center',
            transition: dragging ? 'none' : 'transform 0.1s ease-out',
            maxWidth: '100%',
            maxHeight: '78vh',
            objectFit: 'contain',
            userSelect: 'none',
            pointerEvents: 'none',
          }}
        />
      </div>

      <div className="flex items-center gap-1.5">
        <Button variant="outline" size="icon" className="h-7 w-7" onClick={() => zoomBy(1 / 1.5)}>
          <Minus className="h-3 w-3" />
        </Button>
        <span className="text-xs text-muted-foreground w-10 text-center tabular-nums">
          {Math.round(view.zoom * 100)}%
        </span>
        <Button variant="outline" size="icon" className="h-7 w-7" onClick={() => zoomBy(1.5)}>
          <Plus className="h-3 w-3" />
        </Button>
        {isZoomed && (
          <Button variant="outline" size="icon" className="h-7 w-7" onClick={() => setView({ zoom: 1, x: 0, y: 0 })}>
            <RotateCcw className="h-3 w-3" />
          </Button>
        )}
      </div>
    </div>
  );
}

export function MessageAttachment({ message }: MessageAttachmentProps) {
  const [previewOpen, setPreviewOpen] = useState(false);

  if (!hasAttachment(message)) return null;

  const fileId = getFileId(message);
  const name = getAttachmentName(message);
  const mimeType = getAttachmentMimeType(message);
  const size = getAttachmentSize(message);

  if (isImageAttachment(message)) {
    return (
      <div className="mt-2">
        <button
          type="button"
          onClick={() => setPreviewOpen(true)}
          className="block max-w-sm cursor-zoom-in"
        >
          {/* eslint-disable-next-line @next/next/no-img-element -- auth-gated API route; processor already optimizes on upload */}
          <img
            src={`/api/files/${fileId}/view`}
            alt={name}
            className="rounded-lg max-h-64 object-contain border border-border/50"
          />
        </button>

        <Dialog open={previewOpen} onOpenChange={setPreviewOpen}>
          <DialogContent className="max-w-[92vw] max-h-[92vh] p-4 flex flex-col gap-0">
            <DialogTitle className="sr-only">Image preview</DialogTitle>
            <ZoomableImage src={`/api/files/${fileId}/view`} alt={name} />
          </DialogContent>
        </Dialog>
      </div>
    );
  }

  if (isVideoAttachment(message)) {
    return (
      <div className="mt-2">
        <button
          type="button"
          onClick={() => setPreviewOpen(true)}
          className="flex items-center gap-3 p-3 bg-muted/50 hover:bg-muted rounded-lg border border-border/50 max-w-sm transition-colors cursor-pointer"
        >
          <div className="w-10 h-10 rounded bg-muted flex items-center justify-center shrink-0">
            <Video className="h-5 w-5 text-muted-foreground" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium truncate">{name}</p>
            {size != null && (
              <p className="text-xs text-muted-foreground">{formatFileSize(size)}</p>
            )}
          </div>
        </button>

        <Dialog open={previewOpen} onOpenChange={setPreviewOpen}>
          <DialogContent className="max-w-[90vw] max-h-[90vh] p-2">
            <DialogTitle className="sr-only">Video preview</DialogTitle>
            {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
            <video
              src={`/api/files/${fileId}/view`}
              controls
              className="max-w-full max-h-[85vh] mx-auto"
            />
          </DialogContent>
        </Dialog>
      </div>
    );
  }

  return (
    <div className="mt-2">
      <a
        href={`/api/files/${fileId}/download?filename=${encodeURIComponent(name)}`}
        className="flex items-center gap-3 p-3 bg-muted/50 hover:bg-muted rounded-lg border border-border/50 max-w-sm transition-colors"
      >
        <div className="w-10 h-10 rounded bg-muted flex items-center justify-center shrink-0">
          {mimeType.includes('pdf') ? (
            <FileText className="h-5 w-5 text-red-500" />
          ) : mimeType.includes('document') || mimeType.includes('word') ? (
            <FileText className="h-5 w-5 text-blue-500" />
          ) : (
            <FileIcon className="h-5 w-5 text-muted-foreground" />
          )}
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium truncate">{name}</p>
          {size != null && (
            <p className="text-xs text-muted-foreground">
              {formatFileSize(size)}
            </p>
          )}
        </div>
        <Download className="h-4 w-4 text-muted-foreground shrink-0" />
      </a>
    </div>
  );
}
