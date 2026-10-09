export type ActivityAction = 'rollback';

export interface ActivityChangeSummary {
  id: string;
  label: string;
  description?: string;
  fields?: string[];
  resource?: {
    type: string;
    id: string;
    title: string;
  };
}

export interface ActivityActionPreview {
  action: ActivityAction;
  canExecute: boolean;
  reason?: string;
  warnings: string[];
  hasConflict: boolean;
  conflictFields: string[];
  requiresForce: boolean;
  isNoOp: boolean;
  currentValues: Record<string, unknown> | null;
  targetValues: Record<string, unknown> | null;
  changes: ActivityChangeSummary[];
  affectedResources: { type: string; id: string; title: string }[];
}

export interface ActivityActionResult {
  action: ActivityAction;
  status: 'success' | 'no_op' | 'failed';
  message: string;
  warnings: string[];
  changesApplied: ActivityChangeSummary[];
}
