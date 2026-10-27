import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { accountRequestBody, canSubmitAccount, refusalCopyFor, type AccountDraft } from './agent-account-form.model';

const complete: AccountDraft = {
  name: 'Weather API',
  origin: 'https://api.example.com',
  apiKey: 'k_123',
  placement: 'bearer',
  placementName: '',
  ownership: 'dedicated',
  acknowledged: false,
  submitting: false,
};

describe('add account validation (IMC-7.30)', () => {
  test('a dedicated account with a name, site, and key can be submitted', () => {
    assert({
      given: 'a complete dedicated-account draft',
      should: 'allow submitting',
      actual: canSubmitAccount(complete),
      expected: true,
    });
  });

  test('a missing name, site, or key blocks the submit', () => {
    assert({
      given: 'drafts with a blank name, a blank site, or no key',
      should: 'block submitting each time',
      actual: [
        canSubmitAccount({ ...complete, name: '  ' }),
        canSubmitAccount({ ...complete, origin: '' }),
        canSubmitAccount({ ...complete, apiKey: '' }),
      ],
      expected: [false, false, false],
    });
  });

  test('a custom header or query placement needs its name', () => {
    assert({
      given: 'a header placement with no name, then with one',
      should: 'block until the header name is typed',
      actual: [
        canSubmitAccount({ ...complete, placement: 'header' }),
        canSubmitAccount({ ...complete, placement: 'query', placementName: 'api_key' }),
      ],
      expected: [false, true],
    });
  });

  test('a personal login needs the acknowledgment before it can be submitted', () => {
    assert({
      given: 'a personal login with and without acknowledgment',
      should: 'allow submitting only once acknowledged',
      actual: [
        canSubmitAccount({ ...complete, ownership: 'personal' }),
        canSubmitAccount({ ...complete, ownership: 'personal', acknowledged: true }),
      ],
      expected: [false, true],
    });
  });

  test('a submit in flight cannot be submitted again', () => {
    assert({
      given: 'a complete draft that is already submitting',
      should: 'block the second submit',
      actual: canSubmitAccount({ ...complete, submitting: true }),
      expected: false,
    });
  });

  test('the body carries the acknowledgment only for a personal login', () => {
    assert({
      given: 'a dedicated draft with a stray acknowledgment, and a personal acknowledged one',
      should: 'post acknowledged only for the personal login, and the bearer key prefixed',
      actual: [
        accountRequestBody({ ...complete, acknowledged: true, allowGenericRequests: false }).acknowledged,
        accountRequestBody({ ...complete, ownership: 'personal', acknowledged: true, allowGenericRequests: true }).acknowledged,
        accountRequestBody({ ...complete, allowGenericRequests: false }).apiKey,
        accountRequestBody({ ...complete, allowGenericRequests: false }).placement,
      ],
      expected: [false, true, 'Bearer k_123', { in: 'header', name: 'Authorization' }],
    });
  });

  test('a refusal reads back as its owner copy', () => {
    assert({
      given: 'a refusal naming origin_invalid, and an unknown failure',
      should: 'show the matching copy, or the generic one',
      actual: [
        refusalCopyFor(new Error('{"error":"origin_invalid"}')),
        refusalCopyFor(new Error('boom')),
      ],
      expected: [
        'The site address must be an https:// address with no path, like https://api.example.com.',
        'The account could not be added.',
      ],
    });
  });
});
