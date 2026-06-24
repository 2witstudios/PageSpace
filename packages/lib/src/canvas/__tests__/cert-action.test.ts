import { describe, it, expect } from 'vitest';
import { nextCertAction } from '../cert-action';
import type { FlyCertResponse, CertActionStatus } from '../cert-action';

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

describe('nextCertAction DB status mapping', () => {
  it('provision action maps to provisioning DB status', () => {
    const action = nextCertAction('verified', ok(false));
    expect(action.action).toBe('provision');
    // The caller is responsible for mapping provision → 'provisioning' in the DB
    // But let's verify the nextDbStatus helper works correctly
    const status = certActionToStatus(action.action);
    expect(status).toBe('provisioning');
  });

  it('mark-active action maps to active DB status', () => {
    const action = nextCertAction('verified', ok(true));
    expect(certActionToStatus(action.action)).toBe('active');
  });

  it('mark-failed action maps to failed DB status', () => {
    const action = nextCertAction('verified', err('boom'));
    expect(certActionToStatus(action.action)).toBe('failed');
  });

  it('poll-again action maps to provisioning DB status', () => {
    const action = nextCertAction('provisioning', ok(false));
    expect(certActionToStatus(action.action)).toBe('provisioning');
  });
});

function certActionToStatus(action: CertActionStatus): 'provisioning' | 'active' | 'failed' {
  switch (action) {
    case 'provision':
    case 'poll-again':
      return 'provisioning';
    case 'mark-active':
      return 'active';
    case 'mark-failed':
      return 'failed';
  }
}
