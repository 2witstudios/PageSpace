import { NextResponse } from 'next/server';

const API_URL = process.env.PAGESPACE_API_URL!;
const TOKEN = process.env.PAGESPACE_MCP_TOKEN!;

export async function GET() {
  const res = await fetch(
    `${API_URL}/api/ai/page-agents/multi-drive?includeTools=false&includeSystemPrompt=false&groupByDrive=true`,
    { headers: { Authorization: `Bearer ${TOKEN}` }, cache: 'no-store' }
  );

  if (!res.ok) {
    return NextResponse.json({ error: `PageSpace error ${res.status}` }, { status: res.status });
  }

  const data = await res.json();
  return NextResponse.json(data);
}
