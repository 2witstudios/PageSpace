/**
 * Pure argv builders for the GitHub Actions subcommands (gh run *, gh workflow
 * *). No effects. workflow_run input-name validation is a separate pure guard
 * (core/validators.ts) run in the shell before this builds argv. Branch-tested.
 */
import { optArg, optFlag, buildGhJsonFlag, buildApiKvArgs } from '../arg-builders';

export interface RunListArgsInput {
  branch?: string;
  limit?: number;
  status?: 'queued' | 'in_progress' | 'completed';
  event?: string;
}

export function buildRunListArgs({ branch, limit, status, event }: RunListArgsInput): string[] {
  return [
    'run', 'list',
    '--limit', String(limit ?? 10),
    ...optArg('--branch', branch),
    ...optArg('--status', status),
    ...optArg('--event', event),
    ...buildGhJsonFlag([
      'databaseId', 'status', 'conclusion', 'name', 'headBranch', 'event',
      'createdAt', 'displayTitle',
    ]),
  ];
}

export interface RunViewArgsInput {
  runId: number;
  log?: boolean;
}

export function buildRunViewArgs({ runId, log }: RunViewArgsInput): string[] {
  return [
    'run', 'view', String(runId),
    ...optFlag('--log-failed', log),
    // logs and the JSON view are mutually exclusive.
    ...(log
      ? []
      : buildGhJsonFlag(['databaseId', 'status', 'conclusion', 'name', 'headBranch', 'displayTitle', 'jobs'])),
  ];
}

export interface RunRerunArgsInput {
  runId: number;
  failed_only?: boolean;
}

export function buildRunRerunArgs({ runId, failed_only }: RunRerunArgsInput): string[] {
  return ['run', 'rerun', String(runId), ...optFlag('--failed', failed_only)];
}

export function buildWorkflowListArgs(limit?: number): string[] {
  return ['workflow', 'list', '--limit', String(limit ?? 50), ...buildGhJsonFlag(['id', 'name', 'path', 'state'])];
}

export interface WorkflowRunArgsInput {
  workflow: string;
  ref: string;
  inputs?: Record<string, string>;
}

export function buildWorkflowRunArgs({ workflow, ref, inputs }: WorkflowRunArgsInput): string[] {
  return [
    'workflow', 'run', workflow,
    '--ref', ref,
    ...Object.entries(inputs ?? {}).flatMap(([key, value]) => buildApiKvArgs('-f', key, value)),
  ];
}
