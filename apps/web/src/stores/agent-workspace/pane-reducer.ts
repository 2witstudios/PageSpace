/**
 * The pane grid's pure layout model — re-exported from
 * `@pagespace/lib/agent-sessions/workspace-layout-verbs`, where the model
 * MOVED (epic Phase 3) so the browser's optimistic apply and the server's
 * verb engine run the SAME reducer instead of two convention-synced copies.
 * Every transition, type, and doc comment lives there now; this module is
 * the client's import path for them, kept so the store and pane components
 * did not all churn in the move (and until the client store rewrite PR
 * re-points them wholesale).
 *
 * Nothing here may diverge from the shared module — that is the point.
 */

export {
  newWorkspace,
  assignPane,
  assignPaneShowing,
  dismissPicker,
  splitRight,
  splitDown,
  closePane,
  selectPane,
  isLastPane,
  resetPane,
  panesOf,
  paneShowing,
  type PaneState,
  type ColumnState,
  type WorkspaceState,
} from '@pagespace/lib/agent-sessions/workspace-layout-verbs';
