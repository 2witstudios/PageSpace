import {
  ArrowUp,
  AtSign,
  Hash,
  Bold,
  Paperclip,
  Bot,
  Inbox,
} from "lucide-react";

export function ChannelsSection() {
  return (
    <section className="py-16 md:py-24 lg:py-32">
      <div className="container mx-auto px-4 md:px-6">
        <div className="mx-auto max-w-3xl text-center mb-12 md:mb-16">
          <h2 className="text-3xl font-bold tracking-tight sm:text-4xl md:text-5xl mb-4">
            Team chat, upgraded with AI
          </h2>
          <p className="text-lg text-muted-foreground">
            @mention AI agents in any conversation. They respond in context,
            remembering past discussions and understanding your project.
          </p>
        </div>

        <div className="grid lg:grid-cols-2 gap-12 items-center">
          <div className="space-y-6">
            {[
              { icon: AtSign, title: "@mention AI Agents", desc: "Type @Marketing-AI or @Code-Review in any channel. AI agents join the conversation with full context of the channel." },
              { icon: Hash, title: "Channels & Direct Messages", desc: "Public channels for team discussions, private channels for focused work, and 1:1 DMs — all with AI agents available." },
              { icon: Inbox, title: "Unified Inbox", desc: "Every channel, DM, and mention in one place. Never lose track of a conversation across your workspace." },
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

          <ChannelMock />
        </div>
      </div>
    </section>
  );
}

function ChannelMock() {
  return (
    <div className="relative">
      <div className="rounded-xl border border-border bg-card shadow-lg overflow-hidden">
        <div className="flex items-center justify-between border-b border-border bg-muted/30 px-4 py-3">
          <div className="flex items-center gap-2">
            <Hash className="h-4 w-4 text-muted-foreground" />
            <span className="text-sm font-medium">product-launch</span>
            <span className="text-xs text-muted-foreground">12 members</span>
          </div>
          <div className="flex -space-x-2">
            <div className="h-6 w-6 rounded-full bg-primary border-2 border-card flex items-center justify-center text-[10px] text-white font-medium">S</div>
            <div className="h-6 w-6 rounded-full bg-green-500 border-2 border-card flex items-center justify-center text-[10px] text-white font-medium">M</div>
            <div className="h-6 w-6 rounded-full bg-gradient-to-br from-violet-500 to-violet-600 border-2 border-card flex items-center justify-center">
              <Bot className="h-3 w-3 text-white" />
            </div>
          </div>
        </div>

        <div className="p-4 space-y-4 min-h-[360px] max-w-4xl mx-auto">
          <Message author="Sarah" avatar="S" avatarColor="bg-primary" time="10:34 AM">
            We need to finalize the launch email copy. <span className="text-primary font-medium">@Marketing-AI</span> can you draft something based on our positioning doc?
          </Message>

          <AIMessage name="Marketing AI" time="10:34 AM" />

          <Message author="Marcus" avatar="M" avatarColor="bg-green-500" time="10:35 AM">
            Love it! Can we make the CTA more action-oriented?
          </Message>

          <AITypingIndicator name="Marketing AI" />
        </div>

        <div className="p-4">
          <div className="max-w-4xl mx-auto">
            <div className="bg-background rounded-2xl border border-border/60 shadow-sm overflow-hidden">
              <div className="flex items-end gap-2 p-3">
                <div className="flex-1 min-h-[36px] flex items-center">
                  <span className="text-sm text-muted-foreground">Message #product-launch...</span>
                </div>
                <button className="h-9 w-9 shrink-0 rounded-full bg-muted text-muted-foreground flex items-center justify-center">
                  <ArrowUp className="h-4 w-4" />
                </button>
              </div>
              <div className="flex items-center justify-between px-3 py-2 border-t border-border/40">
                <div className="flex items-center gap-0.5">
                  <button className="h-8 w-8 p-0 rounded-md text-muted-foreground hover:bg-muted/50 flex items-center justify-center">
                    <Bold className="h-4 w-4" />
                  </button>
                  <div className="w-px h-4 bg-border/60 mx-1" />
                  <button className="h-8 w-8 p-0 rounded-md text-muted-foreground hover:bg-muted/50 flex items-center justify-center">
                    <AtSign className="h-4 w-4" />
                  </button>
                </div>
                <div className="flex items-center gap-1">
                  <button className="h-8 w-8 p-0 rounded-md text-muted-foreground hover:bg-muted/50 flex items-center justify-center">
                    <Paperclip className="h-4 w-4" />
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function Message({ author, avatar, avatarColor, time, children }: {
  author: string;
  avatar: string;
  avatarColor: string;
  time: string;
  children: React.ReactNode;
}) {
  return (
    <div className="group flex items-start gap-4">
      <div className={`shrink-0 h-10 w-10 rounded-full ${avatarColor} flex items-center justify-center text-sm text-white font-medium`}>{avatar}</div>
      <div className="flex flex-col min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="font-semibold text-sm">{author}</span>
          <span className="text-xs text-muted-foreground">{time}</span>
        </div>
        <div className="prose prose-sm dark:prose-invert max-w-none">
          <p className="text-sm">{children}</p>
        </div>
      </div>
    </div>
  );
}

function AIMessage({ name, time }: { name: string; time: string }) {
  return (
    <div className="group flex items-start gap-4">
      <div className="shrink-0 h-10 w-10 rounded-full bg-gradient-to-br from-violet-500 to-violet-600 flex items-center justify-center">
        <Bot className="h-5 w-5 text-white" />
      </div>
      <div className="flex flex-col min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="font-semibold text-sm">{name}</span>
          <span className="text-xs px-1.5 py-0.5 rounded-full bg-violet-100 text-violet-700 dark:bg-violet-900/30 dark:text-violet-300 font-medium">agent</span>
          <span className="text-xs text-muted-foreground">{time}</span>
        </div>
        <div className="prose prose-sm dark:prose-invert max-w-none">
          <p className="text-sm mb-2">Based on your positioning doc, here&#39;s a draft:</p>
          <div className="bg-muted/50 rounded-lg p-3 text-sm border border-border/50">
            <p className="font-medium mb-1">Subject: Meet your new AI-powered workspace</p>
            <p className="text-muted-foreground text-sm">
              We&#39;re excited to introduce PageSpace—where your documents, tasks, and team conversations live alongside AI that actually understands your work...
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

function AITypingIndicator({ name }: { name: string }) {
  return (
    <div className="group flex items-start gap-4">
      <div className="shrink-0 h-10 w-10 rounded-full bg-gradient-to-br from-violet-500 to-violet-600 flex items-center justify-center">
        <Bot className="h-5 w-5 text-white" />
      </div>
      <div className="flex flex-col min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="font-semibold text-sm">{name}</span>
          <span className="text-xs px-1.5 py-0.5 rounded-full bg-violet-100 text-violet-700 dark:bg-violet-900/30 dark:text-violet-300 font-medium">agent</span>
        </div>
        <div className="flex items-center gap-2 py-1">
          <div className="flex gap-1">
            {[0, 150, 300].map((delay) => (
              <div key={delay} className="h-2 w-2 rounded-full bg-muted-foreground/40 animate-bounce" style={{ animationDelay: `${delay}ms` }} />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
