/**
 * Declarative rows for the GitHub Actions tools (gh run *, gh workflow *). Token
 * exec, cmd 'gh'. gh_workflow_run's workflow-flag-safety and input-name checks
 * become a single validator wired into both the schema and execute.
 */
import { z } from 'zod';
import { defineRow, type GitToolRow } from './types';
import { cwdField } from './fields';
import { validateFlagSafe, validateWorkflowInputNames } from '../core/validators';
import {
  buildRunListArgs,
  buildRunViewArgs,
  buildRunRerunArgs,
  buildWorkflowListArgs,
  buildWorkflowRunArgs,
} from '../core/command-specs/actions';

export const ACTIONS_TOOL_ROWS: GitToolRow[] = [
  defineRow({
    key: 'gh_run_list',
    group: 'actions',
    cmd: 'gh',
    exec: 'token',
    description:
      'List GitHub Actions workflow runs. Use to check CI status after pushing or to find failing runs. Requires a connected GitHub account.',
    schema: z
      .object({
        branch: z.string().optional(),
        limit: z.number().int().positive().max(50).optional(),
        status: z.enum(['queued', 'in_progress', 'completed']).optional(),
        event: z.string().optional().describe('Filter by trigger event (e.g. "pull_request", "push")'),
        cwd: cwdField,
      })
      .strict(),
    buildArgs: ({ branch, limit, status, event }) => ({ args: buildRunListArgs({ branch, limit, status, event }) }),
  }),
  defineRow({
    key: 'gh_run_view',
    group: 'actions',
    cmd: 'gh',
    exec: 'token',
    description:
      'View details of a specific GitHub Actions run including job-level pass/fail status. Pass log: true to include logs for failed jobs (can be large). Requires a connected GitHub account.',
    schema: z
      .object({
        runId: z.number().int().positive().describe('Run databaseId from gh_run_list'),
        log: z.boolean().optional().describe('Include logs for failed jobs'),
        cwd: cwdField,
      })
      .strict(),
    buildArgs: ({ runId, log }) => ({ args: buildRunViewArgs({ runId, log }) }),
  }),
  defineRow({
    key: 'gh_run_rerun',
    group: 'actions',
    cmd: 'gh',
    exec: 'token',
    description:
      'Re-run a GitHub Actions workflow run. Pass failed_only: true to re-run only the failed jobs (the usual choice for flaky CI). Requires a connected GitHub account.',
    schema: z
      .object({
        runId: z.number().int().positive().describe('Run databaseId from gh_run_list'),
        failed_only: z.boolean().optional().describe('Re-run only the failed jobs'),
        cwd: cwdField,
      })
      .strict(),
    buildArgs: ({ runId, failed_only }) => ({ args: buildRunRerunArgs({ runId, failed_only }) }),
  }),
  defineRow({
    key: 'gh_workflow_list',
    group: 'actions',
    cmd: 'gh',
    exec: 'token',
    description: 'List GitHub Actions workflows in the repository. Requires a connected GitHub account.',
    schema: z
      .object({ limit: z.number().int().positive().max(100).optional(), cwd: cwdField })
      .strict(),
    buildArgs: ({ limit }) => ({ args: buildWorkflowListArgs(limit) }),
  }),
  defineRow({
    key: 'gh_workflow_run',
    group: 'actions',
    cmd: 'gh',
    exec: 'token',
    description:
      'Dispatch a GitHub Actions workflow run on a ref. WARNING: this triggers real automation (deploys, releases, jobs) — only dispatch workflows you understand. The workflow must have a workflow_dispatch trigger. Requires a connected GitHub account.',
    schema: z
      .object({
        workflow: z.string().min(1).describe('Workflow file name (e.g. "ci.yml") or ID'),
        ref: z.string().min(1).describe('Branch or tag to run the workflow on'),
        inputs: z
          .record(z.string(), z.string())
          .optional()
          .describe('workflow_dispatch inputs as key/value pairs'),
        cwd: cwdField,
      })
      .strict(),
    validate: ({ workflow, ref, inputs }) => {
      if (!workflow || !ref) return { ok: false, error: 'workflow and ref are required' };
      const safe = validateFlagSafe(workflow, 'workflow');
      if (!safe.ok) return safe;
      return validateWorkflowInputNames(inputs);
    },
    buildArgs: ({ workflow, ref, inputs }) => ({ args: buildWorkflowRunArgs({ workflow, ref, inputs }) }),
  }),
];
