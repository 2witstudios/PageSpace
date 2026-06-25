import { describe, it, expect } from 'vitest';
import { nextCertAction, certActionToDbStatus, isCertEligible, isServingStatus } from '../cert-action';
import type { FlyCertResponse } from '../cert-action';

const ok = (configured: boolean): FlyCertResponse => ({ ok: true, configured });
const err = (error: string): FlyCertResponse => ({ ok: false, error });

describe('nextCertAction', () => {
  describe('verified → provision', () => {
    it('returns provision when domain is verified and cert not yet configured', () => {
      const action = nextCertAction('verified', ok(false));
      expect(action.action).toBe('provision');
    });

    it('returns mark-active when domain is verified and cert already configured', () => {
      const action = nextCertAction('verified', ok(true));
      expect(action.action).toBe('mark-active');
    });
  });

  describe('cert_failed → retry provision', () => {
    it('returns provision when domain is cert_failed and cert not yet configured', () => {
      const action = nextCertAction('cert_failed', ok(false));
      expect(action.action).toBe('provision');
    });

    it('returns mark-active when domain is cert_failed and cert is now configured', () => {
      const action = nextCertAction('cert_failed', ok(true));
      expect(action.action).toBe('mark-active');
    });
  });

  describe('provisioning + pending → poll', () => {
    it('returns poll-again when domain is provisioning and cert not yet configured', () => {
      const action = nextCertAction('provisioning', ok(false));
      expect(action.action).toBe('poll-again');
    });

    it('returns mark-active when domain is provisioning and cert is now configured', () => {
      const action = nextCertAction('provisioning', ok(true));
      expect(action.action).toBe('mark-active');
    });
  });

  describe('active → re-check', () => {
    it('returns mark-active when domain is active and cert remains configured', () => {
      const action = nextCertAction('active', ok(true));
      expect(action.action).toBe('mark-active');
    });

    it('returns poll-again when domain is active but cert is no longer configured', () => {
      const action = nextCertAction('active', ok(false));
      expect(action.action).toBe('poll-again');
    });
  });

  describe('Fly error → mark-failed', () => {
    it('returns mark-failed with reason when Fly returns an error for verified domain', () => {
      const action = nextCertAction('verified', err('Fly API timeout'));
      expect(action.action).toBe('mark-failed');
      if (action.action === 'mark-failed') {
        expect(action.reason).toMatch(/Fly API timeout/);
      }
    });

    it('returns mark-failed when Fly returns an error for provisioning domain', () => {
      const action = nextCertAction('provisioning', err('certificate not found'));
      expect(action.action).toBe('mark-failed');
      if (action.action === 'mark-failed') {
        expect(action.reason).toMatch(/certificate not found/);
      }
    });

    it('returns mark-failed with generic message when error string is empty', () => {
      const action = nextCertAction('verified', err(''));
      expect(action.action).toBe('mark-failed');
      if (action.action === 'mark-failed') {
        expect(action.reason).toBeTruthy();
      }
    });
  });
});

describe('certActionToDbStatus', () => {
  it('provision action maps to provisioning DB status', () => {
    expect(certActionToDbStatus({ action: 'provision' })).toBe('provisioning');
  });

  it('poll-again action maps to provisioning DB status', () => {
    expect(certActionToDbStatus({ action: 'poll-again' })).toBe('provisioning');
  });

  it('mark-active action maps to active DB status', () => {
    expect(certActionToDbStatus({ action: 'mark-active' })).toBe('active');
  });

  it('mark-failed action maps to cert_failed DB status', () => {
    expect(certActionToDbStatus({ action: 'mark-failed', reason: 'boom' })).toBe('cert_failed');
  });
});

describe('isCertEligible', () => {
  it('returns true for verified', () => expect(isCertEligible('verified')).toBe(true));
  it('returns true for provisioning', () => expect(isCertEligible('provisioning')).toBe(true));
  it('returns true for active', () => expect(isCertEligible('active')).toBe(true));
  it('returns true for cert_failed', () => expect(isCertEligible('cert_failed')).toBe(true));
  it('returns false for pending', () => expect(isCertEligible('pending')).toBe(false));
  it('returns false for dns_failed', () => expect(isCertEligible('dns_failed')).toBe(false));
  it('returns false for failed (legacy)', () => expect(isCertEligible('failed')).toBe(false));
});

describe('isServingStatus', () => {
  // Serving = DNS-confirmed host that should hold mirrored content, independent
  // of cert state. Asserted for EVERY status value in the enum.
  it('returns true for verified', () => expect(isServingStatus('verified')).toBe(true));
  it('returns true for provisioning', () => expect(isServingStatus('provisioning')).toBe(true));
  it('returns true for active', () => expect(isServingStatus('active')).toBe(true));
  it('returns false for pending', () => expect(isServingStatus('pending')).toBe(false));
  it('returns false for dns_failed', () => expect(isServingStatus('dns_failed')).toBe(false));
  it('returns false for cert_failed', () => expect(isServingStatus('cert_failed')).toBe(false));
  it('returns false for failed (legacy)', () => expect(isServingStatus('failed')).toBe(false));
  it('returns false for an unknown status', () => expect(isServingStatus('bogus')).toBe(false));
});
