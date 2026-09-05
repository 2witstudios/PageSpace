import type { ReactNode } from "react";

/**
 * Real quotes about PageSpace, shown as pull-quote cards. `body` is plain text
 * for the Review JSON-LD (schema.tsx); `quote` is the styled display node.
 * Wording is verbatim. A quote with a `url` links out to the public post; one
 * without renders as a plain unlinked card.
 */
export interface Testimonial {
  author: string;
  handle: string;
  url?: string;
  avatar?: string;
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
    credential: { icon: "zap", text: "AI automation specialist" },
  },
  {
    author: "Noah Hines",
    handle: "@NoahHines",
    avatar: "/noah-hines.png",
    body:
      "Every 6-12 months I look into new apps to organize my life, notes, to-do's, etc. because something is always missing. Pretty sure I'm done looking because PageSpace has what I've been looking for (and things I didn't know I wanted). You can make it simple or very automated and complex, which helps me manage each area of my life according to what it actually needs.",
    quote: (
      <>
        Every 6-12 months I look into new apps to organize my life, notes, to-do&rsquo;s, etc. because something is always missing. Pretty sure I&rsquo;m done looking because <span className="lnk">PageSpace</span> has what I&rsquo;ve been looking for (and things I didn&rsquo;t know I wanted). You can make it simple or very automated and complex, which helps me manage each area of my life according to what it actually needs.
      </>
    ),
    credential: { icon: "chart", text: "Sales Manager at Ideal Impact" },
  },
];
