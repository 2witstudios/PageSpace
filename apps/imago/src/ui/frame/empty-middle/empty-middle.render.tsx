import Link from 'next/link';
import { ImagoOrb } from '../../metal/imago-orb/imago-orb';
import { renderPageIcon } from '../../metal/page-icon';
import type { ReactNode } from 'react';
import { pageTypeIcons } from '../../components/page-type-icon/page-type-icon';
import type { PageTypeValue } from '@pagespace/lib/utils/enums';
import {
  askImagoClass,
  emptyBlockClass,
  emptyBodyClass,
  emptyGroupLabelClass,
  emptyHeadClass,
  emptyLineClass,
  emptyMiddleClass,
  emptyRecentsClass,
  emptyRowClass,
  emptyTitleClass,
} from './empty-middle-class';

export type EmptyRecent = {
  readonly id: string;
  readonly title: string;
  readonly type: PageTypeValue;
  readonly href: string;
  readonly age: string;
  /** Imago's own page: its orb in place of the type icon. */
  readonly imago?: boolean;
};

export type EmptyMiddleRenderProps = {
  /** Show sidebar, when the pane is closed too; it leads the head. */
  readonly leading: ReactNode;
  readonly recents: readonly EmptyRecent[];
  readonly onAskImago: () => void;
};

const NOTHING_OPEN = 'Nothing open';

/**
 * What the middle shows once its last area is closed (SPEC v3.2): a 48px head, "Nothing open",
 * the viewer's recents in this drive, and Ask Imago, which brings Imago back into the middle.
 */
export function renderEmptyMiddle({ leading, recents, onAskImago }: EmptyMiddleRenderProps): ReactNode {
  return (
    <section className={emptyMiddleClass} aria-label={NOTHING_OPEN}>
      <header className={emptyHeadClass}>
        {leading}
        <span>{NOTHING_OPEN}</span>
      </header>
      <div className={emptyBodyClass}>
        <div className={emptyBlockClass}>
          <h2 className={emptyTitleClass}>{NOTHING_OPEN}</h2>
          <p className={emptyLineClass}>Pick a page from the sidebar, or ask Imago.</p>
          {recents.length === 0 ? null : (
            <div className={emptyRecentsClass}>
              <div className={emptyGroupLabelClass}>Recents</div>
              {recents.map((recent) => (
                <Link key={recent.id} href={recent.href} prefetch={true} className={emptyRowClass}>
                  <span className={pageTypeIcons[recent.type].hue} aria-hidden="true">
                    {renderPageIcon({ icon: pageTypeIcons[recent.type].icon, size: 15, imago: recent.imago })}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-left">
                    {recent.type === 'CHANNEL' ? `#${recent.title}` : recent.title}
                  </span>
                  <span className="text-xs text-ink-faint">{recent.age}</span>
                </Link>
              ))}
            </div>
          )}
          <button type="button" className={askImagoClass} onClick={onAskImago}>
            <ImagoOrb size="glyph" live />
            Ask Imago
          </button>
        </div>
      </div>
    </section>
  );
}
