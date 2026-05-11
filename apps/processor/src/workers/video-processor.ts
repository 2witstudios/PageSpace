import { execFile } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import fs from 'fs/promises';
import { contentStore } from '../server';
import { loggers } from '@pagespace/lib/logging/logger-config';
import type { VideoProcessJobData, VideoProcessResult } from '../types';

const execFileAsync = promisify(execFile);

const TEMP_ROOT = process.env.TEMP_UPLOADS_PATH || '/tmp/processor-uploads';

export async function processVideo(data: VideoProcessJobData): Promise<VideoProcessResult> {
  const { contentHash, fileId } = data;

  loggers.processor.info('Video processing started', { contentHash, fileId });

  const inputPath = path.join(TEMP_ROOT, `video-${contentHash}`);
  const thumbPath = path.join(TEMP_ROOT, `video-${contentHash}-thumb.webp`);

  try {
    await contentStore.streamOriginalToFile(contentHash, inputPath);

    await extractThumbnail(inputPath, thumbPath);
    const thumbBuffer = await fs.readFile(thumbPath);
    await contentStore.saveCache(contentHash, 'thumbnail.webp', thumbBuffer, 'image/webp');

    const meta = await probeVideo(inputPath);

    loggers.processor.info('Video processing succeeded', { contentHash, ...meta });

    return {
      success: true,
      thumbnailKey: `cache/${contentHash}/thumbnail.webp`,
      ...meta,
    };

  } catch (error) {
    loggers.processor.error(
      'Video processing failed',
      error instanceof Error ? error : undefined,
      { contentHash, fileId },
    );
    throw error;
  } finally {
    await fs.unlink(inputPath).catch(() => {});
    await fs.unlink(thumbPath).catch(() => {});
  }
}

async function extractThumbnail(inputPath: string, thumbPath: string): Promise<void> {
  await execFileAsync('ffmpeg', [
    '-y',
    '-i', inputPath,
    '-vf', 'select=eq(n\\,0)',
    '-vframes', '1',
    '-f', 'webp',
    thumbPath,
  ]);
}

interface VideoMeta {
  duration?: number;
  width?: number;
  height?: number;
}

async function probeVideo(inputPath: string): Promise<VideoMeta> {
  const { stdout } = await execFileAsync('ffprobe', [
    '-v', 'quiet',
    '-print_format', 'json',
    '-show_streams',
    '-select_streams', 'v:0',
    inputPath,
  ]);

  const probe = JSON.parse(stdout) as { streams?: Array<{ duration?: string; width?: number; height?: number }> };
  const stream = probe.streams?.[0];

  return {
    duration: stream?.duration ? parseFloat(stream.duration) : undefined,
    width: stream?.width,
    height: stream?.height,
  };
}

export function isVideo(mimeType: string): boolean {
  return mimeType.startsWith('video/');
}
