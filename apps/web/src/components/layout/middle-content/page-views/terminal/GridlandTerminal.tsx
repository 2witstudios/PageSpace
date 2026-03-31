"use client";

import React, { useState, useCallback, useRef, useEffect } from 'react';
import { TUI } from '@gridland/web/next';
import { useKeyboard } from '@gridland/utils';

interface HistoryEntry {
  command: string;
  output: string;
  timestamp: number;
}

interface TerminalSession {
  history: HistoryEntry[];
}

interface GridlandTerminalProps {
  session: TerminalSession;
  onCommand: (command: string) => void;
  onClear: () => void;
  isDark: boolean;
  isReadOnly: boolean;
}

const PROMPT = '$ ';

// Theme colors
const themes = {
  dark: {
    bg: '#1a1b26',
    fg: '#c0caf5',
    prompt: '#7aa2f7',
    output: '#9ece6a',
    error: '#f7768e',
    dim: '#565f89',
    border: '#3b4261',
    inputBg: '#1f2335',
  },
  light: {
    bg: '#f5f5f5',
    fg: '#343b58',
    prompt: '#2e7de9',
    output: '#587539',
    error: '#c64343',
    dim: '#8990b3',
    border: '#c4c8da',
    inputBg: '#e9e9ec',
  },
};

function TerminalContent({ session, onCommand, onClear, isDark, isReadOnly }: GridlandTerminalProps) {
  const [input, setInput] = useState('');
  const [historyIndex, setHistoryIndex] = useState(-1);
  const scrollOffsetRef = useRef(0);
  const theme = isDark ? themes.dark : themes.light;

  const handleSubmit = useCallback(() => {
    const trimmed = input.trim();
    if (!trimmed) return;

    if (trimmed === 'clear') {
      onClear();
      setInput('');
      setHistoryIndex(-1);
      return;
    }

    onCommand(trimmed);
    setInput('');
    setHistoryIndex(-1);
    scrollOffsetRef.current = 0;
  }, [input, onCommand, onClear]);

  useKeyboard((key) => {
    if (isReadOnly) return;

    if (key.name === 'return') {
      handleSubmit();
      return;
    }

    if (key.name === 'backspace') {
      setInput(prev => prev.slice(0, -1));
      return;
    }

    if (key.name === 'up') {
      setHistoryIndex(prev => {
        const commands = session.history.map(h => h.command);
        const next = prev + 1;
        if (next < commands.length) {
          setInput(commands[commands.length - 1 - next]);
          return next;
        }
        return prev;
      });
      return;
    }

    if (key.name === 'down') {
      setHistoryIndex(prev => {
        if (prev <= 0) {
          setInput('');
          return -1;
        }
        const commands = session.history.map(h => h.command);
        const next = prev - 1;
        setInput(commands[commands.length - 1 - next]);
        return next;
      });
      return;
    }

    // Ctrl+L to clear
    if (key.name === 'l' && key.ctrl) {
      onClear();
      return;
    }

    // Ctrl+U to clear input line
    if (key.name === 'u' && key.ctrl) {
      setInput('');
      return;
    }

    // Regular character input
    if (key.sequence && key.sequence.length === 1 && !key.ctrl && !key.meta) {
      setInput(prev => prev + key.sequence);
    }
  });

  return (
    <box flexDirection="column" flexGrow={1}>
      {/* Header */}
      <box
        height={1}
        flexDirection="row"
        backgroundColor={theme.border}
      >
        <text fg={theme.fg} bold> Terminal </text>
        <box flexGrow={1} />
        <text fg={theme.dim}> {session.history.length} commands </text>
      </box>

      {/* Scrollable output area */}
      <scrollbox flexGrow={1} flexDirection="column">
        {/* Welcome message when empty */}
        {session.history.length === 0 && (
          <box flexDirection="column" padding={1}>
            <text fg={theme.dim}>PageSpace Terminal</text>
            <text fg={theme.dim}>Type a command and press Enter. Type &quot;clear&quot; to reset.</text>
            <text fg={theme.dim}>Shell connection not yet configured.</text>
            <text fg={theme.dim}>{''}</text>
          </box>
        )}

        {/* Command history */}
        {session.history.map((entry, i) => (
          <box key={i} flexDirection="column">
            <box flexDirection="row">
              <text fg={theme.prompt} bold>{PROMPT}</text>
              <text fg={theme.fg}>{entry.command}</text>
            </box>
            {entry.output && (
              <box>
                <text fg={theme.output}>{entry.output}</text>
              </box>
            )}
          </box>
        ))}
      </scrollbox>

      {/* Input line */}
      <box
        height={1}
        flexDirection="row"
        backgroundColor={theme.inputBg}
        borderColor={theme.border}
      >
        <text fg={theme.prompt} bold>{PROMPT}</text>
        <text fg={theme.fg}>{input}</text>
        <text fg={theme.prompt}>{'█'}</text>
      </box>
    </box>
  );
}

export default function GridlandTerminal(props: GridlandTerminalProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [dimensions, setDimensions] = useState({ width: 0, height: 0 });
  const theme = props.isDark ? themes.dark : themes.light;

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const observer = new ResizeObserver(entries => {
      for (const entry of entries) {
        setDimensions({
          width: entry.contentRect.width,
          height: entry.contentRect.height,
        });
      }
    });

    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return (
    <div ref={containerRef} className="w-full h-full">
      {dimensions.width > 0 && dimensions.height > 0 && (
        <TUI
          style={{ width: dimensions.width, height: dimensions.height }}
          backgroundColor={theme.bg}
          fontSize={14}
          autoFocus
        >
          <TerminalContent {...props} />
        </TUI>
      )}
    </div>
  );
}
