// site-generator-fast — a fast, dependency-free drop-in for makefun-site 1.0.0.
// Reimplemented from the makefun-site README (its front matter, template dialect,
// Markdown subset, slug rule and report) for the make.fun bounty
// "Build a static site faster, 22 November 2026".
// run(input) returns exactly makefun-site 1.0.0's build(input) for every input,
// but faster: bulk scanning instead of per-character regex work, a single-pass
// Markdown renderer, memoised slugs, and templates compiled to plain JS.
// No dependencies, no WASM, no native code, no I/O, no clock, no randomness.

// ---------------------------------------------------------------- utilities

/** Code-unit order (never the locale's). */
const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** Whether code unit `c` is JavaScript whitespace (what /\s/ matches). */
function isWS(c) {
  return (
    c === 32 || (c >= 9 && c <= 13) || c === 160 || c === 1680 ||
    (c >= 8192 && c <= 8202) || c === 8232 || c === 8233 || c === 8239 ||
    c === 8287 || c === 12288 || c === 65279
  );
}

const ESC_AMP = '&amp;';
const ESC_LT = '&lt;';
const ESC_GT = '&gt;';
const ESC_QUOT = '&quot;';
const ESC_APOS = '&#39;';

/**
 * `text` with & < > " and ' escaped. One pass; the common case (nothing to
 * escape) returns the input string itself without building anything.
 */
export function escapeHtml(text) {
  let out = null;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    let rep = null;
    if (c === 38) rep = ESC_AMP;
    else if (c === 60) rep = ESC_LT;
    else if (c === 62) rep = ESC_GT;
    else if (c === 34) rep = ESC_QUOT;
    else if (c === 39) rep = ESC_APOS;
    else continue;
    if (out === null) out = [];
    if (i > start) out.push(text.slice(start, i));
    out.push(rep);
    start = i + 1;
  }
  if (out === null) return text;
  if (start < text.length) out.push(text.slice(start));
  return out.join('');
}

/** The most characters a slug keeps before a collision suffix. */
export const SLUG_MAX = 64;

/**
 * The slug of `text`, exactly as makefun-site's slugify: NFKD, combining marks
 * dropped, A-Z lowered, each run of characters other than a-z and 0-9 one "-",
 * none at either end, at most 64 characters (a "-" left at the cut dropped),
 * "untitled" when nothing is left. Pure ASCII text skips the normalisation.
 */
function slugifyRaw(text) {
  let ascii = true;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 127) { ascii = false; break; }
  }
  const plain = ascii ? text : text.normalize('NFKD').replace(/\p{M}/gu, '');
  let out = '';
  let gap = false;
  for (let i = 0; i < plain.length; i++) {
    const c = plain.charCodeAt(i);
    let keep = 0;
    if (c >= 65 && c <= 90) keep = c + 32;
    else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) keep = c;
    else { gap = out.length > 0; continue; }
    if (gap) out += '-';
    gap = false;
    out += String.fromCharCode(keep);
  }
  out = out.slice(0, SLUG_MAX).replace(/-+$/, '');
  return out === '' ? 'untitled' : out;
}

/** Memoised slugify: tag names and headings repeat, titles do not. */
function slugify(text, cache) {
  let v = cache.get(text);
  if (v === undefined) {
    v = slugifyRaw(text);
    cache.set(text, v);
  }
  return v;
}

/** `slug` made unique against `taken` (and added to it): slug, slug-2, ... */
function uniqueSlug(slug, taken) {
  if (!taken.has(slug)) { taken.add(slug); return slug; }
  let n = 2;
  let out;
  while (taken.has((out = `${slug}-${n}`))) n++;
  taken.add(out);
  return out;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** A YYYY-MM-DD date in words, from the string alone. */
function longDate(date) {
  return `${Number(date.slice(8, 10))} ${MONTHS[Number(date.slice(5, 7)) - 1]} ${date.slice(0, 4)}`;
}

/** The words of a body: its runs of characters other than whitespace. */
function wordsOf(text) {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 32 || c === 10 || c === 9 || c === 13 || c === 11 || c === 12) {
      inWord = false;
      continue;
    }
    if (c < 160) {
      if (!inWord) { inWord = true; n++; }
      continue;
    }
    if (isWS(c)) {
      inWord = false;
      continue;
    }
    if (!inWord) { inWord = true; n++; }
  }
  return n;
}

/** `rel` (a link's path, "/"-separated) from the directory `dir`, or null when it climbs out of the root. */
function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

// ---------------------------------------------------------------- front matter

/** The keys a source's front matter may give. */
const KEYS = new Set(['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary']);

/** The days of month `m` (1-12) of year `y`, by the Gregorian rule. */
function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** A string value: "..." with \" and \\ its only escapes, or bare. */
function stringOf(raw) {
  if (raw.charCodeAt(0) === 34) {
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) return { error: 'a quoted string is not closed' };
    let out = null;
    let start = 1;
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw.charCodeAt(i);
      if (c === 92) {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        if (out === null) out = [];
        if (i > start) out.push(raw.slice(start, i));
        out.push(n);
        start = i + 2;
        i++;
      } else if (c === 34) return { error: 'a quoted string holds a stray quote' };
    }
    if (out === null) return { value: raw.slice(1, -1) };
    if (start < raw.length - 1) out.push(raw.slice(start, raw.length - 1));
    return { value: out.join('') };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' };
  return { value: raw };
}

/** Whether `raw` is a valid date, and its parts. */
function dateParts(raw) {
  if (raw.length !== 10 || raw.charCodeAt(4) !== 45 || raw.charCodeAt(7) !== 45) return null;
  let y = 0;
  let mo = 0;
  let d = 0;
  for (let i = 0; i < 10; i++) {
    if (i === 4 || i === 7) continue;
    const c = raw.charCodeAt(i);
    if (c < 48 || c > 57) return null;
    const v = c - 48;
    if (i < 4) y = y * 10 + v;
    else if (i < 7) mo = mo * 10 + v;
    else d = d * 10 + v;
  }
  if (y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return null;
  return true;
}

/** Whether `raw` is a template name: [a-z0-9-]+. */
function isName(raw) {
  if (raw.length === 0) return false;
  for (let i = 0; i < raw.length; i++) {
    const c = raw.charCodeAt(i);
    if (!((c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45)) return false;
  }
  return true;
}

/** Whether `raw` is a slug: [a-z0-9]+(-[a-z0-9]+)*, at most 64 characters. */
function isSlug(raw) {
  const n = raw.length;
  if (n === 0 || n > 64) return false;
  let i = 0;
  while (i < n) {
    const c = raw.charCodeAt(i);
    if (!((c >= 97 && c <= 122) || (c >= 48 && c <= 57))) return false;
    while (i < n) {
      const d = raw.charCodeAt(i);
      if ((d >= 97 && d <= 122) || (d >= 48 && d <= 57)) i++;
      else break;
    }
    if (i < n) {
      if (raw.charCodeAt(i) !== 45) return false;
      i++;
      if (i >= n) return false;
    }
  }
  return true;
}

/** One key's value, or why it is refused. */
function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date':
      return dateParts(raw) === null
        ? { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' }
        : { value: raw };
    case 'tags': {
      if (raw.charCodeAt(0) !== 91 || raw.charCodeAt(raw.length - 1) !== 93) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',');
      for (let k = 0; k < tags.length; k++) {
        const t = tags[k].trim();
        tags[k] = t;
        if (t === '') return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
        for (let j = 0; j < t.length; j++) {
          const c = t.charCodeAt(j);
          if (c === 34 || c === 91 || c === 93) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
        }
      }
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return isName(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return isSlug(raw) ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

/**
 * A source's front matter and body: { data, body }, or { error } with the first
 * reason it is refused. `text` has "\n" line ends. Lines are scanned by index,
 * never split: only the front matter region is walked.
 */
export function parseFrontMatter(text) {
  const n = text.length;
  let nl = text.indexOf('\n');
  if (nl === -1) nl = n;
  if (nl !== 3 || text.charCodeAt(0) !== 45 || text.charCodeAt(1) !== 45 || text.charCodeAt(2) !== 45) {
    return { error: 'no front matter' };
  }
  // Find the closing line: a line exactly "---".
  let closeStart = -1;
  let closeEnd = -1;
  let pos = nl + 1;
  while (pos < n) {
    let e = text.indexOf('\n', pos);
    if (e === -1) e = n;
    if (e - pos === 3 && text.charCodeAt(pos) === 45 && text.charCodeAt(pos + 1) === 45 && text.charCodeAt(pos + 2) === 45) {
      closeStart = pos;
      closeEnd = e;
      break;
    }
    if (e === n) break;
    pos = e + 1;
  }
  if (closeStart === -1) return { error: 'the front matter is not closed' };
  const data = {};
  let p = nl + 1;
  let lineNo = 1;
  while (p < closeStart) {
    let e = text.indexOf('\n', p);
    if (e === -1 || e > closeStart) e = closeStart;
    lineNo++;
    const ls = p;
    const le = e;
    p = e + 1;
    // Blank (spaces and tabs only) or a comment ("#" first): skipped.
    let j = ls;
    while (j < le && (text.charCodeAt(j) === 32 || text.charCodeAt(j) === 9)) j++;
    if (j === le) continue;
    if (text.charCodeAt(ls) === 35) continue;
    // "key: value": a key of a-z and _, a colon, one space and the value.
    let k = ls;
    while (k < le) {
      const c = text.charCodeAt(k);
      if ((c >= 97 && c <= 122) || c === 95) k++;
      else break;
    }
    if (k === ls || k >= le || text.charCodeAt(k) !== 58) return { error: `line ${lineNo} is not "key: value"` };
    const key = text.slice(ls, k);
    let raw;
    if (k + 1 === le) raw = '';
    else if (text.charCodeAt(k + 1) === 32) raw = text.slice(k + 2, le);
    else return { error: `line ${lineNo} is not "key: value"` };
    let rEnd = raw.length;
    while (rEnd > 0 && (raw.charCodeAt(rEnd - 1) === 32 || raw.charCodeAt(rEnd - 1) === 9)) rEnd--;
    if (rEnd !== raw.length) raw = raw.slice(0, rEnd);
    if (!KEYS.has(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = valueOf(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: closeEnd === n ? '' : text.slice(closeEnd + 1) };
}

// ---------------------------------------------------------------- Markdown

/** Whether the line [ls, le) is blank (spaces and tabs only). */
function isBlank(src, ls, le) {
  for (let i = ls; i < le; i++) {
    const c = src.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A fence opening at [ls, le): its language, or null. */
function fenceOpen(src, ls, le) {
  if (le - ls < 3) return null;
  if (src.charCodeAt(ls) !== 96 || src.charCodeAt(ls + 1) !== 96 || src.charCodeAt(ls + 2) !== 96) return null;
  let i = ls + 3;
  while (i < le) {
    const c = src.charCodeAt(i);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45) i++;
    else break;
  }
  const lang = src.slice(ls + 3, i);
  while (i < le && (src.charCodeAt(i) === 32 || src.charCodeAt(i) === 9)) i++;
  return i === le ? lang : null;
}

/** Whether the line [ls, le) closes a fence: three backticks, spaces/tabs after. */
function isFenceClose(src, ls, le) {
  if (le - ls < 3) return false;
  if (src.charCodeAt(ls) !== 96 || src.charCodeAt(ls + 1) !== 96 || src.charCodeAt(ls + 2) !== 96) return false;
  let i = ls + 3;
  while (i < le && (src.charCodeAt(i) === 32 || src.charCodeAt(i) === 9)) i++;
  return i === le;
}

/** A heading at [ls, le): { depth, ts, te } (its text's bounds), or null. */
function headingAt(src, ls, le) {
  let h = ls;
  while (h < le && src.charCodeAt(h) === 35) h++;
  const depth = h - ls;
  if (depth < 1 || depth > 6) return null;
  if (h >= le || (src.charCodeAt(h) !== 32 && src.charCodeAt(h) !== 9)) return null;
  let ts = h;
  while (ts < le && (src.charCodeAt(ts) === 32 || src.charCodeAt(ts) === 9)) ts++;
  let te = le;
  while (te > ts && (src.charCodeAt(te - 1) === 32 || src.charCodeAt(te - 1) === 9)) te--;
  return te <= ts ? null : { depth, ts, te };
}

/** Whether the line [ls, le) is a thematic break: --- or ***, spaces/tabs after. */
function isHR(src, ls, le) {
  if (le - ls < 3) return false;
  const c = src.charCodeAt(ls);
  if (c !== 45 && c !== 42) return false;
  if (src.charCodeAt(ls + 1) !== c || src.charCodeAt(ls + 2) !== c) return false;
  let i = ls + 3;
  while (i < le && (src.charCodeAt(i) === 32 || src.charCodeAt(i) === 9)) i++;
  return i === le;
}

/** Whether the line [ls, le) ends a paragraph: blank, fence, heading or break. */
function endsParagraph(src, ls, le) {
  if (ls >= le) return true;
  const c = src.charCodeAt(ls);
  if (c === 32 || c === 9) return isBlank(src, ls, le);
  if (c === 96) return fenceOpen(src, ls, le) !== null;
  if (c === 35) return headingAt(src, ls, le) !== null;
  if (c === 45 || c === 42) return isHR(src, ls, le);
  return false;
}

/** A paragraph line as it is rendered: spaces and tabs at either end dropped. */
function trimLine(src, a, b) {
  while (a < b && (src.charCodeAt(a) === 32 || src.charCodeAt(a) === 9)) a++;
  while (b > a && (src.charCodeAt(b - 1) === 32 || src.charCodeAt(b - 1) === 9)) b--;
  return src.slice(a, b);
}

/** A bullet item at [ls, le): { ts } (its text's start), or null. */
function bulletAt(src, ls, le) {
  if (le - ls < 2) return null;
  const c = src.charCodeAt(ls);
  if ((c === 45 || c === 42) && src.charCodeAt(ls + 1) === 32) return { ts: ls + 2 };
  return null;
}

/** An ordered item at [ls, le): { num, ts }, or null. */
function orderedAt(src, ls, le) {
  let d = 0;
  while (ls + d < le && d < 10) {
    const c = src.charCodeAt(ls + d);
    if (c >= 48 && c <= 57) d++;
    else break;
  }
  if (d === 0 || d > 9) return null;
  if (ls + d + 1 >= le || src.charCodeAt(ls + d) !== 46 || src.charCodeAt(ls + d + 1) !== 32) return null;
  return { num: Number(src.slice(ls, ls + d)), ts: ls + d + 2 };
}

/** A list's first line at [ls, le): { ordered, num } , or null. */
function listStart(src, ls, le) {
  const b = bulletAt(src, ls, le);
  if (b !== null) return { ordered: false, num: 1 };
  const o = orderedAt(src, ls, le);
  return o === null ? null : { ordered: true, num: o.num };
}

/** A list continuation line: two or more spaces, then a non-space. */
function isContinued(src, ls, le) {
  let i = ls;
  while (i < le && src.charCodeAt(i) === 32) i++;
  return i - ls >= 2 && i < le && !isWS(src.charCodeAt(i));
}

/** Whether code unit `c` is one a backslash escapes. */
function isEscapable(c) {
  return (
    c === 92 || c === 96 || c === 42 || c === 95 || c === 91 || c === 93 || c === 40 ||
    c === 41 || c === 35 || c === 43 || c === 45 || c === 46 || c === 33 || c === 62
  );
}

/** The first index from `from` where `s` holds `what` outside a backslash escape, or -1. */
function findUnescaped(s, what, from) {
  for (let j = from; j <= s.length - what.length; j++) {
    if (s.charCodeAt(j) === 92 && j + 1 < s.length && isEscapable(s.charCodeAt(j + 1))) {
      j++;
      continue;
    }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

/** The first single * from `from` (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from) {
  for (let j = from; j < s.length; j++) {
    const c = s.charCodeAt(j);
    if (c === 92 && j + 1 < s.length && isEscapable(s.charCodeAt(j + 1))) {
      j++;
      continue;
    }
    if (c !== 42) continue;
    if (s.charCodeAt(j + 1) === 42) {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

/** Whether `s` holds any whitespace (what /\s/ matches). */
function hasWS(s) {
  for (let i = 0; i < s.length; i++) if (isWS(s.charCodeAt(i))) return true;
  return false;
}

/** The characters inline rendering treats specially; the scanner jumps between them in native code. */
const INLINE_SPECIAL = /[\\`*\[&<>"']/g;

/**
 * `s` rendered inline, its pieces pushed onto `out`; `link(target)` is a
 * link's href. Plain runs are copied in bulk; only the characters the escape
 * table names are replaced, and only the constructs are expanded. The shared
 * scanner's position is reset on entry and set explicitly after every
 * construct, so the recursive calls for nested spans cannot disturb the scan.
 */
function inlineInto(s, link, out) {
  const n = s.length;
  let start = 0;
  INLINE_SPECIAL.lastIndex = 0;
  let m;
  while ((m = INLINE_SPECIAL.exec(s)) !== null) {
    const i = m.index;
    const ch = m[0];
    if (ch === '\\') {
      // A backslash before an escapable character writes that character.
      if (i + 1 < n && isEscapable(s.charCodeAt(i + 1))) {
        if (i > start) out.push(s.slice(start, i));
        const nc = s.charCodeAt(i + 1);
        out.push(nc === 62 ? ESC_GT : s[i + 1]);
        INLINE_SPECIAL.lastIndex = i + 2;
        start = i + 2;
      }
      continue;
    }
    if (ch === '`') {
      const j = s.indexOf('`', i + 1);
      if (j > i + 1) {
        if (i > start) out.push(s.slice(start, i));
        out.push('<code>', escapeHtml(s.slice(i + 1, j)), '</code>');
        INLINE_SPECIAL.lastIndex = j + 1;
        start = j + 1;
      }
      continue;
    }
    if (ch === '*') {
      if (s.charCodeAt(i + 1) === 42) {
        const j = findUnescaped(s, '**', i + 2);
        if (j > i + 2) {
          if (i > start) out.push(s.slice(start, i));
          out.push('<strong>');
          inlineInto(s.slice(i + 2, j), link, out);
          INLINE_SPECIAL.lastIndex = j + 2;
          out.push('</strong>');
          start = j + 2;
        } else {
          // No closer: both stars are themselves.
          INLINE_SPECIAL.lastIndex = i + 2;
        }
        continue;
      }
      const j = findSingleStar(s, i + 1);
      if (j > i + 1) {
        if (i > start) out.push(s.slice(start, i));
        out.push('<em>');
        inlineInto(s.slice(i + 1, j), link, out);
        INLINE_SPECIAL.lastIndex = j + 1;
        out.push('</em>');
        start = j + 1;
      }
      continue;
    }
    if (ch === '[') {
      const k = findUnescaped(s, ']', i + 1);
      let mm = -1;
      let target = '';
      if (k !== -1 && s.charCodeAt(k + 1) === 40) mm = s.indexOf(')', k + 2);
      if (mm !== -1) target = s.slice(k + 2, mm);
      if (mm !== -1 && target !== '' && !hasWS(target)) {
        if (i > start) out.push(s.slice(start, i));
        out.push('<a href="', escapeHtml(link(target)), '">');
        inlineInto(s.slice(i + 1, k), link, out);
        INLINE_SPECIAL.lastIndex = mm + 1;
        out.push('</a>');
        start = mm + 1;
      }
      continue;
    }
    if (i > start) out.push(s.slice(start, i));
    out.push(ch === '&' ? ESC_AMP : ch === '<' ? ESC_LT : ch === '>' ? ESC_GT : ch === '"' ? ESC_QUOT : ESC_APOS);
    start = i + 1;
  }
  if (n > start) out.push(s.slice(start, n));
}

/**
 * `src` rendered: its HTML (each block on its own lines, a "\n" after the
 * last), its table of contents (every level 2 and 3 heading) and its excerpt
 * (the first paragraph's inline HTML, or ""). Lines are walked by index, never
 * split; `link` resolves a link target; `slugCache` memoises heading slugs.
 */
function renderMarkdown(src, link, slugCache) {
  const n = src.length;
  const ids = new Set();
  const toc = [];
  let excerpt = null;
  const parts = [];
  let ls = 0;
  while (ls <= n) {
    let le = src.indexOf('\n', ls);
    if (le === -1) le = n;
    const nls = le < n ? le + 1 : n + 1;
    // A blank line is empty or opens on a space or tab; any other line is not blank.
    if (ls === le || ((src.charCodeAt(ls) === 32 || src.charCodeAt(ls) === 9) && isBlank(src, ls, le))) { ls = nls; continue; }
    const lang = fenceOpen(src, ls, le);
    if (lang !== null) {
      const body = [];
      let bls = nls;
      while (bls <= n) {
        let ble = src.indexOf('\n', bls);
        if (ble === -1) ble = n;
        const bnls = ble < n ? ble + 1 : n + 1;
        if (isFenceClose(src, bls, ble)) { bls = bnls; break; }
        body.push(escapeHtml(src.slice(bls, ble)), '\n');
        bls = bnls;
      }
      const cls = lang === '' ? '' : ` class="language-${escapeHtml(lang)}"`;
      parts.push(`<pre><code${cls}>${body.join('')}</code></pre>\n`);
      ls = bls;
      continue;
    }
    const hd = headingAt(src, ls, le);
    if (hd !== null) {
      const text = src.slice(hd.ts, hd.te);
      const id = uniqueSlug(slugify(text, slugCache), ids);
      if (hd.depth === 2 || hd.depth === 3) {
        const o = [];
        inlineInto(text, link, o);
        const html = o.join('');
        parts.push(`<h${hd.depth} id="${id}">`, html, `</h${hd.depth}>\n`);
        toc.push({ level: hd.depth, id, html });
      } else {
        parts.push(`<h${hd.depth} id="${id}">`);
        inlineInto(text, link, parts);
        parts.push(`</h${hd.depth}>\n`);
      }
      ls = nls;
      continue;
    }
    if (isHR(src, ls, le)) { parts.push('<hr>\n'); ls = nls; continue; }
    if (src.charCodeAt(ls) === 62) {
      const qlines = [];
      let qls = ls;
      while (qls <= n) {
        let qle = src.indexOf('\n', qls);
        if (qle === -1) qle = n;
        const qnls = qle < n ? qle + 1 : n + 1;
        if (src.charCodeAt(qls) !== 62) break;
        let s = qls + 1;
        if (s < qle && src.charCodeAt(s) === 32) s++;
        const t = trimLine(src, s, qle);
        if (t !== '') qlines.push(t);
        qls = qnls;
      }
      if (qlines.length === 0) parts.push('<blockquote>\n</blockquote>\n');
      else {
        parts.push('<blockquote>\n<p>');
        inlineInto(qlines.join('\n'), link, parts);
        parts.push('</p>\n</blockquote>\n');
      }
      ls = qls;
      continue;
    }
    const lst = listStart(src, ls, le);
    if (lst !== null) {
      const isOrdered = lst.ordered;
      const start = lst.num;
      const items = [];
      let lls = ls;
      while (lls <= n) {
        let lle = src.indexOf('\n', lls);
        if (lle === -1) lle = n;
        const lnls = lle < n ? lle + 1 : n + 1;
        const m = isOrdered ? orderedAt(src, lls, lle) : bulletAt(src, lls, lle);
        if (m !== null) {
          items.push([trimLine(src, m.ts, lle)]);
          lls = lnls;
          continue;
        }
        if (isContinued(src, lls, lle)) {
          items[items.length - 1].push(trimLine(src, lls, lle));
          lls = lnls;
          continue;
        }
        break;
      }
      const tag = isOrdered ? 'ol' : 'ul';
      const open = isOrdered && start !== 1 ? `<ol start="${start}">` : `<${tag}>`;
      parts.push(open, '\n');
      for (const item of items) {
        parts.push('<li>');
        inlineInto(item.join('\n'), link, parts);
        parts.push('</li>\n');
      }
      parts.push(`</${tag}>\n`);
      ls = lls;
      continue;
    }
    const plines = [trimLine(src, ls, le)];
    let pls = nls;
    while (pls <= n) {
      let ple = src.indexOf('\n', pls);
      if (ple === -1) ple = n;
      const pnls = ple < n ? ple + 1 : n + 1;
      if (endsParagraph(src, pls, ple)) break;
      plines.push(trimLine(src, pls, ple));
      pls = pnls;
    }
    if (excerpt === null) {
      const o = [];
      inlineInto(plines.join('\n'), link, o);
      excerpt = o.join('');
      parts.push('<p>', excerpt, '</p>\n');
    } else {
      parts.push('<p>');
      inlineInto(plines.join('\n'), link, parts);
      parts.push('</p>\n');
    }
    ls = pls;
  }
  return { html: parts.join(''), toc, excerpt: excerpt ?? '' };
}

// ---------------------------------------------------------------- Templates

/** The deepest an include nests: one past it renders nothing. */
export const INCLUDE_DEPTH = 8;

const PATH = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF = /^if (not )?(\S+)$/;
const INCLUDE = /^include "([a-z0-9-]+)"$/;

/** A template that does not parse: its name and why. */
export class TemplateError extends Error {}

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  if (!PATH.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}, a standalone tag's line taken with it. */
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = /^[ \t]*$/.test(src.slice(lineStart, open)) && /^[ \t]*$/.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
export function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = INCLUDE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

/** Whether a value counts as true in an if: not undefined, null, false, "", 0 or an empty array. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/** The value at `path` in the scope chain: its first name from the nearest scope holding it, then own properties. */
function lookupAST(scope, path) {
  let s = scope;
  while (s !== null && !Object.hasOwn(s, path[0])) s = Object.getPrototypeOf(s);
  if (s === null) return undefined;
  let v = s[path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

/**
 * `nodes` rendered by walking the tree (the fallback when a template cannot be
 * compiled). `scope` is a null-prototype chain of frames; `out` collects pieces.
 */
function renderAST(nodes, scope, depth, out, esc, textOfFn, truthyFn, tpl) {
  for (const n of nodes) {
    switch (n.kind) {
      case 'text':
        out.push(n.text);
        break;
      case 'var':
        out.push(esc(textOfFn(lookupAST(scope, n.path))));
        break;
      case 'raw':
        out.push(textOfFn(lookupAST(scope, n.path)));
        break;
      case 'if': {
        const v = truthyFn(lookupAST(scope, n.path));
        const branch = v !== n.not ? n.then : n.else;
        if (branch !== null) renderAST(branch, scope, depth, out, esc, textOfFn, truthyFn, tpl);
        break;
      }
      case 'for': {
        const xs = lookupAST(scope, n.path);
        if (!Array.isArray(xs)) break;
        for (let k = 0; k < xs.length; k++) {
          const frame = Object.create(scope);
          frame[n.name] = xs[k];
          frame.loop = { index: k + 1, first: k === 0, last: k === xs.length - 1, length: xs.length };
          renderAST(n.body, frame, depth, out, esc, textOfFn, truthyFn, tpl);
        }
        break;
      }
      case 'include': {
        const t = tpl.get(n.name);
        if (t !== undefined && depth < INCLUDE_DEPTH) t(scope, depth + 1, out, esc, textOfFn, truthyFn, tpl);
        break;
      }
    }
  }
}

/**
 * Compile `nodes` into a function (S, D, o, esc, textOf, truthy, tpl): S is the
 * null-prototype scope chain (a first name reads off the nearest frame that
 * binds it, exactly as the scope walk does), D the include depth, o the output
 * pieces, and the rest the runtime helpers. Falls back to the tree walker when
 * the generated code cannot be built.
 */
function compileNodes(nodes) {
  let uid = 0;
  const code = [];
  const tmp = () => `_t${uid++}`;
  const lookup = (path, scope, into) => {
    code.push(`${into}=${scope}[${JSON.stringify(path[0])}];`);
    for (let k = 1; k < path.length; k++) {
      const seg = JSON.stringify(path[k]);
      code.push(`${into}=${into}!==null&&typeof ${into}==="object"&&Object.hasOwn(${into},${seg})?${into}[${seg}]:void 0;`);
    }
  };
  const gen = (list, scope) => {
    for (const n of list) {
      if (n.kind === 'text') {
        code.push(`o.push(${JSON.stringify(n.text)});`);
        continue;
      }
      if (n.kind === 'var' || n.kind === 'raw') {
        const v = tmp();
        code.push(`let ${v};`);
        lookup(n.path, scope, v);
        code.push(n.kind === 'var' ? `o.push(esc(textOf(${v})));` : `o.push(textOf(${v}));`);
        continue;
      }
      if (n.kind === 'if') {
        const v = tmp();
        code.push(`let ${v};`);
        lookup(n.path, scope, v);
        code.push(`if(${n.not ? '!' : ''}truthy(${v})){`);
        gen(n.then, scope);
        if (n.else !== null) {
          code.push('}else{');
          gen(n.else, scope);
        }
        code.push('}');
        continue;
      }
      if (n.kind === 'for') {
        const xs = tmp();
        const k = tmp();
        const s = tmp();
        code.push(`{let ${xs};`);
        lookup(n.path, scope, xs);
        code.push(`if(Array.isArray(${xs})){for(let ${k}=0;${k}<${xs}.length;${k}++){const ${s}=Object.create(${scope});${s}[${JSON.stringify(n.name)}]=${xs}[${k}];${s}.loop={index:${k}+1,first:${k}===0,last:${k}===${xs}.length-1,length:${xs}.length};`);
        gen(n.body, s);
        code.push(`}}}`);
        continue;
      }
      if (n.kind === 'include') {
        const t = tmp();
        code.push(`{const ${t}=tpl.get(${JSON.stringify(n.name)});if(${t}!==void 0&&D<8)${t}(${scope},D+1,o,esc,textOf,truthy,tpl);}`);
        continue;
      }
    }
  };
  gen(nodes, 'S');
  return new Function('S', 'D', 'o', 'esc', 'textOf', 'truthy', 'tpl', code.join('\n'));
}

/** A template's renderer: its compiled function, or the tree walker on failure. */
function makeRenderer(nodes) {
  try {
    return compileNodes(nodes);
  } catch {
    return (S, D, o, esc, textOfFn, truthyFn, tpl) => renderAST(nodes, S, D, o, esc, textOfFn, truthyFn, tpl);
  }
}

// ---------------------------------------------------------------- the build

/** The top-level directories the generator writes itself, which no page's slug at the root may take. */
export const RESERVED = Object.freeze(['posts', 'tags', 'page']);

/** The report file every build writes. */
export const REPORT_FILE = 'build-report.txt';

/** Whether `t` holds a scheme (https:, mailto: ...). */
function hasScheme(t) {
  const c0 = t.charCodeAt(0);
  if (!((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122))) return false;
  for (let i = 1; i < t.length; i++) {
    const c = t.charCodeAt(i);
    if (c === 58) return true;
    if (!((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 43 || c === 45 || c === 46)) return false;
  }
  return false;
}

/** A link's href for `target`, from the source directory `dir`; null when it names neither a page nor a static file. */
function resolveLink(target, dir, bySource, staticPaths, base) {
  if (hasScheme(target) || target.startsWith('/') || target.startsWith('#')) return target;
  const hash = target.indexOf('#');
  const rel = hash === -1 ? target : target.slice(0, hash);
  const frag = hash === -1 ? '' : target.slice(hash);
  const path = rel === '' ? null : resolvePath(dir, rel);
  if (path !== null) {
    const url = bySource.get(path);
    if (url !== undefined) return `${url}${frag}`;
    if (staticPaths.has(path)) return `${base}/${path}${frag}`;
  }
  return null;
}

/** A page's link record as templates read it. */
const linkOf = (s) =>
  s === null
    ? null
    : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) };

/** A post's card, as lists show it. */
function cardOf(s) {
  return {
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  };
}

/** A page as its layout reads it. */
function pageOf(s) {
  const c = s.card;
  return {
    title: c.title,
    url: c.url,
    date: c.date,
    date_long: c.date_long,
    summary: c.summary,
    excerpt: c.excerpt,
    reading_minutes: c.reading_minutes,
    tags: c.tags,
    slug: s.slug,
    content: s.html,
    toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
    newer: linkOf(s.newer ?? null),
    older: linkOf(s.older ?? null),
    is_post: s.post,
  };
}

/** One site's output tree: path -> text. */
export function run(input) {
  const slugCache = new Map();
  const templates = new Map();
  const report = [];
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      templates.set(name, makeRenderer(parseTemplate(name, input.templates[name])));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  let base = input.site.base_url;
  let be = base.length;
  while (be > 0 && base.charCodeAt(be - 1) === 47) be--;
  base = base.slice(0, be);

  // 1. The sources, in code-unit order of their paths, line ends made "\n".
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  const allSources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) {
      allSources.push({ path: f.path, text: f.content.indexOf('\r') === -1 ? f.content : f.content.replace(/\r\n?/g, '\n') });
    } else statics.push({ path: f.path, content: f.content });
  }

  // 2. Each source's front matter, in the checks' order.
  const sources = [];
  for (const s of allSources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    const own = s.path.startsWith('tags/') ? 'tags' : s.path.startsWith('page/') ? 'page' : undefined;
    if (own !== undefined) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    sources.push(s);
  }

  // 3. Each page's output directory and url: its slug made unique in its directory, in source order.
  const bySource = new Map();
  const taken = new Map();
  for (const s of sources) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, set);
    }
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title, slugCache), set);
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s.url);
  }

  // 4. Each body's Markdown, its links resolved to the pages and static files they name.
  const staticPaths = new Set(statics.map((f) => f.path));
  const broken = new Set();
  const linkCache = new Map();
  for (const s of sources) {
    const dir = dirOf(s.path);
    let memo = linkCache.get(dir);
    if (memo === undefined) {
      memo = new Map();
      linkCache.set(dir, memo);
    }
    const link = (target) => {
      // Valid resolutions are memoised per directory; a broken link is
      // recorded for every source that holds it, so it is never memoised
      // as resolved (a null entry means broken, and still records this source).
      let href = memo.get(target);
      if (href === undefined) {
        href = resolveLink(target, dir, bySource, staticPaths, base);
        memo.set(target, href);
      }
      if (href === null) {
        broken.add(`broken-link ${s.path} -> ${target}`);
        return target;
      }
      return href;
    };
    const md = renderMarkdown(s.body, link, slugCache);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // 5. The posts, newest first and then by slug; each post's newer and older neighbours.
  const posts = sources.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // 6. The tags: grouped by their slug, each named as first met in the posts' order, ordered by count and then slug.
  const bySlug = new Map();
  for (const p of posts) {
    p.tagRefs = [];
    const seen = new Set();
    for (const name of p.data.tags ?? []) {
      const slug = slugify(name, slugCache);
      if (seen.has(slug)) continue;
      seen.add(slug);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of sources) {
    if (s.post) continue;
    s.tagRefs = [];
    const seen = new Set();
    for (const name of s.data.tags ?? []) {
      const slug = slugify(name, slugCache);
      if (seen.has(slug)) continue;
      seen.add(slug);
      s.tagRefs.push(bySlug.get(slug) ?? { name, slug, url: '', posts: [] });
    }
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // 7. Every page through its layout, the index pages and the tag pages through theirs.
  for (const s of sources) s.card = cardOf(s);
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => p.card);
  const output = {};
  const render = (name, vars) => {
    const fn = templates.get(name);
    if (fn === undefined) return null;
    const scope = Object.create(null);
    scope.site = site;
    scope.tags = allTags;
    scope.recent = recent;
    Object.assign(scope, vars);
    const o = [];
    fn(scope, 0, o, escapeHtml, textOf, truthy, templates);
    return o.join('');
  };
  for (const s of sources) output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s) });
  const per = input.site.per_page;
  const nIndex = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= nIndex; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => p.card),
      pager: { number: k, total: nIndex, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === nIndex ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    const html = render('tag', { tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => p.card) } });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // 8. The report: every refusal, draft, broken link and template that did not parse, sorted, then the counts.
  const lines = [...report, ...broken].sort(byCodeUnits);
  const nPages = sources.filter((s) => !s.post).length;
  lines.push(`built ${nPages} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output[REPORT_FILE] = `${lines.join('\n')}\n`;
  return output;
}
