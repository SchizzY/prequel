// The pull request index: opening one against any repo on this machine, and
// removing ones you are done with.
//
// A repo is added by pointing at a folder rather than by restarting prequel
// somewhere else, so the branches offered here always come from the repo the
// PR will actually be about -- the server is asked for them each time the
// selection changes rather than the page guessing.
(function () {
  const CLIENT_ID = Math.random().toString(36).slice(2);
  const ME = document.body.dataset.me;

  const $ = (id) => document.getElementById(id);
  const headers = () => ({ 'content-type': 'application/json', 'x-prequel-client': CLIENT_ID });

  function toast(message) {
    const el = $('toast');
    if (!el) return;
    el.textContent = message;
    el.hidden = false;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => {
      el.hidden = true;
    }, 3500);
  }

  async function send(method, url, body) {
    const res = await fetch(url, {
      method,
      headers: headers(),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.error || `${method} ${url} failed (${res.status})`);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  // --- opening a pull request ---------------------------------------------

  const panel = $('new-pr');
  const toggle = $('new-pr-toggle');
  if (!panel || !toggle) return;

  const repoSelect = $('new-repo');
  const dropRepo = $('repo-drop');
  const baseSelect = $('new-base');
  const headSelect = $('new-head');
  const titleInput = $('new-title');
  const bodyInput = $('new-body');
  const createButton = $('new-create');
  const status = $('new-pr-hint');

  // Left alone once you type: the title only follows the branch while it still
  // says what the branch says.
  let titleTouched = false;

  function setStatus(text, kind) {
    status.textContent = text || '';
    status.dataset.kind = kind || '';
  }

  const options = (select, values, chosen) => {
    select.replaceChildren(
      ...values.map((value) => {
        const option = document.createElement('option');
        option.value = value;
        option.textContent = value;
        option.selected = value === chosen;
        return option;
      })
    );
  };

  // Nothing to compare is a state GitHub shows rather than hides: say why the
  // button is off instead of letting it fail on submit.
  function validate() {
    const same = baseSelect.value && baseSelect.value === headSelect.value;
    createButton.disabled = same || !headSelect.options.length;
    if (same) setStatus('Choose two different branches — there is nothing to compare.', 'warn');
    else if (headSelect.options.length) setStatus(repoSelect.selectedOptions[0]?.dataset.path || '');
  }

  async function loadBranches() {
    const chosen = repoSelect.selectedOptions[0];
    if (!chosen) return;
    dropRepo.hidden = !chosen.dataset.removable;
    setStatus('Reading branches…');
    createButton.disabled = true;
    try {
      const refs = await send('GET', `/api/repos/${chosen.value}/branches`);
      const all = [...refs.branches.local, ...refs.branches.remote];
      // The branch the repo is standing on is what you are almost always
      // reviewing; the base it would merge into is the other end.
      const head = all.includes(refs.head) ? refs.head : all[0];
      const base = all.includes(refs.defaultBase) ? refs.defaultBase : all.find((b) => b !== head);
      options(headSelect, all, head);
      options(baseSelect, all, base);
      if (!titleTouched) titleInput.value = head || '';
      validate();
    } catch (err) {
      setStatus(err.message, 'error');
    }
  }

  // The panel is opened rarely, so it earns an entrance; it leaves faster than
  // it arrives, the way a dismissal should.
  function openPanel() {
    panel.hidden = false;
    // Flush the display change before the open state lands, so the transition
    // has two frames to run between. requestAnimationFrame would do it too,
    // but not while the tab is in the background.
    void panel.offsetHeight;
    panel.dataset.open = '';
    toggle.setAttribute('aria-expanded', 'true');
    if (!headSelect.options.length) loadBranches();
  }

  function closePanel() {
    delete panel.dataset.open;
    toggle.setAttribute('aria-expanded', 'false');
    setTimeout(() => {
      panel.hidden = true;
    }, 120);
  }

  toggle.addEventListener('click', () => (panel.hidden ? openPanel() : closePanel()));
  $('new-cancel').addEventListener('click', closePanel);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !panel.hidden) closePanel();
  });

  repoSelect.addEventListener('change', loadBranches);
  baseSelect.addEventListener('change', validate);
  headSelect.addEventListener('change', () => {
    if (!titleTouched) titleInput.value = headSelect.value;
    validate();
  });
  titleInput.addEventListener('input', () => {
    titleTouched = titleInput.value.trim().length > 0;
  });

  createButton.addEventListener('click', async () => {
    createButton.disabled = true;
    try {
      const { pull } = await send('POST', '/api/pulls', {
        handle: ME,
        repoId: repoSelect.value,
        title: titleInput.value.trim() || headSelect.value,
        body: bodyInput.value,
        baseRef: baseSelect.value,
        headRef: headSelect.value,
        diffMode: 'branch',
      });
      location.href = `/pr/${pull.number}`;
    } catch (err) {
      setStatus(err.message, 'error');
      createButton.disabled = false;
    }
  });

  // --- adding and forgetting repos ----------------------------------------

  // A repo added mid-session gets the same option the page would have rendered.
  function addOption(repo) {
    let option = [...repoSelect.options].find((o) => o.value === repo.id);
    if (!option) {
      option = document.createElement('option');
      option.value = repo.id;
      option.textContent = repo.name;
      option.title = repo.root_path;
      option.dataset.path = repo.root_path;
      option.dataset.removable = '1';
      repoSelect.appendChild(option);
    }
    repoSelect.value = repo.id;
    return option;
  }

  $('repo-add').addEventListener('click', async (e) => {
    const button = e.currentTarget;
    button.disabled = true;
    setStatus('Waiting for the folder dialog…');
    try {
      const picked = await send('POST', '/api/repos/pick', { repoId: repoSelect.value });
      if (picked.cancelled) return validate();
      addOption(picked.repo);
      await loadBranches();
    } catch (err) {
      // No dialog to show (a headless box): take a typed path instead of
      // leaving the button dead.
      if (err.status === 501) return addByPath();
      setStatus(err.message, 'error');
    } finally {
      button.disabled = false;
    }
  });

  async function addByPath() {
    const typed = prompt('Path to the repository');
    if (!typed) return validate();
    try {
      const added = await send('POST', '/api/repos', { path: typed });
      addOption(added.repo);
      await loadBranches();
    } catch (err) {
      setStatus(err.message, 'error');
    }
  }

  dropRepo.addEventListener('click', async () => {
    const option = repoSelect.selectedOptions[0];
    if (!option) return;
    try {
      await send('DELETE', `/api/repos/${option.value}`);
      option.remove();
      repoSelect.selectedIndex = 0;
      await loadBranches();
    } catch (err) {
      setStatus(err.message, 'error');
    }
  });

  // --- removing a pull request --------------------------------------------

  document.addEventListener('click', async (e) => {
    const drop = e.target.closest('.pr-list-drop');
    if (!drop) return;
    const item = drop.closest('.pr-list-item');
    const title = item.querySelector('.pr-list-title')?.textContent.trim() || `#${drop.dataset.pr}`;
    // The reviews and comments go with it and nothing here can bring them
    // back, so this is the one place the page asks.
    if (!confirm(`Delete ${title}?\n\nIts reviews, comments and history go too. The branch itself is untouched.`)) return;
    try {
      await send('DELETE', `/api/pulls/${drop.dataset.pr}`);
      // Collapse the row rather than snatching it away: the list closing over
      // the gap is what says the delete landed.
      item.style.height = `${item.offsetHeight}px`;
      void item.offsetHeight;
      item.classList.add('is-leaving');
      setTimeout(() => {
        item.remove();
        recount();
        applyFilters();
      }, 200);
      toast(`Deleted #${drop.dataset.pr}`);
    } catch (err) {
      toast(err.message);
    }
  });

  // --- the list: search, open/closed, and how long ago ---------------------

  const rows = () => [...document.querySelectorAll('.pr-list-item')];
  const blank = $('list-blank');
  const search = $('pr-filter');
  let showing = 'open';

  function applyFilters() {
    const needle = (search?.value || '').trim().toLowerCase();
    let visible = 0;
    for (const row of rows()) {
      const match =
        row.dataset.state === showing && (!needle || row.dataset.search.includes(needle));
      row.hidden = !match;
      if (match) visible += 1;
    }
    if (blank) blank.hidden = visible > 0 || !rows().length;
  }

  function recount() {
    const tally = (state) => rows().filter((r) => r.dataset.state === state).length;
    const open = $('count-open');
    const closed = $('count-closed');
    if (open) open.textContent = tally('open');
    if (closed) closed.textContent = tally('closed');
  }

  search?.addEventListener('input', applyFilters);

  for (const button of document.querySelectorAll('.state-filter')) {
    button.addEventListener('click', () => {
      showing = button.dataset.state;
      for (const other of document.querySelectorAll('.state-filter')) {
        other.classList.toggle('is-active', other === button);
      }
      applyFilters();
    });
  }

  // Timestamps render as ISO server-side so the markup stays timezone-neutral;
  // "6 hours ago" is a thing only the browser knows how to say.
  const UNITS = [
    [60, 'second'],
    [60, 'minute'],
    [24, 'hour'],
    [7, 'day'],
    [4.35, 'week'],
    [12, 'month'],
    [Infinity, 'year'],
  ];

  function relative(iso) {
    const then = new Date(iso);
    if (Number.isNaN(then.getTime())) return iso;
    let delta = (Date.now() - then.getTime()) / 1000;
    if (delta < 45) return 'just now';
    for (const [step, unit] of UNITS) {
      if (Math.abs(delta) < step) {
        const n = Math.round(delta);
        return `${n} ${unit}${n === 1 ? '' : 's'} ago`;
      }
      delta /= step;
    }
    return then.toLocaleDateString();
  }

  for (const el of document.querySelectorAll('time[datetime]')) {
    const iso = el.getAttribute('datetime');
    el.title = new Date(iso).toLocaleString();
    el.textContent = relative(iso);
  }

  applyFilters();

  // --- live updates -------------------------------------------------------
  // An agent can open or close a pull request while this page is up; the list
  // is cheap to rebuild, so take the whole page rather than patching a row.
  const events = new EventSource('/api/events');
  events.addEventListener('message', (e) => {
    let data;
    try {
      data = JSON.parse(e.data);
    } catch {
      return;
    }
    if (data.origin === CLIENT_ID) return;
    if (['pull.created', 'pull.deleted', 'pull.updated'].includes(data.type)) location.reload();
  });
})();
