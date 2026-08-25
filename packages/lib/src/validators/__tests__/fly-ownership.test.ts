/**
 * `_fly-ownership` TXT pre-validation.
 *
 * The distinction this module exists to draw: through a certificate's status
 * alone, "Fly has not issued yet" and "the customer was never told to publish a
 * record" look identical, and they need opposite responses. So the states here
 * are asserted as four DIFFERENT answers, and in particular `not_required` is
 * never conflated with `satisfied` — the second claims we verified something.
 */
import { describe, expect, it } from 'vitest';
import {
  FLY_OWNERSHIP_TXT_PREFIX,
  acceptedOwnershipValues,
  describeOwnershipVerification,
  flyOwnershipTxtName,
  parseOwnershipTxtValues,
  verifyFlyOwnershipTxt,
  type FlyOwnershipRequirement,
  type FlyOwnershipVerification,
} from '../fly-ownership';
import { assert } from '../../__tests__/riteway';

const requirement: FlyOwnershipRequirement = {
  name: '_fly-ownership.docs.acme.com',
  appValue: 'app-ABC123',
  orgValue: 'org-XYZ789',
};

/** Fly names an org value and no app value — a state `verifyFlyOwnershipTxt` accepts. */
const orgOnlyRequirement: FlyOwnershipRequirement = {
  name: '_fly-ownership.docs.acme.com',
  appValue: '',
  orgValue: 'org-XYZ789',
};

/** The mirror case: an app value and no org value. */
const appOnlyRequirement: FlyOwnershipRequirement = {
  name: '_fly-ownership.docs.acme.com',
  appValue: 'app-ABC123',
  orgValue: '',
};

const verify = (records: string[][], req: FlyOwnershipRequirement | null = requirement) =>
  verifyFlyOwnershipTxt({ requirement: req, records });

describe('flyOwnershipTxtName — where the record must live', () => {
  assert({
    given: 'a hostname',
    should: 'prefix it with the record label Fly reads',
    actual: flyOwnershipTxtName('docs.acme.com'),
    expected: `${FLY_OWNERSHIP_TXT_PREFIX}.docs.acme.com`,
  });

  assert({
    given: 'an uppercased hostname with a trailing dot and whitespace',
    should: 'normalize before prefixing',
    actual: flyOwnershipTxtName('  Docs.ACME.com.  '),
    expected: '_fly-ownership.docs.acme.com',
  });
});

describe('parseOwnershipTxtValues — the two shapes a real TXT answer arrives in', () => {
  assert({
    given: 'a value chunked at the 255-byte TXT limit',
    should: 'concatenate the chunks with no separator, or a long value never matches',
    actual: parseOwnershipTxtValues([['app-', 'ABC', '123']]),
    expected: ['app-ABC123'],
  });

  assert({
    given: 'several ownership values sharing one record, as Fly documents',
    should: 'split on the semicolon, so a hostname serving two Fly apps still validates',
    actual: parseOwnershipTxtValues([['app-ABC123;app-DEF456']]),
    expected: ['app-ABC123', 'app-DEF456'],
  });

  assert({
    given: 'a value stored with zone-file quoting by a DNS UI',
    should: 'strip the surrounding quotes',
    actual: parseOwnershipTxtValues([['"app-ABC123"']]),
    expected: ['app-ABC123'],
  });

  assert({
    given: 'multiple records at the name, one of them unrelated',
    should: 'return every candidate rather than only the first record',
    actual: parseOwnershipTxtValues([['v=spf1 -all'], ['app-ABC123']]),
    expected: ['v=spf1 -all', 'app-ABC123'],
  });

  assert({
    given: 'empty and whitespace-only segments',
    should: 'drop them',
    actual: parseOwnershipTxtValues([['', '  '], [';;']]),
    expected: [],
  });
});

describe('verifyFlyOwnershipTxt — four distinguishable answers', () => {
  assert({
    given: 'Fly asked for no ownership record at all',
    should: 'report not_required — NOT satisfied, which would claim a check we never ran',
    actual: verify([['anything']], null),
    expected: { state: 'not_required' },
  });

  assert({
    given: 'nothing resolves at the record name',
    should: 'report missing, with the record the customer still has to publish',
    actual: verify([]),
    expected: { state: 'missing', expected: requirement },
  });

  assert({
    given: 'the app-scoped value is published',
    should: 'be satisfied',
    actual: verify([['app-ABC123']]),
    expected: { state: 'satisfied' },
  });

  assert({
    given: 'the ORG-scoped value is published instead',
    should: 'also be satisfied, because Fly accepts either',
    actual: verify([['org-XYZ789']]),
    expected: { state: 'satisfied' },
  });

  assert({
    given: 'a case-folded value, as several DNS providers store it',
    should: 'still be satisfied',
    actual: verify([['APP-abc123']]),
    expected: { state: 'satisfied' },
  });

  assert({
    given: 'a record carrying only some other value',
    should: 'report mismatched, and say what was actually found',
    actual: verify([['app-WRONG']]),
    expected: { state: 'mismatched', expected: requirement, found: ['app-WRONG'] },
  });

  assert({
    given: 'the right value alongside an unrelated TXT record at the same name',
    should: 'be satisfied — coexisting records are normal',
    actual: verify([['v=spf1 -all'], ['app-ABC123']]),
    expected: { state: 'satisfied' },
  });

  assert({
    given: 'Fly asked for ownership but named no value to publish',
    should: 'report mismatched rather than satisfied — it is a state nobody can act on',
    actual: verify([['something']], { name: '_fly-ownership.x.com', appValue: '', orgValue: '' }),
    expected: {
      state: 'mismatched',
      expected: { name: '_fly-ownership.x.com', appValue: '', orgValue: '' },
      found: ['something'],
    },
  });
});

describe('describeOwnershipVerification — an instruction only when one is owed', () => {
  it.each([
    ['not_required', { state: 'not_required' } as const],
    ['satisfied', { state: 'satisfied' } as const],
  ])('given %s, should offer no instruction', (_label, result) => {
    expect(describeOwnershipVerification(result)).toBeNull();
  });

  it('given a missing record, should name the record and the value to publish', () => {
    const message = describeOwnershipVerification({ state: 'missing', expected: requirement });
    expect(message).toContain('_fly-ownership.docs.acme.com');
    expect(message).toContain('app-ABC123');
  });

  it('given a mismatch, should name both what was expected and what was found', () => {
    const message = describeOwnershipVerification({
      state: 'mismatched',
      expected: requirement,
      found: ['app-WRONG'],
    });
    expect(message).toContain('app-ABC123');
    expect(message).toContain('app-WRONG');
  });

  it('given a requirement naming both values, should name both, since either satisfies Fly', () => {
    const message = describeOwnershipVerification({ state: 'missing', expected: requirement });
    expect(message).toContain('app-ABC123');
    expect(message).toContain('org-XYZ789');
  });

  // "with the value A or B" reads as ONE value whose text is "A or B" — a string
  // a customer can paste into a TXT record verbatim. The phrasing has to say
  // these are alternatives, and only when there is more than one.
  it('given two accepted values, should present them as alternatives, not as one value', () => {
    const message = describeOwnershipVerification({ state: 'missing', expected: requirement });
    expect(message).toContain('either of these values: app-ABC123 or org-XYZ789');
    expect(message).not.toContain('the value app-ABC123 or');
  });

  it('given one accepted value, should still say "the value", not offer a choice', () => {
    const message = describeOwnershipVerification({ state: 'missing', expected: orgOnlyRequirement });
    expect(message).toContain('the value org-XYZ789');
    expect(message).not.toContain('either of these values');
  });

  // The regression: `verifyFlyOwnershipTxt` accepts an org-only requirement (it
  // filters empty values), but the instruction used to print `appValue`
  // unconditionally — so this state produced a message with a blank where the
  // value belongs, in the one place the customer has nothing else to act on.
  // Typed rather than `as const`: the tuple type checks each row against the real
  // union (which is what `as const` was reaching for) without freezing `found`
  // into a readonly tuple that no longer matches the shipped `string[]`.
  it.each<[string, FlyOwnershipVerification]>([
    ['missing', { state: 'missing', expected: orgOnlyRequirement }],
    ['mismatched', { state: 'mismatched', expected: orgOnlyRequirement, found: ['app-WRONG'] }],
  ])('given an org-only requirement reported as %s, should name the org value', (_label, result) => {
    const message = describeOwnershipVerification(result);
    expect(message).toContain('org-XYZ789');
    expect(message).not.toContain('the value  ');
    expect(message).not.toContain('(expected ;');
  });

  it('given an app-only requirement, should name the app value and not trail an empty alternative', () => {
    const message = describeOwnershipVerification({
      state: 'missing',
      expected: appOnlyRequirement,
    });
    expect(message).toContain('app-ABC123');
    expect(message).not.toContain(' or ');
  });

  // Unreachable through `ownershipRequirementOf`, which returns null when Fly
  // names neither value — asserted anyway because the type permits it and the
  // alternative is an instruction telling the customer to publish nothing.
  it('given a requirement naming no value at all, should say the requirement is unusable', () => {
    const message = describeOwnershipVerification({
      state: 'mismatched',
      expected: { name: '_fly-ownership.docs.acme.com', appValue: '', orgValue: '' },
      found: ['app-WRONG'],
    });
    expect(message).toContain('without naming a value');
  });
});

describe('acceptedOwnershipValues — one definition of acceptable, shared', () => {
  assert({
    given: 'a requirement naming both an app and an org value',
    should: 'offer both, because Fly accepts either',
    actual: acceptedOwnershipValues(requirement),
    expected: ['app-ABC123', 'org-XYZ789'],
  });

  assert({
    given: 'a requirement naming only an org value',
    should: 'drop the empty app value rather than offering a blank',
    actual: acceptedOwnershipValues(orgOnlyRequirement),
    expected: ['org-XYZ789'],
  });

  // The property the shared helper exists for: whatever verification is willing
  // to match against is exactly what the instruction is willing to print.
  it('given an org-only requirement, should agree with what verification accepts', () => {
    expect(verify([['org-XYZ789']], orgOnlyRequirement)).toEqual({ state: 'satisfied' });
    expect(describeOwnershipVerification({ state: 'missing', expected: orgOnlyRequirement })).toContain(
      acceptedOwnershipValues(orgOnlyRequirement)[0],
    );
  });
});
