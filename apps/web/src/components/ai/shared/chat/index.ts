/**
 * Shared chat components - used by both Agent engine and Global Assistant engine
 */

// Chat infrastructure
export { ChatMessagesArea, type ChatMessagesAreaRef } from './ChatMessagesArea';
export { ChatInputArea, type ChatInputAreaRef } from './ChatInputArea';
export { StreamingIndicator } from './StreamingIndicator';
export { ProviderSetupCard } from './ProviderSetupCard';
export { VirtualizedMessageList, type VirtualizedMessageListProps } from './VirtualizedMessageList';
export { VirtualizedConversationList, type VirtualizedConversationListProps } from './VirtualizedConversationList';

// Message rendering
export { default as AiInput } from './AiInput';
export { MessageRenderer } from './MessageRenderer';
export { CompactMessageRenderer } from './CompactMessageRenderer';
export { StreamingMarkdown } from './StreamingMarkdown';
export { TodoListMessage } from './TodoListMessage';
export { CompactTodoListMessage } from './CompactTodoListMessage';
export { MessageActionButtons } from './MessageActionButtons';
export { MessageEditor } from './MessageEditor';
export { DeleteMessageDialog } from './DeleteMessageDialog';
export { UndoAiChangesDialog } from './UndoAiChangesDialog';

// Tool call rendering
export * from './tool-calls';
