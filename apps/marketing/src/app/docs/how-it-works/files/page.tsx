import { DocsMarkdown } from "@/components/DocsContent";
import { createMetadata } from "@/lib/metadata";

export const metadata = createMetadata({
  title: "Files & Uploads — How it Works",
  description: "How PageSpace handles file uploads: drag-and-drop into the tree, background text extraction and OCR, image optimisation, and content-addressed deduplication.",
  path: "/docs/how-it-works/files",
  keywords: ["files", "uploads", "OCR", "text extraction", "deduplication", "how it works"],
});

const content = `
# Files & Uploads

Drop a file into any drive and it becomes a File page alongside your documents, sheets, and channels. A background processor pulls out the text, runs OCR on images, and rewrites images into sizes tuned for your UI and for AI. Identical uploads are stored once.

## What you can do

- Drag and drop one or more files onto the page tree or an empty drive view. Files land where you dropped them, in order.
- Click **Upload files** in an empty drive view to pick from your file browser instead.
- Open a File page to preview it — images, PDFs, and plain text render inline; other types offer a download button.
- Download the original at any time.
- Convert a File page into a Document page once text has been extracted. The original file stays; you get an editable Document you can rewrite, link, and @-mention.
- Let AI read images and documents you've uploaded. An AI Chat page in the same [drive](/docs/how-it-works/drives) can see your files as context.
- Attach files to an AI Chat message with the attach button, or paste an image straight from your clipboard into the chat input.
- Upload a profile picture on your account page; it's optimised the same way.

## How it works

An upload goes in two steps.

**Step 1 — storage.** The processor takes your bytes, computes a SHA-256 hash of the content, and uses that hash as the file's address. If the platform has already seen that exact file (from you or anyone else), the upload is deduplicated: no new bytes are written, and your new page simply points at the existing blob. Before anything is stored, the processor runs the bytes through a content classifier (Magika) that looks at the file, not the extension, to decide what it actually is. Executables, HTML, SVG, and scripts are rejected at this step even if they're renamed.

**Step 2 — processing.** Once the file is stored, jobs are queued based on what the classifier found:

- **PDF, Word (.doc / .docx), plain text, Markdown, CSV, JSON** → text extraction. The extracted text is cached next to the file so AI can read it without re-parsing.
- **PNG, JPEG, GIF, WebP, TIFF, BMP** → image optimisation. Each image is re-encoded at several preset sizes: a thumbnail for the tree, a preview for inline display, and two sizes tuned for AI (one for chat context, one for vision models). EXIF rotation is applied; originals are kept untouched.
- **Images** → OCR. Tesseract reads the image and the recognised text is cached alongside the file, so a scanned receipt or a screenshot of a document becomes searchable and readable by AI.

While those jobs run, the File page shows a processing status. Your browser gets live updates over the real-time socket, so the preview and "text available" state appear without a refresh. You can keep working — upload a second file, edit a Document, send an AI message — nothing is blocked on the first file finishing.

Size and concurrency are bounded by your tier. Free gives you 500 MB of storage and accepts files up to 20 MB, with 2 uploads in flight at once. Pro is 2 GB / 50 MB per file / 3 at once. Founder is 10 GB / 50 MB per file / 3 at once. Business is 50 GB / 100 MB per file / 10 at once.

## What it doesn't do

- **It doesn't accept every file type.** Executables for Windows, macOS, Linux, and Android, as well as raw HTML, SVG, and JavaScript, are rejected outright. If the content classifier can't identify the file confidently, the upload is refused rather than stored as an unknown blob — there's no override.
- **It doesn't extract text from every document format.** Text extraction covers PDF, Word, plain text, Markdown, CSV, and JSON. Rich Text Format, Apple Pages, PowerPoint, Excel, EPUB, and legacy binary formats are stored and downloadable but not indexed for AI.
- **It doesn't version files.** Uploading a new revision with the same filename creates a separate File page, not a new version of the old one. Converting a File to a Document creates a new page; it doesn't replace the file. If you need history, rely on Document page history after conversion.
- **OCR runs locally, not through a vision model.** It uses Tesseract with the English model by default. Handwriting, unusual scripts, and low-contrast scans will miss words — the text is good enough for search, not good enough to trust as a transcript.
- **It doesn't sync with external drives.** There's no background pull from Google Drive, Dropbox, or OneDrive. Every file is one you (or an AI agent with upload rights) put there.
- **Deduplication is account-wide, not private.** Two users who upload the same PDF share one stored copy. You can't see each other's files — permissions still apply — but you also can't guarantee your bytes are stored uniquely.

## Related

- [Pages](/docs/how-it-works/pages) — File is one of the nine page types; see how it sits in the tree.
- [Drives & Workspaces](/docs/how-it-works/drives) — storage quotas are per-drive-owner, and uploads go into a specific drive.
- [AI in your Workspace](/docs/how-it-works/ai) — how AI reads extracted text and optimised images from your files.
- [Search](/docs/how-it-works/search) — extracted and OCR'd text feeds search, so scanned pages are findable.
- [Sharing & Permissions](/docs/how-it-works/sharing) — who can upload into a drive, and who can read what you've uploaded.
`;

export default function HowItWorksFilesPage() {
  return <DocsMarkdown content={content} />;
}
