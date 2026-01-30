"use client";

import { cn } from "@/lib/utils";
import {
  FileText,
  MessageSquare,
  Sparkles,
  FolderOpen,
  Search,
  Plus,
  ChevronRight,
  MoreHorizontal,
  Users,
  Settings,
} from "lucide-react";

interface MockAppPreviewProps {
  variant?: "sidebar" | "document" | "chat" | "canvas";
  className?: string;
}

export function MockAppPreview({ variant = "sidebar", className }: MockAppPreviewProps) {
  return (
    <div className={cn("w-full h-full flex bg-background", className)}>
      {/* Sidebar */}
      <div className="w-[320px] border-r border-border bg-sidebar flex flex-col">
        {/* Sidebar Header */}
        <div className="p-4 border-b border-border">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-primary flex items-center justify-center">
              <span className="text-primary-foreground font-bold text-lg">P</span>
            </div>
            <div>
              <div className="font-semibold text-foreground">My Workspace</div>
              <div className="text-sm text-muted-foreground">Personal</div>
            </div>
          </div>
        </div>

        {/* Search */}
        <div className="p-3">
          <div className="flex items-center gap-2 px-3 py-2.5 rounded-lg bg-muted text-muted-foreground">
            <Search className="w-4 h-4" />
            <span className="text-sm">Search...</span>
          </div>
        </div>

        {/* Quick Actions */}
        <div className="px-3 pb-2">
          <button className="flex items-center gap-2 w-full px-3 py-2 rounded-lg hover:bg-accent text-sm text-foreground">
            <Plus className="w-4 h-4" />
            New Page
          </button>
        </div>

        {/* Navigation */}
        <div className="flex-1 overflow-auto px-3">
          <div className="space-y-1">
            <NavItem icon={<Sparkles className="w-4 h-4" />} label="AI Assistant" active />
            <NavItem icon={<MessageSquare className="w-4 h-4" />} label="Messages" badge="3" />
            <NavItem icon={<FolderOpen className="w-4 h-4" />} label="All Pages" />
          </div>

          <div className="mt-6">
            <div className="px-3 py-2 text-xs font-medium text-muted-foreground uppercase tracking-wider">
              Recent
            </div>
            <div className="space-y-1 mt-1">
              <NavItem icon={<FileText className="w-4 h-4" />} label="Product Roadmap" />
              <NavItem icon={<FileText className="w-4 h-4" />} label="Meeting Notes" />
              <NavItem icon={<FileText className="w-4 h-4" />} label="Design System" />
            </div>
          </div>
        </div>

        {/* User */}
        <div className="p-3 border-t border-border">
          <div className="flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-accent">
            <div className="w-8 h-8 rounded-full bg-primary/20 flex items-center justify-center">
              <span className="text-sm font-medium text-primary">JD</span>
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium text-foreground truncate">John Doe</div>
            </div>
            <Settings className="w-4 h-4 text-muted-foreground" />
          </div>
        </div>
      </div>

      {/* Main Content */}
      <div className="flex-1 flex flex-col">
        {variant === "document" && <DocumentContent />}
        {variant === "chat" && <ChatContent />}
        {variant === "sidebar" && <DocumentContent />}
        {variant === "canvas" && <CanvasContent />}
      </div>
    </div>
  );
}

function NavItem({
  icon,
  label,
  active,
  badge,
}: {
  icon: React.ReactNode;
  label: string;
  active?: boolean;
  badge?: string;
}) {
  return (
    <div
      className={cn(
        "flex items-center gap-2 px-3 py-2 rounded-lg text-sm",
        active
          ? "bg-primary/10 text-primary font-medium"
          : "text-foreground hover:bg-accent"
      )}
    >
      {icon}
      <span className="flex-1">{label}</span>
      {badge && (
        <span className="px-2 py-0.5 text-xs rounded-full bg-primary text-primary-foreground">
          {badge}
        </span>
      )}
      <ChevronRight className="w-4 h-4 text-muted-foreground opacity-0 group-hover:opacity-100" />
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
        </div>
        <div className="flex items-center gap-2">
          <div className="flex -space-x-2">
            <div className="w-8 h-8 rounded-full bg-blue-500 border-2 border-background" />
            <div className="w-8 h-8 rounded-full bg-green-500 border-2 border-background" />
            <div className="w-8 h-8 rounded-full bg-purple-500 border-2 border-background" />
          </div>
          <button className="p-2 rounded-lg hover:bg-accent">
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

function ChatContent() {
  return (
    <>
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-border">
        <div className="flex items-center gap-3">
          <Sparkles className="w-5 h-5 text-primary" />
          <span className="font-medium text-foreground">AI Assistant</span>
        </div>
        <button className="p-2 rounded-lg hover:bg-accent">
          <MoreHorizontal className="w-5 h-5 text-muted-foreground" />
        </button>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-auto p-6 space-y-6">
        <div className="flex gap-4">
          <div className="w-10 h-10 rounded-full bg-primary/20 flex items-center justify-center flex-shrink-0">
            <span className="text-sm font-medium text-primary">JD</span>
          </div>
          <div className="flex-1">
            <div className="text-sm text-muted-foreground mb-1">You</div>
            <div className="bg-muted rounded-2xl rounded-tl-sm px-4 py-3 text-foreground">
              Can you help me write a product roadmap for Q1?
            </div>
          </div>
        </div>

        <div className="flex gap-4">
          <div className="w-10 h-10 rounded-full bg-primary flex items-center justify-center flex-shrink-0">
            <Sparkles className="w-5 h-5 text-primary-foreground" />
          </div>
          <div className="flex-1">
            <div className="text-sm text-muted-foreground mb-1">PageSpace AI</div>
            <div className="bg-primary/10 rounded-2xl rounded-tl-sm px-4 py-3 text-foreground space-y-3">
              <p>I&apos;d be happy to help you create a Q1 product roadmap. Let me suggest a structure:</p>
              <ul className="list-disc list-inside space-y-1 text-sm">
                <li>Executive Summary</li>
                <li>Key Objectives & KPIs</li>
                <li>Feature Releases Timeline</li>
                <li>Resource Allocation</li>
              </ul>
              <p>Would you like me to expand on any of these sections?</p>
            </div>
          </div>
        </div>
      </div>

      {/* Input */}
      <div className="p-4 border-t border-border">
        <div className="flex items-center gap-3 px-4 py-3 rounded-xl border border-border bg-background">
          <input
            type="text"
            placeholder="Ask anything..."
            className="flex-1 bg-transparent outline-none text-foreground placeholder:text-muted-foreground"
          />
          <button className="p-2 rounded-lg bg-primary text-primary-foreground">
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" />
            </svg>
          </button>
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
