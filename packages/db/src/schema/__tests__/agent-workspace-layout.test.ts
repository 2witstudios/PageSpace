/**
 * Agent Workspace Layout Schema Unit Tests
 *
 * Validates the relational pane-grid tables (epic Phase 3, the #2202
 * machine-panes pattern re-cut for agent sessions): columns, compound PKs,
 * composite FK cascade, and the rev counter living in its OWN table (never a
 * column on `agent_workspaces` — the serializing `rev + 1` row lock must not
 * contend with sandbox teardown/ensure CAS writes). Runs without a database.
 */
import { describe, it, expect } from 'vitest';
import { getTableColumns } from 'drizzle-orm';
import { getTableConfig } from 'drizzle-orm/pg-core';
import {
  agentWorkspacePaneColumns,
  agentWorkspacePanes,
  agentWorkspaceLayoutRevs,
  agentWorkspaceLayoutOps,
} from '../agent-workspace-layout';

describe('agent_workspace_pane_columns', () => {
  const columns = getTableColumns(agentWorkspacePaneColumns);

  it('has client-minted id (no default generator) and required workspaceId/orderIndex', () => {
    expect(columns.id.notNull).toBe(true);
    expect(columns.id.hasDefault).toBe(false);
    expect(columns.workspaceId.notNull).toBe(true);
    expect(columns.orderIndex.notNull).toBe(true);
  });

  it('reserves widthFraction as nullable (deferred resize verbs)', () => {
    expect(columns.widthFraction.notNull).toBe(false);
  });

  it('is keyed by the compound (workspaceId, id) — two workspaces may mint the same column id', () => {
    const { primaryKeys } = getTableConfig(agentWorkspacePaneColumns);
    expect(primaryKeys).toHaveLength(1);
    expect(primaryKeys[0].columns.map((c) => c.name).sort()).toEqual(['id', 'workspaceId']);
  });

  it('indexes the workspace slice', () => {
    const { indexes } = getTableConfig(agentWorkspacePaneColumns);
    expect(indexes.some((index) => index.config.name === 'agent_workspace_pane_columns_workspace_idx')).toBe(true);
  });
});

describe('agent_workspace_panes', () => {
  const columns = getTableColumns(agentWorkspacePanes);

  it('has client-minted id, and nullable kind/targetId (NULL kind = unbound picker pane)', () => {
    expect(columns.id.notNull).toBe(true);
    expect(columns.id.hasDefault).toBe(false);
    expect(columns.kind.notNull).toBe(false);
    expect(columns.targetId.notNull).toBe(false);
  });

  it('carries NO name and NO agentPageId — both derive at read time (stale-label drift class)', () => {
    expect(columns).not.toHaveProperty('name');
    expect(columns).not.toHaveProperty('agentPageId');
    expect(columns).not.toHaveProperty('sessionName');
  });

  it('reserves heightFraction as nullable (deferred resize verbs)', () => {
    expect(columns.heightFraction.notNull).toBe(false);
  });

  it('is keyed by the compound (workspaceId, id)', () => {
    const { primaryKeys } = getTableConfig(agentWorkspacePanes);
    expect(primaryKeys).toHaveLength(1);
    expect(primaryKeys[0].columns.map((c) => c.name).sort()).toEqual(['id', 'workspaceId']);
  });

  it('cascades from its column via the composite (workspaceId, columnId) FK', () => {
    const { foreignKeys } = getTableConfig(agentWorkspacePanes);
    const columnFk = foreignKeys.find((fk) =>
      fk.reference().foreignTable === agentWorkspacePaneColumns,
    );
    expect(columnFk).toBeDefined();
    expect(columnFk!.onDelete).toBe('cascade');
    expect(columnFk!.reference().columns.map((c) => c.name).sort()).toEqual(['columnId', 'workspaceId']);
  });
});

describe('agent_workspace_layout_revs', () => {
  it('is its own table keyed by workspaceId with rev defaulting to 0', () => {
    const columns = getTableColumns(agentWorkspaceLayoutRevs);
    expect(columns.workspaceId.primary).toBe(true);
    expect(columns.rev.notNull).toBe(true);
    expect(columns.rev.hasDefault).toBe(true);
  });
});

describe('agent_workspace_layout_ops', () => {
  it('is keyed by the compound (workspaceId, opId) — one memory row per recent op', () => {
    const { primaryKeys } = getTableConfig(agentWorkspaceLayoutOps);
    expect(primaryKeys).toHaveLength(1);
    expect(primaryKeys[0].columns.map((c) => c.name).sort()).toEqual(['opId', 'workspaceId']);
  });

  it('records the produced rev and whether the op applied', () => {
    const columns = getTableColumns(agentWorkspaceLayoutOps);
    expect(columns.rev.notNull).toBe(true);
    expect(columns.applied.notNull).toBe(true);
    expect(columns.createdAt.hasDefault).toBe(true);
  });
});
