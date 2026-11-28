import Link from 'next/link';
import type { ReactNode, Ref, SyntheticEvent } from 'react';
import { renderAvatar } from '../../components/avatar/avatar.render';
import { renderIcon } from '../../components/icon/icon.render';
import { renderRailTooltip, renderSpineCount } from '../rail-button/rail-button.render';
import {
  accountBadgeClass,
  accountCountClass,
  accountEmailClass,
  accountHeadClass,
  accountItemClass,
  accountMenuClass,
  accountNameClass,
  avatarSummaryClass,
  creditsBuyClass,
  creditsCardClass,
  creditsFigureClass,
  creditsHeadClass,
  creditsMeterClass,
  creditsMeterFillClass,
  creditsNoteClass,
  phoneAccountMenuClass,
  phoneMoreClass,
} from './avatar-menu-class';
import { countOf, type CreditsCard } from './avatar-menu-model';

/** Classic's landing page, outside imago's basePath: a plain anchor, not Next's Link. */
export const CLASSIC_HOME = '/dashboard';

export const ACCOUNT_PROFILE_PATH = '/account/profile';
export const PERSONALIZATION_PATH = '/account/personalization';
export const USAGE_PATH = '/account/usage';
export const BILLING_PATH = '/account/billing';
export const SETTINGS_PATH = '/account';

export type AvatarMenuRenderProps = {
  /** The signed-in user's name; null until the profile loads. */
  readonly name: string | null;
  readonly email: string | null;
  readonly image: string | null;
  readonly open: boolean;
  readonly onToggle: (open: boolean) => void;
  /** Void action: a row was followed, so the menu closes. */
  readonly onPick: () => void;
  /** The theme switcher, bound to the page's theme by the container. */
  readonly theme: ReactNode;
  /** Void action: revokes the session and leaves for sign-in. */
  readonly onSignOut: () => void;
  readonly signingOut: boolean;
  /** The credits card and the Usage and Billing figures; null until billing is known to be on and loaded. */
  readonly credits: CreditsCard | null;
  /** Void action: opens the feedback dialog. */
  readonly onFeedback: () => void;
  /** Present while the email is unverified: the top "Verify Email" row. */
  readonly verifyEmail: { readonly onVerify: () => void } | null;
  readonly detailsRef?: Ref<HTMLDetailsElement> | undefined;
  /** The account is open: the avatar carries the spine's active ring. */
  readonly active?: boolean;
  /**
   * The phone bottom bar's More item (C-Resp-Phone-Tree): the same menu behind a bar item named
   * "More, {n} notifications", opening upwards instead of beside the spine.
   */
  readonly more?: { readonly notifications: number } | undefined;
};

/**
 * The avatar at the foot of the rail and its menu (C-Shell-AccountMenu): who is signed in, the
 * credits card, the account's pages, feedback, the theme and log out.
 */
export function renderAvatarMenu(props: AvatarMenuRenderProps): ReactNode {
  const {
    name,
    email,
    image,
    open,
    onToggle,
    onPick,
    theme,
    onSignOut,
    signingOut,
    credits,
    onFeedback,
    verifyEmail,
    detailsRef,
    active = false,
    more,
  } = props;
  return (
    <details
      ref={detailsRef}
      className={more === undefined ? 'relative' : 'relative flex flex-1'}
      open={open}
      onToggle={(event: SyntheticEvent<HTMLDetailsElement>) => onToggle(event.currentTarget.open)}
    >
      {more === undefined ? (
        <summary className={avatarSummaryClass(active)} aria-label="Account menu">
          {renderAvatar({ name: name ?? '', src: image ?? undefined, size: 'md' })}
          {renderRailTooltip('Account')}
        </summary>
      ) : (
        <summary
          className={phoneMoreClass(active)}
          aria-label={more.notifications > 0 ? `More, ${more.notifications} notifications` : 'More'}
        >
          {renderIcon({ name: 'more', size: 21 })}
          More
          {renderSpineCount(more.notifications)}
        </summary>
      )}
      <ul className={more === undefined ? accountMenuClass : phoneAccountMenuClass} aria-label="Account">
        {name === null ? null : (
          <li className={accountHeadClass} data-account-name="">
            <span className={accountNameClass}>{name}</span>
            {email === null ? null : <span className={accountEmailClass}>{email}</span>}
          </li>
        )}
        {verifyEmail === null ? null : (
          <li>
            <button type="button" className={accountItemClass} onClick={verifyEmail.onVerify}>
              <span>Verify Email</span>
              <span className={accountBadgeClass}>Unverified</span>
            </button>
          </li>
        )}
        {credits === null ? null : (
          <li className={creditsCardClass} data-credits-card="">
            <div className={creditsHeadClass}>
              <span className="font-medium uppercase tracking-wide">Your credits</span>
              <span>{credits.plan === null ? null : credits.resets === null ? credits.plan : `${credits.plan} · resets ${credits.resets}`}</span>
            </div>
            <div className={creditsFigureClass}>
              {countOf(credits.left)} <span className="font-normal text-ink-muted">/ {countOf(credits.allowance)} credits</span>
            </div>
            <div role="progressbar" aria-label="Monthly credits left" aria-valuenow={credits.percent} aria-valuemin={0} aria-valuemax={100} className={creditsMeterClass}>
              <span className={creditsMeterFillClass} style={{ display: 'block', width: `${credits.percent}%` }} />
            </div>
            {credits.bonus > 0 ? <span className={creditsNoteClass}>+{countOf(credits.bonus)} bonus credits from top-ups</span> : null}
            {credits.reserved > 0 ? <span className={creditsNoteClass}>~{countOf(credits.reserved)} reserved on in-flight calls</span> : null}
            <Link href={USAGE_PATH} prefetch={true} className={creditsBuyClass} onClick={onPick}>
              Buy credits
            </Link>
          </li>
        )}
        <li>
          <Link href={ACCOUNT_PROFILE_PATH} prefetch={true} className={accountItemClass} onClick={onPick}>
            Account
          </Link>
        </li>
        <li>
          <Link href={PERSONALIZATION_PATH} prefetch={true} className={accountItemClass} onClick={onPick}>
            Personalization
          </Link>
        </li>
        <li>
          <Link href={USAGE_PATH} prefetch={true} className={accountItemClass} onClick={onPick}>
            <span>Usage</span>
            {credits === null ? null : <span className={accountCountClass}>{`${countOf(credits.left)} / ${countOf(credits.allowance)}`}</span>}
          </Link>
        </li>
        {credits === null ? null : (
          <li>
            <Link href={BILLING_PATH} prefetch={true} className={accountItemClass} onClick={onPick}>
              {credits.plan === null ? 'Billing' : `Billing (${credits.plan})`}
            </Link>
          </li>
        )}
        <li>
          <Link href={SETTINGS_PATH} prefetch={true} className={accountItemClass} onClick={onPick}>
            Settings
          </Link>
        </li>
        <li>
          <button
            type="button"
            className={accountItemClass}
            onClick={() => {
              onPick();
              onFeedback();
            }}
          >
            Feedback
          </button>
        </li>
        <li>{theme}</li>
        <li>
          {/* Not on the board: kept during the rollout so classic PageSpace stays one click away (D5). */}
          <a href={CLASSIC_HOME} className={accountItemClass}>
            Classic PageSpace
          </a>
        </li>
        <li>
          <button type="button" className={accountItemClass} onClick={onSignOut} disabled={signingOut}>
            Log out
          </button>
        </li>
      </ul>
    </details>
  );
}
