"use client";

import React from 'react';
import type { TerminalSession } from './types';

interface GridlandTerminalProps {
  session: TerminalSession;
  onCommand: (command: string) => void;
  onClear: () => void;
  isDark: boolean;
  isReadOnly: boolean;
}

export default function GridlandTerminal(_props: GridlandTerminalProps) {
  return (
    <div className="w-full h-full flex items-center justify-center text-sm text-muted-foreground">
      Terminal — coming soon
    </div>
  );
}
