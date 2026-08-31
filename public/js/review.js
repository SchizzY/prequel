// Interactivity: segmented toggles (view/diff), collapse/expand, copy path,
// "Viewed" state. Toggle choices persist in localStorage and are re-applied
// on loads where the URL doesn't pin them.

// Segmented toggles that persist across loads: display 'view' (split/unified)
// and 'diff' mode (all/branch/working). Each is re-applied on loads where the
// URL doesn't pin it.
const PERSIST_PARAMS = ['view', 'diff'];

// Navigate, setting `param=value` and preserving all other query params.
function goToParam(param, value) {
  if (PERSIST_PARAMS.includes(param)) localStorage.setItem('prequel:' + param, value);
  const params = new URLSearchParams(location.search);
  params.set(param, value);
  location.search = params.toString();
}

// On load, honor saved preferences for params not pinned in the URL.
(function applySavedParams() {
  const params = new URLSearchParams(location.search);
  let changed = false;
  for (const param of PERSIST_PARAMS) {
    if (params.has(param)) continue; // explicit choice in URL wins
    const saved = localStorage.getItem('prequel:' + param);
    const rendered = document.documentElement.getAttribute('data-' + param);
    if (saved && saved !== rendered) {
      params.set(param, saved);
      changed = true;
    }
  }
  if (changed) location.replace(location.pathname + '?' + params.toString());
})();

// Base branch picker in the header — reload diffed against the chosen ref.
document.addEventListener('change', (e) => {
  const refSelect = e.target.closest('.ref-select');
  // The PR pages have their own picker that patches the pull request instead.
  if (refSelect && !refSelect.classList.contains('pr-base-select')) {
    goToParam('base', refSelect.value);
  }
});

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// Build a context (unchanged) row matching the current table layout.
function contextRow(split, oldNo, newNo, inner) {
  const code =
    '<td class="blob-code blob-code-context"><span class="blob-code-inner">' +
    '<span class="marker"> </span>' + inner + '</span></td>';
  const numOld = `<td class="blob-num blob-num-context" data-line-number="${oldNo}"></td>`;
  const numNew = `<td class="blob-num blob-num-context" data-line-number="${newNo}"></td>`;
  return split
    ? `<tr class="context-loaded">${numOld}${code}${numNew}${code}</tr>`
    : `<tr class="context-loaded">${numOld}${numNew}${code}</tr>`;
}

function disableExpander(row) {
  row.removeAttribute('data-expander');
  const btn = row.querySelector('.expander');
  if (btn) btn.remove();
}

const CHUNK = 20;

async function expandContext(btn) {
  const row = btn.closest('tr[data-expander]');
  if (!row || row.dataset.loading) return;
  const { path, rev } = row.dataset;
  const newStart = parseInt(row.dataset.newStart, 10);
  const oldStart = parseInt(row.dataset.oldStart, 10);
  const prevNewEnd = parseInt(row.dataset.prevNewEnd, 10) || 0;
  const offset = oldStart - newStart; // oldNo = newNo + offset (constant in a gap)
  const gapEndNew = newStart - 1;
  const bounded = prevNewEnd > 0; // gap between two hunks (fully known)
  const gapStartNew = bounded ? prevNewEnd + 1 : Math.max(1, gapEndNew - CHUNK + 1);
  if (gapEndNew < gapStartNew) {
    disableExpander(row);
    return;
  }

  const split = row.closest('table').classList.contains('diff-table-split');
  row.dataset.loading = '1';
  try {
    // The PR, when there is one: its diff may come from another repo, or from
    // a branch this checkout is not standing on, and the server needs to read
    // the context lines from the same place the diff came from.
    const pr = document.documentElement.dataset.pr;
    const res = await fetch(
      `/api/context?path=${encodeURIComponent(path)}&rev=${rev}` +
        `&start=${gapStartNew}&end=${gapEndNew}` +
        (pr ? `&pr=${encodeURIComponent(pr)}` : '')
    );
    const data = await res.json();
    // Expanded context can use a token colour this page was not rendered with.
    // The server sends the whole (tiny) palette; replacing it is idempotent.
    if (data.css) {
      const sheet = document.getElementById('tok-palette');
      if (sheet && sheet.textContent.length < data.css.length) sheet.textContent = data.css;
    }
    const lines = data.lines || [];
    let frag = '';
    lines.forEach((content, i) => {
      const n = data.from + i;
      const inner = data.html ? data.html[i] : escapeHtml(content);
      frag += contextRow(split, n + offset, n, inner);
    });
    if (frag) row.insertAdjacentHTML('beforebegin', frag);

    if (bounded || gapStartNew <= 1) {
      disableExpander(row); // gap fully filled (or reached top of file)
    } else {
      // top-of-file: continue upward on the next click
      row.dataset.newStart = String(gapStartNew);
      row.dataset.oldStart = String(gapStartNew + offset);
    }
  } catch {
    /* leave the expander in place so the user can retry */
  } finally {
    delete row.dataset.loading;
  }
}

// Keep --subnav-h in sync with the sticky subnav's real height (it changes if
// the header wraps), so sticky file headers and the tree pane offset correctly.
function syncSubnavHeight() {
  const subnav = document.querySelector('.pr-subnav');
  if (subnav) {
    document.documentElement.style.setProperty('--subnav-h', subnav.offsetHeight + 'px');
  }
}
syncSubnavHeight();
window.addEventListener('resize', syncSubnavHeight);
window.addEventListener('load', syncSubnavHeight);

// --- file tree ----------------------------------------------------------
const TREE_KEY = 'prequel:tree'; // 'hidden' | 'shown'

function markTreeViewed(id, viewed) {
  const row = document.querySelector(`.tree-file-row[data-file-id="${id}"]`);
  if (row) row.classList.toggle('is-viewed', viewed);
}

function setActiveTreeFile(id) {
  document
    .querySelectorAll('.tree-file-row.is-active')
    .forEach((r) => r.classList.remove('is-active'));
  const row = document.querySelector(`.tree-file-row[data-file-id="${id}"]`);
  if (row) row.classList.add('is-active');
}

(function applyTreeState() {
  if (localStorage.getItem(TREE_KEY) === 'hidden') {
    document.querySelector('.review-layout')?.classList.add('tree-hidden');
  }
})();

// --- resizable file pane (drag the divider; width persists) --------------
const TREE_W_KEY = 'prequel:tree-w';
const TREE_W_MIN = 180;
const treeWMax = () => Math.min(800, Math.round(window.innerWidth * 0.6));

function setTreeWidth(px) {
  const w = Math.max(TREE_W_MIN, Math.min(treeWMax(), Math.round(px)));
  document.querySelector('.review-layout')?.style.setProperty('--tree-w', w + 'px');
  return w;
}

(function applySavedTreeWidth() {
  const saved = parseInt(localStorage.getItem(TREE_W_KEY), 10);
  if (Number.isFinite(saved)) setTreeWidth(saved);
})();

(function initTreeResizer() {
  const resizer = document.querySelector('.tree-resizer');
  const pane = document.querySelector('.file-tree-pane');
  if (!resizer || !pane) return;

  let startX = 0;
  let startW = 0;

  const onMove = (e) => {
    setTreeWidth(startW + (e.clientX - startX));
  };
  const onUp = () => {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    resizer.classList.remove('is-dragging');
    document.body.style.userSelect = '';
    document.body.style.cursor = '';
    const w = parseInt(getComputedStyle(pane).width, 10);
    if (Number.isFinite(w)) localStorage.setItem(TREE_W_KEY, String(w));
  };

  resizer.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    startX = e.clientX;
    startW = parseInt(getComputedStyle(pane).width, 10) || 300;
    resizer.classList.add('is-dragging');
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'col-resize';
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });

  // double-click the divider to reset to the default width
  resizer.addEventListener('dblclick', () => {
    document.querySelector('.review-layout')?.style.removeProperty('--tree-w');
    localStorage.removeItem(TREE_W_KEY);
  });
})();

document.addEventListener('click', (e) => {
  // Hunk context expander
  const expander = e.target.closest('.expander');
  if (expander) {
    e.preventDefault();
    expandContext(expander);
    return;
  }

  // Toggle the file-tree pane
  const treeToggle = e.target.closest('.tree-pane-toggle');
  if (treeToggle) {
    const layout = document.querySelector('.review-layout');
    const hidden = layout.classList.toggle('tree-hidden');
    localStorage.setItem(TREE_KEY, hidden ? 'hidden' : 'shown');
    return;
  }

  // Collapse/expand a tree folder
  const dirRow = e.target.closest('.tree-dir-row');
  if (dirRow) {
    dirRow.closest('.tree-dir').classList.toggle('is-collapsed');
    return;
  }

  // Click a file in the tree → scroll to it (anchor handles scroll)
  const fileRow = e.target.closest('.tree-file-row');
  if (fileRow) {
    setActiveTreeFile(fileRow.getAttribute('data-file-id'));
    // let the default #anchor navigation scroll to the file
    return;
  }

  // Segmented toggles (Unified/Split, All/Branch/Working)
  const segBtn = e.target.closest('.seg-btn');
  if (segBtn) {
    e.preventDefault();
    goToParam(segBtn.getAttribute('data-param'), segBtn.getAttribute('data-value'));
    return;
  }

  // collapse/expand the whole file
  const collapse = e.target.closest('.collapse-btn');
  if (collapse) {
    const file = collapse.closest('.file');
    const collapsed = file.classList.toggle('is-collapsed');
    collapse.setAttribute('aria-expanded', String(!collapsed));
    return;
  }

  // copy file path
  const copyBtn = e.target.closest('.copy-path');
  if (copyBtn) {
    const path = copyBtn.getAttribute('data-path');
    navigator.clipboard?.writeText(path).then(
      () => flash(copyBtn),
      () => {}
    );
  }
});

function flash(el) {
  el.classList.add('copied');
  setTimeout(() => el.classList.remove('copied'), 800);
}

// "Viewed" checkboxes persist per file id in localStorage and collapse the file.
const VIEWED_KEY = 'prequel:viewed';
function loadViewed() {
  try {
    return JSON.parse(localStorage.getItem(VIEWED_KEY) || '{}');
  } catch {
    return {};
  }
}
function saveViewed(state) {
  localStorage.setItem(VIEWED_KEY, JSON.stringify(state));
}

const viewedState = loadViewed();
document.querySelectorAll('.viewed-checkbox').forEach((cb) => {
  const id = cb.getAttribute('data-file-id');
  if (viewedState[id]) {
    cb.checked = true;
    cb.closest('.file').classList.add('is-collapsed');
    markTreeViewed(id, true);
  }
  cb.addEventListener('change', () => {
    viewedState[id] = cb.checked;
    saveViewed(viewedState);
    cb.closest('.file').classList.toggle('is-collapsed', cb.checked);
    markTreeViewed(id, cb.checked);
  });
});


// --- deferred files ------------------------------------------------------
// A large diff renders up to a budget and leaves the rest as headers, so the
// page is not a few hundred thousand table cells the moment it opens. Those
// files then load as they come into view.
//
// This is virtualization at file granularity rather than row granularity, and
// that is a deliberate choice: rows are what a reader searches. Text that is
// not in the DOM cannot be found by Ctrl-F or selected across, and a review
// tool where find-in-page silently misses half the diff is worse than a slow
// one. A file is a unit the reader already thinks of as a unit -- it has a
// header, it collapses -- so loading one is legible in a way a window of rows
// scrolling in and out never is.
async function loadDeferredFile(fileEl) {
  const holder = fileEl.querySelector('.diff-deferred');
  if (!holder || fileEl.dataset.loading === '1') return;
  const btn = holder.querySelector('.load-file-diff');
  const root = document.documentElement;
  fileEl.dataset.loading = '1';
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Loading…';
  }
  try {
    const params = new URLSearchParams({
      path: fileEl.dataset.path,
      view: root.dataset.view === 'unified' ? 'unified' : 'split',
      diff: root.dataset.diff || 'working',
    });
    if (root.dataset.pr) params.set('pr', root.dataset.pr);
    const base = new URLSearchParams(location.search).get('base');
    if (base) params.set('base', base);
    const res = await fetch(`/api/file-diff?${params}`);
    if (!res.ok) throw new Error('failed');
    const data = await res.json();
    if (data.css) {
      const sheet = document.getElementById('tok-palette');
      if (sheet && sheet.textContent.length < data.css.length) sheet.textContent = data.css;
    }
    // The response is a whole .file element; take its body and drop it in, so
    // the header, its counts and the comment affordances stay as they were.
    const parsed = new DOMParser().parseFromString(data.html, 'text/html');
    const table = parsed.querySelector('.diff-table, .binary-notice');
    if (!table) throw new Error('no rows');
    holder.replaceWith(table);
    fileEl.removeAttribute('data-deferred');
    document.dispatchEvent(new CustomEvent('prequel:file-loaded', { detail: { path: fileEl.dataset.path } }));
  } catch {
    fileEl.dataset.loading = '';
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Load diff';
    }
    const note = holder.querySelector('.deferred-note');
    if (note) note.textContent = 'Could not load this diff.';
  }
}

// Clicking is still honoured, for a file the observer has not reached yet and
// for browsers without IntersectionObserver.
document.addEventListener('click', (e) => {
  const btn = e.target.closest('.load-file-diff');
  if (!btn) return;
  e.preventDefault();
  const fileEl = btn.closest('.file');
  if (fileEl) loadDeferredFile(fileEl);
});

// Load files as they approach the viewport, one at a time. Serialised because
// each one is a git call plus syntax highlighting on a single-threaded server:
// firing ten at once turns scrolling into a stall, which is the thing being
// fixed here.
(() => {
  if (!('IntersectionObserver' in window)) return;
  const queue = [];
  let running = false;

  async function drain() {
    if (running) return;
    running = true;
    while (queue.length) {
      const el = queue.shift();
      if (el.isConnected && el.hasAttribute('data-deferred')) await loadDeferredFile(el);
    }
    running = false;
  }

  const io = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        io.unobserve(entry.target);
        queue.push(entry.target);
      }
      drain();
    },
    // A screenful of lead time, so a file is usually ready by the time it is
    // scrolled to rather than popping in under the reader.
    { rootMargin: '800px 0px' }
  );

  const observe = () =>
    document.querySelectorAll('.file[data-deferred]').forEach((el) => io.observe(el));
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', observe);
  else observe();
})();
