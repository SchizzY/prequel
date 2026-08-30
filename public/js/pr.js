// Conversation tab behaviour: post PR-level comments and thread replies, and
// keep the page live while agents work through the API.
(function () {
  const CLIENT_ID = Math.random().toString(36).slice(2);

  // Who the browser posts as. The server picks the human participant and
  // stamps it on <body>; agents identify themselves over the API instead.
  const ME = document.body.dataset.me;

  const json = () => ({ 'content-type': 'application/json', 'x-prequel-client': CLIENT_ID });

  function toast(message) {
    const el = document.getElementById('toast');
    if (!el) return;
    el.textContent = message;
    el.hidden = false;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => {
      el.hidden = true;
    }, 3500);
  }

  // Timestamps render as ISO server-side so the markup stays cacheable and
  // timezone-independent; make them human here.
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

  function humaniseTimes(root = document) {
    root.querySelectorAll('time[datetime]').forEach((el) => {
      const iso = el.getAttribute('datetime');
      el.title = new Date(iso).toLocaleString();
      el.textContent = relative(iso);
    });
  }

  async function post(url, body) {
    const res = await fetch(url, { method: 'POST', headers: json(), body: JSON.stringify(body) });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `request failed (${res.status})`);
    }
    return res.json();
  }

  // Submitting either composer reloads: the server owns feed ordering, and
  // re-deriving it here would be a second, drifting implementation of it.
  async function submit(form, url, payload) {
    const button = form.querySelector('button[type="submit"]');
    const textarea = form.querySelector('textarea');
    const body = textarea.value.trim();
    if (!body) return;

    button.disabled = true;
    try {
      await post(url, { ...payload, body, handle: ME });
      textarea.value = '';
      window.location.reload();
    } catch (err) {
      toast(err.message);
      button.disabled = false;
    }
  }

  document.addEventListener('submit', (e) => {
    const prForm = e.target.closest('#pr-comment-form');
    if (prForm) {
      e.preventDefault();
      submit(prForm, `/api/pulls/${prForm.dataset.pr}/threads`, {});
      return;
    }
    const replyForm = e.target.closest('.reply-form');
    if (replyForm) {
      e.preventDefault();
      submit(replyForm, `/api/threads/${replyForm.dataset.thread}/comments`, {});
    }
  });

  // Ctrl/Cmd+Enter submits, like GitHub.
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || !(e.metaKey || e.ctrlKey)) return;
    const form = e.target.closest('#pr-comment-form, .reply-form');
    if (form) form.requestSubmit();
  });

  // Live updates while an agent works the review over the API.
  function connectEvents() {
    const es = new EventSource('/api/events');
    es.addEventListener('message', (e) => {
      let msg;
      try {
        msg = JSON.parse(e.data);
      } catch {
        return;
      }
      if (msg.origin === CLIENT_ID) return; // our own echo
      if (msg.type && msg.type.startsWith('thread.')) window.location.reload();
      if (msg.type === 'review.submitted') window.location.reload();
    });
    es.addEventListener('error', () => {
      /* EventSource retries on its own */
    });
  }

  humaniseTimes();
  connectEvents();
})();
