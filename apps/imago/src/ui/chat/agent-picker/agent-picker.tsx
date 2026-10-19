'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';
import { renderIcon } from '../../components/icon/icon.render';
import { ImagoOrb } from '../../metal/imago-orb/imago-orb';
import { headControlClass } from '../../frame/controls/controls-class';
import { useDisclosure } from '../../frame/disclosure/use-disclosure';
import type { AgentMenu } from '../chat-agents/chat-agents';
import {
  agentTileClass,
  pickerFooterClass,
  pickerGroupLabelClass,
  pickerHeadClass,
  pickerPopoverClass,
  pickerRowClass,
  pickerTriggerClass,
} from './agent-picker-class';

export type AgentPickerProps = {
  /** The agent the conversation is with. */
  readonly agentName: string;
  /** Imago (the global agent) is the one talking. */
  readonly imago: boolean;
  readonly agents: AgentMenu;
  readonly selectAgent: (value: string) => void;
  /** Imago's Model section (provider and model); shown only while Imago is picked. */
  readonly model: ReactNode;
  /** The drive's agents screen and the new-page flow, for the footer; null without a drive. */
  readonly allAgentsHref: string | null;
  readonly onNewAgent: (() => void) | null;
};

/** Imago is its liquid-metal orb, alive in the head; any other agent is the sparkle on its hue. */
const spark = (imago: boolean, size: 'head' | 'row'): ReactNode =>
  imago ? (
    <ImagoOrb size={size === 'head' ? 'tile' : 'row'} live={size === 'head'} />
  ) : (
    <span className={agentTileClass(false, size)} aria-hidden="true">
      {renderIcon({ name: 'sparkle', size: size === 'head' ? 12 : 14 })}
    </span>
  );

/**
 * Who Imago's column talks to (C-Chat-AgentPicker): "Choose agent: <name>" opens a non-modal
 * "Choose agent" popover headed "Talk to": Imago first ("Global · your chosen model"), then the
 * drive's agents with their model and folder. With Imago picked, its Model section sits under
 * the list; an agent page fixes its own model. The footer reaches all agents and a new one.
 */
export function AgentPicker(props: AgentPickerProps): ReactNode {
  const { agentName, imago, agents, selectAgent, model, allAgentsHref, onNewAgent } = props;
  const { open, setOpen, ref } = useDisclosure();
  const pick = (value: string) => {
    selectAgent(value);
    setOpen(false);
  };
  return (
    <details ref={ref} className="relative" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary className={pickerTriggerClass} aria-label={`Choose agent: ${agentName}`}>
        {spark(imago, 'head')}
        <span className="truncate">{agentName}</span>
        {renderIcon({ name: 'chevronDown', size: 11 })}
      </summary>
      <div role="dialog" aria-label="Choose agent" className={pickerPopoverClass}>
        <div className={pickerHeadClass}>
          <span>Talk to</span>
          <button type="button" className={headControlClass} aria-label="Close agent picker" onClick={() => setOpen(false)}>
            {renderIcon({ name: 'close', size: 12 })}
          </button>
        </div>
        <div role="radiogroup" aria-label="Agent" className="flex flex-col">
          {agents.groups.map((group) => (
            <div key={group.label} className="flex flex-col">
              {group.options.some((option) => option.imago === true) ? null : <div className={pickerGroupLabelClass}>{group.label}</div>}
              {group.options.map((option) => {
                const checked = option.value === agents.value;
                return (
                  <button
                    key={option.value}
                    type="button"
                    role="radio"
                    aria-checked={checked}
                    disabled={option.disabled}
                    className={pickerRowClass(checked, option.disabled)}
                    onClick={() => pick(option.value)}
                  >
                    {spark(option.imago === true, 'row')}
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate text-sm font-medium text-ink">{option.title}</span>
                      {option.meta === undefined ? null : <span className="truncate text-xs text-ink-muted">{option.meta}</span>}
                    </span>
                    {checked ? <span className="text-xs font-medium text-accent-deep">Active</span> : null}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
        {imago && model !== null ? (
          <div className="flex flex-col gap-1 border-t border-hairline px-3 py-2">
            <div className="text-2xs font-medium tracking-wide text-ink-muted uppercase">Model</div>
            {model}
          </div>
        ) : null}
        <div className={pickerFooterClass}>
          <span className="flex-1">Agents are pages in your drive.</span>
          {allAgentsHref === null ? null : (
            <Link href={allAgentsHref} prefetch={true} onClick={() => setOpen(false)}>
              All agents
            </Link>
          )}
          {onNewAgent === null ? null : (
            <button type="button" className="cursor-pointer border-0 bg-transparent p-0 text-xs text-accent" onClick={() => { setOpen(false); onNewAgent(); }}>
              New agent
            </button>
          )}
        </div>
      </div>
    </details>
  );
}
