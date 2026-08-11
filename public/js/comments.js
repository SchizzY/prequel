// Review comments: hover-"+" for a line comment (or the file-header button for
// a file-level comment), save, render as inline threads, delete. Plus bulk
// clear (with undo) and export-then-clear, for the review→hand-off→re-review loop.

(function () {
  const root = document.documentElement;
  if (root.dataset.commentsEnabled !== '1') return;
  const branch = root.dataset.branch || '';

  const exportBtn = document.getElementById('export-btn');
  const clearBtn = document.getElementById('clear-btn');
  let commentCount = 0;

  const isSplitTable = (table) => table.classList.contains('diff-table-split');

  function escapeHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // --- subnav buttons ----------------------------------------------------
  function updateButtons() {
    if (exportBtn) {
      exportBtn.hidden = commentCount === 0;
      exportBtn.textContent =
        commentCount === 1 ? 'Export 1 comment for Claude' : `Export ${commentCount} comments for Claude`;
    }
    if (clearBtn) clearBtn.hidden = commentCount === 0;
  }

  // --- toast (with optional action) --------------------------------------
  let toastTimer = null;
  function toast(message, action) {
    const el = document.getElementById('toast');
    if (!el) return;
    el.textContent = '';
    const span = document.createElement('span');
    span.textContent = message;
    el.appendChild(span);
    if (action) {
      const btn = document.createElement('button');
      btn.className = 'toast-action';
      btn.textContent = action.label;
      btn.addEventListener('click', () => {
        el.hidden = true;
        action.fn();
      });
      el.appendChild(btn);
    }
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (el.hidden = true), 6000);
  }

  // --- shared thread markup ---------------------------------------------
  function commentInner(c) {
    let time = '';
    try {
      time = new Date(c.createdAt).toLocaleString();
    } catch {
      /* ignore */
    }
    const range =
      c.side !== 'file' && c.endLine > c.startLine
        ? `<span class="comment-lines">Lines ${c.startLine}–${c.endLine}</span>`
        : '';
    return (
      `<div class="comment-thread"><div class="comment">` +
      `<div class="comment-header">${range}<span class="comment-time">${escapeHtml(time)}</span>` +
      `<span class="comment-tools"><button class="comment-delete" title="Delete comment">Delete</button></span></div>` +
      `<div class="comment-body markdown-body">${c.bodyHtml || escapeHtml(c.body || '')}</div>` +
      `</div></div>`
    );
  }

  function composeInner() {
    return (
      `<form class="comment-compose">` +
      `<textarea class="comment-input" rows="3" placeholder="Leave a comment. Markdown supported."></textarea>` +
      `<div class="comment-compose-actions">` +
      `<button type="button" class="btn comment-cancel">Cancel</button>` +
      `<button type="submit" class="btn btn-primary">Comment</button>` +
      `</div></form>`
    );
  }

  // Unified spans the code column (colspan 3); split confines the thread to the
  // side it was made on (2 of 4 columns), leaving the other side empty.
  function threadCells(isSplit, side, inner) {
    if (!isSplit) return `<td class="comment-cell" colspan="3">${inner}</td>`;
    const cell = `<td class="comment-cell" colspan="2">${inner}</td>`;
    const empty = '<td class="comment-cell-empty" colspan="2"></td>';
    return side === 'old' ? cell + empty : empty + cell;
  }

  const commentRowHtml = (c, isSplit) =>
    `<tr class="comment-row" data-comment-id="${c.id}">${threadCells(isSplit, c.side, commentInner(c))}</tr>`;
  const fileCommentHtml = (c) =>
    `<div class="file-comment" data-comment-id="${c.id}">${commentInner(c)}</div>`;

  // --- anchoring helpers -------------------------------------------------
  function findAnchorCell(filePath, side, line) {
    const file = document.querySelector(`.file[data-path="${CSS.escape(filePath)}"]`);
    if (!file) return null;
    return file.querySelector(
      `.blob-num.commentable[data-side="${side}"][data-comment-line="${line}"]`
    );
  }

  // The code cell that belongs to a gutter cell (same row, next .blob-code).
  function codeCellFor(gutterCell) {
    const cells = [...gutterCell.closest('tr').children];
    const start = cells.indexOf(gutterCell);
    for (let i = start + 1; i < cells.length; i++) {
      if (cells[i].classList.contains('blob-code')) return cells[i];
    }
    return null;
  }

  function snapshotFor(gutterCell) {
    const code = codeCellFor(gutterCell);
    const inner = code && code.querySelector('.blob-code-inner');
    return inner ? inner.textContent.slice(1) : ''; // drop the +/-/space marker
  }

  // Capture every line's code across a range on one side (for export context).
  function snapshotForRange(filePath, side, lo, hi) {
    const out = [];
    for (let n = lo; n <= hi; n++) {
      const cell = findAnchorCell(filePath, side, n);
      if (cell) out.push(snapshotFor(cell));
    }
    return out.length ? out : [''];
  }

  // Tint the selected line range (gutter + code) while composing / dragging.
  function clearRangeHighlight() {
    document.querySelectorAll('.mq-range-line').forEach((el) => el.classList.remove('mq-range-line'));
  }
  function highlightRange(filePath, side, lo, hi) {
    clearRangeHighlight();
    if (hi <= lo) return;
    for (let n = lo; n <= hi; n++) {
      const g = findAnchorCell(filePath, side, n);
      if (!g) continue;
      g.classList.add('mq-range-line');
      const code = codeCellFor(g);
      if (code) code.classList.add('mq-range-line');
    }
  }

  function insertionPointAfter(row) {
    let last = row;
    while (last.nextElementSibling && last.nextElementSibling.classList.contains('comment-row')) {
      last = last.nextElementSibling;
    }
    return last;
  }

  // --- composing ---------------------------------------------------------
  // Single line = range where start === end. The thread is anchored after the
  // END line (GitHub's convention), and the snapshot captures the whole block.
  function openLineCompose(filePath, side, a, b) {
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);

    // Re-focus if the identical range is already being composed.
    const same = [...document.querySelectorAll('.comment-compose-row')].find(
      (r) =>
        r.dataset.filePath === filePath &&
        r.dataset.side === side &&
        Number(r.dataset.startLine) === lo &&
        Number(r.dataset.endLine) === hi
    );
    if (same) return same.querySelector('.comment-input').focus();

    // Otherwise replace any open line-compose and (re)highlight this range.
    document.querySelectorAll('.comment-compose-row').forEach((r) => r.remove());
    const cell = findAnchorCell(filePath, side, hi);
    if (!cell) return clearRangeHighlight();

    const isSplit = isSplitTable(cell.closest('table'));
    const at = insertionPointAfter(cell.closest('tr'));
    at.insertAdjacentHTML(
      'afterend',
      `<tr class="comment-row comment-compose-row">${threadCells(isSplit, side, composeInner())}</tr>`
    );
    const composeRow = at.nextElementSibling;
    Object.assign(composeRow.dataset, {
      filePath,
      side,
      startLine: String(lo),
      endLine: String(hi),
      snapshot: JSON.stringify(snapshotForRange(filePath, side, lo, hi)),
    });
    setFormContext(composeRow);
    highlightRange(filePath, side, lo, hi);
    composeRow.querySelector('.comment-input').focus();
  }

  function openFileCompose(fileEl) {
    const filePath = fileEl.dataset.path;
    const container = fileEl.querySelector('.file-comments');
    let compose = container.querySelector('.file-comment-compose');
    if (!compose) {
      container.insertAdjacentHTML('beforeend', `<div class="file-comment-compose">${composeInner()}</div>`);
      compose = container.querySelector('.file-comment-compose');
      Object.assign(compose.dataset, { filePath, side: 'file', startLine: '0', endLine: '0', snapshot: '[]' });
      setFormContext(compose);
    }
    compose.querySelector('.comment-input').focus();
  }

  // Copy anchor context onto the form so submit is container-agnostic.
  function setFormContext(container) {
    const form = container.querySelector('.comment-compose');
    Object.assign(form.dataset, {
      filePath: container.dataset.filePath,
      side: container.dataset.side,
      startLine: container.dataset.startLine,
      endLine: container.dataset.endLine,
      snapshot: container.dataset.snapshot,
    });
  }

  async function submitCompose(form) {
    const container = form.closest('.comment-compose-row, .file-comment-compose');
    const body = form.querySelector('.comment-input').value.trim();
    if (!body) return;
    form.querySelectorAll('button').forEach((b) => (b.disabled = true));
    try {
      const res = await fetch('/api/comments', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          filePath: form.dataset.filePath,
          side: form.dataset.side,
          startLine: Number(form.dataset.startLine),
          endLine: Number(form.dataset.endLine),
          body,
          branch,
          lineSnapshot: JSON.parse(form.dataset.snapshot || '[]'),
        }),
      });
      const { comment } = await res.json();
      if (comment.side === 'file') {
        container.outerHTML = fileCommentHtml(comment);
      } else {
        const isSplit = isSplitTable(container.closest('table'));
        container.insertAdjacentHTML('afterend', commentRowHtml(comment, isSplit));
        container.remove();
      }
      clearRangeHighlight();
      commentCount++;
      updateButtons();
    } catch {
      form.querySelectorAll('button').forEach((b) => (b.disabled = false));
    }
  }

  async function removeComment(el) {
    try {
      await fetch(`/api/comments/${el.dataset.commentId}`, { method: 'DELETE' });
      el.remove();
      commentCount = Math.max(0, commentCount - 1);
      updateButtons();
    } catch {
      /* leave it in place on failure */
    }
  }

  // --- load, export, clear ----------------------------------------------
  function renderComment(c) {
    if (c.side === 'file') {
      const file = document.querySelector(`.file[data-path="${CSS.escape(c.filePath)}"]`);
      if (file) file.querySelector('.file-comments').insertAdjacentHTML('beforeend', fileCommentHtml(c));
      return;
    }
    // ranges anchor after the end line (GitHub's convention)
    const cell = findAnchorCell(c.filePath, c.side, c.endLine || c.startLine);
    if (!cell) return; // line not present in the current view/mode
    const row = cell.closest('tr');
    const isSplit = isSplitTable(cell.closest('table'));
    insertionPointAfter(row).insertAdjacentHTML('afterend', commentRowHtml(c, isSplit));
  }

  async function loadComments() {
    let comments = [];
    try {
      const res = await fetch(`/api/comments?branch=${encodeURIComponent(branch)}`);
      ({ comments } = await res.json());
    } catch {
      return;
    }
    commentCount = comments.length;
    updateButtons();
    comments.forEach(renderComment);
  }

  async function runExport() {
    if (commentCount === 0) return;
    exportBtn.disabled = true;
    try {
      const res = await fetch('/api/export', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ branch, format: 'md' }),
      });
      const data = await res.json();
      if (!data.count) return toast('No comments to export.');
      let copied = false;
      try {
        await navigator.clipboard.writeText(data.content);
        copied = true;
      } catch {
        /* clipboard may be blocked; the file write still succeeded */
      }
      toast(
        `Wrote ${data.path}${copied ? ' · copied to clipboard' : ' (clipboard blocked)'}`,
        { label: 'Clear now', fn: runClear }
      );
    } catch {
      toast('Export failed.');
    } finally {
      exportBtn.disabled = false;
    }
  }

  function removeAllCommentEls() {
    document
      .querySelectorAll('.comment-row, .file-comment, .file-comment-compose')
      .forEach((el) => el.remove());
  }

  async function runClear() {
    if (commentCount === 0) return;
    if (clearBtn) clearBtn.disabled = true;
    try {
      const res = await fetch('/api/comments/clear', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ branch }),
      });
      const { cleared } = await res.json();
      removeAllCommentEls();
      commentCount = 0;
      updateButtons();
      toast(`Cleared ${cleared} comment${cleared === 1 ? '' : 's'}`, { label: 'Undo', fn: undoClear });
    } finally {
      if (clearBtn) clearBtn.disabled = false;
    }
  }

  async function undoClear() {
    try {
      const res = await fetch('/api/comments/restore', { method: 'POST' });
      const { restored } = await res.json();
      if (!restored) return;
      removeAllCommentEls();
      await loadComments();
      toast(`Restored ${restored} comment${restored === 1 ? '' : 's'}`);
    } catch {
      /* ignore */
    }
  }

  // --- events ------------------------------------------------------------
  if (exportBtn) exportBtn.addEventListener('click', runExport);
  if (clearBtn) clearBtn.addEventListener('click', runClear);

  // --- range selection state (shift-click + drag) ------------------------
  let dragStart = null; // {filePath, side, line}
  let dragging = false;
  let suppressClick = false; // set after a drag so the trailing click is ignored

  document.addEventListener('click', (e) => {
    const add = e.target.closest('.add-comment');
    if (add) {
      e.preventDefault();
      if (suppressClick) {
        suppressClick = false;
        return;
      }
      const gutter = add.closest('.commentable');
      const filePath = gutter.closest('.file').dataset.path;
      const side = gutter.dataset.side;
      const line = Number(gutter.dataset.commentLine);
      // shift-click extends from the line of an already-open compose (same side)
      if (e.shiftKey) {
        const open = [...document.querySelectorAll('.comment-compose-row')].find(
          (r) => r.dataset.filePath === filePath && r.dataset.side === side
        );
        const anchor = open ? Number(open.dataset.startLine) : line;
        openLineCompose(filePath, side, anchor, line);
      } else {
        openLineCompose(filePath, side, line, line);
      }
      return;
    }
    const fileAdd = e.target.closest('.add-file-comment');
    if (fileAdd) {
      e.preventDefault();
      return openFileCompose(fileAdd.closest('.file'));
    }
    const cancel = e.target.closest('.comment-cancel');
    if (cancel) {
      e.preventDefault();
      cancel.closest('.comment-compose-row, .file-comment-compose').remove();
      return clearRangeHighlight();
    }
    const del = e.target.closest('.comment-delete');
    if (del) {
      e.preventDefault();
      removeComment(del.closest('[data-comment-id]'));
    }
  });

  // Drag across the gutter to select a range.
  document.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    const gutter = e.target.closest('.commentable');
    if (!gutter) return;
    dragStart = {
      filePath: gutter.closest('.file').dataset.path,
      side: gutter.dataset.side,
      line: Number(gutter.dataset.commentLine),
    };
    dragging = false;
  });

  document.addEventListener('mousemove', (e) => {
    if (!dragStart) return;
    const row = e.target.closest('tr');
    const cell = row && row.querySelector(`.commentable[data-side="${dragStart.side}"]`);
    if (!cell) return; // no commentable line for this side on this row
    const line = Number(cell.dataset.commentLine);
    if (line === dragStart.line && !dragging) return;
    dragging = true;
    e.preventDefault(); // suppress text selection while dragging
    document.body.style.userSelect = 'none';
    highlightRange(dragStart.filePath, dragStart.side, Math.min(dragStart.line, line), Math.max(dragStart.line, line));
  });

  document.addEventListener('mouseup', (e) => {
    if (!dragStart) return;
    const ds = dragStart;
    dragStart = null;
    document.body.style.userSelect = '';
    if (!dragging) return; // a plain click — let the click handler open a single-line compose
    dragging = false;
    suppressClick = true;
    setTimeout(() => (suppressClick = false), 300); // clear even if no click follows
    const row = e.target.closest('tr');
    const cell = row && row.querySelector(`.commentable[data-side="${ds.side}"]`);
    const endLine = cell ? Number(cell.dataset.commentLine) : ds.line;
    openLineCompose(ds.filePath, ds.side, ds.line, endLine);
  });

  document.addEventListener('submit', (e) => {
    const form = e.target.closest('.comment-compose');
    if (form) {
      e.preventDefault();
      submitCompose(form);
    }
  });

  loadComments();
})();
