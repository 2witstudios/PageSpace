export const AI_PRIVACY = `
# AI & Privacy (FAQ)

PageSpace can work with **local models** (like Ollama) and **cloud models** (via providers).

## What gets sent to an AI model?

It depends on:

- Which provider/model you choose
- Which pages you explicitly include or reference
- Which tools are enabled for the agent

If you care about data residency, prefer local models and keep sensitive content out of prompts for cloud models.
`.trim();

export const SHARING_PERMISSIONS = `
# Sharing & Permissions

## Why permissions exist

PageSpace is built for collaboration, so not everyone should necessarily be able to edit everything.

## Common access levels (simplified)

- **View**: you can read the page
- **Edit**: you can change the page (and usually create content under it)

## Troubleshooting

- If you can **see** a page but can’t **type or change** things, you likely have view-only access.
- If you can’t find a page someone mentioned, you might not have permission to it.
`.trim();

export const REALTIME_COLLABORATION = `
# Real-time Collaboration

Some page types support real-time updates so multiple people can work together without “refresh battles.”

## What to expect

- Changes can appear quickly when multiple people are on the same content.
- If something feels out of sync, try navigating away and back (or refreshing) to rehydrate state.

## Best practices

- Use **Documents** for shared notes and specs.
- Use **Task Lists** for projects where each task needs a “task page” for details and updates.
- Use **Channels** for ongoing conversation.
`.trim();

export const TROUBLESHOOTING = `
# Troubleshooting (FAQ)

## “I can’t edit”

You probably don’t have edit permission for that page.

## “AI isn’t using my drive/pages”

An agent only knows what’s in its prompt + what you share with it. If it needs to read pages, tools must be enabled and it must have permission.

## “File preview isn’t available”

Some file types can’t be previewed directly, or the file might still be processing.
`.trim();

