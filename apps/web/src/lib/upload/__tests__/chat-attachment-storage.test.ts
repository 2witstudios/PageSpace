import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockCheckObjectExists = vi.fn();
const mockPutObject = vi.fn();

vi.mock('@/lib/upload/s3-effects', () => ({
  checkObjectExists: (...args: unknown[]) => mockCheckObjectExists(...args),
  putObject: (...args: unknown[]) => mockPutObject(...args),
}));

const mockGetSignedUrl = vi.fn();
vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: (...args: unknown[]) => mockGetSignedUrl(...args),
}));

vi.mock('@/lib/presigned-url', () => ({
  getS3Client: () => ({}),
  getS3Bucket: () => 'test-bucket',
}));

import {
  buildChatAttachmentKey,
  uploadChatAttachment,
  parseChatAttachmentStorageKey,
  parseChatAttachmentContentHash,
  hashAttachmentBuffer,
  getChatAttachmentUrl,
  isChatAttachmentStorageKey,
} from '../chat-attachment-storage';

beforeEach(() => {
  vi.clearAllMocks();
  mockPutObject.mockResolvedValue(undefined);
  mockGetSignedUrl.mockResolvedValue('https://signed.example.com/get');
});

describe('buildChatAttachmentKey', () => {
  it('given a content hash, should build a key outside the global files/ prefix', () => {
    const key = buildChatAttachmentKey('abc123');
    expect(key.startsWith('files/')).toBe(false);
    expect(key).toBe('chat-attachments/abc123/original');
  });
});

describe('uploadChatAttachment', () => {
  const buffer = Buffer.from('hello world');
  const mediaType = 'image/png';

  it('given the object already exists, should skip the PUT entirely (dedup)', async () => {
    mockCheckObjectExists.mockResolvedValue(true);

    const result = await uploadChatAttachment(buffer, mediaType);

    expect(mockPutObject).not.toHaveBeenCalled();
    expect(result.storageKey.startsWith('files/')).toBe(false);
    expect(result.storageKey).toBe(buildChatAttachmentKey(result.contentHash));
  });

  it('given the object does not exist, should PUT the bytes directly to S3', async () => {
    mockCheckObjectExists.mockResolvedValue(false);

    const result = await uploadChatAttachment(buffer, mediaType);

    expect(mockPutObject).toHaveBeenCalledWith(result.storageKey, buffer, mediaType);
  });

  it('given the same bytes twice, should produce the same content-addressed storage key', async () => {
    mockCheckObjectExists.mockResolvedValue(false);

    const first = await uploadChatAttachment(buffer, mediaType);
    const second = await uploadChatAttachment(Buffer.from('hello world'), mediaType);

    expect(second.storageKey).toBe(first.storageKey);
    expect(second.contentHash).toBe(first.contentHash);
  });

  it('given the PUT rejects, should propagate the error', async () => {
    mockCheckObjectExists.mockResolvedValue(false);
    mockPutObject.mockRejectedValue(new Error('S3 unavailable'));

    await expect(uploadChatAttachment(buffer, mediaType)).rejects.toThrow('S3 unavailable');
  });

  it('given a buffer over the 4MB cap, should throw without touching S3', async () => {
    const oversized = Buffer.alloc(4 * 1024 * 1024 + 1);

    await expect(uploadChatAttachment(oversized, mediaType)).rejects.toThrow(/exceeds/i);

    expect(mockCheckObjectExists).not.toHaveBeenCalled();
    expect(mockPutObject).not.toHaveBeenCalled();
  });

  it('given a buffer exactly at the 4MB cap, should upload normally', async () => {
    mockCheckObjectExists.mockResolvedValue(false);
    const atLimit = Buffer.alloc(4 * 1024 * 1024);

    const result = await uploadChatAttachment(atLimit, mediaType);

    expect(result.storageKey).toBe(buildChatAttachmentKey(result.contentHash));
    expect(mockPutObject).toHaveBeenCalled();
  });
});

describe('echoed chat-attachment recognition — anchored to our storage', () => {
  // getS3Bucket is mocked to 'test-bucket' above; the endpoint is read from env.
  const HASH = 'ab'.repeat(32);
  const KEY = `chat-attachments/${HASH}/original`;

  beforeEach(() => {
    vi.stubEnv('AWS_ENDPOINT_URL_S3', 'https://s3.example.com');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const accepted: Array<[string, string]> = [
    ['the exact storage key', KEY],
    ['a virtual-hosted presigned URL on our endpoint', `https://test-bucket.s3.example.com/${KEY}?X-Amz-Signature=abc&X-Amz-Expires=3600`],
    ['a path-style presigned URL on our endpoint', `https://s3.example.com/test-bucket/${KEY}?X-Amz-Signature=abc`],
  ];

  it.each(accepted)('given %s, should recover the key and its hash', (_label, value) => {
    expect(parseChatAttachmentStorageKey(value)).toBe(KEY);
    expect(parseChatAttachmentContentHash(value)).toBe(HASH);
  });

  const rejected: Array<[string, string]> = [
    ['an attacker host with the key in its query string', `https://attacker.example/image.png?ref=${KEY}`],
    ['an attacker host with the key as its path', `https://attacker.example/${KEY}`],
    ['an attacker host with our bucket and the key as its path', `https://attacker.example/test-bucket/${KEY}`],
    ['a look-alike host that merely ends with our endpoint', `https://test-bucket.s3.example.com.attacker.example/${KEY}`],
    ['our endpoint with credentials in the URL', `https://user:pw@test-bucket.s3.example.com/${KEY}`],
    ['our endpoint with the key behind a fragment', `https://test-bucket.s3.example.com/x#/${KEY}`],
    ['our endpoint with a different bucket (path-style)', `https://s3.example.com/other-bucket/${KEY}`],
    ['our endpoint with a key suffix', `https://test-bucket.s3.example.com/${KEY}/extra`],
    ['our endpoint over plain http when the endpoint is https', `http://test-bucket.s3.example.com/${KEY}`],
    ['a hash of the wrong length', 'https://test-bucket.s3.example.com/chat-attachments/deadbeef/original'],
    ['an arbitrary external URL', 'https://example.com/img.png'],
    ['a data: URL', 'data:image/png;base64,aGVsbG8='],
    ['a page-file key', `files/${HASH}/original`],
    ['a key with leading text', `x${KEY}`],
  ];

  it.each(rejected)('given %s, should not treat it as ours', (_label, value) => {
    expect(parseChatAttachmentStorageKey(value)).toBeNull();
    expect(parseChatAttachmentContentHash(value)).toBeNull();
  });

  it('given no custom endpoint, should accept the AWS virtual-hosted and path-style hosts for the region only', () => {
    vi.stubEnv('AWS_ENDPOINT_URL_S3', '');
    vi.stubEnv('AWS_REGION', 'eu-west-2');

    expect(parseChatAttachmentStorageKey(`https://test-bucket.s3.eu-west-2.amazonaws.com/${KEY}?X-Amz-Signature=x`)).toBe(KEY);
    expect(parseChatAttachmentStorageKey(`https://s3.eu-west-2.amazonaws.com/test-bucket/${KEY}`)).toBe(KEY);
    expect(parseChatAttachmentStorageKey(`https://test-bucket.s3.us-east-1.amazonaws.com/${KEY}`)).toBeNull();
    expect(parseChatAttachmentStorageKey(`https://attacker.example/${KEY}`)).toBeNull();
  });
});

describe('hashAttachmentBuffer', () => {
  it('should be the sha256 hex of the bytes — the hash the storage key is built from', () => {
    expect(hashAttachmentBuffer(Buffer.from('hello world'))).toBe(
      'b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9',
    );
  });
});

describe('getChatAttachmentUrl — key scope', () => {
  const HASH = 'a'.repeat(64);
  const OWN_KEY = `chat-attachments/${HASH}/original`;

  it('given a key this module minted, should sign a GET for exactly that key', async () => {
    const url = await getChatAttachmentUrl(OWN_KEY);

    expect(url).toBe('https://signed.example.com/get');
    expect(mockGetSignedUrl).toHaveBeenCalledTimes(1);
    const command = mockGetSignedUrl.mock.calls[0][1] as { input: { Bucket: string; Key: string } };
    expect(command.input).toEqual({ Bucket: 'test-bucket', Key: OWN_KEY });
  });

  it('given the key uploadChatAttachment returns, should accept it (mint and check agree)', async () => {
    mockCheckObjectExists.mockResolvedValue(true);
    const { storageKey } = await uploadChatAttachment(Buffer.from('hello world'), 'image/png');

    expect(isChatAttachmentStorageKey(storageKey)).toBe(true);
  });

  const refused: Array<[string, unknown]> = [
    ["another tenant's page file", `files/${HASH}/original`],
    ['a processor cache object', `cache/${HASH}/ai-vision`],
    ['an avatar', 'avatars/user-1/avatar.png'],
    ['a valid prefix followed by /../ traversal', `chat-attachments/${HASH}/original/../../../files/${HASH}/original`],
    ['traversal in place of the hash', `chat-attachments/../files/${HASH}/original`],
    ['a non-hex hash', `chat-attachments/${'g'.repeat(64)}/original`],
    ['an uppercase-hex hash', `chat-attachments/${'A'.repeat(64)}/original`],
    ['a short hash', 'chat-attachments/deadbeef/original'],
    ['a long hash', `chat-attachments/${'a'.repeat(65)}/original`],
    ['a different leaf', `chat-attachments/${HASH}/thumbnail`],
    ['a leading path segment', `files/${OWN_KEY}`],
    ['a leading slash', `/${OWN_KEY}`],
    ['a trailing suffix', `${OWN_KEY}/extra`],
    ['a trailing newline', `${OWN_KEY}\n`],
    ['a full URL containing a valid key', `https://bucket.example.com/${OWN_KEY}`],
    ['a query string after a valid key', `${OWN_KEY}?versionId=1`],
    ['an empty string', ''],
    ['a non-string', { toString: () => OWN_KEY }],
  ];

  it.each(refused)('given %s, should throw without signing anything', async (_label, key) => {
    expect(isChatAttachmentStorageKey(key)).toBe(false);
    await expect(getChatAttachmentUrl(key as string)).rejects.toThrow(/refusing to sign/i);
    expect(mockGetSignedUrl).not.toHaveBeenCalled();
  });
});
