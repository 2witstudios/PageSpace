'use client';

export default function MessagesLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // The sidebar is now handled by the main Layout component
  // which detects the messages route and shows MessagesLeftSidebar
  return children;
}