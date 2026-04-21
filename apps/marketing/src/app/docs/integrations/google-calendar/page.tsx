import { DocsMarkdown } from "@/components/DocsContent";
import { createMetadata } from "@/lib/metadata";

export const metadata = createMetadata({
  title: "Google Calendar — Integration",
  description: "How Google Calendar integrates with PageSpace: two-way sync, a dedicated calendar surface, and AI tools that can read availability and schedule meetings for you.",
  path: "/docs/integrations/google-calendar",
  keywords: ["Google Calendar", "calendar", "sync", "integration", "scheduling", "availability"],
});

const content = `
# Google Calendar

Connect your Google account once and your calendars sync into PageSpace in both directions. You get a dedicated calendar surface inside the app, and an agent can read your availability, schedule meetings, and invite attendees — all acting as you.

## What you can do

- Connect your personal Google account from **Settings → Integrations → Google Calendar**.
- Pick exactly which of your Google calendars sync in — uncheck the ones you don't want to see.
- See your events in the **Calendar dashboard** — a personal view at the top level, and a separate per-drive calendar for drive-scoped events. Month, week, day, and agenda layouts.
- Create, edit, and delete events inside PageSpace — anything you create here is pushed back to Google so it also shows up on your phone and in your other clients.
- Ask an agent to check your availability for a slot, find a time that works for a group, or draft an invite.
- Let an agent schedule a meeting directly, complete with attendees, and have it land on everyone's Google Calendar.
- Set an event's visibility to the whole drive, to attendees only, or to just yourself.

## How it works

**The connection is per-user.** Each teammate connects their own Google account — there is no drive-shared Google Calendar. Your events are yours, and an agent in a drive only sees your calendar if *you* are the one asking.

**Sync runs both directions.** PageSpace pulls events from Google using incremental sync tokens, and Google pushes real-time updates back over a webhook whenever something changes there. A fallback cron reconciles every six hours in case a push is missed. In the other direction, events you create *inside* PageSpace are sent up to Google. Events that originally came *from* Google aren't pushed back — if you edit a Google-sourced event in PageSpace, the next pull overwrites your local change. That tradeoff exists so the two sides can't silently disagree about the same event.

**Agents use dedicated calendar tools.** When you @mention an [AI Chat](/docs/page-types/ai-chat) or talk to the global assistant, it has access to read-side tools (\`list_calendar_events\`, \`get_calendar_event\`, \`check_calendar_availability\`) and write-side tools (\`create_calendar_event\`, \`update_calendar_event\`, \`invite_calendar_attendees\`, \`rsvp_calendar_event\`). These act on the PageSpace event table — anything the agent creates is then pushed up to Google by the sync service, so a meeting it books for you lands on your Google Calendar like any other.

**Visibility is enforced on every read.** Events are tagged **drive-wide**, **attendees only**, or **private**. Even when an agent queries the calendar, it only sees events you'd see — a private event you haven't shared is never returned.

## Good to know

- **The connection is per-user, not drive-shared.** Sharing a drive doesn't share your calendar. If you want your teammate's agent to see your availability, they need their own Google connection.
- **Local edits to Google-sourced events are overwritten.** Edit an event that originated on your phone, and the next pull sync will replace your change with the Google version. Edit PageSpace-native events freely — those round-trip cleanly.
- **The calendar dashboard is its own surface, not a page.** It lives at its own URL and doesn't appear in the page tree, so you won't find it under a drive's folders.

## Related

- [AI in your Workspace](/docs/features/ai) — how agents call calendar tools under your identity.
- [Drives & Workspaces](/docs/features/drives) — where per-drive calendar views live.
- [Accounts & Sign In](/docs/features/accounts) — managing the Google account tied to your PageSpace login.
- [AI Chat](/docs/page-types/ai-chat) — where the calendar tools get allow-listed for an agent.
`;

export default function IntegrationGoogleCalendarPage() {
  return <DocsMarkdown content={content} />;
}
