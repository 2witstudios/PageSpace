import { streamChat } from '@/lib/pagespace';

export const runtime = 'nodejs';

export async function POST(request: Request): Promise<Response> {
  let body: { messages: Array<{ role: 'user' | 'assistant'; content: string }>; conversation_id?: string };
  try {
    body = await request.json() as typeof body;
  } catch {
    return Response.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const apiKey = process.env.PAGESPACE_API_KEY;
  const baseUrl = process.env.PAGESPACE_BASE_URL ?? 'http://localhost:3000';
  const model = process.env.PAGESPACE_MODEL ?? 'ps-agent://default';

  if (!apiKey) {
    return Response.json({ error: 'PAGESPACE_API_KEY not configured' }, { status: 500 });
  }

  const { messages, conversation_id: conversationId } = body;

  const stream = await streamChat({ apiKey, baseUrl, model, messages, conversationId });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
}
