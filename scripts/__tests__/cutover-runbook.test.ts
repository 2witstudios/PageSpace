/**
 * Validation test for the cutover runbook.
 * Asserts the runbook file exists and contains all required sections.
 */
import { describe, it, expect } from 'vitest';
import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';

const RUNBOOK_PATH = path.resolve(
  __dirname,
  '../../docs/runbooks/tenant-migration.md',
);

describe('Cutover Runbook', () => {
  it('exists at docs/runbooks/tenant-migration.md', () => {
    expect(existsSync(RUNBOOK_PATH)).toBe(true);
  });

  it('contains all required sections', async () => {
    const content = await readFile(RUNBOOK_PATH, 'utf-8');

    const requiredSections = [
      'Pre-migration',
      'Export',
      'Import',
      'Validate',
      'DNS Switch',
      'Rollback',
      'Cleanup',
    ];

    for (const section of requiredSections) {
      expect(content).toContain(section);
    }
  });

  it('contains rollback instructions for each phase', async () => {
    const content = await readFile(RUNBOOK_PATH, 'utf-8');

    // Each major section should have a rollback subsection
    expect(content).toContain('Rollback: Pre-migration');
    expect(content).toContain('Rollback: Export');
    expect(content).toContain('Rollback: Import');
    expect(content).toContain('Rollback: Validate');
    expect(content).toContain('Rollback: DNS Switch');
    expect(content).toContain('Rollback: Cleanup');
  });

  it('references the migration scripts', async () => {
    const content = await readFile(RUNBOOK_PATH, 'utf-8');

    expect(content).toContain('tenant-export.ts');
    expect(content).toContain('tenant-import.ts');
    expect(content).toContain('tenant-validate.ts');
  });

  it('documents the 30-day grace period', async () => {
    const content = await readFile(RUNBOOK_PATH, 'utf-8');

    expect(content).toContain('30-day');
  });

  it('includes a summary checklist', async () => {
    const content = await readFile(RUNBOOK_PATH, 'utf-8');

    expect(content).toContain('Summary Checklist');
    expect(content).toContain('- [ ]'); // Markdown checkboxes
  });
});
