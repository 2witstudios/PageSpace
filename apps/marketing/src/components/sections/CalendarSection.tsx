import {
  CheckSquare,
  CalendarDays,
  Zap,
  Bot,
} from "lucide-react";

export function CalendarSection() {
  return (
    <section className="py-16 md:py-24 lg:py-32">
      <div className="container mx-auto px-4 md:px-6">
        <div className="mx-auto max-w-3xl text-center mb-12 md:mb-16">
          <h2 className="text-3xl font-bold tracking-tight sm:text-4xl md:text-5xl mb-4">
            Everything in one view
          </h2>
          <p className="text-lg text-muted-foreground">
            Unified calendar across all your workspaces.
            Task deadlines, meetings, and AI work sessions—all in one place.
          </p>
        </div>

        <div className="grid lg:grid-cols-2 gap-12 items-center">
          <div className="space-y-6">
            {[
              { icon: CalendarDays, title: "Cross-Workspace View", desc: "See events from all your drives in one calendar. Filter by workspace, project, or person when you need focus." },
              { icon: Zap, title: "Google Calendar Sync", desc: "Connect your Google Calendar to see everything together. External meetings alongside PageSpace deadlines." },
              { icon: Bot, title: "AI Scheduling Awareness", desc: "AI agents see your calendar. They know when you're busy and can suggest better times for focus work." },
              { icon: CheckSquare, title: "Task Deadlines", desc: "Task due dates appear on your calendar automatically. Never miss a deadline because it was hidden in a task list." },
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

          <CalendarMock />
        </div>
      </div>
    </section>
  );
}

function CalendarMock() {
  const days = [
    { day: "Mon", date: 10, isToday: false },
    { day: "Tue", date: 11, isToday: false },
    { day: "Wed", date: 12, isToday: true },
    { day: "Thu", date: 13, isToday: false },
    { day: "Fri", date: 14, isToday: false },
  ];

  const hours = [9, 10, 11, 12, 14];

  return (
    <div className="relative">
      <div className="rounded-xl border border-border bg-card shadow-lg overflow-hidden">
        <div className="flex items-center justify-between border-b border-border bg-muted/30 px-4 py-3">
          <div className="flex items-center gap-2">
            <CalendarDays className="h-4 w-4 text-muted-foreground" />
            <span className="text-sm font-medium">February 2026</span>
          </div>
          <div className="flex items-center gap-2">
            <button className="p-1 rounded hover:bg-muted text-muted-foreground">&larr;</button>
            <button className="px-2 py-1 rounded bg-primary/10 text-primary text-xs">Today</button>
            <button className="p-1 rounded hover:bg-muted text-muted-foreground">&rarr;</button>
          </div>
        </div>

        <div className="flex flex-col h-[320px] overflow-hidden">
          <div className="flex border-b bg-background sticky top-0 z-10">
            <div className="w-16 shrink-0 border-r" />
            {days.map((d) => (
              <div key={d.day} className="flex-1 border-r last:border-r-0">
                <button className={`w-full px-2 py-2 text-center hover:bg-muted/50 transition-colors ${d.isToday ? "bg-primary/5" : ""}`}>
                  <div className="text-xs text-muted-foreground">{d.day}</div>
                  <div className={`text-lg font-semibold w-8 h-8 mx-auto flex items-center justify-center rounded-full ${d.isToday ? "bg-primary text-primary-foreground" : ""}`}>
                    {d.date}
                  </div>
                </button>
              </div>
            ))}
          </div>

          <div className="flex-1 overflow-auto">
            <div className="flex min-h-full pt-3">
              <div className="w-16 shrink-0">
                {hours.map((hour) => (
                  <div key={hour} className="relative" style={{ height: 48 }}>
                    <span className="absolute -top-2 right-2 text-xs text-muted-foreground">
                      {hour > 12 ? `${hour - 12} PM` : hour === 12 ? "12 PM" : `${hour} AM`}
                    </span>
                  </div>
                ))}
              </div>

              <div className="flex-1 flex">
                <DayColumn events={[{ top: 0, height: 40, title: "Team standup", time: "9:00 AM", color: "purple" }]} />
                <DayColumn events={[{ top: 48, height: 80, title: "AI: Research", time: "10:00 AM", color: "slate" }]} />
                <DayColumn isToday events={[{ top: 0, height: 40, title: "1:1 with Sarah", time: "9:00 AM", color: "purple" }]} showTimeIndicator />
                <DayColumn events={[
                  { top: 96, height: 40, title: "Launch deadline", time: "11:00 AM", color: "red" },
                  { top: 192, height: 48, title: "Investor call", time: "2:00 PM", color: "purple" },
                ]} />
                <DayColumn hasTask events={[{ top: 96, height: 32, title: "Review drafts", isTask: true }]} />
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function DayColumn({ events = [], showTimeIndicator = false, hasTask = false }: {
  events?: Array<{ top: number; height: number; title: string; time?: string; color?: string; isTask?: boolean }>;
  isToday?: boolean;
  showTimeIndicator?: boolean;
  hasTask?: boolean;
}) {
  const hours = [9, 10, 11, 12, 14];

  return (
    <div className={`flex-1 ${hasTask ? "" : "border-r"} relative`}>
      {hours.map((h) => (
        <div key={h} className="border-b hover:bg-muted/30 cursor-pointer transition-colors" style={{ height: 48 }} />
      ))}
      {showTimeIndicator && (
        <div className="absolute left-0 right-0 z-20 pointer-events-none" style={{ top: 72 }}>
          <div className="flex items-center">
            <div className="w-2 h-2 rounded-full bg-red-500" />
            <div className="flex-1 h-0.5 bg-red-500" />
          </div>
        </div>
      )}
      {events.map((event, i) => (
        <button
          key={i}
          className={`absolute left-1 right-1 px-1.5 py-0.5 rounded text-xs overflow-hidden border-l-2 hover:opacity-80 transition-opacity cursor-pointer text-left ${
            event.isTask
              ? "bg-muted/30 border-l-muted-foreground/50 border-dashed opacity-70"
              : `bg-${event.color}-500/10 border-l-${event.color}-500`
          }`}
          style={{ top: event.top, height: event.height }}
        >
          <div className={`font-medium truncate ${event.isTask ? "text-muted-foreground italic" : `text-${event.color}-600`}`}>
            {event.isTask && <span className="mr-1">☐</span>}
            {event.title}
          </div>
          {event.time && <div className="text-muted-foreground truncate">{event.time}</div>}
        </button>
      ))}
    </div>
  );
}
