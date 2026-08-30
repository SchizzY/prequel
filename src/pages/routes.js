// The two pages. Conversation is the PR story -- description, review summaries,
// PR-wide discussion; Files changed is the diff with its inline threads.
//
// Both render from the same API-layer model the agents drive, so anything an
// agent does over REST shows up here without a second code path.

import { marked } from 'marked';

import { buildDiffView, diffOptions } from '../render/diffView.js';
import { listPulls, getPullByNumber, tabCounts, ensureRepo } from '../model/pulls.js';
import { getParticipant } from '../model/participants.js';
import { listReviews, verdictSummary, getReview } from '../model/reviews.js';
import * as threads from '../model/threads.js';
import { listTimeline } from '../model/timeline.js';
import { reanchorPull } from '../anchor/reanchor.js';

const md = (text) => (text ? marked.parse(text) : '');

/**
 * Merge the timeline with the objects it references, so the template walks one
 * ordered list instead of correlating three.
 */
function buildFeed(db, pull) {
  const reviewsById = new Map(listReviews(db, pull.id).map((r) => [r.id, r]));
  const byThread = new Map(threads.listThreads(db, pull.id).map((t) => [t.id, t]));

  return listTimeline(db, pull.id)
    .map((event) => {
      const item = { ...event, bodyHtml: null, review: null, thread: null };
      switch (event.kind) {
        case 'review_submitted': {
          // The timeline records the verdict; the body lives on the review.
          const review = [...reviewsById.values()].find(
            (r) => r.participant_id === event.participant_id && r.state === 'submitted'
          );
          if (review) {
            item.review = { ...review, bodyHtml: md(review.body) };
            item.threads = threads.listThreads(db, pull.id, { reviewId: review.id });
          }
          break;
        }
        case 'commented': {
          const thread = byThread.get(event.payload?.threadId);
          if (thread) {
            item.thread = {
              ...thread,
              comments: thread.comments.map((c) => ({ ...c, bodyHtml: md(c.body) })),
            };
          }
          break;
        }
        case 'thread_resolved':
        case 'thread_assigned': {
          item.thread = byThread.get(event.payload?.threadId) ?? null;
          break;
        }
        case 'triaged': {
          item.from = byThread.get(event.payload?.from) ?? null;
          item.to = byThread.get(event.payload?.to) ?? null;
          break;
        }
        default:
          break;
      }
      return item;
    })
    // A review card carries its own findings; a resolve/assign notice next to it
    // adds nothing the card does not already show.
    .filter((item) => !(item.kind === 'thread_assigned' && !item.thread));
}

/** Everything the shared header and tab strip need. */
function chrome(db, pull, active) {
  const counts = tabCounts(db, pull.id);
  return {
    pull,
    active,
    counts,
    verdicts: verdictSummary(db, pull.id),
    tabs: [
      { id: 'conversation', label: 'Conversation', href: `/pr/${pull.number}`, count: counts.conversation },
      { id: 'files', label: 'Files changed', href: `/pr/${pull.number}/files`, count: counts.files },
    ],
  };
}

export function mountPages(app, db, { repoRoot, defaultBase = null } = {}) {
  const repo = ensureRepo(db, repoRoot);

  const pullOr404 = (req, res) => {
    const pull = getPullByNumber(db, repo.id, Number(req.params.number));
    if (!pull) {
      res.status(404).render('pr/missing', { number: req.params.number, colorMode: 'auto' });
      return null;
    }
    return pull;
  };

  // Index: every PR in this repo.
  app.get('/pulls', (req, res) => {
    const pulls = listPulls(db, repo.id).map((p) => ({
      ...p,
      counts: tabCounts(db, p.id),
      verdicts: verdictSummary(db, p.id),
    }));
    res.render('pr/index', {
      colorMode: ['light', 'dark'].includes(req.query.mode) ? req.query.mode : 'auto',
      repo,
      repoPath: repoRoot,
      pulls,
    });
  });

  // Conversation tab.
  app.get('/pr/:number', (req, res) => {
    const pull = pullOr404(req, res);
    if (!pull) return;
    res.render('pr/conversation', {
      colorMode: ['light', 'dark'].includes(req.query.mode) ? req.query.mode : 'auto',
      repoPath: repoRoot,
      ...chrome(db, pull, 'conversation'),
      author: getParticipant(db, pull.author_id),
      descriptionHtml: md(pull.body),
      feed: buildFeed(db, pull),
      reviews: listReviews(db, pull.id, { state: 'submitted' }).map((r) => ({
        ...r,
        bodyHtml: md(r.body),
      })),
    });
  });

  // Files changed tab: the original diff view, under the PR chrome.
  app.get('/pr/:number/files', async (req, res, next) => {
    const pull = pullOr404(req, res);
    if (!pull) return;
    try {
      // The PR records the refs it is about; the query string can still override
      // the presentation knobs (split/unified, which changes to show).
      const opts = diffOptions(req.query, {
        defaultBase: pull.base_ref || defaultBase,
        defaultMode: pull.diff_mode || 'branch',
      });
      // Opening the diff is exactly when stale line numbers would mislead, and
      // the blob-sha check makes an unchanged tree almost free, so re-anchor
      // here rather than making it something you have to remember to run.
      await reanchorPull(db, {
        repoRoot,
        pullRequestId: pull.id,
        rev: opts.diffMode === 'branch' ? 'HEAD' : 'WORKTREE',
      });

      const built = await buildDiffView(repoRoot, opts);
      res.render('pr/files', {
        colorMode: opts.colorMode,
        view: opts.view,
        diffMode: opts.diffMode,
        repoPath: repoRoot,
        isRepo: Boolean(repoRoot),
        commentsEnabled: Boolean(repoRoot),
        ...chrome(db, pull, 'files'),
        ...built,
        threads: threads.listThreads(db, pull.id, { anchored: true }).map((t) => ({
          ...t,
          comments: t.comments.map((c) => ({ ...c, bodyHtml: md(c.body) })),
        })),
      });
    } catch (err) {
      next(err);
    }
  });

  return app;
}
