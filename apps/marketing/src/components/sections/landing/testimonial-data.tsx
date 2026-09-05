import type { ReactNode } from "react";

/**
 * Real Threads posts about PageSpace, shown as pull-quote cards. `body` is plain
 * text for the Review JSON-LD (schema.tsx); `quote` is the styled display node.
 * Wording is quoted verbatim from the public posts.
 */
export interface Testimonial {
  author: string;
  handle: string;
  url: string;
  avatar: string;
  body: string;
  quote: ReactNode;
  credential?: { icon: string; text: ReactNode };
}

export const TESTIMONIALS: Testimonial[] = [
  {
    author: "Eric Elliott",
    handle: "@__ericelliott",
    url: "https://www.threads.com/share/BAUpnJndnx/",
    avatar: "/eric-elliott.jpg",
    body:
      "PageSpace.ai by @jono_minh is not just my favorite AI tool — it's my favorite productivity software of all time. Imagine Slack, Notion, Trello, and Claude Code all fused into one product, in an agent-first environment.",
    quote: (
      <>
        <span className="lnk">PageSpace.ai</span> by <span className="lnk">@jono_minh</span> is not just my favorite AI tool — it&rsquo;s my favorite productivity software of all time. Imagine Slack, Notion, Trello, and Claude Code all fused into one product, in an agent-first environment.
      </>
    ),
    credential: { icon: "webby", text: <>Webby-nominated author of <em>Composing Software</em></> },
  },
  {
    author: "Aria",
    handle: "@ariapramesi",
    url: "https://www.threads.com/@ariapramesi/post/DbJIM0JkVGT",
    avatar: "/aria-pramesi.jpg",
    body:
      "slowly, pagespace becomes my go-to tool for projects and project kb management. toss things there, sort it after. better vs obsidian and notion in many ways for me.",
    quote: (
      <>
        slowly, <span className="lnk">pagespace</span> becomes my go-to tool for projects and project kb management. toss things there, sort it after. better vs obsidian and notion in many ways for me.
      </>
    ),
  },
];
