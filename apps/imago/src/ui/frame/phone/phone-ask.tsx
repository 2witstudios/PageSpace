import Link from 'next/link';
import type { ReactNode } from 'react';
import { renderIcon } from '../../components/icon/icon.render';
import { phoneAskClass } from './phone-shell-class';

/**
 * The floating "Ask" over the phone Files tree: it opens Imago on the drive's chat, which is a
 * screen of its own on a phone.
 */
export function PhoneAsk({ href }: { readonly href: string }): ReactNode {
  return (
    <Link href={href} prefetch={true} className={phoneAskClass}>
      {renderIcon({ name: 'sparkle', size: 14 })}
      Ask
    </Link>
  );
}
