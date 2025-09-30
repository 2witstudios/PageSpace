// Mock AI helpers for testing AI-related functionality
// Note: This is a simplified version for basic testing.
// For full AI SDK testing, use the official @ai-sdk/provider/test package

type MockGenerateInput = { prompt: string; mode?: string }

export const aiHelpers = {
  createMockModel() {
    return {
      doGenerate: async (input: MockGenerateInput) => {
        void input
        return {
          text: 'This is a mock AI response',
          finishReason: 'stop',
          usage: {
            promptTokens: 10,
            completionTokens: 5,
          },
        }
      },
      doStream: async function* (input: MockGenerateInput) {
        void input
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
      doGenerate: async (input: MockGenerateInput) => {
        void input
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
