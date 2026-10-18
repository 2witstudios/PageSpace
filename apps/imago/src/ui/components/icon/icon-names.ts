import {
  Activity,
  Bell,
  ArrowUpRight,
  Bot,
  Cable,
  Calendar,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Ellipsis,
  File,
  FileCode,
  FileImage,
  FileSpreadsheet,
  FileText,
  ListFilter,
  Files,
  Flag,
  Folder,
  GripVertical,
  Hash,
  History,
  SquarePen,
  LayoutGrid,
  ListTodo,
  Lock,
  Menu,
  MessageSquare,
  MessagesSquare,
  Monitor,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  Plus,
  Puzzle,
  Search,
  Send,
  Settings,
  Share2,
  Sun,
  Square,
  SquareTerminal,
  Trash2,
  Undo2,
  Redo2,
  Webhook,
  Users,
  Wallet,
  Workflow,
  Wrench,
  X,
  type LucideIcon,
} from 'lucide-react';

// DEC-8: lucide-react replaces myimago's hand-drawn set. The keys are the
// names myimago's shell uses, so ported call sites keep their icon names.
export const icons = {
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
  chevronLeft: ChevronLeft,
  chevronDown: ChevronDown,
  sun: Sun,
  moon: Moon,
  monitor: Monitor,
  // The spine's drive tools and bell (IMC-1.4).
  activity: Activity,
  agents: Bot,
  workflows: Workflow,
  members: Users,
  bell: Bell,
  connections: Cable,
  // A view-only thread's notice.
  lock: Lock,
  // The chat composer's Stop and a tool call's line.
  stop: Square,
  tool: Wrench,
  // Page types imago opens in classic (DEC-9), as classic draws them
  // (page-types.config iconName).
  canvas: FileImage,
  sheet: FileSpreadsheet,
  code: FileCode,
  file: File,
  // Imago's head: History and New chat (IMC-2.1).
  history: History,
  // Page-type strips (IMC-3.3, IMC-3.9).
  undo: Undo2,
  redo: Redo2,
  webhook: Webhook,
  // The spend strip above the composer (IMC-2.4).
  wallet: Wallet,
  newChat: SquarePen,
  // The Files pane's filter field (IMC-1.8).
  filter: ListFilter,
  // The v3.2 column controls (IMC-1.6): Close/Show sidebar, Collapse Imago.
  panelLeftClose: PanelLeftClose,
  panelLeftOpen: PanelLeftOpen,
  panelRightClose: PanelRightClose,
  // The Board's drag handle (IMG-9.4).
  grip: GripVertical,
} as const satisfies Readonly<Record<string, LucideIcon>>;

/**
 * `imago` is Imago's orb (ImagoOrb), drawn by renderIcon rather than from lucide, so it is
 * named here and not in `icons`. Use it only for Imago itself, never for another agent.
 */
export type IconName = keyof typeof icons | 'imago';

export const iconNames = Object.keys(icons) as readonly IconName[];
