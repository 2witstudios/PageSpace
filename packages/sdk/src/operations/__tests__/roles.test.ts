import { describe, expect, it } from 'vitest';
import { buildRequest } from '../../transport/build-request.js';
import { parseResponse } from '../../transport/parse-response.js';
import { ResponseValidationError } from '../../errors.js';
import {
  buildRemoveRolePagePermissionsInput,
  buildSetRoleDriveWidePermissionsInput,
  buildSetRolePagePermissionsInput,
  createDriveRole,
  deleteDriveRole,
  getDriveRole,
  listDriveRoles,
  removeRolePagePermissions,
  setRoleDriveWidePermissions,
  setRolePagePermissions,
  updateDriveRole,
} from '../roles.js';

const config = { baseUrl: 'https://pagespace.ai' };

/** Shape verified against packages/lib/src/services/drive-role-service.ts DriveRole (route-serialized: Date -> ISO string). */
const roleFixture = {
  id: 'r1abc',
  driveId: 'd1abc',
  name: 'Editor',
  description: 'Can edit but not share',
  color: '#6366f1',
  isDefault: false,
  permissions: {
    p1abc: { canView: true, canEdit: true, canShare: false },
  },
  driveWidePermissions: { canView: true, canEdit: false, canShare: false },
  position: 1,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-02T00:00:00.000Z',
};

describe('roles.list — request shape', () => {
  it('builds a GET to /api/drives/:driveId/roles', () => {
    const request = buildRequest(listDriveRoles, { driveId: 'd1abc' }, config);
    expect(request.method).toBe('GET');
    expect(request.url).toBe('https://pagespace.ai/api/drives/d1abc/roles');
    expect(request.body).toBeUndefined();
  });

  it('rejects input missing driveId before any network call', () => {
    const result = listDriveRoles.inputSchema.safeParse({});
    expect(result.success).toBe(false);
  });
});

describe('roles.list — response contract', () => {
  it('parses { roles } (route truth: drives/[driveId]/roles/route.ts GET)', () => {
    const result = parseResponse(listDriveRoles, 200, new Headers(), JSON.stringify({ roles: [roleFixture] }));
    expect(result).toEqual({ roles: [roleFixture] });
  });

  it('parses an empty roles list', () => {
    const result = parseResponse(listDriveRoles, 200, new Headers(), JSON.stringify({ roles: [] }));
    expect(result).toEqual({ roles: [] });
  });

  it('rejects a response that drifts from the DriveRole contract', () => {
    const malformed = { roles: [{ ...roleFixture, permissions: 'not-a-record' }] };
    const result = parseResponse(listDriveRoles, 200, new Headers(), JSON.stringify(malformed));
    expect(result).toBeInstanceOf(ResponseValidationError);
  });

  it('classifies a 403 (not a member) as PermissionDeniedError', () => {
    const result = parseResponse(listDriveRoles, 403, new Headers(), JSON.stringify({ error: 'Not a member of this drive' }));
    expect((result as { code: string }).code).toBe('PERMISSION_DENIED');
  });
});

describe('roles.list — metadata', () => {
  it('requires only drive-member scope (read op)', () => {
    expect(listDriveRoles.requiredScope).toBe('drive');
  });
});

describe('roles.get — request shape', () => {
  it('interpolates driveId and roleId with no body', () => {
    const request = buildRequest(getDriveRole, { driveId: 'd1abc', roleId: 'r1abc' }, config);
    expect(request.method).toBe('GET');
    expect(request.url).toBe('https://pagespace.ai/api/drives/d1abc/roles/r1abc');
    expect(request.body).toBeUndefined();
  });
});

describe('roles.get — response contract', () => {
  it('parses { role } (route truth: drives/[driveId]/roles/[roleId]/route.ts GET)', () => {
    const result = parseResponse(getDriveRole, 200, new Headers(), JSON.stringify({ role: roleFixture }));
    expect(result).toEqual({ role: roleFixture });
  });

  it('classifies a 404 (role not found) as NotFoundError', () => {
    const result = parseResponse(getDriveRole, 404, new Headers(), JSON.stringify({ error: 'Role not found' }));
    expect((result as { code: string }).code).toBe('NOT_FOUND');
  });
});

describe('roles.get — metadata', () => {
  it('requires only drive-member scope', () => {
    expect(getDriveRole.requiredScope).toBe('drive');
  });
});

describe('roles.create — request shape', () => {
  it('builds a POST with name + permissions in the body (route requires both)', () => {
    const request = buildRequest(
      createDriveRole,
      { driveId: 'd1abc', name: 'Editor', permissions: { p1abc: { canView: true, canEdit: true, canShare: false } } },
      config,
    );
    expect(request.method).toBe('POST');
    expect(request.url).toBe('https://pagespace.ai/api/drives/d1abc/roles');
    expect(JSON.parse(request.body ?? '{}')).toEqual({
      name: 'Editor',
      permissions: { p1abc: { canView: true, canEdit: true, canShare: false } },
    });
  });

  it('rejects an empty name (route: 1-50 chars)', () => {
    const result = createDriveRole.inputSchema.safeParse({ driveId: 'd1abc', name: '', permissions: {} });
    expect(result.success).toBe(false);
  });

  it('rejects a name over 50 chars', () => {
    const result = createDriveRole.inputSchema.safeParse({ driveId: 'd1abc', name: 'x'.repeat(51), permissions: {} });
    expect(result.success).toBe(false);
  });

  it('rejects a permissions entry missing a required flag (no partial triples)', () => {
    const result = createDriveRole.inputSchema.safeParse({
      driveId: 'd1abc',
      name: 'Editor',
      permissions: { p1abc: { canView: true, canEdit: true } },
    });
    expect(result.success).toBe(false);
  });

  it('accepts an empty permissions map (route requires the key present, not non-empty)', () => {
    const result = createDriveRole.inputSchema.safeParse({ driveId: 'd1abc', name: 'Editor', permissions: {} });
    expect(result.success).toBe(true);
  });
});

describe('roles.create — response contract', () => {
  it('parses a 201 { role }', () => {
    const result = parseResponse(createDriveRole, 201, new Headers(), JSON.stringify({ role: roleFixture }));
    expect(result).toEqual({ role: roleFixture });
  });

  it('classifies a 409 (duplicate name) as a typed error', () => {
    const result = parseResponse(createDriveRole, 409, new Headers(), JSON.stringify({ error: 'A role with this name already exists' }));
    expect(result).not.toBeInstanceOf(ResponseValidationError);
  });
});

describe('roles.create — metadata', () => {
  it('requires drive:admin scope (owner/admin-gated route)', () => {
    expect(createDriveRole.requiredScope).toBe('drive:admin');
  });

  it('states the required authority in its description', () => {
    expect(createDriveRole.description.toLowerCase()).toMatch(/owner|admin/);
  });
});

describe('roles.update — request shape', () => {
  it('sends only the provided fields, never a wholesale permissions map', () => {
    const request = buildRequest(updateDriveRole, { driveId: 'd1abc', roleId: 'r1abc', name: 'Renamed' }, config);
    expect(request.method).toBe('PATCH');
    expect(request.url).toBe('https://pagespace.ai/api/drives/d1abc/roles/r1abc');
    expect(JSON.parse(request.body ?? '{}')).toEqual({ name: 'Renamed' });
  });

  it('can replace driveWidePermissions wholesale (single object, not a per-page map)', () => {
    const request = buildRequest(
      updateDriveRole,
      { driveId: 'd1abc', roleId: 'r1abc', driveWidePermissions: { canView: true, canEdit: false, canShare: false } },
      config,
    );
    expect(JSON.parse(request.body ?? '{}')).toEqual({
      driveWidePermissions: { canView: true, canEdit: false, canShare: false },
    });
  });

  it('can clear driveWidePermissions with an explicit null', () => {
    const request = buildRequest(updateDriveRole, { driveId: 'd1abc', roleId: 'r1abc', driveWidePermissions: null }, config);
    expect(JSON.parse(request.body ?? '{}')).toEqual({ driveWidePermissions: null });
  });

  it('does not accept a wholesale permissions field at all (must use setRolePagePermissions instead)', () => {
    const result = updateDriveRole.inputSchema.safeParse({
      driveId: 'd1abc',
      roleId: 'r1abc',
      permissions: { p1abc: { canView: true, canEdit: true, canShare: true } },
    });
    expect(result.success).toBe(false);
  });
});

describe('roles.update — response contract', () => {
  it('parses { role }', () => {
    const result = parseResponse(updateDriveRole, 200, new Headers(), JSON.stringify({ role: roleFixture }));
    expect(result).toEqual({ role: roleFixture });
  });

  it('classifies a 403 (not owner/admin) as PermissionDeniedError', () => {
    const result = parseResponse(updateDriveRole, 403, new Headers(), JSON.stringify({ error: 'Only owners and admins can update roles' }));
    expect((result as { code: string }).code).toBe('PERMISSION_DENIED');
  });
});

describe('roles.update — metadata', () => {
  it('requires drive:admin scope', () => {
    expect(updateDriveRole.requiredScope).toBe('drive:admin');
  });
});

describe('roles.delete — request shape', () => {
  it('builds a DELETE to /api/drives/:driveId/roles/:roleId', () => {
    const request = buildRequest(deleteDriveRole, { driveId: 'd1abc', roleId: 'r1abc' }, config);
    expect(request.method).toBe('DELETE');
    expect(request.url).toBe('https://pagespace.ai/api/drives/d1abc/roles/r1abc');
    expect(request.body).toBeUndefined();
  });
});

describe('roles.delete — response contract', () => {
  it('parses { success: true }', () => {
    const result = parseResponse(deleteDriveRole, 200, new Headers(), JSON.stringify({ success: true }));
    expect(result).toEqual({ success: true });
  });
});

describe('roles.delete — metadata (high-privilege, destructive, non-idempotent)', () => {
  it('requires drive:admin scope', () => {
    expect(deleteDriveRole.requiredScope).toBe('drive:admin');
  });

  it('is flagged destructive so the CLI requires --yes', () => {
    expect(deleteDriveRole.destructive).toBe(true);
  });

  it('uses DELETE, which isIdempotentMethod classifies as non-idempotent (no auto-retry)', () => {
    expect(deleteDriveRole.method).toBe('DELETE');
  });
});

describe('roles.setPagePermissions — request shape', () => {
  it('sends a permissionsPatch keyed by pageId, never a wholesale permissions replace', () => {
    const request = buildRequest(
      setRolePagePermissions,
      { driveId: 'd1abc', roleId: 'r1abc', permissionsPatch: { p1abc: { canView: true, canEdit: true, canShare: false } } },
      config,
    );
    expect(request.method).toBe('PATCH');
    expect(request.url).toBe('https://pagespace.ai/api/drives/d1abc/roles/r1abc');
    expect(JSON.parse(request.body ?? '{}')).toEqual({
      permissionsPatch: { p1abc: { canView: true, canEdit: true, canShare: false } },
    });
  });

  it('rejects a null entry (this op only sets — removal is a distinct operation)', () => {
    const result = setRolePagePermissions.inputSchema.safeParse({
      driveId: 'd1abc',
      roleId: 'r1abc',
      permissionsPatch: { p1abc: null },
    });
    expect(result.success).toBe(false);
  });

  it('rejects a partial permission triple (an omitted flag is not treated as false)', () => {
    const result = setRolePagePermissions.inputSchema.safeParse({
      driveId: 'd1abc',
      roleId: 'r1abc',
      permissionsPatch: { p1abc: { canView: true, canEdit: true } },
    });
    expect(result.success).toBe(false);
  });
});

describe('roles.setPagePermissions — response contract', () => {
  it('parses { role }', () => {
    const result = parseResponse(setRolePagePermissions, 200, new Headers(), JSON.stringify({ role: roleFixture }));
    expect(result).toEqual({ role: roleFixture });
  });
});

describe('roles.setPagePermissions — metadata', () => {
  it('requires drive:admin scope', () => {
    expect(setRolePagePermissions.requiredScope).toBe('drive:admin');
  });
});

describe('buildSetRolePagePermissionsInput — ergonomic single-page builder (pure)', () => {
  it('nests the flat pageId + flags into a single-entry permissionsPatch', () => {
    const input = buildSetRolePagePermissionsInput({
      driveId: 'd1abc',
      roleId: 'r1abc',
      pageId: 'p1abc',
      canView: true,
      canEdit: true,
      canShare: false,
    });
    expect(input).toEqual({
      driveId: 'd1abc',
      roleId: 'r1abc',
      permissionsPatch: { p1abc: { canView: true, canEdit: true, canShare: false } },
    });
  });

  it('is total and pure — identical input always yields a deep-equal (new) object', () => {
    const args = { driveId: 'd1', roleId: 'r1', pageId: 'p1', canView: false, canEdit: false, canShare: false };
    const a = buildSetRolePagePermissionsInput(args);
    const b = buildSetRolePagePermissionsInput(args);
    expect(a).toEqual(b);
    expect(a).not.toBe(b);
  });
});

describe('roles.setDriveWidePermissions — request shape', () => {
  it('nests canView/canEdit/canShare under driveWidePermissions (single object, no merge needed)', () => {
    const request = buildRequest(
      setRoleDriveWidePermissions,
      { driveId: 'd1abc', roleId: 'r1abc', driveWidePermissions: { canView: true, canEdit: false, canShare: false } },
      config,
    );
    expect(request.method).toBe('PATCH');
    expect(JSON.parse(request.body ?? '{}')).toEqual({
      driveWidePermissions: { canView: true, canEdit: false, canShare: false },
    });
  });

  it('rejects a partial permission triple', () => {
    const result = setRoleDriveWidePermissions.inputSchema.safeParse({
      driveId: 'd1abc',
      roleId: 'r1abc',
      driveWidePermissions: { canView: true },
    });
    expect(result.success).toBe(false);
  });
});

describe('roles.setDriveWidePermissions — response contract', () => {
  it('parses { role }', () => {
    const result = parseResponse(setRoleDriveWidePermissions, 200, new Headers(), JSON.stringify({ role: roleFixture }));
    expect(result).toEqual({ role: roleFixture });
  });
});

describe('roles.setDriveWidePermissions — metadata', () => {
  it('requires drive:admin scope', () => {
    expect(setRoleDriveWidePermissions.requiredScope).toBe('drive:admin');
  });
});

describe('buildSetRoleDriveWidePermissionsInput — ergonomic builder (pure)', () => {
  it('nests the flat flags under driveWidePermissions', () => {
    const input = buildSetRoleDriveWidePermissionsInput({
      driveId: 'd1abc',
      roleId: 'r1abc',
      canView: true,
      canEdit: false,
      canShare: false,
    });
    expect(input).toEqual({
      driveId: 'd1abc',
      roleId: 'r1abc',
      driveWidePermissions: { canView: true, canEdit: false, canShare: false },
    });
  });
});

describe('roles.removePagePermissions — request shape', () => {
  it('sends a permissionsPatch with a null entry (prune, not an explicit all-false grant)', () => {
    const request = buildRequest(
      removeRolePagePermissions,
      { driveId: 'd1abc', roleId: 'r1abc', permissionsPatch: { p1abc: null } },
      config,
    );
    expect(request.method).toBe('PATCH');
    expect(JSON.parse(request.body ?? '{}')).toEqual({ permissionsPatch: { p1abc: null } });
  });

  it('rejects a non-null entry (this op only prunes — setting is a distinct operation)', () => {
    const result = removeRolePagePermissions.inputSchema.safeParse({
      driveId: 'd1abc',
      roleId: 'r1abc',
      permissionsPatch: { p1abc: { canView: true, canEdit: false, canShare: false } },
    });
    expect(result.success).toBe(false);
  });
});

describe('roles.removePagePermissions — response contract', () => {
  it('parses { role }', () => {
    const result = parseResponse(removeRolePagePermissions, 200, new Headers(), JSON.stringify({ role: roleFixture }));
    expect(result).toEqual({ role: roleFixture });
  });
});

describe('roles.removePagePermissions — metadata (destructive: prunes a grant)', () => {
  it('requires drive:admin scope', () => {
    expect(removeRolePagePermissions.requiredScope).toBe('drive:admin');
  });

  it('is flagged destructive so the CLI requires --yes, even though the server-side effect is idempotent', () => {
    expect(removeRolePagePermissions.destructive).toBe(true);
  });
});

describe('buildRemoveRolePagePermissionsInput — ergonomic single-page builder (pure)', () => {
  it('nests the flat pageId into a single-entry null permissionsPatch', () => {
    const input = buildRemoveRolePagePermissionsInput({ driveId: 'd1abc', roleId: 'r1abc', pageId: 'p1abc' });
    expect(input).toEqual({ driveId: 'd1abc', roleId: 'r1abc', permissionsPatch: { p1abc: null } });
  });
});
