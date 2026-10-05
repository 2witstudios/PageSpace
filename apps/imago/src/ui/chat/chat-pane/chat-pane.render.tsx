import type { ReactNode, Ref, UIEventHandler } from 'react';
import type { ChatDensity } from '../../frame/stage/stage';
import { renderPaneHeader } from '../../frame/pane/pane-header';
import { Icon } from '../../components/icon/icon';
import type { AgentMenu } from '../chat-agents/chat-agents';
import type { ChatMessage } from '../chat-model/chat';
import { renderChatMessage } from '../chat-message/chat-message.render';
import {
  chatAgentNameClass,
  chatAgentPickerClass,
  chatAgentSelectClass,
  chatContextLabelClass,
  chatEmptyClass,
  chatHeaderTitleClass,
  chatNoticeClass,
  chatPaneClass,
  chatScrollClass,
  chatThreadClass,
} from './chat-pane-class';

export type ChatPaneRenderProps = {
  readonly density: ChatDensity;
  /** The agent the conversation is with. */
  readonly agentName: string;
  /** The agents the header offers, Imago's first; with none listed yet it names `agentName` only. */
  readonly agents: AgentMenu;
  /** Void action: the option the viewer picked. */
  readonly selectAgent: (value: string) => void;
  /** Ahead of the title: the hidden chat history's opener. */
  readonly leading?: ReactNode;
  /** What the agent answers against: the drive, the section, or the open object. */
  readonly contextLabel: string;
  /** Oldest first; undefined while the conversation loads. */
  readonly messages: readonly ChatMessage[] | undefined;
  /** The reply still arriving, if any. */
  readonly streamingMessageId: string | null;
  /** What went wrong, said above the composer. */
  readonly notice: string | null;
  readonly citationDriveId: string | null;
  readonly composer: ReactNode;
  /** The scroller, for the container to keep the newest message in view. */
  readonly scrollRef?: Ref<HTMLDivElement>;
  readonly onScroll?: UIEventHandler<HTMLDivElement>;
};

const renderAgent = ({ agentName, agents, selectAgent }: ChatPaneRenderProps): ReactNode =>
  agents.groups.length === 0 ? (
    <span className={chatAgentNameClass}>{agentName}</span>
  ) : (
    <span className={chatAgentPickerClass}>
      <select
        aria-label="Agent"
        value={agents.value}
        className={chatAgentSelectClass}
        onChange={(event) => selectAgent(event.currentTarget.value)}
      >
        {agents.groups.map((group) => (
          <optgroup key={group.label} label={group.label}>
            {group.options.map((option) => (
              <option key={option.value} value={option.value} disabled={option.disabled}>
                {option.title}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
      <Icon name="chevronDown" size={12} />
    </span>
  );

const renderTitle = (props: ChatPaneRenderProps): ReactNode => (
  <span className={chatHeaderTitleClass}>
    {renderAgent(props)}
    <span className="text-ink-faint" aria-hidden="true">
      /
    </span>
    <small className={chatContextLabelClass}>{props.contextLabel}</small>
  </span>
);

/**
 * The chat column: a header picking the agent and naming what it is
 * answering against, the thread, and the floating composer. Roomy over a drive or a
 * section; dense beside an open object, where the header names the object.
 */
export function renderChatPane(props: ChatPaneRenderProps): ReactNode {
  const { density, agentName, leading, messages, streamingMessageId, notice, citationDriveId, composer, scrollRef, onScroll } =
    props;
  return (
    <section className={chatPaneClass(density)} aria-label="Chat" data-density={density}>
      {renderPaneHeader({ title: renderTitle(props), leading })}
      <div ref={scrollRef} onScroll={onScroll} className={chatScrollClass}>
        <ol className={chatThreadClass(density)} aria-busy={messages === undefined ? true : undefined}>
          {messages === undefined ? null : messages.length === 0 ? (
            <li className={chatEmptyClass}>{`Ask ${agentName} anything. Open a page only when the work needs it.`}</li>
          ) : (
            messages.map((message) =>
              renderChatMessage({
                message,
                density,
                assistantName: agentName,
                streaming: message.id === streamingMessageId,
                citationDriveId,
              }),
            )
          )}
          {notice === null ? null : (
            <li role="alert" className={chatNoticeClass}>
              {notice}
            </li>
          )}
        </ol>
      </div>
      {composer}
    </section>
  );
}
