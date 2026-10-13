// What the chat header offers (DEC D2): the viewer's Imago agents first, in
// registry order, then the agents of the open drive. Both lists are the
// server's: the drive's list is already only the agents the viewer can use,
// and nothing here filters it by access. In the Home drive that list holds
// the Imago agents too; they are offered once, in their own group.

import type { BuiltinAgentPointer, ChatAgent, DriveAgent } from '../chat-model/chat';

export type AgentOption = {
  /** The agent page id; an Imago agent with no page yet has a placeholder and cannot be chosen. */
  readonly value: string;
  readonly title: string;
  readonly disabled: boolean;
  /** The row's second line in the picker: "Global · your chosen model", or model · folder. */
  readonly meta?: string;
};

export type AgentGroup = {
  readonly label: string;
  readonly options: readonly AgentOption[];
};

export type AgentMenu = {
  /** The chosen option; empty while nothing is chosen. */
  readonly value: string;
  readonly groups: readonly AgentGroup[];
};

type AgentLists = {
  readonly builtins?: readonly BuiltinAgentPointer[];
  readonly driveAgents?: readonly DriveAgent[];
};

const PENDING = 'pending:';

/** Imago's own row says it is global and talks through the model you chose (C-Chat-AgentPicker). */
const IMAGO_META = 'Global · your chosen model';

const builtinOption = (agent: BuiltinAgentPointer): AgentOption => {
  const meta = agent.key === 'imago' ? { meta: IMAGO_META } : {};
  return agent.pageId === null
    ? { value: `${PENDING}${agent.key}`, title: agent.title, disabled: true, ...meta }
    : { value: agent.pageId, title: agent.title, disabled: false, ...meta };
};

const option = (agent: DriveAgent | ChatAgent): AgentOption => ({ value: agent.id, title: agent.title, disabled: false });

/** A drive agent's second line: its model and the folder it lives in (the drive at the top level). */
const driveOption = (
  agent: DriveAgent,
  driveName: string | undefined,
  folderTitle: ((pageId: string) => string | undefined) | undefined,
): AgentOption => {
  const folder = agent.parentId === undefined ? undefined : agent.parentId === 'root' ? driveName : folderTitle?.(agent.parentId);
  const meta = [agent.aiModel, folder].filter((part): part is string => part !== undefined && part !== '').join(' · ');
  return meta === '' ? option(agent) : { ...option(agent), meta };
};

const imagoOf = (builtins: readonly BuiltinAgentPointer[] | undefined) => builtins?.find((agent) => agent.key === 'imago');

/**
 * The header's groups and choice. An agent chosen in another drive stays
 * offered after a move, under "Chosen", so the header still names it.
 */
export const agentMenu = ({
  builtins,
  driveAgents,
  driveName,
  selected,
  folderTitle,
}: AgentLists & {
  readonly driveName?: string;
  readonly selected: ChatAgent | null;
  /** A folder's title by page id, from the drive's tree, for the agent rows' meta. */
  readonly folderTitle?: (pageId: string) => string | undefined;
}): AgentMenu => {
  const imago = (builtins ?? []).map(builtinOption);
  const builtinIds = new Set(imago.map((entry) => entry.value));
  const drive = (driveAgents ?? []).filter((agent) => !builtinIds.has(agent.id)).map((agent) => driveOption(agent, driveName, folderTitle));
  const listed = selected === null || [...imago, ...drive].some((entry) => entry.value === selected.id);
  const groups: AgentGroup[] = [
    { label: 'Imago', options: imago },
    { label: `Agents in ${driveName ?? 'this drive'}`, options: drive },
    { label: 'Chosen', options: listed || selected === null ? [] : [option(selected)] },
  ];
  return {
    value: selected?.id ?? imagoOf(builtins)?.pageId ?? '',
    groups: groups.filter((group) => group.options.length > 0),
  };
};

/**
 * The agent an option names: null for Imago (the default), the agent for any
 * other, undefined for what cannot be chosen.
 */
export const agentFor = ({ builtins, driveAgents }: AgentLists, value: string): ChatAgent | null | undefined => {
  if (value === '' || value.startsWith(PENDING)) return undefined;
  if (imagoOf(builtins)?.pageId === value) return null;
  const builtin = builtins?.find((agent) => agent.pageId === value);
  if (builtin !== undefined) return { id: value, title: builtin.title };
  const agent = driveAgents?.find((entry) => entry.id === value);
  return agent === undefined ? undefined : { id: agent.id, title: agent.title };
};
