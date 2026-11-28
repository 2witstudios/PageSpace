import type { ReactNode } from 'react';

/**
 * One settings or account screen (C-Settings-*, C-Account-*): a 720px form column with the
 * screen's single h1 and its lede, then flat sections. The nav is the shell's pane, so a screen
 * draws no "Back to Settings" and no card chrome of its own.
 */
export function SettingsScreen({ title, lede, actions, children }: {
  readonly title: string;
  readonly lede?: ReactNode;
  readonly actions?: ReactNode;
  readonly children?: ReactNode;
}): ReactNode {
  return (
    <div className="mx-auto w-full max-w-settings px-settings-x py-settings-y">
      <header className="mb-8 flex items-start gap-4">
        <div className="min-w-0 flex-1">
          <h1 className="text-settings-title font-bold tracking-tight text-ink">{title}</h1>
          {lede === undefined ? null : <p className="mt-2 text-sm text-ink-muted">{lede}</p>}
        </div>
        {actions === undefined ? null : <div className="flex flex-none items-center gap-2">{actions}</div>}
      </header>
      <div className="flex flex-col gap-10">{children}</div>
    </div>
  );
}

/** A section of a screen: a 15px head, an optional description, then its content. */
export function SettingsSection({ title, description, actions, children }: {
  readonly title: string;
  readonly description?: ReactNode;
  readonly actions?: ReactNode;
  readonly children?: ReactNode;
}): ReactNode {
  return (
    <section aria-label={title} className="flex flex-col gap-3">
      <div className="flex items-start gap-4">
        <div className="min-w-0 flex-1">
          <h2 className="text-settings-section font-semibold text-ink">{title}</h2>
          {description === undefined ? null : <p className="mt-1 text-sm text-ink-muted">{description}</p>}
        </div>
        {actions === undefined ? null : <div className="flex flex-none items-center gap-2">{actions}</div>}
      </div>
      {children}
    </section>
  );
}

/** Grouped controls: a bordered radius-12 box whose rows are split by hairlines. */
export function SettingsGroup({ label, children }: { readonly label?: string; readonly children?: ReactNode }): ReactNode {
  return (
    <div role={label === undefined ? undefined : 'group'} aria-label={label} className="divide-y divide-hairline rounded-xl border border-hairline">
      {children}
    </div>
  );
}

/** One row of a group: a label with its hint on the left, the control on the right. */
export function SettingsRow({ label, hint, children }: { readonly label: ReactNode; readonly hint?: ReactNode; readonly children?: ReactNode }): ReactNode {
  return (
    <div className="flex items-center gap-4 px-4 py-3">
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium text-ink">{label}</div>
        {hint === undefined ? null : <div className="mt-px text-xs text-ink-muted">{hint}</div>}
      </div>
      {children === undefined ? null : <div className="flex flex-none items-center gap-2">{children}</div>}
    </div>
  );
}
