import { describe, it, expect } from 'vitest';
import { buildAdminReadAuditEvent } from '../admin-read-audit';

describe('buildAdminReadAuditEvent (#954)', () => {
  it('builds a distinct admin.data.read event capturing actor, subject and categories', () => {
    const event = buildAdminReadAuditEvent({
      adminUserId: 'admin-1',
      resourceType: 'user_workspace',
      targetUserId: 'subject-9',
      accessedDataCategories: ['workspace_structure', 'page_titles'],
    });

    expect(event.eventType).toBe('admin.data.read');
    expect(event.userId).toBe('admin-1');
    expect(event.resourceId).toBe('subject-9');
    expect(event.details).toMatchObject({
      privilegedAdminRead: true,
      targetUserId: 'subject-9',
      accessedDataCategories: ['workspace_structure', 'page_titles'],
      impersonated: false,
    });
  });

  it('flags impersonated reads with a higher risk score and anomaly flag', () => {
    const event = buildAdminReadAuditEvent({
      adminUserId: 'admin-1',
      resourceType: 'user_workspace',
      targetUserId: 'subject-9',
      accessedDataCategories: ['workspace_structure'],
      impersonated: true,
    });

    expect(event.riskScore).toBe(0.6);
    expect(event.anomalyFlags).toEqual(['admin_impersonation']);
    expect(event.details?.impersonated).toBe(true);
  });

  it('attributes service-token reads to the service, not the impersonated subject', () => {
    const event = buildAdminReadAuditEvent({
      serviceId: 'service-token',
      resourceType: 'admin_global_prompt',
      targetUserId: 'subject-9',
      accessedDataCategories: ['workspace_structure'],
      impersonated: true,
    });

    // Actor is the service; the subject must NOT be recorded as the actor.
    expect(event.serviceId).toBe('service-token');
    expect(event.userId).toBeUndefined();
    expect(event.details?.targetUserId).toBe('subject-9');
    expect(event.details?.actorServiceId).toBe('service-token');
  });

  it('falls back resourceId to resourceType when no id/subject is given', () => {
    const event = buildAdminReadAuditEvent({
      adminUserId: 'admin-1',
      resourceType: 'ai_conversation_stats',
      accessedDataCategories: ['ai_usage'],
    });
    expect(event.resourceId).toBe('ai_conversation_stats');
    expect(event.details?.targetUserId).toBeNull();
  });

  it('is referentially transparent and does not share the categories array', () => {
    const input = {
      adminUserId: 'admin-1',
      resourceType: 'user_workspace',
      accessedDataCategories: ['workspace_structure'],
    };
    const a = buildAdminReadAuditEvent(input);
    const b = buildAdminReadAuditEvent(input);
    expect(a).toEqual(b);
    (a.details?.accessedDataCategories as string[]).push('leak');
    expect((buildAdminReadAuditEvent(input).details?.accessedDataCategories as string[])).toEqual([
      'workspace_structure',
    ]);
  });
});
