// The base branch a pull request merges into. On the standalone review page the
// base is a view option and a query param is enough; here it is a property of
// the PR, so picking one patches the pull request and reloads — the diff, the
// +/- summary and the commit list all read base_ref, and they must agree.
(function () {
  document.addEventListener('change', async (e) => {
    const select = e.target.closest('.pr-base-select');
    if (!select) return;

    const previous = select.dataset.current || '';
    select.disabled = true;
    try {
      const res = await fetch(`/api/pulls/${select.dataset.pr}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ baseRef: select.value }),
      });
      if (!res.ok) throw new Error(`could not change the base (${res.status})`);
      window.location.reload();
    } catch (err) {
      // Put the header back to what is actually stored rather than leaving it
      // claiming a base the PR does not have.
      if (previous) select.value = previous;
      select.disabled = false;
      const toast = document.getElementById('toast');
      if (toast) {
        toast.textContent = err.message;
        toast.hidden = false;
        setTimeout(() => {
          toast.hidden = true;
        }, 3500);
      }
    }
  });
})();
