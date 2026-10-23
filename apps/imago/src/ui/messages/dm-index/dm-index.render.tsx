import type { ReactNode } from 'react';
import { cn } from '../../cn';
import { renderAvatar } from '../../components/avatar/avatar.render';
import { renderButton } from '../../components/button/button.render';
import { listGroupLabelClass } from '../../components/list-group/list-group-class';
import { messagesNoteClass } from '../messages-pane/messages-pane-class';
import type { MessageablePerson } from './dm-index-model';

/** The people ground's list: loading, failed, none, or the people themselves. */
export type DmGroundState =
  | { readonly status: 'loading' }
  | { readonly status: 'error'; readonly retry: () => void }
  | { readonly status: 'empty' }
  | { readonly status: 'ready'; readonly people: readonly MessageablePerson[] };

const peopleNotes = {
  loading: 'Loading people…',
  error: 'Could not load people.',
  empty: 'No one to message yet.',
} as const;

/**
 * The DM ground: what direct messages are, and the people the viewer can message
 * (GET /api/users/messageable). Each person's source line is left out until the
 * API says which drive or role it is (needs-api: messageable/conversation shared drives and roles).
 */
export function renderDmGround(props: { readonly people: DmGroundState }): ReactNode {
  const { people } = props;
  let list: ReactNode;
  if (people.status === 'loading') list = <p role="status" className={messagesNoteClass}>{peopleNotes.loading}</p>;
  else if (people.status === 'error')
    list = (
      <>
        <p role="alert" className={messagesNoteClass}>{peopleNotes.error}</p>
        {renderButton({ variant: 'ghost', onClick: people.retry, children: 'Try again' })}
      </>
    );
  else if (people.status === 'empty') list = <p className={messagesNoteClass}>{peopleNotes.empty}</p>;
  else
    list = (
      <ul className="grid grid-cols-5 gap-2">
        {people.people.map((person) => (
          <li
            key={person.id}
            className="flex flex-col items-center gap-2 rounded-xl border border-hairline px-2 py-3 text-center"
          >
            {renderAvatar({ name: person.name, size: 'lg', src: person.avatarUrl ?? undefined })}
            <span className="w-full truncate text-sm font-medium text-ink">{person.name}</span>
          </li>
        ))}
      </ul>
    );

  return (
    <section aria-label="Start a conversation" className="flex min-h-0 flex-1 flex-col items-center overflow-y-auto px-6 pb-6">
      <div className="flex w-full max-w-imago-ground flex-col gap-6 pt-8">
        <div>
          <h2 className="mb-1 text-md font-semibold tracking-tight text-ink">Direct messages</h2>
          <p className="text-sm leading-normal text-ink-muted">
            Private, one-to-one. You can message your connections and anyone who shares a drive with you.
          </p>
        </div>
        <div>
          <h3 className={cn(listGroupLabelClass, 'mb-2 px-0')}>People you can message</h3>
          {list}
        </div>
      </div>
    </section>
  );
}
