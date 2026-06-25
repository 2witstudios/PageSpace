import { describe, it, expect } from 'vitest';
import {
  classifyProcessing,
  UNCLASSIFIED_RECORD,
  type Art30Record,
} from '../classify-processing';

describe('classifyProcessing (Art 30 record of processing)', () => {
  it('classifies content resources under contract / account_lifetime', () => {
    const record = classifyProcessing('create', 'page');
    expect(record).toEqual<Art30Record>({
      dataCategory: 'content',
      legalBasis: 'contract',
      retentionPolicy: 'account_lifetime',
      recipients: ['internal'],
    });
  });

  it('marks file content as also flowing to the storage subprocessor', () => {
    expect(classifyProcessing('upload', 'file').recipients).toEqual(['internal', 'storage_subprocessor']);
  });

  it('classifies identity (user) data', () => {
    expect(classifyProcessing('profile_update', 'user').dataCategory).toBe('identity');
  });

  it('treats security/auth operations as legitimate interest with security-log retention', () => {
    const login = classifyProcessing('login', 'user');
    expect(login.legalBasis).toBe('legitimate_interest');
    expect(login.retentionPolicy).toBe('security_log_retention');
  });

  it('classifies authentication resources (token/device) with security-log retention', () => {
    expect(classifyProcessing('token_create', 'token')).toEqual<Art30Record>({
      dataCategory: 'authentication',
      legalBasis: 'legitimate_interest',
      retentionPolicy: 'security_log_retention',
      recipients: ['internal'],
    });
  });

  it('classifies access-control resources', () => {
    expect(classifyProcessing('permission_grant', 'permission').dataCategory).toBe('access_control');
    expect(classifyProcessing('member_add', 'member').dataCategory).toBe('access_control');
  });

  it('returns the defined unclassified fallback for an unmapped resourceType', () => {
    expect(classifyProcessing('create', 'totally_unknown')).toEqual(UNCLASSIFIED_RECORD);
  });

  it('never throws on arbitrary input', () => {
    expect(() => classifyProcessing('', '')).not.toThrow();
    expect(classifyProcessing('', '').dataCategory).toBe('unclassified');
  });

  it('is referentially transparent for the same inputs', () => {
    expect(classifyProcessing('create', 'page')).toEqual(classifyProcessing('create', 'page'));
  });

  it('does not share mutable recipient arrays between calls', () => {
    const a = classifyProcessing('create', 'page');
    a.recipients.push('leak');
    const b = classifyProcessing('create', 'page');
    expect(b.recipients).toEqual(['internal']);
  });
});
