# Changelog

All notable changes to PageSpace will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **Paginated Documents** - Documents can now be displayed with print-ready pagination
  - Toggle between Continuous and Paginated layouts via "Page Layout" button in document header
  - Paginated documents show visual page breaks, page numbers in footers, and headers
  - US Letter page size (8.5" × 11") with 1-inch margins
  - Tables automatically span across multiple pages
  - Opt-in feature - existing documents remain in continuous layout by default
  - Compatible with AI editing, Monaco code view, and collaborative editing
  - Custom in-house Tiptap extension (~560 lines) - no external dependencies
  - Pre-defined page sizes: A3, A4, A5, Letter, Legal, Tabloid

### Changed
- Added `isPaginated` boolean field to pages database schema

### Technical
- Database migration: Added `isPaginated` column to `pages` table (default: false)
- API: PATCH `/api/pages/[pageId]` now accepts `isPaginated` field
- New pagination extension: `apps/web/src/lib/editor/pagination/` (PaginationExtension, utils, constants)
- New component: `PaginationToggle` for layout switching UI
- Documentation: Added implementation guide at `docs/3.0-guides-and-tools/paginated-documents-implementation.md`

---

## [Previous Releases]

See git history for previous changes.
