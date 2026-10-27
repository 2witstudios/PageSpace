import type { IconName } from '../../components/icon/icon-names';
import { railItems } from '../rail/rail-items';
import type { Stage } from '../stage/stage';

export type PhoneBarSection = 'chat' | 'files' | 'messages' | 'tasks';

export type PhoneBarItem = {
  readonly id: PhoneBarSection;
  readonly icon: IconName;
  readonly label: string;
  /** The accessible name: "Messages, 8 unread" when there are any. */
  readonly name: string;
  /** The section in the current drive, basePath-relative; null with no drive. */
  readonly href: string | null;
  readonly unread: number;
  readonly current: boolean;
};

/** The section the stage belongs to among the bar's four, or null (the account is More's). */
export const phoneBarSection = (stage: Stage): PhoneBarSection | null =>
  stage.section === 'chat' || stage.section === 'files' || stage.section === 'messages' || stage.section === 'tasks'
    ? stage.section
    : null;

/**
 * C-Resp-Phone-Tree's bottom bar: Chat, Files, Messages and Tasks in the current drive, the
 * spine's destinations as data; only Messages carries a count.
 */
export const phoneBarItems = (stage: Stage, driveId: string | null, messagesUnread: number): readonly PhoneBarItem[] => {
  const active = phoneBarSection(stage);
  return railItems(driveId).flatMap((entry): PhoneBarItem[] => {
    if (entry.id !== 'chat' && entry.id !== 'files' && entry.id !== 'messages' && entry.id !== 'tasks') return [];
    const unread = entry.id === 'messages' ? messagesUnread : 0;
    return [
      {
        id: entry.id,
        icon: entry.icon,
        label: entry.label,
        name: unread > 0 ? `${entry.label}, ${unread} unread` : entry.label,
        href: entry.href,
        unread,
        current: entry.id === active,
      },
    ];
  });
};
