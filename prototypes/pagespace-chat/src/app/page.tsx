import { ChatShell } from '@/components/ChatShell';

export default function Home() {
  // Pass activeConvId from a URL param or env var to enable thread mode.
  // Without it, the prototype operates in OpenAI mode (client sends full history).
  const activeConvId = process.env.DEMO_CONVERSATION_ID;
  return <ChatShell activeConvId={activeConvId} />;
}
