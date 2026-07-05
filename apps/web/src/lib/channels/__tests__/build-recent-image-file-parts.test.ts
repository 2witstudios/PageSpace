import { describe, it } from 'vitest';
import { assert } from '@/lib/ai/core/__tests__/riteway';
import {
  buildRecentImageFileParts,
  MAX_RECENT_IMAGE_ATTACHMENTS,
  MAX_RECENT_IMAGE_ATTACHMENT_SIZE_BYTES,
  type RecentImageFileCandidate,
} from '../build-recent-image-file-parts';

const baseCandidate: RecentImageFileCandidate = {
  fileId: 'file-1',
  url: 'https://example.com/signed/file-1',
  mimeType: 'image/png',
  filename: 'screenshot.png',
  sizeBytes: 1024,
  accessible: true,
};

describe('buildRecentImageFileParts', () => {
  it('given a single valid image candidate, should return one file part', () => {
    const result = buildRecentImageFileParts([baseCandidate]);

    assert({
      given: 'one accessible, allowed, in-size image candidate',
      should: 'return a single file part with the resolved url/mediaType/filename',
      actual: result,
      expected: [
        { type: 'file', url: baseCandidate.url, mediaType: 'image/png', filename: 'screenshot.png' },
      ],
    });
  });

  it('given more candidates than the cap, should keep only the most recent maxCount', () => {
    const candidates = Array.from({ length: MAX_RECENT_IMAGE_ATTACHMENTS + 3 }, (_, i) => ({
      ...baseCandidate,
      fileId: `file-${i}`,
      url: `https://example.com/signed/file-${i}`,
      filename: `image-${i}.png`,
    }));

    const result = buildRecentImageFileParts(candidates);

    assert({
      given: `${candidates.length} valid candidates (more than the cap of ${MAX_RECENT_IMAGE_ATTACHMENTS})`,
      should: 'cap the output at maxCount, keeping the most recent (last) ones in order',
      actual: result.map((p) => p.filename),
      expected: candidates.slice(-MAX_RECENT_IMAGE_ATTACHMENTS).map((c) => c.filename),
    });
  });

  it('given a custom maxCount, should cap at that value instead of the default', () => {
    const candidates = Array.from({ length: 4 }, (_, i) => ({
      ...baseCandidate,
      fileId: `file-${i}`,
      filename: `image-${i}.png`,
    }));

    const result = buildRecentImageFileParts(candidates, 2);

    assert({
      given: '4 valid candidates with an explicit maxCount of 2',
      should: 'cap the output at 2, keeping the last 2',
      actual: result.map((p) => p.filename),
      expected: ['image-2.png', 'image-3.png'],
    });
  });

  it('given a candidate over the size limit, should skip it', () => {
    const oversized: RecentImageFileCandidate = {
      ...baseCandidate,
      fileId: 'file-oversized',
      filename: 'huge.png',
      sizeBytes: MAX_RECENT_IMAGE_ATTACHMENT_SIZE_BYTES + 1,
    };

    const result = buildRecentImageFileParts([oversized]);

    assert({
      given: 'a candidate whose sizeBytes exceeds the max',
      should: 'skip it and return no file parts',
      actual: result,
      expected: [],
    });
  });

  it('given a candidate with a disallowed mime type, should skip it', () => {
    const disallowed: RecentImageFileCandidate = {
      ...baseCandidate,
      fileId: 'file-disallowed',
      filename: 'doc.pdf',
      mimeType: 'application/pdf',
    };

    const result = buildRecentImageFileParts([disallowed]);

    assert({
      given: 'a candidate whose mimeType is not an allowed image type',
      should: 'skip it and return no file parts',
      actual: result,
      expected: [],
    });
  });

  it('given a candidate with a null mime type, should skip it', () => {
    const nullMime: RecentImageFileCandidate = {
      ...baseCandidate,
      fileId: 'file-null-mime',
      mimeType: null,
    };

    const result = buildRecentImageFileParts([nullMime]);

    assert({
      given: 'a candidate whose mimeType is null',
      should: 'skip it and return no file parts',
      actual: result,
      expected: [],
    });
  });

  it('given an inaccessible candidate, should skip it', () => {
    const inaccessible: RecentImageFileCandidate = {
      ...baseCandidate,
      fileId: 'file-inaccessible',
      accessible: false,
    };

    const result = buildRecentImageFileParts([inaccessible]);

    assert({
      given: 'a candidate the user cannot access (accessible: false)',
      should: 'skip it and return no file parts',
      actual: result,
      expected: [],
    });
  });

  it('given a mix of valid and invalid candidates, should keep only the valid ones in order', () => {
    const valid1: RecentImageFileCandidate = { ...baseCandidate, fileId: 'a', filename: 'a.png' };
    const oversized: RecentImageFileCandidate = {
      ...baseCandidate,
      fileId: 'b',
      filename: 'b.png',
      sizeBytes: MAX_RECENT_IMAGE_ATTACHMENT_SIZE_BYTES + 1,
    };
    const inaccessible: RecentImageFileCandidate = {
      ...baseCandidate,
      fileId: 'c',
      filename: 'c.png',
      accessible: false,
    };
    const valid2: RecentImageFileCandidate = { ...baseCandidate, fileId: 'd', filename: 'd.png' };

    const result = buildRecentImageFileParts([valid1, oversized, inaccessible, valid2]);

    assert({
      given: 'a mix of valid and invalid candidates',
      should: 'skip the invalid ones while preserving the relative order of the valid ones',
      actual: result.map((p) => p.filename),
      expected: ['a.png', 'd.png'],
    });
  });

  it('given no candidates, should return an empty array', () => {
    const result = buildRecentImageFileParts([]);

    assert({
      given: 'an empty candidate list',
      should: 'return an empty array',
      actual: result,
      expected: [],
    });
  });
});
