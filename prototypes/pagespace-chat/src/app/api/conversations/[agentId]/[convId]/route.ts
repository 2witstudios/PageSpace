import { NextResponse } from 'next/server';

const API_URL = process.env.PAGESPACE_API_URL!;
const TOKEN = process.env.PAGESPACE_MCP_TOKEN!;

export async function GET(
  _req: Request,
  context: { params: Promise<{ agentId: string; convId: string }> }
) {
  const { agentId, convId } = await context.params;
  const res = await fetch(
    `${API_URL}/api/ai/page-agents/${agentId}/conversations/${convId}/messages`,
    { headers: { Authorization: `Bearer ${TOKEN}` }, cache: 'no-store' }
  );

  if (!res.ok) {
    return NextResponse.json({ error: `PageSpace error ${res.status}` }, { status: res.status });
  }

  const data = await res.json();
  return NextResponse.json(data);
}
