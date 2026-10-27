import AssistantView from "@/components/assistant/AssistantView";

/**
 * The landing is the global assistant — mirroring the PageSpace dashboard,
 * where the middle pane at `/dashboard` is GlobalAssistantView. The fleet
 * pulse lives at /fleet, one click away.
 */
export default function HomePage() {
  return <AssistantView />;
}
