import { describe, it, expect } from 'vitest';
import {
  isHallucinatedTranscript,
  WHISPER_DICTATION_PROMPT,
} from '../whisper-hallucinations';

describe('isHallucinatedTranscript', () => {
  it('flags empty / whitespace-only transcripts', () => {
    expect(isHallucinatedTranscript('')).toBe(true);
    expect(isHallucinatedTranscript('   ')).toBe(true);
    expect(isHallucinatedTranscript(null)).toBe(true);
    expect(isHallucinatedTranscript(undefined)).toBe(true);
  });

  it('flags known YouTube-style silence hallucinations regardless of casing/punctuation', () => {
    expect(isHallucinatedTranscript('Thank you for watching!')).toBe(true);
    expect(isHallucinatedTranscript('thank you for watching')).toBe(true);
    expect(isHallucinatedTranscript('  Thanks for watching!  ')).toBe(true);
    expect(isHallucinatedTranscript('Please subscribe.')).toBe(true);
    expect(isHallucinatedTranscript('Like and subscribe')).toBe(true);
    expect(isHallucinatedTranscript('"Thank you."')).toBe(true);
    expect(isHallucinatedTranscript('you')).toBe(true);
  });

  it('does NOT flag legitimate speech that merely contains a phrase', () => {
    expect(
      isHallucinatedTranscript('thank you for the help with the report earlier')
    ).toBe(false);
    expect(
      isHallucinatedTranscript('can you subscribe me to the newsletter list')
    ).toBe(false);
    expect(isHallucinatedTranscript('what are you working on today')).toBe(false);
  });

  it('does NOT flag short legitimate replies that are not in the denylist', () => {
    expect(isHallucinatedTranscript('okay')).toBe(false);
    expect(isHallucinatedTranscript('yes please')).toBe(false);
    expect(isHallucinatedTranscript('no')).toBe(false);
  });

  it('exposes a dictation conditioning prompt', () => {
    expect(WHISPER_DICTATION_PROMPT.toLowerCase()).toContain('dictation');
  });
});
