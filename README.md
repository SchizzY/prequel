# prequel

*Review it before it's a pull request.*

A local web app that renders a Git repo's diff using a UI that looks like
GitHub's Pull Request **Files changed** tab. Supports system light/dark mode.

See the full plan: `~/_work/anrok/doc/plans/github-pr-simulator.md`.

## Status

**Phase 0 (done):** server + CLI skeleton, GitHub-faithful diff rendering
(Primer design tokens + hand-authored diff CSS), light/dark parity, and both
**unified** and **split (side-by-side)** views with a GitHub-style toggle
(defaults to split; choice persists in localStorage).

**Phase 1 (done):** reads a real git repo and renders its diff.
- `gitService` shells out to `git`; three change scopes via `?diff=`:
  `working` (uncommitted + untracked, **default**), `branch` (committed vs
  base), `all` (branch commits + uncommitted + untracked). The chosen scope
  persists across loads (like the split/unified view).
- Untracked files are included (via `git diff --no-index`).
- `diffParser` turns raw patch text into the render model (added / modified /
  removed / renamed / copied / binary).
- **Syntax highlighting** via Shiki using GitHub's own `github-light` /
  `github-dark` themes (dual-theme, follows the color mode).
- **Hunk context expansion**: click the unfold icon in a hunk header to load
  hidden context (between hunks and above the first hunk).

When launched outside a git repo, it falls back to a built-in sample diff.

**Phase 2a (done) — review comments:**
- Hover a line → blue **+** in the gutter → inline compose box → save. Comments
  render as GitHub-style inline threads (markdown-rendered via `marked`), with
  delete. Works in unified and split.
- **Multi-line ranges**: shift-click the end line, or drag across the gutter, to
  comment on a block (highlighted while selecting; thread anchored after the end
  line; exports as `Lines N–M` with the whole block).
- Persisted centrally in `~/.prequel/<repo-hash>.json`, tagged by branch; injected
  on load and mutated live (no reload). REST API under `/api/comments`.
**Phase 2b (done) — export to Claude:**
- "Export N comments for Claude" button (subnav) builds grouped-by-file,
  code-fenced markdown, writes it to `<repo>/.prequel/review-<ts>.md`, and copies
  it to the clipboard. JSON variant available via the API.
- `.prequel/` is auto-added to the repo's `.git/info/exclude` so exports don't
  appear as untracked in the diff or get committed.

**Phase 2c (done) — round-trip ergonomics:**
- **File-level comments**: the comment button in a file header adds a comment
  on the whole file (not a line); it renders as a banner atop the file and
  exports under that file as "File comment".
- **Clear all** button (with a few-seconds **Undo**) for a clean slate between
  review rounds; the export toast also offers **Clear now**. This suits the
  loop (comment → hand to Claude → Claude fixes → re-review) where comments are
  single-use directives, so resolve/outdated-flagging/edit-in-place were
  intentionally skipped. (Multi-line ranges — see Phase 2a — were added later.)

**Phase 1.5 (in progress):**
- **Changed-files tree** — a sticky, collapsible left sidebar (nested folders,
  path-compressed like GitHub, status-colored, per-file counts). Click a file
  to jump to it; toggle the pane from the subnav. Files marked **Viewed** are
  checked and struck through in the tree. **Drag the divider** to resize the
  pane (width persists; double-click the divider to reset).
- **Word-level (intra-line) highlighting** — changed characters within a
  modified line get GitHub's darker red/green overlay, layered on top of the
  Shiki syntax colors (LCS word diff in `src/render/wordDiff.js`).
- Full-width layout (the diff fills the window).

## Run

```bash
npm install
npm start                 # serves the sample diff, opens the browser
# or, once linked globally:
prequel [repoPath] [--base <ref>] [--port <n>] [--no-open]
```

URL params (all optional): `?view=split|unified` picks the layout,
`?diff=working|branch|all` picks which changes to show (default `working`;
persists), `?base=<ref>` overrides the base branch, `?mode=light|dark` forces a
color mode (default follows the OS).

## Layout

```
bin/prequel.js             CLI entry (port selection, browser launch, repo resolution)
src/server.js             Express app + routes (/ and /api/context)
src/git/gitService.js     git CLI wrapper: refs, diff generation, blob lines
src/git/diffParser.js     raw patch text -> diff model
src/render/renderer.js    diff model -> GitHub-faithful HTML (unified + split)
src/render/highlighter.js Shiki dual-theme syntax highlighting + word-diff overlay
src/render/wordDiff.js    intra-line (word-level) diff ranges
src/comments/commentStore.js  per-repo comment persistence (~/.prequel)
src/export/claudeExport.js    build markdown/JSON export payload
src/sampleDiff.js         built-in sample diff (fallback outside a repo)
views/review.ejs          page shell (loads Primer tokens + diff.css)
public/css/diff.css       GitHub "Files changed" clone
public/js/review.js       toggles, collapse/expand, copy path, Viewed, hunk expansion
public/js/comments.js     hover-+, compose, inject threads, delete
```
