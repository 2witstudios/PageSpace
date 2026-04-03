"use client";

import React, { useState, useCallback, useRef, useEffect, type ReactNode } from 'react';
import { TUI } from '@gridland/web';
import { useKeyboard, type KeyEvent } from '@gridland/utils';
import type { TerminalSession } from './types';

// ── Typed Gridland primitives ────────────────────────────────────────────
// Gridland's reconciler defines intrinsic elements (box, text, scrollbox)
// at runtime. These wrappers provide TypeScript types without conflicting
// with the global JSX.IntrinsicElements (HTML text, input, code).

interface BoxProps {
  children?: ReactNode;
  flexDirection?: 'row' | 'column';
  flexGrow?: number;
  width?: number | string;
  height?: number | string;
  padding?: number;
  gap?: number;
  border?: boolean;
  borderStyle?: 'single' | 'rounded' | 'double' | 'bold';
  borderColor?: string;
  backgroundColor?: string;
}

interface TextProps {
  children?: ReactNode;
  fg?: string;
  bold?: boolean;
  dim?: boolean;
}

interface ScrollboxProps {
  children?: ReactNode;
  flexDirection?: 'row' | 'column';
  flexGrow?: number;
}

function Box(props: BoxProps) {
  return React.createElement('box', props);
}

function Text(props: TextProps) {
  return React.createElement('text', props);
}

function Scrollbox(props: ScrollboxProps) {
  return React.createElement('scrollbox', props);
}

// ── Types ────────────────────────────────────────────────────────────────

interface GridlandTerminalProps {
  session: TerminalSession;
  onCommand: (command: string) => void;
  onClear: () => void;
  isDark: boolean;
  isReadOnly: boolean;
}

// ── Theme ────────────────────────────────────────────────────────────────

const PROMPT = '$ ';

const themes = {
  dark: {
    bg: '#1a1b26',
    fg: '#c0caf5',
    prompt: '#7aa2f7',
    output: '#9ece6a',
    dim: '#565f89',
    border: '#3b4261',
    inputBg: '#1f2335',
  },
  light: {
    bg: '#f5f5f5',
    fg: '#343b58',
    prompt: '#2e7de9',
    output: '#587539',
    dim: '#8990b3',
    border: '#c4c8da',
    inputBg: '#e9e9ec',
  },
};

// ── Terminal content (runs inside TUI reconciler) ────────────────────────

function TerminalContent({ session, onCommand, onClear, isDark, isReadOnly }: GridlandTerminalProps) {
  const [input, setInput] = useState('');
  const [, setHistoryIndex] = useState(-1);
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
  }, [input, onCommand, onClear]);

  useKeyboard((key: KeyEvent) => {
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

    if (key.name === 'l' && key.ctrl) {
      onClear();
      return;
    }

    if (key.name === 'u' && key.ctrl) {
      setInput('');
      return;
    }

    if (key.sequence && key.sequence.length === 1 && !key.ctrl && !key.meta) {
      setInput(prev => prev + key.sequence);
    }
  });

  return (
    <Box flexDirection="column" flexGrow={1}>
      {/* Header bar */}
      <Box height={1} flexDirection="row" backgroundColor={theme.border}>
        <Text fg={theme.fg} bold> Terminal </Text>
        <Box flexGrow={1} />
        <Text fg={theme.dim}> {session.history.length} commands </Text>
      </Box>

      {/* Scrollable output */}
      <Scrollbox flexGrow={1} flexDirection="column">
        {session.history.length === 0 && (
          <Box flexDirection="column" padding={1}>
            <Text fg={theme.dim}>PageSpace Terminal</Text>
            <Text fg={theme.dim}>Type a command and press Enter. Type &quot;clear&quot; to reset.</Text>
            <Text fg={theme.dim}>Shell connection not yet configured.</Text>
          </Box>
        )}

        {session.history.map((entry, i) => (
          <Box key={i} flexDirection="column">
            <Box flexDirection="row">
              <Text fg={theme.prompt} bold>{PROMPT}</Text>
              <Text fg={theme.fg}>{entry.command}</Text>
            </Box>
            {entry.output && (
              <Box>
                <Text fg={theme.output}>{entry.output}</Text>
              </Box>
            )}
          </Box>
        ))}
      </Scrollbox>

      {/* Input line */}
      <Box height={1} flexDirection="row" backgroundColor={theme.inputBg}>
        <Text fg={theme.prompt} bold>{PROMPT}</Text>
        <Text fg={theme.fg}>{input}</Text>
        <Text fg={theme.prompt}>{'\u2588'}</Text>
      </Box>
    </Box>
  );
}

// ── Outer wrapper (manages DOM container + TUI mount) ────────────────────

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
