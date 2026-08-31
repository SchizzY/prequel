// Rendering the markdown that reviewers write.
//
// Bodies here are not trusted input in the ordinary sense: they are written by
// agents, and an agent's summary routinely quotes the diff it was reviewing. So
// a comment body can contain whatever the code under review contains. marked
// passes raw HTML straight through by default, and the templates interpolate
// the result with `<%-`, so without this a `<img onerror=...>` in a reviewed
// file becomes script running on the page, with the whole local API -- every
// repo the user has added -- behind it.
//
// The block is at the *tokenizer*, not the renderer. Overriding `renderer.html`
// alone is not enough: marked sets `lexer.state.inRawBlock` the moment it sees
// an inline `<code>`, `<pre>`, `<kbd>` or `<script>`, and from then on emits the
// raw source as `text` tokens, which never reach the html renderer at all.
// Refusing to tokenise a tag in the first place means that state is never
// entered and every `<` goes through the ordinary text path -- escaped once, so
// a fenced code block still reads correctly.
//
// Link and image targets are limited separately, since those are attributes
// markdown legitimately produces.

import { marked, Renderer, Tokenizer } from 'marked';

const escapeHtml = (s) =>
  String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

// For a URL going into an href or src. marked hands these to the renderer
// exactly as they were written -- unlike titles and alt text, which it has
// already escaped -- so everything is escaped here, `&` included. Escaping `&`
// is what keeps `?x=1&sect;y=2` a literal query string rather than one the
// browser silently decodes to `?x=1<section sign>y=2`; and `<`/`"` are what
// stop `[a](<https://e/" onmouseover="alert(1)>)` closing the attribute and
// adding an event handler.
const attrUrl = (s) =>
  String(s)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

// Anything that is not a scheme at all (a relative or anchor link) is fine;
// anything that names one has to name a safe one. `javascript:`, `data:` and
// `vbscript:` are the executable ones.
const SAFE_SCHEME = /^(https?|mailto|ftp):/i;
const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

// The named entities that can hide a scheme. The colon is the one that matters;
// the rest are the separators an attacker reaches for next.
const NAMED_ENTITY = {
  colon: ':',
  sol: '/',
  tab: '\t',
  newline: '\n',
  lpar: '(',
  rpar: ')',
  semi: ';',
};

const fromCode = (code) =>
  Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';

// Entities have to be *decoded*, not deleted. Deleting them is what let
// `javascript&#58;alert(1)` through: strip the entity and the colon goes with
// it, so the value looks like a relative URL with no scheme at all -- and then
// the browser decodes it back into a working `javascript:` link.
const decodeEntities = (s) =>
  String(s)
    .replace(/&#x([0-9a-f]+);?/gi, (_, hex) => fromCode(parseInt(hex, 16)))
    .replace(/&#(\d+);?/g, (_, dec) => fromCode(parseInt(dec, 10)))
    .replace(/&([a-z]+);/gi, (whole, name) => NAMED_ENTITY[name.toLowerCase()] ?? whole);

function safeHref(href) {
  const value = String(href ?? '').trim();
  // The copy the scheme is judged on: entities resolved, then whitespace and
  // control characters removed, since `java&#9;script:` is a scheme too. Written
  // as a codepoint filter rather than a regex range so the control characters
  // stay out of this file. The original is what gets emitted.
  const bare = [...decodeEntities(value)].filter((ch) => ch.charCodeAt(0) > 0x20).join('');
  if (!bare) return null;
  if (HAS_SCHEME.test(bare) && !SAFE_SCHEME.test(bare)) return null;
  return value;
}

function safeRenderer() {
  const renderer = new Renderer();

  // Unreachable now that the tokenizer refuses tags, but kept so a later change
  // to the tokenizer cannot quietly reopen the hole.
  renderer.html = (html) => escapeHtml(html);

  // `title` and `text` arrive already escaped by marked; escaping them again
  // turns a quote in a title into a visible `&quot;`.
  renderer.link = (href, title, text) => {
    const url = safeHref(href);
    if (!url) return text; // unusable target: keep the words, drop the link
    const titleAttr = title ? ` title="${title}"` : '';
    // Local, but still: an external link should not hand the opener over.
    return `<a href="${attrUrl(url)}"${titleAttr} rel="noopener noreferrer">${text}</a>`;
  };

  renderer.image = (href, title, text) => {
    const url = safeHref(href);
    const alt = text ?? '';
    if (!url) return alt;
    const titleAttr = title ? ` title="${title}"` : '';
    return `<img src="${attrUrl(url)}" alt="${alt}"${titleAttr}>`;
  };

  return renderer;
}

// A tag that is never tokenised cannot set inRawBlock, and cannot be emitted.
function inertTokenizer() {
  const tokenizer = new Tokenizer();
  tokenizer.tag = () => undefined; // inline `<...>`
  tokenizer.html = () => undefined; // block-level HTML
  return tokenizer;
}

const options = { breaks: true, renderer: safeRenderer(), tokenizer: inertTokenizer() };

/** Render a comment, review or description body to HTML that cannot execute. */
export function renderMarkdown(text) {
  return text ? marked.parse(String(text), options) : '';
}
