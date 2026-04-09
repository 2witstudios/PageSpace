import {
  ChevronRight,
  FolderTree,
  Layers,
  Folder,
  Home as HomeIcon,
  Inbox,
  CheckSquare,
  Calendar,
  Search,
  Plus,
  ChevronsUpDown,
  FileText,
  Sparkles,
  MessageSquare,
} from "lucide-react";

export function PageTreeSection() {
  return (
    <section className="py-16 md:py-24 lg:py-32">
      <div className="container mx-auto px-4 md:px-6">
        <div className="mx-auto max-w-3xl text-center mb-12 md:mb-16">
          <h2 className="text-3xl font-bold tracking-tight sm:text-4xl md:text-5xl mb-4">
            Everything is a page
          </h2>
          <p className="text-lg text-muted-foreground">
            Documents, channels, AI agents, spreadsheets, task lists, code files—all
            the same primitive in one tree. Where you place them shapes what AI knows about them.
          </p>
        </div>

        <div className="grid lg:grid-cols-2 gap-12 items-center">
          <SidebarMock />

          <div className="space-y-6">
            {[
              { icon: Layers, title: "Everything is a Page", desc: "Documents, channels, AI agents, spreadsheets, task lists, code files—all the same primitive. Nest and organize them however makes sense for your team." },
              { icon: FolderTree, title: "Context is Structure", desc: "Where you place an AI agent determines what it knows. Put it next to a spec and a channel—it sees both. Move it to a different project—different context. The tree is the knowledge graph." },
              { icon: Sparkles, title: "AI at Every Level", desc: "Drop an AI agent anywhere in the tree. A project-level agent understands the whole project. A document-level agent focuses deeply. A global assistant spans everything." },
            ].map((card) => (
              <div key={card.title} className="rounded-xl border border-border bg-card p-6">
                <div className="flex items-start gap-4">
                  <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 flex-shrink-0">
                    <card.icon className="h-5 w-5 text-primary" />
                  </div>
                  <div>
                    <h3 className="font-semibold mb-1">{card.title}</h3>
                    <p className="text-sm text-muted-foreground">{card.desc}</p>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

function SidebarMock() {
  return (
    <div className="relative">
      <div className="rounded-xl border border-border bg-card shadow-lg overflow-hidden">
        <div className="px-3 py-3 space-y-3">
          <div className="flex items-center gap-2 px-2 py-1.5">
            <ChevronsUpDown className="h-4 w-4 text-muted-foreground flex-shrink-0" />
            <span className="font-semibold text-sm">Acme Corp</span>
          </div>

          <nav className="space-y-0.5">
            {[
              { icon: HomeIcon, label: "Dashboard" },
              { icon: Inbox, label: "Inbox" },
              { icon: CheckSquare, label: "Tasks" },
              { icon: Calendar, label: "Calendar" },
            ].map((item) => (
              <div key={item.label} className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm font-medium text-muted-foreground hover:text-foreground">
                <item.icon className="h-4 w-4" />
                <span>{item.label}</span>
              </div>
            ))}
          </nav>

          <div className="flex items-center gap-1.5">
            <div className="relative flex-1">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
              <div className="h-8 w-full rounded-md border border-input bg-background pl-8 pr-3 text-sm text-muted-foreground flex items-center">Search pages...</div>
            </div>
            <div className="flex h-8 w-8 items-center justify-center rounded-md border border-input bg-background text-muted-foreground flex-shrink-0">
              <Plus className="h-4 w-4" />
            </div>
          </div>

          <div className="space-y-0.5 text-sm">
            <div className="flex items-center gap-1 rounded-lg px-1 py-1.5 font-medium">
              <ChevronRight className="h-4 w-4 text-gray-500 rotate-90 flex-shrink-0" />
              <Folder className="h-4 w-4 text-primary flex-shrink-0" />
              <span className="text-gray-900 dark:text-gray-100 truncate">Product Launch</span>
            </div>

            <div className="space-y-0.5" style={{ paddingLeft: "16px" }}>
              <div className="flex items-center gap-1 rounded-lg px-1 py-1.5 bg-gray-100 dark:bg-gray-800">
                <span className="w-4 flex-shrink-0" />
                <Sparkles className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                <span className="text-gray-900 dark:text-gray-100 font-medium truncate">Marketing Agent</span>
              </div>
              {[
                { icon: FileText, label: "Launch Plan" },
                { icon: FileText, label: "Press Kit" },
              ].map((item) => (
                <div key={item.label} className="flex items-center gap-1 rounded-lg px-1 py-1.5">
                  <span className="w-4 flex-shrink-0" />
                  <item.icon className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                  <span className="text-gray-900 dark:text-gray-100 font-medium truncate">{item.label}</span>
                </div>
              ))}

              <div className="flex items-center gap-1 rounded-lg px-1 py-1.5">
                <ChevronRight className="h-4 w-4 text-gray-500 rotate-90 flex-shrink-0" />
                <MessageSquare className="h-4 w-4 text-primary flex-shrink-0" />
                <span className="text-gray-900 dark:text-gray-100 font-medium truncate">team-updates</span>
              </div>

              <div className="space-y-0.5" style={{ paddingLeft: "20px" }}>
                {[
                  { icon: FileText, label: "standup-notes" },
                  { icon: CheckSquare, label: "Q1 Action Items" },
                ].map((item) => (
                  <div key={item.label} className="flex items-center gap-1 rounded-lg px-1 py-1.5">
                    <span className="w-4 flex-shrink-0" />
                    <item.icon className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                    <span className="text-gray-900 dark:text-gray-100 font-medium truncate">{item.label}</span>
                  </div>
                ))}
              </div>

              <div className="flex items-center gap-1 rounded-lg px-1 py-1.5">
                <span className="w-4 flex-shrink-0" />
                <CheckSquare className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                <span className="text-gray-900 dark:text-gray-100 font-medium truncate">Launch Tasks</span>
              </div>
            </div>

            <div className="flex items-center gap-1 rounded-lg px-1 py-1.5 font-medium mt-0.5">
              <ChevronRight className="h-4 w-4 text-gray-500 flex-shrink-0" />
              <Folder className="h-4 w-4 text-primary flex-shrink-0" />
              <span className="text-gray-900 dark:text-gray-100 truncate">Engineering</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
