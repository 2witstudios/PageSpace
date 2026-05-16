/**
 * Whisper silence-hallucination filtering.
 *
 * Whisper (including OpenAI's cloud `whisper-1`) was trained on large amounts
 * of YouTube audio. When it decodes a segment that is silent or near-silent it
 * tends to emit boilerplate phrases that were never spoken — "Thank you for
 * watching!", "Please subscribe", "Thanks for watching!", etc. Cloud APIs do
 * not expose the local `no_speech_threshold` parameter, so a recording that
 * captures leading/trailing silence (very common in conversation mode, where
 * auto-listen re-arms the mic after TTS) can produce a fully fabricated
 * transcript. In auto-send mode that fabricated text gets pushed to the LLM as
 * a real user turn.
 *
 * This module provides a conservative denylist check: it only flags a
 * transcript when the *entire* utterance is a known hallucination phrase, so
 * legitimate speech that merely contains one of these phrases is never
 * dropped. See https://github.com/OpenWhispr/openwhispr/issues/462.
 */

/**
 * Conditioning prompt passed to the Whisper API. Biasing the decoder toward a
 * dictation context discourages the YouTube-style completions the model
 * otherwise falls back to during silence.
 */
export const WHISPER_DICTATION_PROMPT =
  'The following is a voice dictation transcript of a user speaking to an assistant.';

const HALLUCINATION_PHRASES: readonly string[] = [
  'thank you for watching',
  'thanks for watching',
  'thank you for watching!',
  'thanks for watching!',
  'thank you for watching this video',
  'thank you so much for watching',
  'please subscribe',
  'please subscribe to my channel',
  'please subscribe to the channel',
  'subscribe to my channel',
  'like and subscribe',
  'don\'t forget to subscribe',
  'see you in the next video',
  'see you next time',
  'see you in the next one',
  'thanks for listening',
  'thank you for listening',
  'thank you',
  'you',
];

/**
 * Normalize for comparison: trim, lowercase, strip surrounding quotes/brackets
 * and trailing punctuation, collapse internal whitespace.
 */
function normalize(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/^[\s"'“”‘’\[\(]+|[\s"'“”‘’\]\)]+$/g, '')
    .replace(/[.!?…]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Returns true when the transcript is, in its entirety, a known Whisper
 * silence-hallucination phrase (or is effectively empty). Substring matches
 * are intentionally NOT flagged — real speech such as "thank you for the help
 * earlier" must pass through untouched.
 */
export function isHallucinatedTranscript(text: string | null | undefined): boolean {
  if (!text) return true;
  const normalized = normalize(text);
  if (normalized.length === 0) return true;
  return HALLUCINATION_PHRASES.includes(normalized);
}
