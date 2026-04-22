import { DocsMarkdown } from "@/components/DocsContent";
import { createMetadata } from "@/lib/metadata";

export const metadata = createMetadata({
  title: "Channels — How it Works",
  description: "Channels are real-time chat rooms that live inside your page tree. They inherit permissions from the tree, and AI agents participate as first-class members via @mentions.",
  path: "/docs/page-types/channel",
  keywords: ["channels", "chat", "messaging", "real-time", "AI mentions"],
});

const content = `
# Channels

A Channel is a page you can chat in. It sits in your drive's page tree alongside your documents and folders, so you move it, share it, and nest it the same way you would any other page. When a message arrives, everyone looking at the channel sees it appear instantly — and if you @mention an AI agent in the channel, it replies right there like anyone else would.

## What you can do

- Create a channel anywhere in a drive — at the root, inside a folder, or as a child of another page.
- Post messages with markdown formatting, emoji, and line breaks.
- Attach a file to a message from the attach icon in the input. Images preview inline, other files show as a download card.
- React to any message with an emoji. Click a reaction again to take yours back.
- Type @ to mention a person or an AI agent in your message — mentioning an agent pulls it into the conversation to reply.
- See who else is reading the channel right now.
- Scroll up to load older messages — channels keep full history.
- Jump between unread channels from your inbox, which tracks what you've seen and what's new.

## How it works

A channel is just a page with the type "Channel." That means the people who can see the channel are exactly the people who can see the page — drive owners and admins automatically, plus anyone you grant per-page access to. View access lets someone read messages; edit access lets them post.

When you send a message, it's saved to the channel and broadcast over a live connection to everyone currently looking at it. The same connection carries new reactions and the list of viewers at the top of the page. If the connection drops, messages still arrive the next time you open the channel — the saved record is the source of truth, the live stream is just the fast path.

When your message contains \`@Agent Name\`, PageSpace looks at what that agent is allowed to do and sends it the last several messages as context. The agent replies as a message in the channel, signed with its name, and its reply can itself use tools — so an @mentioned agent can search your drive, open a page, and post back with a summary in one turn.

Unread tracking is per-person: opening a channel marks it read up to the latest message, and your inbox shows a count of channels with activity since you last looked.

## Related

- [Pages](/docs/features/pages) — channels are a page type, so everything pages do (move, share, version the title) applies.
- [Sharing & Permissions](/docs/features/sharing) — who can read versus post in a channel, and how to change that.
- [AI in your Workspace](/docs/features/ai) — what an @mentioned agent can actually do when you call it into a channel.
- [Files & Uploads](/docs/page-types/file) — what happens to the files you drop into a message.
`;

export default function HowItWorksChannelsPage() {
  return <DocsMarkdown content={content} />;
}
