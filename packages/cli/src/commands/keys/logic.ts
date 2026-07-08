/**
 * Pure decision logic for the `pagespace keys` wizard (Phase 9 task 5) — no
 * `@clack/prompts` import, no I/O, total functions only. `wizard.ts` is the
 * thin effects layer that calls `@clack/prompts` and feeds real terminal
 * input through these functions; every branch of "what step comes next" is
 * decided here so it's unit-testable without a real terminal.
 *
 * Scope-building deliberately delegates to `buildTokenScope` (`./create.js`)
 * rather than re-validating drive/role input a second time — the wizard's
 * per-drive role selection is just a different *input shape*
 * (`DriveRoleSelection[]`) for the exact same wire grammar `keys create
 * --drive --role` already builds and tests.
 */
import type { DriveScopeArg } from './args.js';
import { buildTokenScope, type BuildTokenScopeResult } from './create.js';

export type WizardMenuChoice = 'create' | 'list' | 'edit' | 'revoke' | 'use' | 'exit';

const MENU_LABELS: Record<WizardMenuChoice, string> = {
  create: 'Create a new key',
  list: 'List keys',
  edit: 'Edit scope',
  revoke: 'Revoke a key',
  use: 'Set active key',
  exit: 'Exit',
};

/** Edit/Revoke/Use all require selecting from an existing key — omit them from the menu when there is nothing to select. */
export function availableMenuChoices(keyCount: number): readonly WizardMenuChoice[] {
  return keyCount > 0 ? ['create', 'list', 'edit', 'revoke', 'use', 'exit'] : ['create', 'list', 'exit'];
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
export function buildWizardScope(
  selections: readonly DriveRoleSelection[],
  options: { readonly allDrives?: boolean } = {},
): BuildTokenScopeResult {
  return buildTokenScope(
    selections.map((selection) => driveRoleChoiceToScopeArg(selection.driveId, selection.choice)),
    options,
  );
}

/**
 * The Create flow's up-front choice: mint a key scoped to hand-picked drives,
 * or an unrestricted `--all-drives` key. Edit does NOT offer this step — an
 * EXISTING key can only ever be re-scoped among drive:* sets (`update_key:*`
 * is grammar-mutually-exclusive with `all_drives`, and the server-side writer
 * `updateMcpTokenDriveScopes` unconditionally sets `isScoped: true` — there is
 * no in-place path to convert a scoped key to unscoped). Narrowing an
 * existing all-drives key DOWN to specific drives already works today with no
 * grammar changes (see `allDrivesDowngradeConfirmMessage` below); only the
 * widening direction is unsupported.
 */
export type DriveTargetChoice = 'specific' | 'all';

export const DRIVE_TARGET_SELECT_MESSAGE = 'Grant access to specific drives, or all drives (unrestricted)?';

export function driveTargetSelectOptions(): readonly SelectOption<DriveTargetChoice>[] {
  return [
    { value: 'specific', label: 'Choose specific drives' },
    { value: 'all', label: 'All drives (unrestricted) — maximum access, including drives created later' },
  ];
}

/** Pre-mint confirm wording (Create) — all-drives gets dedicated maximum-privilege copy instead of echoing the raw scope string. */
export function confirmMintMessage(scope: string, target: DriveTargetChoice): string {
  return target === 'all'
    ? 'Mint a new key with access to ALL your drives (including any created later)? This is the maximum-privilege key type.'
    : `Mint a new key scoped to: ${scope}?`;
}

/**
 * Edit's downgrade guard: shown when the key being edited is CURRENTLY
 * all-drives (`isScoped === false`, zero driveScopes — see `KeySummary`) and
 * the user is about to narrow it to a specific-drive set. Mirrors the web
 * UI's downgrade guard in `MCPSettingsView.tsx`.
 */
export function allDrivesDowngradeConfirmMessage(keyName: string, driveCount: number): string {
  return `"${keyName}" currently has access to ALL your drives. Narrowing it to ${driveCount} drive(s) — continue?`;
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
  /**
   * `false` with zero `driveScopes` is an `--all-drives` key (unrestricted,
   * including drives created later); `true` with zero `driveScopes` is a
   * scoped key whose drives were all deleted (fail-closed orphan, no access
   * at all). Without this flag the two are indistinguishable in every
   * display helper below — the exact ambiguity this field exists to resolve.
   */
  readonly isScoped: boolean;
}

function formatDateOnly(value: string | null): string {
  return value?.slice(0, 10) ?? 'never';
}

function formatDriveScopeNames(driveScopes: readonly KeyDriveScope[], isScoped: boolean): string {
  if (driveScopes.length === 0) return isScoped ? 'NO ACCESS (orphaned)' : 'all drives';
  const visibleNames = driveScopes.slice(0, 3).map((drive) => drive.name);
  const remaining = driveScopes.length - visibleNames.length;
  return remaining > 0 ? `${visibleNames.join(', ')} +${remaining} more` : visibleNames.join(', ');
}

/** Compact vertical blocks fit inside clack.note's bordered width better than one long row per key. */
export function renderKeysTable(keys: readonly KeySummary[]): readonly string[] {
  if (keys.length === 0) return ['No keys found.'];
  return keys.flatMap((key, index) => [
    ...(index === 0 ? [] : ['']),
    `${key.name}  ${key.tokenPrefix}`,
    `  scopes: ${formatDriveScopeNames(key.driveScopes, key.isScoped)}`,
    `  created ${formatDateOnly(key.createdAt)} · last used ${formatDateOnly(key.lastUsed)}`,
  ]);
}

/**
 * Key select options for the Edit/Revoke/Set-active flows, hinting each
 * key's current drive scopes. `activeKeyId` (when known — the Set-active
 * flow resolves it from the machine's active-key map) prefixes that key's
 * hint with `active · ` so the current activation is visible in the picker.
 */
export function keySelectOptions(keys: readonly KeySummary[], activeKeyId: string | null = null): readonly SelectOption<string>[] {
  return keys.map((key) => {
    const scopes =
      key.driveScopes.length > 0
        ? key.driveScopes.map((drive) => drive.name).join(', ')
        : key.isScoped
          ? 'NO ACCESS (orphaned)'
          : 'all drives';
    return {
      value: key.id,
      label: key.name,
      hint: key.id === activeKeyId ? `active · ${scopes}` : scopes,
    };
  });
}

/** Drive ids already scoped on a key, so the Edit flow's drive multiselect can start pre-selected on its current scopes. */
export function preselectedDriveIds(key: KeySummary): readonly string[] {
  return key.driveScopes.map((drive) => drive.id);
}

export const NON_INTERACTIVE_KEYS_MESSAGE =
  'pagespace keys requires an interactive terminal. Use "pagespace keys create", "pagespace keys list", "pagespace keys revoke", or "pagespace keys use" instead.';
