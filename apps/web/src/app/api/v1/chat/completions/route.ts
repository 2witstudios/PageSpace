import { streamText } from 'ai';
import {
  createAIProvider,
  isProviderError,
} from '@/lib/ai/core/provider-factory';
import { resolveInferenceContext } from '@/lib/ai/openai-api/context-resolver';
import { parseCompletionRequest } from '@/lib/ai/openai-api/request-adapter';
import {
  toChunk,
  toCompletion,
  sseEvent,
  SSE_DONE,
  createCompletionMeta,
} from '@/lib/ai/openai-api/response-adapter';

const errorResponse = (
  status: number,
  error: { message: string; type: string; code: string; param?: string },
) => Response.json({ error }, { status });

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse(400, {
      message: 'Request body must be valid JSON.',
      type: 'invalid_request_error',
      code: 'invalid_json',
    });
  }

  const parsed = parseCompletionRequest(body);
  if (!parsed.ok) {
    return errorResponse(parsed.status, parsed.error);
  }

  const ctx = await resolveInferenceContext(request, parsed.model);
  if (!ctx.ok) {
    return errorResponse(ctx.status, ctx.error);
  }

  const agent = ctx.context.page as {
    aiProvider?: string | null;
    aiModel?: string | null;
    systemPrompt?: string | null;
  };

  const providerResult = await createAIProvider(ctx.context.userId, {
    selectedProvider: agent.aiProvider ?? undefined,
    selectedModel: agent.aiModel ?? undefined,
  });
  if (isProviderError(providerResult)) {
    return errorResponse(providerResult.status, {
      message: providerResult.error,
      type: 'api_error',
      code: 'provider_error',
    });
  }

  const meta = createCompletionMeta(parsed.model);
  const aiResult = streamText({
    model: providerResult.model,
    system: agent.systemPrompt ?? undefined,
    messages: parsed.messages,
  });

  if (!parsed.stream) {
    const [content, usage] = await Promise.all([
      aiResult.text,
      aiResult.totalUsage,
    ]);
    return Response.json(
      toCompletion(meta, {
        content,
        usage: {
          promptTokens: usage?.inputTokens ?? 0,
          completionTokens: usage?.outputTokens ?? 0,
        },
      }),
    );
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        controller.enqueue(
          encoder.encode(sseEvent(toChunk(meta, { role: 'assistant' }))),
        );
        for await (const delta of aiResult.textStream) {
          controller.enqueue(
            encoder.encode(sseEvent(toChunk(meta, { delta }))),
          );
        }
        controller.enqueue(
          encoder.encode(sseEvent(toChunk(meta, { finishReason: 'stop' }))),
        );
        controller.enqueue(encoder.encode(SSE_DONE));
      } catch (err) {
        controller.enqueue(
          encoder.encode(
            sseEvent({
              error: {
                message: err instanceof Error ? err.message : 'Inference failed.',
                type: 'api_error',
                code: 'inference_error',
              },
            }),
          ),
        );
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
    },
  });
}
