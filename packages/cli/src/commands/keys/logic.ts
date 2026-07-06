/**
 * Pure decision logic for the `pagespace keys` wizard (Phase 9 task 5) — no
 * `@clack/prompts` import, no I/O, total functions only. `wizard.ts` is the
 * thin effects layer that calls `@clack/prompts` and feeds real terminal
 * input through these functions; every branch of "what step comes next" is
 * decided here so it's unit-testable without a real terminal.
 *
 * Scope-building deliberately delegates to `buildTokenScope`
 * (`../tokens/create.js`) rather than re-validating drive/role input a
 * second time — the wizard's per-drive role selection is just a different
 * *input shape* (`DriveRoleSelection[]`) for the exact same wire grammar
 * `tokens create --drive --role` already builds and tests.
 */
import type { DriveScopeArg } from '../tokens/args.js';
import { buildTokenScope, type BuildTokenScopeResult } from '../tokens/create.js';

export type WizardMenuChoice = 'create' | 'list' | 'edit' | 'revoke' | 'exit';

const MENU_LABELS: Record<WizardMenuChoice, string> = {
  create: 'Create a new key',
  list: 'List keys',
  edit: 'Edit scope',
  revoke: 'Revoke a key',
  exit: 'Exit',
};

/** Edit/Revoke both require selecting from an existing key — omit them from the menu when there is nothing to select. */
export function availableMenuChoices(keyCount: number): readonly WizardMenuChoice[] {
  return keyCount > 0 ? ['create', 'list', 'edit', 'revoke', 'exit'] : ['create', 'list', 'exit'];
}

/** Maps menu choices to the wizard's top-level `select` options, in the same order they were given. */
export function menuSelectOptions(choices: readonly WizardMenuChoice[]): readonly SelectOption<WizardMenuChoice>[] {
  return choices.map((choice) => ({ value: choice, label: MENU_LABELS[choice] }));
}

export interface SelectOption<T> {
  readonly value: T;
  readonly label: string;
  readonly hint?: string;
}

export interface DriveOption {
  readonly id: string;
  readonly name: string;
  readonly role: 'OWNER' | 'ADMIN' | 'MEMBER';
}

/** Drive multiselect options for the Create/Edit flows, hinting the caller's own role in each drive. */
export function driveMultiSelectOptions(drives: readonly DriveOption[]): readonly SelectOption<string>[] {
  return drives.map((drive) => ({ value: drive.id, label: drive.name, hint: drive.role.toLowerCase() }));
}

export type DriveRoleChoice =
  | { readonly kind: 'member' }
  | { readonly kind: 'admin' }
  | { readonly kind: 'custom'; readonly customRoleId: string };

export interface CustomRoleOption {
  readonly id: string;
  readonly name: string;
}

/**
 * Distribution only triggers on a bare generic type parameter, never on a
 * named union type alias referenced directly in a conditional — so this
 * needs its own generic `Distribute<T>` rather than writing the conditional
 * inline over `DriveRoleChoice`. Distributing keeps each array element's
 * `value` narrowed to one variant (e.g. `{ kind: 'custom'; customRoleId:
 * string }`) instead of widening to the full union — `@clack/prompts`' own
 * `Option<Value>` type distributes the same way, and a widened `value` type
 * fails to structurally match it.
 */
type Distribute<T> = T extends unknown ? { readonly value: T; readonly label: string } : never;
type RoleSelectOption = Distribute<DriveRoleChoice>;

/** Member/Admin are always offered; one further option per custom role defined in the selected drive. */
export function roleSelectOptions(customRoles: readonly CustomRoleOption[]): readonly RoleSelectOption[] {
  const builtIn: readonly RoleSelectOption[] = [
    { value: { kind: 'member' }, label: 'Member' },
    { value: { kind: 'admin' }, label: 'Admin' },
  ];
  return [...builtIn, ...customRoles.map((role) => ({ value: { kind: 'custom' as const, customRoleId: role.id }, label: role.name }))];
}

export function driveRoleChoiceToScopeArg(driveId: string, choice: DriveRoleChoice): DriveScopeArg {
  if (choice.kind === 'member') return { id: driveId, role: 'MEMBER' };
  if (choice.kind === 'admin') return { id: driveId, role: 'ADMIN' };
  return { id: driveId, role: null, customRoleId: choice.customRoleId };
}

export interface DriveRoleSelection {
  readonly driveId: string;
  readonly choice: DriveRoleChoice;
}

/** Maps the wizard's per-drive role selections into `buildTokenScope`'s input shape and reuses its validation verbatim. */
export function buildWizardScope(selections: readonly DriveRoleSelection[]): BuildTokenScopeResult {
  return buildTokenScope(selections.map((selection) => driveRoleChoiceToScopeArg(selection.driveId, selection.choice)));
}

export interface KeyDriveScope {
  readonly id: string;
  readonly name: string;
}

export interface KeySummary {
  readonly id: string;
  readonly name: string;
  readonly tokenPrefix: string;
  readonly driveScopes: readonly KeyDriveScope[];
  readonly createdAt: string;
  readonly lastUsed: string | null;
}

function formatDriveScopeNames(driveScopes: readonly KeyDriveScope[]): string {
  return driveScopes.length > 0 ? driveScopes.map((drive) => drive.name).join(', ') : '(unscoped)';
}

/** One readable line per key for the List step's plain terminal output — no table primitive in `@clack/prompts` fits tabular data. */
export function renderKeysTable(keys: readonly KeySummary[]): readonly string[] {
  if (keys.length === 0) return ['No keys found.'];
  return keys.map(
    (key) => `${key.name}  ${key.tokenPrefix}  ${formatDriveScopeNames(key.driveScopes)}  created ${key.createdAt}  last used ${key.lastUsed ?? 'never'}`,
  );
}

/** Key select options for the Edit/Revoke flows, hinting each key's current drive scopes. */
export function keySelectOptions(keys: readonly KeySummary[]): readonly SelectOption<string>[] {
  return keys.map((key) => ({
    value: key.id,
    label: key.name,
    hint: key.driveScopes.length > 0 ? key.driveScopes.map((drive) => drive.name).join(', ') : 'unscoped',
  }));
}

/** Drive ids already scoped on a key, so the Edit flow's drive multiselect can start pre-selected on its current scopes. */
export function preselectedDriveIds(key: KeySummary): readonly string[] {
  return key.driveScopes.map((drive) => drive.id);
}

/** The Edit flow only offers to revoke the replaced key once its replacement has actually been minted. */
export function shouldOfferRevokeOldKey(mintOutcome: { readonly outcome: string }): boolean {
  return mintOutcome.outcome === 'success';
}

export const NON_INTERACTIVE_KEYS_MESSAGE =
  'pagespace keys requires an interactive terminal. Use "pagespace keys create", "pagespace keys list", or "pagespace keys revoke" instead.';
