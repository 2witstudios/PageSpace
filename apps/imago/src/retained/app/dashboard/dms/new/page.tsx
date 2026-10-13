'use client';

import { useState } from 'react';
import { useRouter } from '@/retained-adapters/navigation';
import { Button } from '@/retained/components/ui/button';
import { Avatar, AvatarFallback, AvatarImage } from '@/retained/components/ui/avatar';
import { Search, UserPlus } from 'lucide-react';
import useSWR from 'swr';
import { toast } from 'sonner';
import { post, fetchWithAuth } from '@/retained/lib/auth/auth-fetch';
import { DmHead } from '@/ui/messages/dm-head/dm-head';
import { useDirectThreads } from '@/ui/messages/use-messages/use-messages';
import { groupPeople, sourceLabelOf, type MessageablePerson } from '@/retained/lib/messages/dm-people';

const fetcher = async (url: string) => {
  const response = await fetchWithAuth(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch: ${response.status}`);
  }
  return response.json();
};

/** C-DM-New: pick a person grouped by how the viewer knows them, then open the chat. */
export default function NewConversationPage() {
  const router = useRouter();
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);

  const { data: messageableData } = useSWR<{ users: MessageablePerson[] }>(
    '/api/users/messageable',
    fetcher
  );
  const { threads } = useDirectThreads();

  // "Open chat" shows for someone the viewer already has a conversation with.
  const conversationByUser = new Map<string, string>();
  for (const thread of threads ?? []) {
    if (thread.otherUserId) conversationByUser.set(thread.otherUserId, thread.id);
  }

  const people = messageableData?.users ?? [];
  const groups = groupPeople(people, searchQuery);
  const selected = people.find((person) => person.id === selectedUserId) ?? null;
  const firstNameOf = (person: MessageablePerson) =>
    (person.displayName || person.name || person.email).split(' ')[0];

  const handleStartConversation = async () => {
    if (!selectedUserId) {
      toast.error('Please select a user to message');
      return;
    }

    setIsCreating(true);

    try {
      const { conversation } = await post<{ conversation: { id: string } }>('/api/messages/conversations', {
        recipientId: selectedUserId,
      });

      router.push(`/dashboard/dms/${conversation.id}`);
    } catch (error) {
      toast.error((error as Error).message || 'Failed to start conversation');
      setIsCreating(false);
    }
  };

  return (
    <div role="region" aria-label="New message" className="flex h-full w-full flex-col">
      <DmHead title="New message" />

      <div className="flex-1 overflow-y-auto px-10 py-9">
        <div className="mx-auto flex max-w-[620px] flex-col gap-[18px]">
          <div>
            <h1 className="mb-1 text-3xl font-bold tracking-tight">New message</h1>
            <p className="leading-relaxed text-muted-foreground">
              Your connections and people who share a drive with you.
            </p>
          </div>

          <label className="flex h-11 items-center gap-2.5 rounded-xl border-[1.5px] border-primary px-3.5 shadow-[0_0_0_4px_rgb(0_0_0/0.06)]">
            <Search className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
            <span className="sr-only">Search people</span>
            <input
              type="text"
              placeholder="Search by name or @username"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="min-w-0 flex-1 border-0 bg-transparent text-[15px] outline-none"
            />
            <kbd className="rounded-md bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">esc</kbd>
          </label>

          {people.length === 0 && !searchQuery && (
            <div className="py-8 text-center">
              <UserPlus className="mx-auto mb-4 h-12 w-12 text-muted-foreground" aria-hidden="true" />
              <p className="mb-4 text-muted-foreground">
                Connect with someone or join a shared drive to start messaging
              </p>
              <Button onClick={() => router.push('/dashboard/connections')} variant="outline">
                Manage Connections
              </Button>
            </div>
          )}

          {groups.length === 0 && searchQuery && people.length > 0 && (
            <p className="py-8 text-center text-muted-foreground">No matches for &quot;{searchQuery}&quot;</p>
          )}

          {groups.map((group) => (
            <section key={group.title}>
              <h2 className="mb-1.5 px-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                {group.title}
              </h2>
              <div role="listbox" aria-label={group.title} className="flex flex-col">
                {group.people.map((person) => {
                  const isSelected = selectedUserId === person.id;
                  const conversationId = conversationByUser.get(person.id);
                  const displayName = person.displayName || person.name || person.email;
                  return (
                    <div
                      key={person.id}
                      role="option"
                      aria-selected={isSelected}
                      onClick={() => setSelectedUserId(person.id)}
                      className={`flex cursor-pointer items-center gap-3 rounded-xl px-2.5 py-2 ${
                        isSelected ? 'bg-primary/10 ring-2 ring-primary' : 'hover:bg-accent'
                      }`}
                    >
                      <Avatar className="h-[38px] w-[38px]">
                        <AvatarImage src={person.image || person.avatarUrl || ''} />
                        <AvatarFallback>{displayName.charAt(0).toUpperCase()}</AvatarFallback>
                      </Avatar>
                      <div className="flex min-w-0 flex-1 flex-col">
                        <div className="flex items-baseline gap-1.5">
                          <span className="truncate font-semibold">{displayName}</span>
                          {person.username && (
                            <span className="shrink-0 font-mono text-[12.5px] text-muted-foreground">@{person.username}</span>
                          )}
                        </div>
                        {person.bio && <span className="truncate text-[12.5px] text-muted-foreground">{person.bio}</span>}
                      </div>
                      <span className="shrink-0 rounded-full bg-muted px-2 text-xs text-muted-foreground">
                        {sourceLabelOf(person)}
                      </span>
                      {conversationId !== undefined && (
                        <button
                          type="button"
                          className="shrink-0 whitespace-nowrap text-[12.5px] font-medium text-primary"
                          onClick={(event) => {
                            event.stopPropagation();
                            router.push(`/dashboard/dms/${conversationId}`);
                          }}
                        >
                          Open chat
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            </section>
          ))}

          <div className="flex items-center gap-2.5 border-t border-border pt-1.5">
            <span className="flex-1 text-[13px] text-muted-foreground">
              Can&apos;t find someone?{' '}
              <button type="button" className="underline" onClick={() => router.push('/dashboard/connections')}>
                Connect with them
              </button>{' '}
              or invite them to a drive.
            </span>
            <Button variant="outline" onClick={() => router.push('/dashboard/dms')} disabled={isCreating}>
              Cancel
            </Button>
            <Button onClick={handleStartConversation} disabled={!selected || isCreating}>
              {isCreating ? 'Starting…' : `Message ${selected ? firstNameOf(selected) : ''}`.trimEnd()}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
