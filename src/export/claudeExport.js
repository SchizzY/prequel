// Builds the payload handed to Claude Code from review comments. Default is
// grouped-by-file, code-fenced markdown (embeds the repo root + each comment's
// code snapshot so Claude can locate the spot even if line numbers shifted).

import { inferLanguage } from '../git/diffParser.js';

function lineLabel(c) {
  return c.startLine === c.endLine ? `Line ${c.startLine}` : `Lines ${c.startLine}–${c.endLine}`;
}

function blockquote(body) {
  return String(body || '')
    .split('\n')
    .map((l) => `> ${l}`)
    .join('\n');
}

function bySortedFile(comments) {
  const groups = new Map();
  for (const c of comments) {
    if (!groups.has(c.filePath)) groups.set(c.filePath, []);
    groups.get(c.filePath).push(c);
  }
  return [...groups.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([file, list]) => [file, list.sort((a, b) => a.startLine - b.startLine)]);
}

export function buildMarkdown(repoRoot, branch, comments) {
  const out = [];
  out.push(`# Review feedback${branch ? ` — ${branch}` : ''}`);
  out.push(`Repo: ${repoRoot}`);
  out.push('');
  out.push('Please address each review comment below; make the requested change for each.');
  out.push('');

  for (const [file, list] of bySortedFile(comments)) {
    out.push(`## ${file}`);
    out.push('');
    const lang = inferLanguage(file) || '';
    for (const c of list) {
      if (c.side === 'file') {
        out.push('### File comment');
        out.push(blockquote(c.body));
        out.push('');
        continue;
      }
      out.push(`### ${lineLabel(c)}${c.side === 'old' ? ' (old side)' : ''}`);
      const code = (c.lineSnapshot || []).join('\n');
      if (code) {
        out.push('```' + lang);
        out.push(code);
        out.push('```');
      }
      out.push(blockquote(c.body));
      out.push('');
    }
  }
  return out.join('\n').replace(/\n+$/, '') + '\n';
}

export function buildJson(comments) {
  return JSON.stringify(
    bySortedFile(comments).flatMap(([file, list]) =>
      list.map((c) => ({
        file,
        side: c.side,
        lines: c.side === 'file' ? null : [c.startLine, c.endLine],
        code: (c.lineSnapshot || []).join('\n'),
        comment: c.body,
      }))
    ),
    null,
    2
  );
}
