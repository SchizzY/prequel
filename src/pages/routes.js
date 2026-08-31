// The two pages. Conversation is the PR story -- description, review summaries,
// PR-wide discussion; Files changed is the diff with its inline threads.
//
// Both render from the same API-layer model the agents drive, so anything an
// agent does over REST shows up here without a second code path.

import { renderMarkdown } from '../render/markdown.js';

import { buildDiffView, diffOptions } from '../render/diffView.js';
import {
  listAllPulls,
  getPullByNumber,
  getRepo,
  listRepos,
  tabCounts,
  ensureRepo,
} from '../model/pulls.js';
import { getParticipant, currentHuman } from '../model/participants.js';
import { listReviews, verdictSummary, getReview } from '../model/reviews.js';
import * as threads from '../model/threads.js';
import { listTimeline } from '../model/timeline.js';
import { reanchorPull } from '../anchor/reanchor.js';
import {
  getUserName,
  getDiffStat,
  listCommits,
  listBranches,
  resolveBaseRev,
  resolveHeadRev,
} from '../git/gitService.js';

const md = (text) => renderMarkdown(text);

// JSON destined for a <script> block. A body containing the characters
// "</script>" would otherwise close the tag and turn a review comment into
// markup; escaping "<" keeps the payload valid JSON and inert as HTML.
const scriptJson = (value) => JSON.stringify(value).replace(/</g, '\\u003c');

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
          // The event names its review directly. Events written before it did
          // fall back to the participant's latest round submitted no later than
          // the event -- matching on participant alone always found their
          // first review, so a second round rendered as a copy of the first.
          const review =
            reviewsById.get(event.payload?.reviewId) ??
            [...reviewsById.values()]
              .filter(
                (r) =>
                  r.participant_id === event.participant_id &&
                  r.state === 'submitted' &&
                  String(r.submitted_at ?? '') <= String(event.created_at ?? '')
              )
              .pop();
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
        case 'thread_resolved': {
          item.thread = byThread.get(event.payload?.threadId) ?? null;
          break;
        }
        case 'thread_assigned': {
          item.thread = byThread.get(event.payload?.threadId) ?? null;
          // Who it was handed to *at the time*. Taken from the event, so a
          // later reassignment does not rewrite this notice, and clearing the
          // assignee reads as the unassignment it is rather than as a handoff
          // to nobody.
          // Events written before the payload carried an assignee say nothing
          // either way, so they keep reading as assignments and borrow the
          // thread's current owner. Only an event that positively records "no
          // assignee" is an unassignment.
          const knowsAssignee = event.payload ? 'assigneeId' in event.payload : false;
          const assigneeId = knowsAssignee
            ? event.payload.assigneeId
            : (item.thread?.assignee_id ?? null);
          const assignee = assigneeId ? getParticipant(db, assigneeId) : null;
          item.assigneeHandle = assignee?.handle ?? event.payload?.assignee ?? null;
          item.unassigned = knowsAssignee && !event.payload.assigneeId;
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

const SEVERITY_ORDER = ['blocking', 'suggestion', 'question', 'nit'];

/**
 * The right-hand rail. Everything on it is derived from the threads the
 * timeline already renders -- there is no separate assignment or label store,
 * so a section can never disagree with the conversation next to it.
 */
function sidebar(db, pull) {
  const all = threads.listThreads(db, pull.id);
  const open = all.filter((t) => t.status === 'open');

  // Who owns the findings that are still open.
  const assigned = new Map();
  for (const t of open) {
    if (!t.assignee_id) continue;
    const row = assigned.get(t.assignee_id) ?? { ...getParticipant(db, t.assignee_id), count: 0 };
    row.count += 1;
    assigned.set(t.assignee_id, row);
  }

  // Severity is this tool's version of labels: what kind of work is waiting.
  const bySeverity = new Map();
  for (const t of all) {
    if (t.severity) bySeverity.set(t.severity, (bySeverity.get(t.severity) ?? 0) + 1);
  }

  // Everyone who has said something here, the author included.
  const people = new Map();
  const add = (p) => {
    if (p && !people.has(p.handle)) people.set(p.handle, p);
  };
  add(getParticipant(db, pull.author_id));
  for (const t of all) for (const c of t.comments) add(c);

  return {
    assignees: [...assigned.values()].sort((a, b) => b.count - a.count),
    severities: [...bySeverity]
      .map(([severity, count]) => ({ severity, count }))
      .sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity)),
    findings: { open: open.length, resolved: all.length - open.length },
    participants: [...people.values()],
  };
}

/**
 * Everything the shared header and tab strip need.
 *
 * The tab counts say what the tab holds, the way GitHub's do: comments on
 * Conversation, commits on Commits, and changed *files* on Files changed --
 * not the threads written about them, which is a number the tab already shows
 * next to each file.
 */
function chrome(db, pull, active, { commitCount = 0, fileCount = null } = {}) {
  const counts = tabCounts(db, pull.id);
  return {
    pull,
    active,
    counts,
    verdicts: verdictSummary(db, pull.id),
    tabs: [
      { id: 'conversation', label: 'Conversation', href: `/pr/${pull.number}`, count: counts.conversation },
      { id: 'commits', label: 'Commits', href: `/pr/${pull.number}/commits`, count: commitCount },
      {
        id: 'files',
        label: 'Files changed',
        href: `/pr/${pull.number}/files`,
        // Falls back to the thread count only when the diff could not be read
        // at all, which is also when a file count would be a lie.
        count: fileCount ?? counts.files,
      },
    ],
  };
}

/**
 * Commits under the day they were made, the way the Commits tab reads. The
 * label is formatted server-side so the grouping and its heading can never
 * disagree about which day a commit belongs to.
 */
function groupByDay(commits) {
  const groups = [];
  for (const commit of commits) {
    const day = String(commit.date).slice(0, 10);
    let group = groups.find((g) => g.day === day);
    if (!group) {
      const when = new Date(commit.date);
      group = {
        day,
        label: Number.isNaN(when.getTime())
          ? day
          : `Commits on ${when.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}`,
        commits: [],
      };
      groups.push(group);
    }
    group.commits.push(commit);
  }
  return groups;
}

export function mountPages(app, db, { repoRoot, defaultBase = null } = {}) {
  const home = ensureRepo(db, repoRoot);
  // Resolved once; only consulted when the store has no human yet.
  const gitName = getUserName(repoRoot).catch(() => null);

  // A pull request names the repo it belongs to, and that repo is not
  // necessarily the one prequel was started in -- the picker on /pulls adds
  // others. Every git call below therefore asks the PR where to run, instead
  // of assuming the launch directory.
  const rootOf = (pull) => getRepo(db, pull.repo_id)?.root_path || repoRoot;

  const pullOr404 = (req, res) => {
    const pull = getPullByNumber(db, Number(req.params.number));
    if (!pull) {
      res.status(404).render('pr/missing', { number: req.params.number, colorMode: 'auto' });
      return null;
    }
    return pull;
  };

  // Index: every PR in every repo you have added, and the picker that adds more.
  app.get('/pulls', async (req, res) => {
    const pulls = listAllPulls(db).map((p) => ({
      ...p,
      counts: tabCounts(db, p.id),
      verdicts: verdictSummary(db, p.id),
    }));
    const repos = listRepos(db).map((r) => ({ ...r, home: r.root_path === repoRoot }));
    res.render('pr/index', {
      // Opening a PR from this page posts as the human the store knows, the
      // same identity the conversation composer uses.
      me: currentHuman(db, { name: await gitName }),
      colorMode: ['light', 'dark'].includes(req.query.mode) ? req.query.mode : 'auto',
      repo: home,
      repos,
      // Worth labelling which repo a PR came from only once there is more than
      // one to confuse it with.
      showRepo: repos.length > 1,
      repoPath: repoRoot,
      pulls,
    });
  });

  // How this PR's commits are found, wherever a page needs them.
  const commitsFor = (pull) => {
    const root = rootOf(pull);
    return root
      ? listCommits(root, {
          base: pull.base_ref || defaultBase,
          mode: pull.diff_mode || 'branch',
          head: pull.head_ref,
        }).catch(() => [])
      : Promise.resolve([]);
  };

  // The +/- summary the header carries on every tab.
  const statsFor = (pull) => {
    const root = rootOf(pull);
    return root
      ? getDiffStat(root, {
          base: pull.base_ref || defaultBase,
          mode: pull.diff_mode || 'branch',
          head: pull.head_ref,
        }).catch(() => null)
      : Promise.resolve(null);
  };

  // Conversation tab.
  app.get('/pr/:number', async (req, res) => {
    const pull = pullOr404(req, res);
    if (!pull) return;
    const commits = await commitsFor(pull);
    const root = rootOf(pull);
    // The header carries the same +/- summary as the Files tab, which this
    // page has no diff of its own to count -- so ask git for the numbers.
    const stats = await statsFor(pull);
    res.render('pr/conversation', {
      me: currentHuman(db, { name: await gitName }),
      colorMode: ['light', 'dark'].includes(req.query.mode) ? req.query.mode : 'auto',
      repoPath: root,
      ...chrome(db, pull, 'conversation', {
        commitCount: commits.length,
        fileCount: stats?.files ?? null,
      }),
      stats,
      // The commits behind the diff, so the timeline can say what landed.
      commits,
      branches: root ? await listBranches(root) : { local: [], remote: [] },
      sidebar: sidebar(db, pull),
      author: getParticipant(db, pull.author_id),
      descriptionHtml: md(pull.body),
      feed: buildFeed(db, pull),
      reviews: listReviews(db, pull.id, { state: 'submitted' }).map((r) => ({
        ...r,
        bodyHtml: md(r.body),
      })),
    });
  });

  // Commits tab: what the branch actually carries, grouped by day.
  app.get('/pr/:number/commits', async (req, res) => {
    const pull = pullOr404(req, res);
    if (!pull) return;
    const commits = await commitsFor(pull);
    const root = rootOf(pull);
    const stats = await statsFor(pull);
    res.render('pr/commits', {
      me: currentHuman(db, { name: await gitName }),
      colorMode: ['light', 'dark'].includes(req.query.mode) ? req.query.mode : 'auto',
      repoPath: root,
      ...chrome(db, pull, 'commits', {
        commitCount: commits.length,
        fileCount: stats?.files ?? null,
      }),
      branches: root ? await listBranches(root) : { local: [], remote: [] },
      stats,
      groups: groupByDay(commits),
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
      const root = rootOf(pull);
      // Where the new side of the diff lives. A PR about a branch this repo is
      // not standing on is read from that branch, so the threads are
      // re-anchored against the same code the diff below shows.
      const headRev = await resolveHeadRev(root, pull.head_ref);
      // Opening the diff is exactly when stale line numbers would mislead, and
      // the blob-sha check makes an unchanged tree almost free, so re-anchor
      // here rather than making it something you have to remember to run.
      // Threads are snapshotted against the working tree, so that is what they
      // are compared with whenever it is the tree this PR is about. Note this
      // does not follow ?diff=: which changes a reader asked to *see* must not
      // decide what the store records, or flipping to Branch and back would
      // bury every comment on uncommitted code and then dig it up again.
      await reanchorPull(db, {
        repoRoot: root,
        pullRequestId: pull.id,
        rev: headRev.checkedOut ? 'WORKTREE' : headRev.rev,
        // Old-side comments are about the diff's old side, which is the merge
        // base -- not the base branch tip, which may have moved on since.
        baseRev: await resolveBaseRev(root, pull.base_ref, headRev.rev),
        // Only the tree the threads were written against may rewrite them. A
        // PR about a branch this checkout is not standing on is still rendered,
        // it just does not get to record what it saw.
        persist: headRev.checkedOut,
      });

      const built = await buildDiffView(root, { ...opts, head: pull.head_ref });
      res.render('pr/files', {
        colorMode: opts.colorMode,
        view: opts.view,
        diffMode: opts.diffMode,
        repoPath: root,
        isRepo: Boolean(root),
        commentsEnabled: Boolean(root),
        me: currentHuman(db, { name: await gitName }),
        ...chrome(db, pull, 'files', {
          commitCount: (await commitsFor(pull)).length,
          // This page has the diff in hand; no need to ask git twice.
          fileCount: built.summary.fileCount,
        }),
        ...built,
        branches: await listBranches(root),
        stats: {
          files: built.summary.fileCount,
          additions: built.summary.additions,
          deletions: built.summary.deletions,
        },
        threadsJson: scriptJson(
          threads.listThreads(db, pull.id, { anchored: true }).map((t) => ({
            ...t,
            comments: t.comments.map((c) => ({ ...c, bodyHtml: md(c.body) })),
          }))
        ),
      });
    } catch (err) {
      next(err);
    }
  });

  return app;
}
