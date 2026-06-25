# GDPR Data Export Format

`GET /api/account/export` returns a ZIP archive of all data held about the
authenticated user (GDPR Art 15 access / Art 20 portability). Every bundle is
self-describing via a `manifest.json` at its root.

## Choosing a format — `?format=`

| `format` | Contents |
|----------|----------|
| `native` (default, or any unrecognized value) | One JSON file per data category, mirroring PageSpace's internal structure. |
| `portable` | A single `data.json` in the documented, interoperable [schema.org](https://schema.org) vocabulary. |

Example: `GET /api/account/export?format=portable`

## `manifest.json`

Present in every export. Lets a recipient interpret the bundle without
out-of-band knowledge.

```json
{
  "schemaVersion": "1.0.0",
  "generator": "PageSpace GDPR export",
  "exportedAt": "2026-06-24T00:00:00.000Z",
  "format": "native",
  "files": [
    { "name": "pages.json", "description": "Pages across your drives", "recordCount": 42 }
  ]
}
```

- `schemaVersion` — bumped when the bundle structure/inventory changes.
- `files[]` — the inventory: each file's name, a human description, and its record
  count (array length; `1` for the singular profile / personalization).

## Native format

Per-category JSON files: `profile.json`, `drives.json`, `pages.json`,
`messages.json`, `files-metadata.json`, `activity.json`, `ai-usage.json`,
`tasks.json`, `sessions.json`, `notifications.json`, `display-preferences.json`,
and `personalization.json` (only when the user has personalization). Shapes are
the `*Export` interfaces in
`packages/lib/src/compliance/export/gdpr-export.ts`.

## Portable format (schema.org)

A single `data.json` mapping the data onto widely-supported schema.org types so
it can be ingested by other tools without bespoke parsers:

- The data subject → [`Person`](https://schema.org/Person) (`@context:
  "https://schema.org"`), with `identifier`, `name`, `email`, `image`,
  `dateCreated`, `dateModified`.
- Drives → [`CreativeWork`](https://schema.org/CreativeWork) under `owns`.
- Pages → `CreativeWork` under `creativeWork` (`name`, `text`, `additionalType`
  = page type, `isPartOf` = drive id, `dateCreated`/`dateModified`).
- Messages → [`Message`](https://schema.org/Message) under `message` (`text`,
  `dateSent`, `messageAttachment` = source surface).
- Files → [`MediaObject`](https://schema.org/MediaObject) under `subjectOf`
  (`encodingFormat`, `contentSize`, `contentUrl`, `isPartOf`, `dateCreated`).

The portable format is **lossless**: categories without a natural schema.org
type (activity, AI usage, tasks, sessions, notifications, display preferences,
personalization) are carried verbatim as
[`PropertyValue`](https://schema.org/PropertyValue) entries under
`additionalProperty`, so the portable bundle contains exactly the same data as
the native export.

All dates are ISO-8601 strings. Empty sections are emitted as empty arrays.

The mapping is a pure transform (`toPortableExport` in
`packages/lib/src/compliance/export/export-format.ts`), so the format is stable
and testable independent of the database.
