"use client";

import GlobalAssistantView from '@/components/layout/middle-content/page-views/dashboard/GlobalAssistantView';

export default function DrivePage() {
  // The GlobalAssistantView will be context-aware through the locationContext
  // that gets passed to the AI API, which includes the current drive info
  return <GlobalAssistantView />;
}