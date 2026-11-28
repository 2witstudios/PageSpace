"use client";

// Ported from apps/web/src/components/shared/FeedbackDialog.tsx. The submit goes through the
// imago API client (CSRF, sign-in on 401) instead of web's fetch helper.

import { useState, useCallback, useRef, useEffect } from "react";
import { createId } from "@paralleldrive/cuid2";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/retained/components/ui/dialog";
import { Button } from "@/retained/components/ui/button";
import { Textarea } from "@/retained/components/ui/textarea";
import { Label } from "@/retained/components/ui/label";
import { Alert, AlertDescription } from "@/retained/components/ui/alert";
import { useApiClient } from "@/api/swr-provider";
import { MessageSquare, Upload, X, Info } from "lucide-react";
import { cn } from "@/retained/lib/utils/index";

export const FEEDBACK_ENDPOINT = "/api/feedback";

interface FeedbackDialogProps {
  isOpen: boolean;
  onClose: () => void;
}

interface AttachedFile {
  id: string;
  file: File;
  preview: string;
}

const MAX_FILES = 5;
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
const ACCEPTED_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"];

const readAsDataUrl = (file: File): Promise<string> =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error(`Failed to read file: ${file.name}`));
    reader.onabort = () => reject(new Error(`File read aborted: ${file.name}`));
    reader.readAsDataURL(file);
  });

export function FeedbackDialog({ isOpen, onClose }: FeedbackDialogProps) {
  const client = useApiClient();
  const [message, setMessage] = useState("");
  const [attachedFiles, setAttachedFiles] = useState<AttachedFile[]>([]);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isSubmitted, setIsSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const attachedFilesRef = useRef<AttachedFile[]>([]);

  // Keep ref in sync with state for unmount cleanup
  useEffect(() => {
    attachedFilesRef.current = attachedFiles;
  }, [attachedFiles]);

  // Cleanup blob URLs on unmount only
  useEffect(() => {
    return () => {
      attachedFilesRef.current.forEach((f) => {
        URL.revokeObjectURL(f.preview);
      });
    };
  }, []);

  const handleClose = useCallback(() => {
    if (!isSubmitting) {
      attachedFilesRef.current.forEach((f) => URL.revokeObjectURL(f.preview));
      setMessage("");
      setAttachedFiles([]);
      setError(null);
      setIsSubmitted(false);
      onClose();
    }
  }, [isSubmitting, onClose]);

  const addFiles = useCallback((fileList: FileList | File[]) => {
    const files = Array.from(fileList);
    const newFiles: AttachedFile[] = [];
    const errors: string[] = [];

    for (const file of files) {
      if (attachedFiles.length + newFiles.length >= MAX_FILES) {
        errors.push(`Maximum ${MAX_FILES} files allowed`);
        break;
      }

      if (!ACCEPTED_TYPES.includes(file.type)) {
        errors.push(`${file.name}: Only images are allowed`);
        continue;
      }

      if (file.size > MAX_FILE_SIZE) {
        errors.push(`${file.name}: File too large (max 10MB)`);
        continue;
      }

      newFiles.push({
        id: createId(),
        file,
        preview: URL.createObjectURL(file),
      });
    }

    if (errors.length > 0) {
      setError(errors.join(". "));
    }

    if (newFiles.length > 0) {
      setAttachedFiles((prev) => [...prev, ...newFiles]);
    }
  }, [attachedFiles.length]);

  const removeFile = useCallback((id: string) => {
    setAttachedFiles((prev) => {
      const file = prev.find((f) => f.id === id);
      if (file) {
        URL.revokeObjectURL(file.preview);
      }
      return prev.filter((f) => f.id !== id);
    });
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);

    if (e.dataTransfer.files?.length) {
      addFiles(e.dataTransfer.files);
    }
  }, [addFiles]);

  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;

    const files: File[] = [];
    for (const item of items) {
      if (item.kind === "file" && ACCEPTED_TYPES.includes(item.type)) {
        const file = item.getAsFile();
        if (file) files.push(file);
      }
    }

    if (files.length > 0) {
      e.preventDefault();
      addFiles(files);
    }
  }, [addFiles]);

  const collectSystemContext = useCallback(() => {
    return {
      pageUrl: window.location.href,
      userAgent: navigator.userAgent,
      screenSize: `${window.screen.width}x${window.screen.height}`,
      viewportSize: `${window.innerWidth}x${window.innerHeight}`,
      appVersion: process.env.NEXT_PUBLIC_APP_VERSION || "unknown",
    };
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!message.trim()) {
      setError("Please enter your feedback");
      return;
    }

    setIsSubmitting(true);
    setError(null);

    try {
      const attachments = await Promise.all(
        attachedFiles.map(async (af) => ({
          name: af.file.name,
          type: af.file.type,
          data: await readAsDataUrl(af.file),
        })),
      );

      await client.apiFetch(FEEDBACK_ENDPOINT, {
        method: "POST",
        json: {
          message: message.trim(),
          attachments,
          context: collectSystemContext(),
        },
      });

      setIsSubmitted(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to submit feedback");
    } finally {
      setIsSubmitting(false);
    }
  };

  if (isSubmitted) {
    return (
      <Dialog open={isOpen} onOpenChange={handleClose}>
        <DialogContent showCloseButton={false} className="sm:max-w-md">
          <div className="text-center py-6">
            <div className="mx-auto w-12 h-12 bg-primary/10 rounded-full flex items-center justify-center mb-4">
              <MessageSquare className="w-6 h-6 text-primary" />
            </div>
            <DialogTitle className="text-xl font-semibold mb-2">Thank you!</DialogTitle>
            <DialogDescription className="text-muted-foreground">
              Your feedback has been submitted. We appreciate you taking the time to help us improve.
            </DialogDescription>
            <Button onClick={handleClose} className="mt-6">
              Close
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Dialog open={isOpen} onOpenChange={handleClose}>
      <DialogContent showCloseButton={false} className="sm:max-w-lg">
        <DialogHeader className="flex-row items-start gap-3">
          <div className="flex-1 space-y-1.5">
            <DialogTitle>Send Feedback</DialogTitle>
            <DialogDescription>
              Help us improve PageSpace. Share bugs, feature ideas, or anything else.
            </DialogDescription>
          </div>
          <button
            type="button"
            aria-label="Close"
            title="Close"
            onClick={handleClose}
            disabled={isSubmitting}
            className="flex size-7 flex-none items-center justify-center rounded-md text-muted-foreground hover:bg-accent"
          >
            <X className="size-3.5" />
          </button>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="feedback-message">Your Feedback</Label>
            <Textarea
              id="feedback-message"
              placeholder="Tell us what's on your mind..."
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              onPaste={handlePaste}
              className="min-h-32 resize-none"
              maxLength={2000}
              disabled={isSubmitting}
            />
            <p className="text-xs text-muted-foreground text-right">
              {message.length}/2000
            </p>
          </div>

          {/* File upload area */}
          <div className="space-y-2">
            <Label>Screenshots (optional)</Label>
            <button
              type="button"
              className={cn(
                "flex w-full flex-col items-center gap-1 rounded-lg border-2 border-dashed p-4 text-center transition-colors",
                isDragOver
                  ? "border-primary bg-primary/5"
                  : "border-muted-foreground/25 hover:border-muted-foreground/50",
                attachedFiles.length >= MAX_FILES && "cursor-not-allowed opacity-50",
              )}
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onDrop={handleDrop}
              onClick={() => attachedFiles.length < MAX_FILES && fileInputRef.current?.click()}
              disabled={attachedFiles.length >= MAX_FILES}
            >
              <Upload className="w-8 h-8 mb-1 text-muted-foreground" />
              <span className="text-sm text-muted-foreground">
                Drag & drop images, paste from clipboard, or click to upload
              </span>
              <span className="text-xs text-muted-foreground">
                PNG, JPG, GIF, WebP up to 10MB ({attachedFiles.length}/{MAX_FILES})
              </span>
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept={ACCEPTED_TYPES.join(",")}
              multiple
              className="hidden"
              onChange={(e) => e.target.files && addFiles(e.target.files)}
              disabled={attachedFiles.length >= MAX_FILES}
            />
          </div>

          {/* Attached files preview */}
          {attachedFiles.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {attachedFiles.map((af) => (
                <div
                  key={af.id}
                  className="relative w-16 h-16 rounded-md overflow-hidden border"
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={af.preview}
                    alt={af.file.name}
                    className="w-full h-full object-cover"
                  />
                  <button
                    type="button"
                    aria-label="Remove screenshot"
                    onClick={() => removeFile(af.id)}
                    className="absolute top-0.5 right-0.5 flex size-5 items-center justify-center rounded-full bg-black/60 text-white"
                  >
                    <X className="w-3 h-3" />
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* Privacy notice */}
          <Alert>
            <Info className="h-4 w-4" />
            <AlertDescription className="text-xs">
              To help us investigate issues, we automatically collect: current page URL,
              browser info, screen size, and app version. Your account email will be associated
              with this feedback.
            </AlertDescription>
          </Alert>

          {error && (
            <div role="alert" className="p-3 bg-destructive/10 border border-destructive/20 rounded-md">
              <p className="text-sm text-destructive">{error}</p>
            </div>
          )}

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={handleClose}
              disabled={isSubmitting}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={isSubmitting || !message.trim()}>
              {isSubmitting ? "Submitting..." : "Submit Feedback"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
