// Mock AI helpers for testing AI-related functionality
// Note: This is a simplified version for basic testing.
// For full AI SDK testing, use the official @ai-sdk/provider/test package

export const aiHelpers = {
  createMockModel() {
    return {
      doGenerate: async ({ prompt, mode }: any) => {
        return {
          text: 'This is a mock AI response',
          finishReason: 'stop',
          usage: {
            promptTokens: 10,
            completionTokens: 5,
          },
        }
      },
      doStream: async function* ({ prompt, mode }: any) {
        yield { type: 'text-delta' as const, textDelta: 'This ' }
        yield { type: 'text-delta' as const, textDelta: 'is ' }
        yield { type: 'text-delta' as const, textDelta: 'streaming' }
        yield {
          type: 'finish' as const,
          finishReason: 'stop',
          usage: { promptTokens: 10, completionTokens: 3 },
        }
      },
    }
  },

  createMockToolCallingModel() {
    return {
      doGenerate: async ({ prompt, mode }: any) => {
        return {
          text: '',
          toolCalls: [
            {
              toolCallId: 'call_123',
              toolName: 'read_page',
              args: { pageId: 'page-123' },
            },
          ],
          finishReason: 'tool-calls',
          usage: {
            promptTokens: 10,
            completionTokens: 15,
          },
        }
      },
    }
  },
}