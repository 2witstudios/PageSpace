# Worktree Swarm Tracker

> **Base commit:** `061d874f` (master)
> **Updated:** 2026-02-08
> **Worktree root:** `.codename-grove/`

## Status Key

- `[ ]` Not started
- `[~]` In progress
- `[x]` Done — PR ready or merged
- `[!]` Blocked / needs attention (see notes)
- `[-]` Dropped / descoped

---

## Completed Swarm (PRs #497–#510)

All 10 original worktrees have been merged or closed. Branches and worktrees cleaned up.

| WT | Branch | PR | Status | Issues |
|----|--------|----|--------|--------|
| WT1 | `security/quick-wins` | #497 | MERGED | #467, #454, #418 |
| WT2 | `security/auth-hardening` | #500 | MERGED | #419, #421, #422 |
| WT3 | `security/ai-providers` | #502 | MERGED | #464, #420, #462, #417 |
| WT4 | `data/lifecycle` | #499 | MERGED | #458, #463, #468 |
| WT5 | `data/compliance` | #498 | MERGED | #457, #460, #461 |
| WT6 | `typing/web` | #509 | MERGED | #440, #442 |
| WT7 | `typing/processor` | #506 | MERGED | #441, #431, #436, #443, #444, #439 |
| WT8 | `typing/lib` | #507 | MERGED | (subset absorbed into #506/#509) |
| WT9 | `techdebt/tests` | #510 | MERGED | #448, #126, #128, #129, #130, #131, #125 |
| WT10 | `techdebt/features` | — | CLOSED | Issues redistributed to new worktrees |

---

## Active Worktrees

### WT-A: `fix/settings-nav`

**Branch:** `fix/settings-nav` | **Path:** `.codename-grove/fix-settings-nav`

| Issue | Summary | Status |
|-------|---------|--------|
| #505 | Settings navigation bug | `[ ]` |

**Notes:** Investigate settings page layout/navigation — `<Link>` vs `router.push`, layout nesting, intercepting routes.

---

### WT-B: `fix/bundle-pdfjs`

**Branch:** `fix/bundle-pdfjs` | **Path:** `.codename-grove/fix-bundle-pdfjs`

| Issue | Summary | Status |
|-------|---------|--------|
| #466 | Bundle PDF.js worker locally | `[ ]` |

**Notes:** Check if `pdfjs-dist` ships worker in node_modules. Tighten CSP `connect-src`, remove unused `cdn.jsdelivr.net`.

---

### WT-C: `typing/remaining`

**Branch:** `typing/remaining` | **Path:** `.codename-grove/typing-remaining`

| Issue | Summary | Status |
|-------|---------|--------|
| #445 | File processing MIME/pdf types | `[ ]` |
| #446 | Desktop IPC/MCP types | `[ ]` |
| #447 | Runtime TS suppressions | `[ ]` |

**Sequencing:** #445 before #447 (shared `file-processor.ts`).

**Notes:** Last 3 issues from umbrella #449. Check patterns from PRs #506/#509. Desktop files (#446) may not be buildable in worktree context.

---

### WT-D: `techdebt/push-notifications`

**Branch:** `techdebt/push-notifications` | **Path:** `.codename-grove/techdebt-push-notifications`

| Issue | Summary | Status |
|-------|---------|--------|
| #434 | Finish push notifications path | `[ ]` |

**Notes:** Check what commit `0283b1df` already shipped. Decision needed: complete support vs. explicit scoping/gating.

---

## Merge Order & Conflict Risk

Recommended merge order (lowest conflict risk first):

1. **WT-A** `fix/settings-nav` — isolated UI fix
2. **WT-D** `techdebt/push-notifications` — scoped to notification pipeline
3. **WT-B** `fix/bundle-pdfjs` — touches PDFViewer + CSP headers
4. **WT-C** `typing/remaining` — widest surface area, merge last

**Known overlap zones:**
- `PDFViewer.tsx` — WT-B (#466) vs WT-C (#447)
- `file-processor.ts` — WT-C (#445, #447)

---

## Deviation Log

> Record any scope changes, dropped issues, or unexpected discoveries here.

| Date | WT | Issue | Change | Reason |
|------|----|-------|--------|--------|
| 2026-02-08 | WT7 | #441 | Relocated work from master to worktree | Agent ran in wrong working directory |
| 2026-02-08 | WT8 | #443 | Relocated work from master to worktree | Agent ran in wrong working directory |
| 2026-02-08 | — | — | Closed WT1–WT10, created WT-A through WT-D | Swarm complete, new focused worktrees |
