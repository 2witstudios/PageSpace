import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { domainCountLabel, domainStatusLabel, imageUrlError, needsDnsRecords } from './domain-settings-model';

describe('domainStatusLabel', () => {
  test('a live certificate reads Secure, a domain waiting on DNS reads DNS not found', () => {
    assert({
      given: 'an active domain and a pending one',
      should: 'label the active row Secure and the pending row DNS not found',
      actual: [domainStatusLabel('active'), domainStatusLabel('pending')],
      expected: ['Secure', 'DNS not found'],
    });
  });

  test('every failure state has its own label', () => {
    assert({
      given: 'the failed, DNS failed, and SSL failed states',
      should: 'label each one distinctly',
      actual: [domainStatusLabel('failed'), domainStatusLabel('dns_failed'), domainStatusLabel('cert_failed')],
      expected: ['DNS failed', 'DNS failed', 'SSL failed'],
    });
  });
});

describe('needsDnsRecords', () => {
  test('a pending or failed domain opens its DNS record table by default', () => {
    assert({
      given: 'pending, failed and dns_failed domains, and an active one',
      should: 'open the records for the first three and not for the active one',
      actual: [needsDnsRecords('pending'), needsDnsRecords('failed'), needsDnsRecords('dns_failed'), needsDnsRecords('active')],
      expected: [true, true, true, false],
    });
  });
});

describe('domainCountLabel', () => {
  test('reads "N of M on your plan"', () => {
    assert({
      given: 'two domains on a plan that allows three',
      should: 'read 2 of 3 on your plan',
      actual: domainCountLabel(2, 3),
      expected: '2 of 3 on your plan',
    });
  });
});

describe('imageUrlError', () => {
  test('an empty value is allowed, since it clears the setting', () => {
    assert({
      given: 'a blank favicon URL',
      should: 'report no error',
      actual: imageUrlError('   '),
      expected: null,
    });
  });

  test('a full https or http address passes', () => {
    assert({
      given: 'an https favicon URL and an http one',
      should: 'report no error for either',
      actual: [imageUrlError('https://cdn.example.test/mark.png'), imageUrlError('http://example.test/mark.ico')],
      expected: [null, null],
    });
  });

  test('a value that is not a full http or https address is reported inline', () => {
    assert({
      given: 'a bare hostname, a javascript: URL and a relative path',
      should: 'report the same message for each',
      actual: [
        imageUrlError('studio-mark.png'),
        imageUrlError('javascript:alert(1)'),
        imageUrlError('/mark.png'),
      ].map((error) => error !== null),
      expected: [true, true, true],
    });
  });
});
