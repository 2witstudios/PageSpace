import type { ReactNode } from 'react';

/** The flat 44px page toolbar strip under the page head (SPEC v3 "No duplicate headers"). */
export const toolbarStripClass =
  'flex h-toolbar-strip flex-none items-center gap-1 overflow-hidden border-b border-hairline px-3';

export type ToolbarStripProps = {
  /** Names the strip for assistive tech: "Formatting", "Code", "File"… */
  readonly label: string;
  readonly children: ReactNode;
};

/**
 * The one mount point for a page type's tools (IMC-1.10): same background as the page, a
 * hairline under it, no shadow. A page type with no tools renders no strip at all.
 */
export function ToolbarStrip({ label, children }: ToolbarStripProps): ReactNode {
  return (
    <div role="toolbar" aria-label={label} className={toolbarStripClass}>
      {children}
    </div>
  );
}
