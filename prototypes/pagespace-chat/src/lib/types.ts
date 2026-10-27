export interface Agent {
  id: string;
  title: string;
  aiModel?: string;
  aiProvider?: string;
}

export interface DriveAgents {
  driveName: string;
  driveId: string;
  driveSlug: string;
  agents: Agent[];
}

export interface Conversation {
  id: string;
  createdAt: string;
  preview: string;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
}

export interface LocalConversation {
  id: string;
  agentId: string;
  agentTitle: string;
  createdAt: string;
  messages: ChatMessage[];
}
