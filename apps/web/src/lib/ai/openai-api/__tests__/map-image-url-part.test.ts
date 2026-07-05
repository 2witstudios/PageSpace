import { describe, test } from 'vitest';
import { assert } from './riteway';
import { mapImageUrlPartToFilePart } from '../map-image-url-part';

describe('mapImageUrlPartToFilePart', () => {
  test('data: URL image_url part is mapped to a file part', () => {
    const part = { type: 'image_url', image_url: { url: 'data:image/png;base64,aGVsbG8=' } };
    const result = mapImageUrlPartToFilePart(part);
    assert({
      given: 'an image_url part whose url is a data: URL',
      should: 'return ok:true with a file part carrying the url and mediaType',
      actual: result,
      expected: { ok: true, part: { type: 'file', url: 'data:image/png;base64,aGVsbG8=', mediaType: 'image/png' } },
    });
  });

  test('remote http(s) URL image_url part is rejected', () => {
    const part = { type: 'image_url', image_url: { url: 'https://example.com/cat.png' } };
    const result = mapImageUrlPartToFilePart(part);
    assert({
      given: 'an image_url part whose url is a remote http(s) URL',
      should: 'return ok:false with a descriptive error instead of throwing or silently dropping',
      actual: result,
      expected: { ok: false, error: 'image_url must be a data: URL — remote image URLs are not supported' },
    });
  });

  test('image_url part missing image_url.url is rejected', () => {
    const part = { type: 'image_url', image_url: {} };
    const result = mapImageUrlPartToFilePart(part);
    assert({
      given: 'an image_url part with no image_url.url string',
      should: 'return ok:false with a descriptive error',
      actual: result,
      expected: { ok: false, error: 'image_url part must have image_url.url (string)' },
    });
  });

  test('bare-string image_url (non-object) is rejected', () => {
    const part = { type: 'image_url', image_url: 'data:image/png;base64,aGVsbG8=' };
    const result = mapImageUrlPartToFilePart(part);
    assert({
      given: 'an image_url value that is a bare string instead of the OpenAI {url} object',
      should: 'return ok:false with the missing-url error (spec requires an object)',
      actual: result,
      expected: { ok: false, error: 'image_url part must have image_url.url (string)' },
    });
  });

  test('data: URL with no MIME type segment is rejected', () => {
    const part = { type: 'image_url', image_url: { url: 'data:,plaintext' } };
    const result = mapImageUrlPartToFilePart(part);
    assert({
      given: 'a data: URL with no MIME type segment',
      should: 'return ok:false — FileUIPart requires a mediaType and the image validator would reject it downstream anyway',
      actual: result,
      expected: { ok: false, error: 'image_url data: URL must include a MIME type (e.g. data:image/png;base64,...)' },
    });
  });
});
