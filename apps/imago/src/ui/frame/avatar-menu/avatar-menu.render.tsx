import Link from 'next/link';
import type { ReactNode, Ref, SyntheticEvent } from 'react';
import { renderAvatar } from '../../components/avatar/avatar.render';
import { railHitClass } from '../rail-button/rail-button-class';
import { renderRailTooltip } from '../rail-button/rail-button.render';
import { accountItemClass, accountMenuClass, accountNameClass } from './avatar-menu-class';

/** Classic's landing page, outside imago's basePath: a plain anchor, not Next's Link. */
export const CLASSIC_HOME = '/dashboard';

export type AvatarMenuRenderProps = {
  /** The signed-in user's name; null until the profile loads. */
  readonly name: string | null;
  readonly image: string | null;
  readonly open: boolean;
  readonly onToggle: (open: boolean) => void;
  /** Void action: a link was followed, so the menu closes. */
  readonly onPick: () => void;
  /** The theme switcher, bound to the page's theme by the container. */
  readonly theme: ReactNode;
  /** Void action: revokes the session and leaves for sign-in. */
  readonly onSignOut: () => void;
  readonly signingOut: boolean;
  readonly detailsRef?: Ref<HTMLDetailsElement> | undefined;
};

/**
 * The avatar at the foot of the rail and its menu: the account, the theme,
 * classic PageSpace and sign-out (D5).
 */
export function renderAvatarMenu(props: AvatarMenuRenderProps): ReactNode {
  const { name, image, open, onToggle, onPick, theme, onSignOut, signingOut, detailsRef } = props;
  return (
    <details
      ref={detailsRef}
      className="relative"
      open={open}
      onToggle={(event: SyntheticEvent<HTMLDetailsElement>) => onToggle(event.currentTarget.open)}
    >
      <summary className={`${railHitClass(true)} summary-plain`} aria-label="Account menu">
        {renderAvatar({ name: name ?? '', src: image ?? undefined, size: 'md' })}
        {renderRailTooltip('Account')}
      </summary>
      <ul className={accountMenuClass} aria-label="Account">
        {name === null ? null : (
          <li className={accountNameClass} data-account-name="">
            {name}
          </li>
        )}
        <li>
          <Link href="/account" prefetch={true} className={accountItemClass} onClick={onPick}>
            Account
          </Link>
        </li>
        <li>{theme}</li>
        <li>
          <a href={CLASSIC_HOME} className={accountItemClass}>
            Classic PageSpace
          </a>
        </li>
        <li>
          <button type="button" className={accountItemClass} onClick={onSignOut} disabled={signingOut}>
            Sign out
          </button>
        </li>
      </ul>
    </details>
  );
}
