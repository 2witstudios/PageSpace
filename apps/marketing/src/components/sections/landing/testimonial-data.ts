/**
 * Eric Elliott testimonial. NOTE: wording is a placeholder pending Eric's
 * sign-off before it goes live. The plain-text `body` feeds the Review JSON-LD
 * in schema.tsx and must stay in sync with the visible card in TestimonialSection.
 */
export const TESTIMONIAL = {
  author: "Eric Elliott",
  handle: "@__ericelliott",
  url: "https://www.threads.com/share/BAUpnJndnx/",
  credential: "Webby-nominated author of Composing Software",
  // Plain text for schema (no markup).
  body:
    "PageSpace.ai by @jono_minh is not just my favorite AI tool — it's my favorite productivity software of all time. Imagine Slack, Notion, Trello, and Claude Code all fused into one product, in an agent-first environment.",
} as const;
