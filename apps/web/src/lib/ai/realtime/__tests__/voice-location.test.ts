import { describe, expect, it } from 'vitest';
import { voiceLocationContextSchema } from '@pagespace/lib/realtime/voice-bridge-contract';
import { toVoiceLocationContext } from '../voice-location';
import { VOICE_MESSAGE_SOURCE } from '../message-source';
import { MESSAGE_SOURCE_VOICE } from '@pagespace/db/schema/conversations';

/**
 * The two types describe the same idea with different absence conventions
 * (`T | null` on the chat side, `.optional()` on the wire). The failure this
 * guards is silent: a `null` handed straight through fails the realtime
 * server's zod parse, and the symptom is the model answering "this page"
 * wrongly rather than an error anyone sees.
 */
describe('toVoiceLocationContext', () => {
  it('should produce something the wire schema accepts', () => {
    const wire = toVoiceLocationContext({
      currentPage: { id: 'p1', title: 'Notes', type: 'DOCUMENT', path: '/drive/Notes' },
      currentDrive: { id: 'd1', name: 'Drive', slug: 'drive' },
      breadcrumbs: ['Drive', 'Notes'],
    });

    expect(voiceLocationContextSchema.safeParse(wire).success).toBe(true);
  });

  it('should convert the chat side\'s nulls to absence, not pass them through', () => {
    const wire = toVoiceLocationContext({
      currentPage: null,
      currentDrive: { id: 'd1', name: 'Drive', slug: 'drive' },
    });

    expect(wire).not.toBeUndefined();
    expect(wire).not.toHaveProperty('currentPage');
    // The proof that it matters: the schema rejects the un-converted shape.
    expect(
      voiceLocationContextSchema.safeParse({
        currentPage: null,
        currentDrive: { id: 'd1', name: 'Drive', slug: 'drive' },
      }).success,
    ).toBe(false);
    expect(voiceLocationContextSchema.safeParse(wire).success).toBe(true);
  });

  it('should return undefined for nowhere in particular, rather than an empty object', () => {
    // A settings screen is a legitimate "no page, no drive". Sending `{}` would
    // overwrite a location the live call already had with an empty one.
    expect(toVoiceLocationContext(null)).toBeUndefined();
    expect(toVoiceLocationContext(undefined)).toBeUndefined();
    expect(toVoiceLocationContext({})).toBeUndefined();
    expect(
      toVoiceLocationContext({ currentPage: null, currentDrive: null, breadcrumbs: [] }),
    ).toBeUndefined();
  });

  it('should keep the optional page flag only when it was set', () => {
    const withFlag = toVoiceLocationContext({
      currentPage: {
        id: 'p1',
        title: 'T',
        type: 'DOCUMENT',
        path: '/T',
        isTaskLinked: true,
      },
    });
    expect(withFlag?.currentPage?.isTaskLinked).toBe(true);

    const withoutFlag = toVoiceLocationContext({
      currentPage: { id: 'p1', title: 'T', type: 'DOCUMENT', path: '/T' },
    });
    expect(withoutFlag?.currentPage).not.toHaveProperty('isTaskLinked');
  });
});

/**
 * The drift guard promised by `message-source.ts`. Client components cannot
 * import `@pagespace/db/schema`, so the browser reads its own copy of the
 * value — this test is what stops the two from diverging. It runs in node,
 * where importing the schema is free.
 */
describe('VOICE_MESSAGE_SOURCE — drift guard', () => {
  it('should be exactly the value the database schema defines', () => {
    expect(VOICE_MESSAGE_SOURCE).toBe(MESSAGE_SOURCE_VOICE);
  });
});
