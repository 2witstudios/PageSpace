/**
 * The mention HTML round trip.
 *
 * Seeding Y.Docs from `pages.content` parses stored HTML back into the editor
 * schema. Before the fix these tests cover, that parse destroyed page mentions:
 * the inherited `parseHTML` matched only `span[data-type="pageMention"]`, so an
 * `<a>` mention fell through to StarterKit's `link` mark and re-rendered without
 * `data-page-id` — the selector `syncMentions`
 * (`services/api/page-mention-service.ts:61`) matches. Round-tripping a document
 * would have deleted its mention graph.
 *
 * Three things are asserted, per mention type and per stored dialect:
 *  1. the parse produces a `pageMention` node with its attributes intact;
 *  2. the round trip is a fixpoint, so a projection cannot churn forever;
 *  3. the re-rendered HTML still matches the selectors `syncMentions` uses.
 *
 * (3) mirrors those selectors rather than calling `syncMentions`, which is not
 * exported and needs a database — so it proves the markup shape, not the
 * service. The selectors are copied from `page-mention-service.ts:61-80`; if
 * they move, this test does not notice.
 */
import { describe, it, expect } from 'vitest';
import { generateHTML, generateJSON } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import * as cheerio from 'cheerio';
import { PageMention } from '../tiptap-mention-config';

// The schema-affecting subset of RichEditor.tsx's list that this behaviour
// depends on: StarterKit contributes the `link` mark that used to win the `<a>`.
const extensions = [
  StarterKit.configure({
    heading: { levels: [1, 2, 3] },
    link: {
      openOnClick: true,
      autolink: true,
      linkOnPaste: true,
      defaultProtocol: 'https',
    },
    codeBlock: false,
  }),
  PageMention,
];

interface MentionAttrs {
  id: string | null;
  label: string | null;
  driveId: string | null;
  driveSlug: string | null;
  mentionType: string;
}

function parseMention(html: string): MentionAttrs | null {
  const doc = generateJSON(html, extensions) as {
    content?: Array<{ content?: Array<{ type: string; attrs?: MentionAttrs }> }>;
  };
  const inline = doc.content?.[0]?.content ?? [];
  const node = inline.find((child) => child.type === 'pageMention');
  return node?.attrs ?? null;
}

function roundTrip(html: string): string {
  return generateHTML(generateJSON(html, extensions), extensions);
}

const DRIVE = 'drv00000000000000000000';
const PAGE = 'pg000000000000000000000';
const USER = 'usr00000000000000000000';
const ROLE = 'rol00000000000000000000';

describe('pageMention HTML round trip', () => {
  describe('the dialect the editor writes today', () => {
    const cases: Array<[string, string, MentionAttrs]> = [
      [
        'page',
        `<p><a class="mention" contenteditable="false" data-mention-type="page" data-page-id="${PAGE}" data-drive-id="${DRIVE}" href="/dashboard/${DRIVE}/${PAGE}" rel="noopener noreferrer nofollow">@My Page</a></p>`,
        { id: PAGE, label: 'My Page', driveId: DRIVE, driveSlug: null, mentionType: 'page' },
      ],
      [
        'user',
        `<p><a class="mention" contenteditable="false" data-mention-type="user" data-user-id="${USER}" data-drive-id="${DRIVE}">@Ada</a></p>`,
        { id: USER, label: 'Ada', driveId: DRIVE, driveSlug: null, mentionType: 'user' },
      ],
      [
        'role',
        `<p><span class="mention" contenteditable="false" data-mention-type="role" data-role-id="${ROLE}" data-drive-id="${DRIVE}">@Editors</span></p>`,
        { id: ROLE, label: 'Editors', driveId: DRIVE, driveSlug: null, mentionType: 'role' },
      ],
      [
        'everyone',
        `<p><span class="mention" contenteditable="false" data-mention-type="everyone" data-drive-id="${DRIVE}">@everyone</span></p>`,
        { id: null, label: 'everyone', driveId: DRIVE, driveSlug: null, mentionType: 'everyone' },
      ],
    ];

    it.each(cases)('parses a %s mention with every attribute intact', (_type, html, expected) => {
      expect(parseMention(html)).toEqual(expected);
    });

    it.each(cases)('round-trips a %s mention to a fixpoint', (_type, html) => {
      const once = roundTrip(html);
      expect(roundTrip(once)).toBe(once);
    });

    it.each(cases)('keeps a %s mention a pageMention node, not a link mark', (_type, html) => {
      expect(parseMention(roundTrip(html))).not.toBeNull();
    });
  });

  describe('the legacy dialect, with literal attribute names', () => {
    // These three are the VERBATIM bytes the pre-fix code emitted — captured by
    // running the previous renderHTML through generateHTML and pasting the
    // result, not transcribed by hand. Attributes with no per-attribute
    // renderHTML fell back to their literal names (core's
    // getRenderedAttributes); the serializer lowercases them, and getAttribute
    // is case-insensitive, which is why `driveid` still reads back.
    const legacyPage = `<p><a data-type="pageMention" class="mention" contenteditable="false" id="${PAGE}" label="My Page" driveid="${DRIVE}" driveslug="my-drive" mentiontype="page" href="/dashboard/${DRIVE}/${PAGE}" rel="noopener noreferrer nofollow" data-mention-type="page" data-page-id="${PAGE}">@My Page</a></p>`;
    const legacyRole = `<p><span data-type="pageMention" class="mention" contenteditable="false" id="${ROLE}" label="Editors" driveid="${DRIVE}" driveslug="my-drive" mentiontype="role" data-mention-type="role" data-role-id="${ROLE}" data-drive-id="${DRIVE}">@Editors</span></p>`;
    // Note `id=""` and, in other stored rows, `data-drive-id=""` — renderHTML
    // wrote `id` from an attribute defaulting to '' rather than null. Reading
    // those back as '' instead of null would leave a non-default value on the
    // node forever.
    const legacyEveryone = `<p><span data-type="pageMention" class="mention" contenteditable="false" id="" label="everyone" driveid="${DRIVE}" driveslug="my-drive" mentiontype="everyone" data-mention-type="everyone" data-drive-id="${DRIVE}">@everyone</span></p>`;

    it('recovers every attribute from the literal names', () => {
      expect(parseMention(legacyPage)).toEqual({
        id: PAGE,
        label: 'My Page',
        driveId: DRIVE,
        driveSlug: 'my-drive',
        mentionType: 'page',
      });
    });

    it('recovers a legacy role mention', () => {
      expect(parseMention(legacyRole)).toEqual({
        id: ROLE,
        label: 'Editors',
        driveId: DRIVE,
        driveSlug: 'my-drive',
        mentionType: 'role',
      });
    });

    it('reads a legacy everyone mention’s empty id as null, not an empty string', () => {
      expect(parseMention(legacyEveryone)).toEqual({
        id: null,
        label: 'everyone',
        driveId: DRIVE,
        driveSlug: 'my-drive',
        mentionType: 'everyone',
      });
    });

    it.each([
      ['page', () => legacyPage],
      ['role', () => legacyRole],
      ['everyone', () => legacyEveryone],
    ])('round-trips a legacy %s mention to a fixpoint', (_type, html) => {
      const once = roundTrip(html());
      expect(roundTrip(once)).toBe(once);
    });

    it('stops emitting the literal attribute names', () => {
      const once = roundTrip(legacyPage);
      expect(once).not.toContain(' label=');
      expect(once).not.toContain(' driveid=');
      expect(once).not.toContain(' mentiontype=');
    });

    it('preserves driveSlug through the new data-drive-slug attribute', () => {
      expect(roundTrip(legacyPage)).toContain('data-drive-slug="my-drive"');
      expect(parseMention(roundTrip(legacyPage))?.driveSlug).toBe('my-drive');
    });
  });

  describe('the dialect the AI writes', () => {
    // lib/ai/skills/bodies/writing-documents.ts:141 instructs models to write
    // this shape: no data-type, no href, no label attribute.
    const aiPage = `<p><a class="mention" data-mention-type="page" data-page-id="${PAGE}">@Quarterly Plan</a></p>`;

    it('parses with the label recovered from the element text', () => {
      expect(parseMention(aiPage)).toEqual({
        id: PAGE,
        label: 'Quarterly Plan',
        driveId: null,
        driveSlug: null,
        mentionType: 'page',
      });
    });

    it('round-trips to a fixpoint', () => {
      const once = roundTrip(aiPage);
      expect(roundTrip(once)).toBe(once);
    });
  });

  describe('an anchor carrying only the identity attribute', () => {
    // syncMentions selects on a[data-page-id] / a[data-user-id] alone, so
    // content written against that contract need not carry data-mention-type.
    it('reads a bare data-page-id anchor as a page mention', () => {
      const html = `<p><a data-page-id="${PAGE}">@My Page</a></p>`;
      expect(parseMention(html)).toMatchObject({ id: PAGE, mentionType: 'page' });
    });

    it('reads a bare data-user-id anchor as a user mention, not a page one', () => {
      const html = `<p><a data-user-id="${USER}">@Ada</a></p>`;
      expect(parseMention(html)).toMatchObject({ id: USER, mentionType: 'user' });
      expect(roundTrip(html)).not.toContain('data-page-id');
    });

    it('reads a bare data-role-id span as a role mention', () => {
      const html = `<p><span data-type="pageMention" data-role-id="${ROLE}">@Editors</span></p>`;
      expect(parseMention(html)).toMatchObject({ id: ROLE, mentionType: 'role' });
    });
  });

  describe('a page mention with no drive context', () => {
    // The AI-authored shape carries data-page-id and nothing else. renderHTML
    // used to fall back to a bare `/dashboard/` href, so the chip rendered as a
    // link that navigated to the dashboard root instead of the mentioned page.
    const noDrive = `<p><a class="mention" data-mention-type="page" data-page-id="${PAGE}">@Quarterly Plan</a></p>`;

    it('emits no href at all rather than a bare /dashboard/', () => {
      const once = roundTrip(noDrive);
      expect(once).not.toContain('href=');
      expect(once).toContain(`data-page-id="${PAGE}"`);
    });

    it('never emits the /p/ resolver into stored HTML, which publishing would not neutralize', () => {
      // neutralizeDashboardLinks only rewrites hrefs starting with /dashboard/,
      // so a /p/{pageId} href would publish as a live link into an auth-gated
      // route. The resolver belongs to the node view, not to stored content.
      expect(roundTrip(noDrive)).not.toContain('/p/');
    });

    it('still emits the dashboard href when the drive is known', () => {
      const html = `<p><a class="mention" data-mention-type="page" data-page-id="${PAGE}" data-drive-id="${DRIVE}">@My Page</a></p>`;
      expect(roundTrip(html)).toContain(`href="/dashboard/${DRIVE}/${PAGE}"`);
    });
  });

  describe('driveId recovery from the href', () => {
    it('reads the driveId out of /dashboard/{driveId}/{pageId} when the attribute is absent', () => {
      const html = `<p><a class="mention" data-mention-type="page" data-page-id="${PAGE}" href="/dashboard/${DRIVE}/${PAGE}">@My Page</a></p>`;
      expect(parseMention(html)?.driveId).toBe(DRIVE);
    });
  });

  describe('the selectors syncMentions matches', () => {
    it('emits a[data-page-id] for a page mention', () => {
      const html = roundTrip(
        `<p><a class="mention" data-mention-type="page" data-page-id="${PAGE}" data-drive-id="${DRIVE}">@My Page</a></p>`
      );
      expect(cheerio.load(html)('a[data-page-id]').attr('data-page-id')).toBe(PAGE);
    });

    it('emits a[data-user-id] for a user mention, which nothing emitted before', () => {
      const html = roundTrip(
        `<p><a class="mention" data-mention-type="user" data-user-id="${USER}" data-drive-id="${DRIVE}">@Ada</a></p>`
      );
      expect(cheerio.load(html)('a[data-user-id]').attr('data-user-id')).toBe(USER);
    });

    it('never writes a user id into data-page-id', () => {
      const html = roundTrip(
        `<p><a class="mention" data-mention-type="user" data-user-id="${USER}">@Ada</a></p>`
      );
      expect(html).not.toContain('data-page-id');
    });

    it('emits span[data-mention-type="role"] with its role id', () => {
      const html = roundTrip(
        `<p><span class="mention" data-mention-type="role" data-role-id="${ROLE}" data-drive-id="${DRIVE}">@Editors</span></p>`
      );
      const $ = cheerio.load(html);
      expect($('span[data-mention-type="role"]').attr('data-role-id')).toBe(ROLE);
      expect($('span[data-mention-type="role"]').attr('data-drive-id')).toBe(DRIVE);
    });

    it('emits span[data-mention-type="everyone"] with its drive id', () => {
      const html = roundTrip(
        `<p><span class="mention" data-mention-type="everyone" data-drive-id="${DRIVE}">@everyone</span></p>`
      );
      expect(cheerio.load(html)('span[data-mention-type="everyone"]').attr('data-drive-id')).toBe(DRIVE);
    });
  });

  describe('the link mark must not claim a mention anchor', () => {
    const pageHtml = `<p><a class="mention" data-mention-type="page" data-page-id="${PAGE}" data-drive-id="${DRIVE}" href="/dashboard/${DRIVE}/${PAGE}">@My Page</a></p>`;

    it('does not inject target="_blank", which breaks the Capacitor WebView', () => {
      expect(roundTrip(pageHtml)).not.toContain('target=');
    });

    it('leaves a genuine link alone', () => {
      const link = '<p><a href="https://example.test/x">a real link</a></p>';
      const doc = generateJSON(link, extensions) as {
        content?: Array<{ content?: Array<{ type: string; marks?: Array<{ type: string }> }> }>;
      };
      const text = doc.content?.[0]?.content?.[0];
      expect(text?.type).toBe('text');
      expect(text?.marks?.[0]?.type).toBe('link');
    });
  });

  describe('a document with several mentions', () => {
    it('preserves all of them in one pass', () => {
      const html =
        `<p>See <a class="mention" data-mention-type="page" data-page-id="${PAGE}" data-drive-id="${DRIVE}">@My Page</a>` +
        ` and tell <a class="mention" data-mention-type="user" data-user-id="${USER}" data-drive-id="${DRIVE}">@Ada</a>` +
        ` plus <span class="mention" data-mention-type="role" data-role-id="${ROLE}" data-drive-id="${DRIVE}">@Editors</span>` +
        ` and <span class="mention" data-mention-type="everyone" data-drive-id="${DRIVE}">@everyone</span>.</p>`;

      const doc = generateJSON(html, extensions) as {
        content?: Array<{ content?: Array<{ type: string }> }>;
      };
      const mentions = (doc.content?.[0]?.content ?? []).filter((n) => n.type === 'pageMention');
      expect(mentions).toHaveLength(4);

      const once = roundTrip(html);
      expect(roundTrip(once)).toBe(once);
    });
  });
});
