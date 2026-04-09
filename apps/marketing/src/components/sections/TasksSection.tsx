import { Checkbox } from "@/components/ui/checkbox";
import {
  ChevronRight,
  ListTodo,
  BarChart3,
  Users,
  Bot,
  AlertCircle,
} from "lucide-react";

export function TasksSection() {
  return (
    <section className="border-t border-border bg-muted/30 py-16 md:py-24 lg:py-32">
      <div className="container mx-auto px-4 md:px-6">
        <div className="mx-auto max-w-3xl text-center mb-12 md:mb-16">
          <h2 className="text-3xl font-bold tracking-tight sm:text-4xl md:text-5xl mb-4">
            Assign work to AI or humans
          </h2>
          <p className="text-lg text-muted-foreground">
            Create tasks and assign them to anyone—including AI agents.
            AI completes research, drafts, and analysis autonomously.
          </p>
        </div>

        <div className="grid lg:grid-cols-2 gap-12 items-center">
          <TaskListMock />

          <div className="space-y-6 order-1 lg:order-2">
            {[
              { icon: Bot, title: "AI as Assignee", desc: "Assign tasks directly to AI agents. They work autonomously—research, draft, analyze—and notify you when done." },
              { icon: ListTodo, title: "Task Lists as Pages", desc: "Task lists are just another page type. Nest them in your file tree, attach context, and AI agents automatically understand the scope." },
              { icon: BarChart3, title: "Smart Rollups", desc: "See all tasks across drives, projects, or assigned to you. Track what AI is working on vs. what needs human attention." },
              { icon: Users, title: "Human + AI Teams", desc: "AI handles the research and first drafts. Humans review and refine. A natural workflow where everyone does what they&apos;re best at." },
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

interface TaskItemProps {
  title: string;
  completed: boolean;
  priority: "red" | "amber" | "slate";
  date: string;
  dateOverdue?: boolean;
  assignee: string;
  list?: string;
}

function TaskItem({ title, completed, priority, date, dateOverdue, assignee, list }: TaskItemProps) {
  return (
    <div className={`flex items-center gap-3 px-4 py-3 active:bg-muted/60 transition-colors border-b border-border/50 last:border-b-0 ${completed ? "opacity-50" : ""}`}>
      <div className="shrink-0">
        <Checkbox checked={completed} className="h-5 w-5" />
      </div>
      <button type="button" className="flex-1 min-w-0 flex flex-col gap-0.5 text-left bg-transparent border-0 p-0">
        <span className={`text-sm leading-snug ${completed ? "line-through text-muted-foreground" : "text-foreground"}`}>{title}</span>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span className={`h-1.5 w-1.5 rounded-full shrink-0 bg-${priority}-500`} />
          {dateOverdue ? (
            <span className="flex items-center gap-0.5 text-red-500 font-medium">
              <AlertCircle className="h-3 w-3" />
              {date}
            </span>
          ) : (
            <span>{date}</span>
          )}
          <span className="truncate max-w-[100px]">{assignee}</span>
          {list && <span className="truncate max-w-[80px] text-muted-foreground/70">{list}</span>}
        </div>
      </button>
      <ChevronRight className="h-4 w-4 text-muted-foreground/40 shrink-0" />
    </div>
  );
}

function TaskListMock() {
  return (
    <div className="relative order-2 lg:order-1 min-w-0">
      <div className="rounded-xl border border-border bg-card shadow-lg overflow-hidden">
        <div className="flex items-center justify-between border-b border-border bg-muted/30 px-4 py-3">
          <div className="flex items-center gap-2">
            <ListTodo className="h-4 w-4 text-muted-foreground" />
            <span className="text-sm font-medium">Product Launch Tasks</span>
          </div>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span>4/7 complete</span>
            <div className="w-16 h-1.5 rounded-full bg-muted overflow-hidden">
              <div className="w-[57%] h-full bg-primary rounded-full" />
            </div>
          </div>
        </div>

        <div>
          <TaskItem title="Finalize product positioning" completed priority="red" date="Feb 8" assignee="Sarah" />
          <TaskItem title="Research competitor pricing" completed priority="amber" date="Feb 7" assignee="Research AI" />
          <TaskItem title="Draft launch email sequence" completed={false} priority="red" date="Today" assignee="Marketing AI" list="Launch Tasks" />
          <TaskItem title="Review AI-generated drafts" completed={false} priority="amber" date="Feb 14" assignee="Marcus" />
          <TaskItem title="Generate social media graphics" completed={false} priority="slate" date="Feb 15" assignee="Design AI" />
          <TaskItem title="Schedule launch webinar" completed={false} priority="red" date="Feb 10" dateOverdue assignee="" />
        </div>
      </div>
    </div>
  );
}
