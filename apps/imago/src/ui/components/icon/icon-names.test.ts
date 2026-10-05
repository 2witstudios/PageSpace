import { renderToString } from 'react-dom/server';
import { createElement as h } from 'react';
import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import {
  ArrowUpRight,
  Bot,
  Calendar,
  Check,
  ChevronDown,
  ChevronRight,
  Ellipsis,
  FileText,
  Files,
  Flag,
  Folder,
  Hash,
  LayoutGrid,
  ListTodo,
  Menu,
  MessageSquare,
  MessagesSquare,
  Monitor,
  Moon,
  Plus,
  Puzzle,
  Search,
  Send,
  Settings,
  Share2,
  Sparkles,
  Sun,
  SquareTerminal,
  Trash2,
  X,
} from 'lucide-react';
import { iconNames, icons } from './icon-names';

describe('icon names', () => {
  test('myimago names map to lucide icons', () => {
    assert({
      given: "every icon name myimago's shell uses (DEC-8)",
      should: 'map each to its lucide-react icon',
      actual: icons,
      expected: {
        search: Search,
        chat: MessageSquare,
        files: Files,
        messages: MessagesSquare,
        tasks: ListTodo,
        calendar: Calendar,
        console: SquareTerminal,
        plugins: Puzzle,
        settings: Settings,
        folder: Folder,
        page: FileText,
        plus: Plus,
        sparkle: Sparkles,
        send: Send,
        share: Share2,
        grid: LayoutGrid,
        menu: Menu,
        close: X,
        arrowUpRight: ArrowUpRight,
        hash: Hash,
        check: Check,
        bot: Bot,
        flag: Flag,
        more: Ellipsis,
        trash: Trash2,
        chevronRight: ChevronRight,
        chevronDown: ChevronDown,
        sun: Sun,
        moon: Moon,
        monitor: Monitor,
      },
    });
  });

  test('every name draws', () => {
    const empty = iconNames.filter(
      (name) => !/<svg[^>]*>.*<(path|rect|circle|line|polyline)/.test(
        renderToString(h(icons[name])),
      ),
    );
    assert({
      given: 'every mapped icon rendered on its own',
      should: 'draw shapes inside the svg (no silently empty icon)',
      actual: empty,
      expected: [],
    });
  });
});
