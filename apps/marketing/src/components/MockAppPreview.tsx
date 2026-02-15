"use client";

import { useState } from "react";
import { cn } from "@/lib/utils";
import {
  FileText,
  MessageSquare,
  Search,
  Plus,
  ChevronRight,
  ChevronLeft,
  ChevronDown,
  MoreHorizontal,
  Users,
  Settings,
  CheckSquare,
  Calendar,
  Home,
  Inbox,
  ChevronsUpDown,
  Folder,
  Brain,
  History,
  Activity,
  ArrowRight,
  Wrench,
  PanelLeft,
  PanelRight,
} from "lucide-react";

interface MockAppPreviewProps {
  variant?: "sidebar" | "document" | "chat" | "canvas";
  className?: string;
}

export function MockAppPreview({ variant = "sidebar", className }: MockAppPreviewProps) {
  return (
    <div className={cn("w-full h-full flex flex-col bg-background", className)}>
      {/* TopBar — matches real desktop app TopBar */}
      <div className="flex items-center gap-2 px-3 py-2 liquid-glass-thin border-b border-[var(--separator)] text-card-foreground shadow-[var(--shadow-ambient)] dark:shadow-none">
        {/* Left: sidebar toggle + nav */}
        <div className="flex items-center gap-1">
          <button className="h-7 w-7 rounded-md flex items-center justify-center hover:bg-muted transition-colors">
            <PanelLeft className="h-4 w-4 text-muted-foreground" />
          </button>
          <button className="h-7 w-7 rounded-md flex items-center justify-center text-muted-foreground/40 cursor-not-allowed">
            <ChevronLeft className="h-4 w-4" />
          </button>
          <button className="h-7 w-7 rounded-md flex items-center justify-center text-muted-foreground/40 cursor-not-allowed">
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>
        {/* Breadcrumb */}
        <div className="flex items-center gap-1 text-sm text-muted-foreground">
          <Home className="h-3.5 w-3.5" />
          <span>/</span>
        </div>
        {/* Search */}
        <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-muted/50 border border-border text-sm text-muted-foreground w-56">
          <Search className="h-3.5 w-3.5" />
          <span className="flex-1">Search...</span>
          <kbd className="text-xs opacity-60">⌘K</kbd>
        </div>
        <div className="flex-1" />
        {/* Right: panel toggle + avatar */}
        <div className="flex items-center gap-1">
          <button className="h-7 w-7 rounded-md flex items-center justify-center hover:bg-muted transition-colors">
            <PanelRight className="h-4 w-4 text-muted-foreground" />
          </button>
          <div className="h-6 w-6 rounded-full bg-blue-500 flex items-center justify-center">
            <span className="text-[10px] font-medium text-white">JD</span>
          </div>
        </div>
      </div>

      {/* Content area with floating sidebars */}
      <div className="flex-1 flex min-h-0">
        {/* Sidebar with pt-4 floating gap */}
        <div className="flex flex-col pt-4">
          <Sidebar activeView={variant} />
        </div>

        {/* Main Content */}
        <div className="flex-1 flex flex-col min-w-0">
          {variant === "document" && <DocumentContent />}
          {variant === "chat" && <ChatContent />}
          {variant === "sidebar" && <DocumentContent />}
          {variant === "canvas" && <CanvasContent />}
        </div>
      </div>
    </div>
  );
}

// Sidebar component matching real app structure
function Sidebar({ activeView }: { activeView: string }) {
  // Interactive tree state
  const [expanded, setExpanded] = useState<Record<string, boolean>>({
    "q1-planning": true,
    "product-launch": false,
  });

  const toggleExpanded = (id: string) => {
    setExpanded(prev => ({ ...prev, [id]: !prev[id] }));
  };

  return (
    <div className="w-[280px] liquid-glass-regular rounded-tr-lg border border-[var(--separator)] shadow-[var(--shadow-elevated)] dark:shadow-none flex flex-col flex-1 px-3 py-3">
      {/* 1. Drive Switcher - matches DriveSwitcher.tsx */}
      <div className="mb-3">
        <button className="flex items-center gap-2 px-2 h-9 w-full rounded-lg hover:bg-accent transition-colors">
          <Folder className="h-4 w-4 shrink-0 text-primary" />
          <span className="truncate font-medium text-sm flex-1 text-left">My Workspace</span>
          <ChevronsUpDown className="h-4 w-4 shrink-0 text-muted-foreground" />
        </button>
      </div>

      {/* 2. Primary Navigation - matches PrimaryNavigation.tsx EXACTLY */}
      <nav className="flex flex-col gap-0.5 mb-2">
        <NavLink icon={<Home className="h-4 w-4" />} label="Dashboard" />
        <NavLink icon={<Inbox className="h-4 w-4" />} label="Inbox" badge="3" />
        <NavLink icon={<CheckSquare className="h-4 w-4" />} label="Tasks" active={activeView === "canvas"} />
        <NavLink icon={<Calendar className="h-4 w-4" />} label="Calendar" />
      </nav>

      {/* 3. Search + Create Button */}
      <div className="flex items-center gap-2 mb-3">
        <div className="relative flex-1">
          <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <div className="h-8 w-full pl-8 pr-3 rounded-lg border border-border bg-background text-sm text-muted-foreground flex items-center">
            Search pages...
          </div>
        </div>
        <button className="h-8 w-8 shrink-0 rounded-lg border border-border bg-background flex items-center justify-center hover:bg-accent transition-colors">
          <Plus className="h-4 w-4 text-muted-foreground" />
        </button>
      </div>

      {/* 4. Page Tree - ACTUAL PAGES, no file extensions */}
      <nav className="flex-1 overflow-auto px-1 py-2">
        {/* Q1 Planning - expandable parent */}
        <PageTreeItem
          icon={<FileText className="w-4 h-4 text-primary" />}
          title="Q1 Planning"
          hasChildren
          expanded={expanded["q1-planning"]}
          onToggle={() => toggleExpanded("q1-planning")}
          active={activeView === "document"}
        />

        {/* Children of Q1 Planning */}
        {expanded["q1-planning"] && (
          <>
            <PageTreeItem
              icon={<FileText className="w-4 h-4 text-gray-500" />}
              title="Product Roadmap"
              depth={1}
              hasChanges
            />
            <PageTreeItem
              icon={<MessageSquare className="w-4 h-4 text-gray-500" />}
              title="Team Discussion"
              depth={1}
            />
            <PageTreeItem
              icon={<FileText className="w-4 h-4 text-gray-500" />}
              title="Budget Analysis"
              depth={1}
            />
          </>
        )}

        {/* Product Launch - expandable parent */}
        <PageTreeItem
          icon={<Folder className="w-4 h-4 text-primary" />}
          title="Product Launch"
          hasChildren
          expanded={expanded["product-launch"]}
          onToggle={() => toggleExpanded("product-launch")}
        />

        {/* Children of Product Launch */}
        {expanded["product-launch"] && (
          <>
            <PageTreeItem
              icon={<FileText className="w-4 h-4 text-gray-500" />}
              title="Launch Checklist"
              depth={1}
            />
            <PageTreeItem
              icon={<FileText className="w-4 h-4 text-gray-500" />}
              title="Marketing Copy"
              depth={1}
            />
          </>
        )}

        {/* Meeting Notes - single page */}
        <PageTreeItem
          icon={<FileText className="w-4 h-4 text-gray-500" />}
          title="Meeting Notes"
        />

        {/* Design System - single page */}
        <PageTreeItem
          icon={<FileText className="w-4 h-4 text-gray-500" />}
          title="Design System"
        />
      </nav>

      {/* 5. AI Assistant - special item */}
      <div className="pt-3 border-t border-border">
        <div className={cn(
          "group flex items-center px-2 py-1.5 rounded-lg transition-all duration-200",
          activeView === "chat"
            ? "bg-accent text-accent-foreground"
            : "hover:bg-accent hover:text-accent-foreground"
        )}>
          <div className="p-0.5 rounded">
            <Brain className="h-4 w-4 text-violet-600 dark:text-violet-400" />
          </div>
          <span className="flex-1 min-w-0 ml-1.5 truncate text-sm font-medium cursor-pointer">
            AI Assistant
          </span>
          <span className="text-xs px-1.5 py-0.5 rounded-full bg-violet-100 text-violet-700 dark:bg-violet-900/30 dark:text-violet-300 font-medium">
            global
          </span>
        </div>
      </div>

      {/* 6. User Footer */}
      <div className="pt-3 border-t border-border mt-3">
        <div className="flex items-center gap-3 px-2 py-1.5 rounded-lg hover:bg-accent transition-colors cursor-pointer">
          <div className="w-8 h-8 rounded-full bg-blue-500 flex items-center justify-center border-2 border-card">
            <span className="text-sm font-medium text-white">JD</span>
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium text-foreground truncate">John Doe</div>
          </div>
          <Settings className="w-4 h-4 text-muted-foreground" />
        </div>
      </div>
    </div>
  );
}

// Primary Navigation Link - matches PrimaryNavigation.tsx styling
function NavLink({
  icon,
  label,
  active,
  badge
}: {
  icon: React.ReactNode;
  label: string;
  active?: boolean;
  badge?: string;
}) {
  return (
    <div
      className={cn(
        "flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm font-medium transition-colors cursor-pointer",
        active
          ? "bg-accent text-accent-foreground"
          : "text-sidebar-foreground hover:bg-accent hover:text-accent-foreground"
      )}
    >
      {icon}
      <span className="flex-1">{label}</span>
      {badge && (
        <span className="px-2 py-0.5 text-xs rounded-full bg-primary text-primary-foreground">
          {badge}
        </span>
      )}
    </div>
  );
}

// PageTreeItem - EXACT MATCH to PageTreeItem.tsx with INTERACTIVE chevrons
function PageTreeItem({
  icon,
  title,
  active,
  depth = 0,
  hasChildren,
  expanded,
  onToggle,
  hasChanges,
}: {
  icon: React.ReactNode;
  title: string;
  active?: boolean;
  depth?: number;
  hasChildren?: boolean;
  expanded?: boolean;
  onToggle?: () => void;
  hasChanges?: boolean;
}) {
  return (
    <div
      className={cn(
        "group flex items-center px-1 py-1.5 rounded-lg transition-all duration-200",
        active
          ? "bg-gray-200 dark:bg-gray-700"
          : "hover:bg-gray-200 dark:hover:bg-gray-700"
      )}
      style={{ paddingLeft: `${depth * 12 + 4}px` }}
    >
      {/* Expand/Collapse Chevron - INTERACTIVE */}
      {hasChildren && (
        <button
          onClick={onToggle}
          className="p-1 rounded hover:bg-gray-300 dark:hover:bg-gray-600 transition-colors cursor-pointer"
        >
          <ChevronRight
            className={cn(
              "h-4 w-4 text-gray-500 transition-transform duration-200",
              expanded && "rotate-90"
            )}
          />
        </button>
      )}

      {/* Icon */}
      <div className={cn("p-0.5 rounded cursor-grab", !hasChildren && "ml-6")}>
        {icon}
      </div>

      {/* Change indicator dot */}
      {hasChanges && (
        <span className="w-2 h-2 rounded-full bg-blue-500 flex-shrink-0 ml-1" />
      )}

      {/* Title */}
      <span className="flex-1 min-w-0 ml-1.5 truncate text-sm font-medium text-gray-900 dark:text-gray-100 hover:underline cursor-pointer">
        {title}
      </span>

      {/* Add button (on hover) */}
      {hasChildren && (
        <div className="flex items-center ml-2 opacity-0 group-hover:opacity-100 transition-opacity duration-200">
          <button className="p-1 rounded hover:bg-gray-300 dark:hover:bg-gray-600 cursor-pointer">
            <Plus className="h-3 w-3 text-gray-500" />
          </button>
        </div>
      )}
    </div>
  );
}

function DocumentContent() {
  return (
    <>
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-border">
        <div className="flex items-center gap-3">
          <FileText className="w-5 h-5 text-muted-foreground" />
          <span className="font-medium text-foreground">Product Roadmap</span>
          <span className="text-xs text-muted-foreground">Saved</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex -space-x-2">
            <div className="w-8 h-8 rounded-full bg-blue-500 border-2 border-card flex items-center justify-center text-xs text-white font-medium">JD</div>
            <div className="w-8 h-8 rounded-full bg-green-500 border-2 border-card flex items-center justify-center text-xs text-white font-medium">SM</div>
            <div className="w-8 h-8 rounded-full bg-purple-500 border-2 border-card flex items-center justify-center text-xs text-white font-medium">AK</div>
          </div>
          <button className="p-2 rounded-lg hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors">
            <MoreHorizontal className="w-5 h-5 text-muted-foreground" />
          </button>
        </div>
      </div>

      {/* Document */}
      <div className="flex-1 overflow-auto p-8">
        <div className="max-w-3xl mx-auto space-y-6">
          <h1 className="text-4xl font-bold text-foreground">Product Roadmap 2025</h1>
          <p className="text-lg text-muted-foreground">
            Our vision for the next year, outlining key milestones and features.
          </p>

          <div className="space-y-4 pt-4">
            <h2 className="text-2xl font-semibold text-foreground">Q1 Goals</h2>
            <ul className="space-y-2 text-foreground">
              <li className="flex items-start gap-3">
                <div className="w-5 h-5 rounded border-2 border-primary mt-0.5" />
                <span>Launch AI-powered document assistant</span>
              </li>
              <li className="flex items-start gap-3">
                <div className="w-5 h-5 rounded bg-primary border-2 border-primary mt-0.5 flex items-center justify-center">
                  <svg className="w-3 h-3 text-primary-foreground" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                  </svg>
                </div>
                <span className="line-through text-muted-foreground">Real-time collaboration</span>
              </li>
              <li className="flex items-start gap-3">
                <div className="w-5 h-5 rounded border-2 border-primary mt-0.5" />
                <span>Mobile app beta release</span>
              </li>
            </ul>
          </div>
        </div>
      </div>
    </>
  );
}

// ChatContent - matching right-sidebar structure
function ChatContent() {
  return (
    <>
      {/* Tab Bar */}
      <div className="flex items-center border-b border-border">
        <button className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2.5 text-xs font-medium border-b-2 border-primary text-primary">
          <MessageSquare className="h-3.5 w-3.5" />
          Chat
        </button>
        <button className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2.5 text-xs font-medium text-muted-foreground border-b-2 border-transparent">
          <History className="h-3.5 w-3.5" />
          History
        </button>
        <button className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2.5 text-xs font-medium text-muted-foreground border-b-2 border-transparent">
          <Activity className="h-3.5 w-3.5" />
          Activity
        </button>
      </div>

      {/* Chat Header - AISelector mock */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-border">
        <button className="flex items-center gap-1.5 px-2 py-1 rounded-md hover:bg-accent text-sm font-medium transition-colors">
          Global Assistant
          <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
        </button>
        <button className="h-7 w-7 rounded-md hover:bg-accent flex items-center justify-center transition-colors" title="New Conversation">
          <Plus className="h-4 w-4 text-muted-foreground" />
        </button>
      </div>

      {/* Messages - compact mode, no avatars */}
      <div className="flex-1 overflow-auto p-3 flex flex-col gap-1.5">
        {/* User message */}
        <div className="group relative bg-primary/10 dark:bg-accent/20 p-2 rounded-md ml-2">
          <span className="text-xs font-medium text-primary">You</span>
          <p className="text-xs text-foreground">Can you help me write a product roadmap for Q1?</p>
          <span className="text-[10px] text-muted-foreground/60">10:30 AM</span>
          <div className="absolute right-1 top-1 opacity-0 group-hover:opacity-100 transition-opacity">
            <button className="h-5 w-5 rounded flex items-center justify-center hover:bg-accent">
              <MoreHorizontal className="h-3 w-3 text-muted-foreground" />
            </button>
          </div>
        </div>

        {/* AI response */}
        <div className="group relative">
          <div className="text-xs text-foreground space-y-1.5">
            <p>I&apos;d be happy to help you create a Q1 product roadmap. Let me suggest a structure:</p>
            <ul className="list-disc list-inside space-y-0.5 text-xs ml-1">
              <li>Executive Summary</li>
              <li>Key Objectives &amp; KPIs</li>
              <li>Feature Releases Timeline</li>
              <li>Resource Allocation</li>
            </ul>
            <p>Would you like me to expand on any of these sections?</p>
          </div>
          <span className="text-[10px] text-muted-foreground/60">10:30 AM</span>
          <div className="absolute right-0 top-0 opacity-0 group-hover:opacity-100 transition-opacity">
            <button className="h-5 w-5 rounded flex items-center justify-center hover:bg-accent">
              <MoreHorizontal className="h-3 w-3 text-muted-foreground" />
            </button>
          </div>
        </div>
      </div>

      {/* Input area */}
      <div className="p-3 border-t border-border">
        <div className="rounded-lg border border-border bg-background">
          <div className="px-3 py-2">
            <span className="text-xs text-muted-foreground">Ask about this page...</span>
          </div>
          <div className="flex items-center justify-between px-2 pb-2">
            <button className="h-6 w-6 rounded flex items-center justify-center hover:bg-accent transition-colors">
              <Wrench className="h-3.5 w-3.5 text-muted-foreground" />
            </button>
            <div className="flex items-center gap-2">
              <span className="text-[10px] text-muted-foreground">Claude / Opus 4.6</span>
              <button className="h-6 w-6 rounded-full bg-primary flex items-center justify-center">
                <ArrowRight className="h-3 w-3 text-primary-foreground" />
              </button>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

function CanvasContent() {
  return (
    <>
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-border">
        <div className="flex items-center gap-3">
          <Users className="w-5 h-5 text-muted-foreground" />
          <span className="font-medium text-foreground">Team Canvas</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-sm text-muted-foreground">3 collaborators</span>
        </div>
      </div>

      {/* Canvas */}
      <div className="flex-1 bg-muted/30 p-8 overflow-hidden">
        <div className="relative w-full h-full">
          {/* Cards */}
          <div className="absolute top-8 left-8 w-64 p-4 rounded-xl bg-card border border-border shadow-sm">
            <div className="text-sm font-medium text-foreground mb-2">Design Review</div>
            <div className="text-xs text-muted-foreground">Updated 2 hours ago</div>
          </div>

          <div className="absolute top-32 left-80 w-64 p-4 rounded-xl bg-card border border-border shadow-sm">
            <div className="text-sm font-medium text-foreground mb-2">Sprint Planning</div>
            <div className="text-xs text-muted-foreground">Updated 30 min ago</div>
          </div>

          <div className="absolute top-16 right-16 w-64 p-4 rounded-xl bg-primary/10 border border-primary/20 shadow-sm">
            <div className="text-sm font-medium text-primary mb-2">Launch Tasks</div>
            <div className="text-xs text-muted-foreground">In progress</div>
          </div>

          {/* Cursors */}
          <div className="absolute top-40 left-60">
            <div className="w-4 h-4 border-l-2 border-t-2 border-blue-500 rotate-[-45deg]" />
            <div className="mt-1 px-2 py-1 rounded bg-blue-500 text-white text-xs whitespace-nowrap">
              Alex
            </div>
          </div>

          <div className="absolute top-24 right-32">
            <div className="w-4 h-4 border-l-2 border-t-2 border-green-500 rotate-[-45deg]" />
            <div className="mt-1 px-2 py-1 rounded bg-green-500 text-white text-xs whitespace-nowrap">
              Sarah
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
