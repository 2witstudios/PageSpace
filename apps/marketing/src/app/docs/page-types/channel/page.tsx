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
- Drag a file straight into the message box to attach it. Images preview inline, other files show as a download card.
- React to any message with an emoji. Click a reaction again to take yours back.
- Type @ to mention a person or an AI agent in your message — mentioning an agent pulls it into the conversation to reply.
- See who else is reading the channel right now.
- Scroll up to load older messages — channels keep full history.
- Jump between unread channels from your inbox, which tracks what you've seen and what's new.

## How it works

A channel is just a page with the type "Channel." That means the people who can see the channel are exactly the people who can see the page — drive members inherit access, and you can grant or revoke it per-page the same way you do for documents. View access lets someone read messages; edit access lets them post.

When you send a message, it's saved to the channel and broadcast over a live connection to everyone currently looking at it. The same connection carries new reactions and the list of viewers at the top of the page. If the connection drops, messages still arrive the next time you open the channel — the saved record is the source of truth, the live stream is just the fast path.

When your message contains \`@Agent Name\`, PageSpace looks at what that agent is allowed to do and sends it the last several messages as context. The agent replies as a message in the channel, signed with its name, and its reply can itself use tools — so an @mentioned agent can search your drive, open a page, and post back with a summary in one turn.

Unread tracking is per-person: opening a channel marks it read up to the latest message, and your inbox shows a count of channels with activity since you last looked.

## What it doesn't do

- **No threads or replies.** Every message is part of one flat timeline. If you want a side conversation, make a new channel.
- **No editing or deleting a message after you send it.** Messages are the permanent record of what was said. The one exception is that removing the channel page removes its messages with it.
- **No direct messages from inside a channel.** DMs are a separate surface — you can't convert a channel message into a private chat, and you can't @mention someone who isn't already a member of the drive to invite them in.
- **No voice, video, or screen share.** Channels are text and attachments only. There are no calls, no huddles, and no presence beyond "this person has the channel open right now."
- **No private sub-groups inside a channel.** If two people in a channel can both see it, they both see every message. To restrict who sees what, put the channel under a folder with tighter permissions or create a separate channel.
- **No message scheduling, pinning, or bookmarks.** You send a message when you send it, and you find older messages by scrolling or searching.
- **No cross-drive channels.** A channel belongs to exactly one drive, and only members of that drive (plus anyone granted explicit access) can see it.

## Related

- [Pages](/docs/features/pages) — channels are a page type, so everything pages do (move, share, version the title) applies.
- [Sharing & Permissions](/docs/features/sharing) — who can read versus post in a channel, and how to change that.
- [AI in your Workspace](/docs/features/ai) — what an @mentioned agent can actually do when you call it into a channel.
- [Files & Uploads](/docs/page-types/file) — what happens to the files you drop into a message.
`;

export default function HowItWorksChannelsPage() {
  return <DocsMarkdown content={content} />;
}
