"use client";

import Navigator from '@/components/layout/middle-content/page-views/terminal/workspace/Navigator';

interface TerminalNavigatorTabProps {
  terminalId: string;
}

/** Thin wrapper so the right sidebar's Terminal tab renders the same
 * Navigator the middle content used to render inline — relocated by
 * composition through the shared terminal-workspace store, not by
 * prop-threading. */
export default function TerminalNavigatorTab({ terminalId }: TerminalNavigatorTabProps) {
  return <Navigator terminalId={terminalId} />;
}
