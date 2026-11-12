(() => {
'use strict';

/* =========================================================
   Setup
   ========================================================= */
const $ = (id) => document.getElementById(id);
const input = $('input');
const gutter = $('gutter');
const output = $('output');
const searchBox = $('search');

const HL_LIMIT = 1500000;   // skip syntax colouring above this many chars
const MAX_HITS = 5000;      // text search cap
const TREE_BATCH = 300;     // tree children rendered per batch
const GRID_MAX = 2000;      // grid rows rendered at once
const STORE_KEY = 'jxw.v1';

const state = {
  mode: 'auto',
  tab: 'text',
  outText: '',
  outType: '',
  lastAction: null,
  analysis: null,
  lines: 0,
  hits: [],
  hitIdx: -1,
  treeFor: null,
  gridFor: null,
  tables: [],
  grid: null,
  gridSort: { col: null, dir: 1 },
  selectedPath: '',
  gridMode: 'nested',
  ng: { for: null, reg: [], cells: 0 }
};

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
const enc = new TextEncoder();
const byteLen = (s) => enc.encode(s).length;

function fmtBytes(n) {
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1048576).toFixed(2) + ' MB';
}
function lineCol(src, pos) {
  let line = 1, last = -1;
  for (let i = 0; i < pos && i < src.length; i++) {
    if (src.charCodeAt(i) === 10) { line++; last = i; }
  }
  return { line, col: pos - last };
}
function posOf(src, line, col) {
  let p = 0;
  for (let l = 1; l < line; l++) {
    const nx = src.indexOf('\n', p);
    if (nx < 0) break;
    p = nx + 1;
  }
  return Math.min(src.length, p + Math.max((col || 1) - 1, 0));
}
function indentStr() {
  const v = $('indent').value;
  return v === 'tab' ? '\t' : ' '.repeat(+v);
}

/* =========================================================
   JSON: strict parser with line/col errors.
   Objects become Map (keeps key order, even numeric keys).
   Numbers stay as their original text (class N), so big IDs
   like 9007199254740993 never lose precision.
   ========================================================= */
class N { constructor(r) { this.r = r; } }

function parseJSON(src) {
  let i = src.charCodeAt(0) === 0xFEFF ? 1 : 0;
  const n = src.length;
  const warnings = [];
  const NUM = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;

  const fail = (msg, p = i) => { const e = new Error(msg); e.pos = p; throw e; };
  const show = (c) => (c === undefined ? 'end of input' : `'${c}'`);
  const ws = () => {
    while (i < n) {
      const c = src.charCodeAt(i);
      if (c === 32 || c === 9 || c === 10 || c === 13) i++; else break;
    }
  };

  function value() {
    ws();
    if (i >= n) fail('Unexpected end of input, expected a value');
    const c = src[i];
    if (c === '{') return obj();
    if (c === '[') return arr();
    if (c === '"') return str();
    if (c === '-' || (c >= '0' && c <= '9')) return num();
    if (src.startsWith('true', i)) { i += 4; return true; }
    if (src.startsWith('false', i)) { i += 5; return false; }
    if (src.startsWith('null', i)) { i += 4; return null; }
    if (c === "'") fail('Strings must use double quotes, not single quotes');
    if (c === '/') fail('Comments are not allowed in JSON');
    fail(`Unexpected character ${show(c)}`);
  }

  function obj() {
    i++;
    const m = new Map();
    ws();
    if (src[i] === '}') { i++; return m; }
    for (;;) {
      ws();
      if (src[i] !== '"') {
        if (src[i] === '}') fail('Trailing comma before }');
        if (i >= n) fail('Unexpected end of input, object is not closed');
        fail('Expected a property name in double quotes');
      }
      const kp = i;
      const k = str();
      ws();
      if (src[i] !== ':') fail(`Expected ':' after property name, found ${show(src[i])}`);
      i++;
      const v = value();
      if (m.has(k)) warnings.push({ msg: `Duplicate key "${k}"`, pos: kp });
      m.set(k, v);
      ws();
      if (src[i] === ',') { i++; continue; }
      if (src[i] === '}') { i++; return m; }
      if (i >= n) fail('Unexpected end of input, object is not closed');
      fail(`Expected ',' or '}' after property value, found ${show(src[i])}`);
    }
  }

  function arr() {
    i++;
    const a = [];
    ws();
    if (src[i] === ']') { i++; return a; }
    for (;;) {
      ws();
      if (src[i] === ']') fail('Trailing comma before ]');
      a.push(value());
      ws();
      if (src[i] === ',') { i++; continue; }
      if (src[i] === ']') { i++; return a; }
      if (i >= n) fail('Unexpected end of input, array is not closed');
      fail(`Expected ',' or ']' after array item, found ${show(src[i])}`);
    }
  }

  function str() {
    const s = i;
    let hasEsc = false;
    i++;
    for (;;) {
      if (i >= n) fail('Unterminated string', s);
      const c = src.charCodeAt(i);
      if (c === 34) { i++; break; }
      if (c === 92) {
        hasEsc = true;
        const e = src[i + 1];
        if (e !== undefined && '"\\/bfnrt'.includes(e)) i += 2;
        else if (e === 'u' && /^[0-9a-fA-F]{4}$/.test(src.substr(i + 2, 4))) i += 6;
        else fail('Invalid escape sequence in string');
        continue;
      }
      if (c < 32) fail('Raw control character in string (use \\n, \\t and so on)');
      i++;
    }
    return hasEsc ? JSON.parse(src.slice(s, i)) : src.slice(s + 1, i - 1);
  }

  function num() {
    NUM.lastIndex = i;
    const m = NUM.exec(src);
    if (!m || m[0] === '-') fail('Invalid number');
    const nx = src[i + m[0].length];
    if (nx !== undefined && /[0-9.eE]/.test(nx)) fail('Invalid number format (leading zeros or a malformed decimal)');
    i += m[0].length;
    return new N(m[0]);
  }

  const v = value();
  ws();
  if (i < n) fail('Unexpected content after the end of the JSON value');
  return { value: v, warnings };
}

// 1.500 -> 1.5, 2.0 -> 2, 1.0e+05 -> 1e5. Pure text edit, no precision loss.
function compactNum(r) {
  const m = r.match(/^(-?\d+)(?:\.(\d+))?(?:[eE]([+-]?)(\d+))?$/);
  if (!m) return r;
  const frac = (m[2] || '').replace(/0+$/, '');
  let s = m[1] + (frac ? '.' + frac : '');
  if (m[4] !== undefined) {
    const exp = m[4].replace(/^0+/, '');
    if (exp) s += 'e' + (m[3] === '-' ? '-' : '') + exp;
  }
  return s;
}

function stringifyJSON(v, ind, sort, cnum, d = 0) {
  if (v === null) return 'null';
  if (v === true || v === false) return String(v);
  if (typeof v === 'string') return JSON.stringify(v);
  if (v instanceof N) return cnum ? compactNum(v.r) : v.r;
  const pad = ind ? '\n' + ind.repeat(d + 1) : '';
  const end = ind ? '\n' + ind.repeat(d) : '';
  if (Array.isArray(v)) {
    if (!v.length) return '[]';
    return '[' + v.map((x) => pad + stringifyJSON(x, ind, sort, cnum, d + 1)).join(',') + end + ']';
  }
  const keys = [...v.keys()];
  if (!keys.length) return '{}';
  if (sort) keys.sort();
  const sep = ind ? ': ' : ':';
  return '{' + keys.map((k) => pad + JSON.stringify(k) + sep + stringifyJSON(v.get(k), ind, sort, cnum, d + 1)).join(',') + end + '}';
}

/* =========================================================
   XML
   ========================================================= */
const XML_TOK = /<!\[CDATA\[[\s\S]*?\]\]>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!DOCTYPE(?:[^>\[]|\[[\s\S]*?\])*>|<(?:"[^"]*"|'[^']*'|[^'">])*>|[^<]+|</gi;

const isOpenTag = (t) => /^<[^!?\/]/.test(t) && !/\/>$/.test(t);
const tagName = (t) => (t.match(/^<\/?([^\s\/>]+)/) || [])[1] || '';

function parseXML(src) {
  const doc = new DOMParser().parseFromString(src.replace(/^\uFEFF/, ''), 'application/xml');
  const pe = doc.getElementsByTagNameNS('*', 'parsererror')[0] || doc.getElementsByTagName('parsererror')[0];
  if (pe) {
    const txt = pe.textContent || '';
    const lm = txt.match(/line(?: number)?\s*(\d+)/i);
    const cm = txt.match(/column\s*(\d+)/i);
    const div = pe.querySelector && pe.querySelector('div');
    const raw = div ? div.textContent : txt.split('\n')[0];
    const msg = raw
      .replace(/^error on line \d+ at column \d+:\s*/i, '')
      .replace(/^XML Parsing Error:\s*/i, '')
      .trim();
    const short = msg.match(/^(\d+):(\d+):\s*([\s\S]*)$/);
    const e = new Error((short ? short[3] : msg) || 'Invalid XML');
    if (lm) { e.line = +lm[1]; e.col = cm ? +cm[1] : 1; }
    else if (short) { e.line = +short[1]; e.col = +short[2]; }
    throw e;
  }
  return doc;
}

function fmtXml(src, ind) {
  const toks = src.replace(/^\uFEFF/, '').match(XML_TOK) || [];
  const out = [];
  let d = 0;
  for (let k = 0; k < toks.length; k++) {
    const t = toks[k];
    if (t[0] !== '<' || t === '<') {
      const tt = t.trim();
      if (tt) out.push(ind.repeat(d) + tt);
      continue;
    }
    if (t.startsWith('</')) {
      d = Math.max(d - 1, 0);
      out.push(ind.repeat(d) + t);
      continue;
    }
    if (isOpenTag(t)) {
      const a = toks[k + 1], b = toks[k + 2];
      if (a !== undefined && a.startsWith('</')) {             // <a></a>
        out.push(ind.repeat(d) + t + a); k += 1; continue;
      }
      if (a !== undefined && a[0] !== '<' && b !== undefined && b.startsWith('</')) {  // <a>text</a>
        out.push(ind.repeat(d) + t + a.trim() + b); k += 2; continue;
      }
      out.push(ind.repeat(d) + t);
      d++;
      continue;
    }
    out.push(ind.repeat(d) + t);   // self-closing, comment, PI, CDATA, doctype
  }
  return out.join('\n');
}

// Collapse whitespace inside a tag, leave quoted attribute values alone.
function squeezeTag(t) {
  return t
    .replace(/("[^"]*"|'[^']*')|\s*=\s*|\s+/g, (m, q) => (q !== undefined ? q : m.includes('=') ? '=' : ' '))
    .replace(/\s+(\/?>)$/, '$1');
}

function minXml(src, aggr) {
  const toks = src.replace(/^\uFEFF/, '').match(XML_TOK) || [];
  const out = [];
  for (let k = 0; k < toks.length; k++) {
    let t = toks[k];
    if (t[0] !== '<' || t === '<') {
      if (!t.trim()) continue;                     // whitespace between tags
      out.push(aggr ? t.replace(/\s+/g, ' ') : t);
      continue;
    }
    if (t.startsWith('<!--')) { if (!aggr) out.push(t); continue; }
    if (t.startsWith('<!') || t.startsWith('<?')) { out.push(t); continue; }
    t = squeezeTag(t);
    if (aggr && isOpenTag(t)) {
      let nx = k + 1;
      while (nx < toks.length && toks[nx][0] !== '<' && !toks[nx].trim()) nx++;
      if (nx < toks.length && squeezeTag(toks[nx]) === `</${tagName(t)}>`) {
        out.push(t.slice(0, -1) + '/>');
        k = nx;
        continue;
      }
    }
    out.push(t);
  }
  return out.join('');
}

// XML element -> Map. Attributes as "@name", text as "#text", repeated children as arrays.
function xmlToObj(el) {
  const m = new Map();
  for (const a of el.attributes) m.set('@' + a.name, a.value);
  let text = '';
  for (const c of el.childNodes) {
    if (c.nodeType === 1) {
      const v = xmlToObj(c);
      const k = c.nodeName;
      if (m.has(k)) {
        const ex = m.get(k);
        if (Array.isArray(ex) && ex.multi) ex.push(v);
        else { const arr = [ex, v]; arr.multi = true; m.set(k, arr); }
      } else m.set(k, v);
    } else if (c.nodeType === 3 || c.nodeType === 4) {
      text += c.nodeValue;
    }
  }
  text = text.trim();
  if (m.size === 0) return text === '' ? null : text;
  if (text) m.set('#text', text);
  return m;
}

const escXml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const leafStr = (v) => (v instanceof N ? v.r : v === null ? '' : String(v));
function safeName(k) {
  let s = String(k).replace(/[^\w.:-]/g, '_');
  if (!/^[A-Za-z_]/.test(s)) s = '_' + s;
  return s;
}

function toXml(v, name, ind, d) {
  const p = ind.repeat(d);
  const nl = ind ? '\n' : '';
  name = safeName(name);
  if (Array.isArray(v)) return v.map((x) => toXml(x, name, ind, d)).filter(Boolean).join(nl);
  if (v instanceof Map) {
    let attrs = '';
    let text = null;
    const kids = [];
    for (const [k, x] of v) {
      const scalar = !(x instanceof Map) && !Array.isArray(x);
      if (k.startsWith('@') && k.length > 1 && scalar) attrs += ` ${safeName(k.slice(1))}="${escXml(leafStr(x))}"`;
      else if (k === '#text' && scalar) text = leafStr(x);
      else {
        const s = toXml(x, k, ind, d + 1);
        if (s) kids.push(s);
      }
    }
    if (!kids.length && text === null) return `${p}<${name}${attrs}/>`;
    if (!kids.length) return `${p}<${name}${attrs}>${escXml(text)}</${name}>`;
    if (text !== null) kids.unshift(ind.repeat(d + 1) + escXml(text));
    return `${p}<${name}${attrs}>${nl}${kids.join(nl)}${nl}${p}</${name}>`;
  }
  if (v === null) return `${p}<${name}/>`;
  return `${p}<${name}>${escXml(leafStr(v))}</${name}>`;
}

function jsonToXml(v, ind) {
  const nl = ind ? '\n' : '';
  let body;
  if (Array.isArray(v)) {
    body = `<root>${nl}${toXml(v, 'item', ind, 1)}${nl}</root>`;
  } else if (v instanceof Map && v.size === 1 && !Array.isArray([...v.values()][0]) && !String([...v.keys()][0]).startsWith('@')) {
    const [k, x] = [...v][0];
    body = toXml(x, k, ind, 0);
  } else {
    body = toXml(v, 'root', ind, 0);
  }
  return '<?xml version="1.0" encoding="UTF-8"?>' + nl + body;
}

/* =========================================================
   Analysis (cached per input + mode)
   ========================================================= */
function detect(src) {
  if (state.mode !== 'auto') return src.trim() ? state.mode : '';
  const t = src.trimStart();
  if (!t) return '';
  return t[0] === '<' ? 'xml' : 'json';
}

function analyze() {
  const src = input.value;
  const c = state.analysis;
  if (c && c.src === src && c.mode === state.mode) return c;
  const a = { src, mode: state.mode, type: detect(src), ok: false, warnings: [] };
  if (a.type === 'json') {
    try {
      const r = parseJSON(src);
      a.value = r.value;
      a.warnings = r.warnings;
      a.ok = true;
    } catch (e) {
      const pos = typeof e.pos === 'number' ? e.pos : null;
      a.error = { msg: e.message, pos };
      if (pos !== null) Object.assign(a.error, lineCol(src, pos));
    }
  } else if (a.type === 'xml') {
    try {
      a.doc = parseXML(src);
      a.ok = true;
    } catch (e) {
      a.error = { msg: e.message, line: e.line, col: e.col, pos: null };
      if (e.line) a.error.pos = posOf(src, e.line, e.col);
    }
  }
  state.analysis = a;
  return a;
}

function rootValue(a) {
  if (a.type === 'json') return a.value;
  if (!a.obj) {
    const r = a.doc.documentElement;
    a.obj = new Map([[r.nodeName, xmlToObj(r)]]);
  }
  return a.obj;
}

/* =========================================================
   Status bar
   ========================================================= */
let toastTimer;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.textContent = ''; }, 2600);
}

function gotoPos(pos, line) {
  input.focus();
  input.setSelectionRange(pos, Math.min(pos + 1, input.value.length));
  const lh = parseFloat(getComputedStyle(input).lineHeight) || 20;
  input.scrollTop = Math.max(0, (line - 1) * lh - input.clientHeight / 3);
  gutter.scrollTop = input.scrollTop;
}

function updateStatus() {
  const a = analyze();
  const v = $('valid');
  $('detected').textContent = a.type ? a.type.toUpperCase() : '';
  $('btnConvert').textContent = a.type === 'xml' ? 'Convert to JSON' : 'Convert to XML';
  $('sortWrap').classList.toggle('dim', a.type === 'xml');

  v.className = 'state';
  v.textContent = '';
  if (!a.type) {
    v.textContent = 'Waiting for input';
  } else if (a.ok) {
    v.classList.add('ok');
    let t = `Valid ${a.type.toUpperCase()}`;
    if (a.warnings.length) {
      const w = a.warnings[0];
      const lc = lineCol(a.src, w.pos);
      const more = a.warnings.length > 1 ? ` (+${a.warnings.length - 1} more)` : '';
      t += `, warning on line ${lc.line}: ${w.msg}${more}`;
    }
    v.textContent = t;
  } else {
    v.classList.add('bad');
    const loc = a.error.line ? `Line ${a.error.line}, col ${a.error.col}: ` : '';
    v.textContent = `Invalid ${a.type.toUpperCase()}. ${loc}${a.error.msg}`;
    if (a.error.pos !== null && a.error.pos !== undefined) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'link';
      b.textContent = 'Go to error';
      b.addEventListener('click', () => gotoPos(a.error.pos, a.error.line));
      v.append(' ', b);
    }
  }

  const inB = byteLen(a.src);
  $('inSize').textContent = inB ? `Input ${fmtBytes(inB)}` : '';
  const bar = $('meterBar');
  if (state.outText && inB) {
    const outB = byteLen(state.outText);
    const diff = Math.round((1 - outB / inB) * 1000) / 10;
    let s = `Output ${fmtBytes(outB)}`;
    if (diff > 0) s += `, ${diff}% smaller`;
    else if (diff < 0) s += `, ${-diff}% larger`;
    $('outSize').textContent = s;
    bar.style.width = Math.min(100, (outB / inB) * 100) + '%';
    bar.classList.toggle('grow', outB > inB);
  } else {
    $('outSize').textContent = '';
    bar.style.width = '0';
  }
}

/* =========================================================
   Gutter
   ========================================================= */
function updateGutter() {
  const v = input.value;
  let count = 1;
  for (let i = v.indexOf('\n'); i !== -1; i = v.indexOf('\n', i + 1)) count++;
  if (count !== state.lines) {
    state.lines = count;
    const shown = Math.min(count, 200000);
    let s = '';
    for (let i = 1; i <= shown; i++) s += i + '\n';
    gutter.textContent = s;
  }
  gutter.scrollTop = input.scrollTop;
}

/* =========================================================
   Output text view (highlighting + search)
   ========================================================= */
const JSON_HL = /("(?:[^"\\\n]|\\.)*")(\s*:)?|\btrue\b|\bfalse\b|\bnull\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g;

function hlJSON(s) {
  let out = '', last = 0;
  for (const m of s.matchAll(JSON_HL)) {
    out += esc(s.slice(last, m.index));
    if (m[1] !== undefined && m[2] !== undefined) {
      out += `<span class="k">${esc(m[1])}</span>${esc(m[2])}`;
    } else {
      const w = m[0];
      const cls = m[1] !== undefined ? 's' : (w === 'true' || w === 'false' || w === 'null') ? 'b' : 'd';
      out += `<span class="${cls}">${esc(w)}</span>`;
    }
    last = m.index + m[0].length;
  }
  return out + esc(s.slice(last));
}

function hlTag(t) {
  const m = t.match(/^(<\/?)([^\s\/>]+)([\s\S]*?)(\/?>)$/);
  if (!m) return esc(t);
  const re = /([^\s=]+)(\s*=\s*)("[^"]*"|'[^']*')/g;
  let attrs = '', last = 0, x;
  while ((x = re.exec(m[3]))) {
    attrs += esc(m[3].slice(last, x.index)) + `<span class="a">${esc(x[1])}</span>${esc(x[2])}<span class="s">${esc(x[3])}</span>`;
    last = re.lastIndex;
  }
  attrs += esc(m[3].slice(last));
  return `<span class="p">${esc(m[1])}</span><span class="t">${esc(m[2])}</span>${attrs}<span class="p">${esc(m[4])}</span>`;
}

function hlXML(s) {
  const toks = s.match(XML_TOK) || [];
  let out = '';
  for (const t of toks) {
    if (t[0] !== '<' || t === '<') out += esc(t);
    else if (t.startsWith('<!--') || t.startsWith('<?') || t.startsWith('<!D') || t.startsWith('<!d')) out += `<span class="c">${esc(t)}</span>`;
    else if (t.startsWith('<![CDATA[')) out += `<span class="s">${esc(t)}</span>`;
    else out += hlTag(t);
  }
  return out;
}

function renderText() {
  const t = state.outText;
  const q = state.tab === 'text' ? searchBox.value : '';
  if (!t) { output.innerHTML = ''; state.hits = []; updateHitCount(); return; }
  if (q) { renderSearchMarks(t, q); return; }
  state.hits = [];
  state.hitIdx = -1;
  updateHitCount();
  if (t.length > HL_LIMIT) { output.textContent = t; return; }
  output.innerHTML = state.outType === 'json' ? hlJSON(t) : state.outType === 'xml' ? hlXML(t) : esc(t);
}

function renderSearchMarks(t, q) {
  const lt = t.toLowerCase();
  const lq = q.toLowerCase();
  let out = '', last = 0, count = 0;
  let idx = lt.indexOf(lq);
  while (idx >= 0 && count < MAX_HITS) {
    out += esc(t.slice(last, idx)) + `<mark>${esc(t.slice(idx, idx + q.length))}</mark>`;
    last = idx + q.length;
    count++;
    idx = lt.indexOf(lq, last);
  }
  out += esc(t.slice(last));
  output.innerHTML = out;
  state.hits = [...output.querySelectorAll('mark')];
  state.hitIdx = state.hits.length ? 0 : -1;
  focusHit();
}

function focusHit() {
// OLD CODE
//   output.querySelectorAll('mark.cur').forEach((m) => m.classList.remove('cur'));
// END OLD CODE
  document.querySelectorAll('mark.cur, .ng-hit.cur').forEach((m) => m.classList.remove('cur'));
  const m = state.hits[state.hitIdx];
  if (m) {
    m.classList.add('cur');
    m.scrollIntoView({ block: 'center', inline: 'center' });
  }
  updateHitCount();
}

function stepHit(dir) {
  if (!state.hits.length) return;
  state.hitIdx = (state.hitIdx + dir + state.hits.length) % state.hits.length;
  focusHit();
}

function updateHitCount() {
  const el = $('searchCount');
// OLD CODE
//   if (state.tab !== 'text' || !searchBox.value) { el.textContent = ''; return; }
// END OLD CODE
  if (!hitsMode() || !searchBox.value) { el.textContent = ''; return; }
  const n = state.hits.length;
  if (!n) { el.textContent = 'No matches'; return; }
  el.textContent = `${state.hitIdx + 1} of ${n}${n >= MAX_HITS ? '+' : ''}`;
}

/* =========================================================
   Tree view
   ========================================================= */
function childPath(path, k) {
  if (typeof k === 'number') return `${path}[${k}]`;
  return /^[A-Za-z_$][\w$]*$/.test(k) ? `${path}.${k}` : `${path}[${JSON.stringify(k)}]`;
}

function leafHTML(v) {
  if (v === null) return '<span class="b">null</span>';
  if (v === true || v === false) return `<span class="b">${v}</span>`;
  if (v instanceof N) return `<span class="d">${esc(v.r)}</span>`;
  return `<span class="s">${esc(JSON.stringify(v))}</span>`;
}

function treeNode(key, v, path, open) {
  const isArr = Array.isArray(v);
  const keyHTML = key !== null ? `<span class="k">${esc(String(key))}</span>` : '';
  if (isArr || v instanceof Map) {
    const det = document.createElement('details');
    const sum = document.createElement('summary');
    const n = isArr ? v.length : v.size;
    sum.innerHTML = `${keyHTML}${key !== null ? ' ' : ''}<span class="meta">${isArr ? `[${n}]` : `{${n}}`}</span>`;
    sum.dataset.path = path;
    det.appendChild(sum);
    let built = false;
    const build = () => {
      if (built) return;
      built = true;
      const box = document.createElement('div');
      box.className = 'kids';
      const entries = isArr ? [...v.entries()] : [...v];
      const more = document.createElement('button');
      more.type = 'button';
      more.className = 'link more';
      box.appendChild(more);
      let shown = 0;
      const add = () => {
        const end = Math.min(entries.length, shown + TREE_BATCH);
        const frag = document.createDocumentFragment();
        for (; shown < end; shown++) {
          const [k, x] = entries[shown];
          frag.appendChild(treeNode(k, x, childPath(path, k), false));
        }
        box.insertBefore(frag, more);
        if (shown >= entries.length) more.remove();
        else more.textContent = `Show ${Math.min(TREE_BATCH, entries.length - shown)} more (${entries.length - shown} left)`;
      };
      more.addEventListener('click', add);
      add();
      det.appendChild(box);
    };
    det.addEventListener('toggle', () => { if (det.open) build(); });
    if (open) { det.open = true; build(); }
    return det;
  }
  const row = document.createElement('div');
  row.className = 'leaf';
  row.dataset.path = path;
  row.innerHTML = (keyHTML ? keyHTML + ': ' : '') + leafHTML(v);
  return row;
}

function renderTree() {
  const a = analyze();
  const tree = $('tree');
  if (state.treeFor === a) { renderTreeHits(); return; }
  state.treeFor = a;
  tree.innerHTML = '';
  $('pathBar').hidden = true;
  if (!a.ok) {
    tree.innerHTML = `<p class="empty">${a.type ? 'Fix the input error to see the tree.' : 'Paste JSON or XML on the left to see it as a tree.'}</p>`;
    renderTreeHits();
    return;
  }
  tree.appendChild(treeNode(null, rootValue(a), '$', true));
  renderTreeHits();
}

function findInTree(root, q, limit) {
  const res = [];
  (function go(v, path, key) {
    if (res.length >= limit) return;
    const keyHit = key !== null && String(key).toLowerCase().includes(q);
    if (Array.isArray(v) || v instanceof Map) {
      if (keyHit) res.push({ path, text: Array.isArray(v) ? `[${v.length}]` : `{${v.size}}` });
      for (const [k, x] of v.entries()) {
        go(x, childPath(path, k), k);
        if (res.length >= limit) return;
      }
    } else {
      const t = cellText(v);
      if (keyHit || t.toLowerCase().includes(q)) res.push({ path, text: t });
    }
  })(root, '$', null);
  return res;
}

function renderTreeHits() {
  const box = $('treeHits');
  const q = state.tab === 'tree' ? searchBox.value.trim().toLowerCase() : '';
  const a = analyze();
  if (!q || !a.ok) { box.hidden = true; box.innerHTML = ''; return; }
  const LIMIT = 300;
  const res = findInTree(rootValue(a), q, LIMIT);
  box.hidden = false;
  const note = !res.length ? 'No keys or values match.'
    : res.length >= LIMIT ? `First ${LIMIT} matches. Click one to select its path.`
    : `${res.length} match${res.length === 1 ? '' : 'es'}. Click one to select its path.`;
  box.innerHTML = `<div class="hits-note">${note}</div>` + res.map((r) =>
    `<button type="button" class="hit" data-path="${esc(r.path)}"><span class="hp">${esc(r.path)}</span><span class="hv">${esc(r.text)}</span></button>`
  ).join('');
}

// OLD CODE
// function showPath(path) {
//   state.selectedPath = path;
//   $('pathText').textContent = path;
//   $('pathBar').hidden = false;
// }
// END OLD CODE
function showPath(path) {
  state.selectedPath = path;
  if (state.tab === 'grid') {
    $('gridPathText').textContent = path;
    $('gridPath').hidden = false;
  } else {
    $('pathText').textContent = path;
    $('pathBar').hidden = false;
  }
}

/* =========================================================
   Grid view
   ========================================================= */
function cellText(v) {
  if (v === null) return 'null';
  if (v === undefined) return '';
  if (v instanceof N) return v.r;
  if (Array.isArray(v)) {
    if (v.every((x) => !(x instanceof Map) && !Array.isArray(x))) return v.map(cellText).join(', ');
    return stringifyJSON(v, '', false, false);
  }
  if (v instanceof Map) return stringifyJSON(v, '', false, false);
  return String(v);
}

function collectTables(v, path, out, depth) {
  if (out.length >= 40 || depth > 8) return;
  if (Array.isArray(v)) {
    if (v.length) out.push({ path, rows: v });
    const fi = v.findIndex((x) => x instanceof Map || Array.isArray(x));
    if (fi >= 0) collectTables(v[fi], childPath(path, fi), out, depth + 1);
  } else if (v instanceof Map) {
    for (const [k, x] of v) {
      if (x instanceof Map || Array.isArray(x)) collectTables(x, childPath(path, k), out, depth + 1);
    }
  }
}

function tablesFor(root) {
  const out = [];
  collectTables(root, '$', out, 0);
  out.sort((a, b) => b.rows.length - a.rows.length);
  if (!out.length || root instanceof Map) out.push({ path: '$', rows: [root] });
  return out;
}

function flatten(v, prefix, out, d) {
  if (v instanceof Map && v.size && d < 4) {
    for (const [k, x] of v) flatten(x, prefix ? `${prefix}.${k}` : k, out, d + 1);
  } else {
    out.set(prefix || 'value', v);
  }
}

function buildGrid(rows) {
  const cols = new Set();
  const data = rows.map((r) => {
    const m = new Map();
    flatten(r, '', m, 0);
    for (const k of m.keys()) cols.add(k);
    return m;
  });
  const colList = [...cols];
  const text = data.map((m) => colList.map((c) => (m.has(c) ? cellText(m.get(c)) : '')).join('\u0001').toLowerCase());
  return { cols: colList, data, text };
}

function cmp(a, b) {
  const ua = a === undefined || a === null;
  const ub = b === undefined || b === null;
  if (ua || ub) return ua === ub ? 0 : ua ? 1 : -1;
  const sa = cellText(a), sb = cellText(b);
  const na = Number(sa), nb = Number(sb);
  if (sa.trim() !== '' && sb.trim() !== '' && !isNaN(na) && !isNaN(nb)) return na - nb;
  return sa.localeCompare(sb, undefined, { numeric: true, sensitivity: 'base' });
}

function gridRows() {
  const g = state.grid;
  const q = state.tab === 'grid' ? searchBox.value.trim().toLowerCase() : '';
  let idx = g.data.map((_, i) => i);
  if (q) idx = idx.filter((i) => g.text[i].includes(q));
  const { col, dir } = state.gridSort;
  if (col !== null) {
    const c = g.cols[col];
    idx.sort((x, y) => dir * cmp(g.data[x].get(c), g.data[y].get(c)));
  }
  return idx;
}

function cellClass(v) {
  if (v === null) return 'nul';
  if (v instanceof N) return 'num';
  if (typeof v === 'boolean') return 'bool';
  if (Array.isArray(v) || v instanceof Map) return 'obj';
  if (typeof v === 'string' && v.trim() !== '' && !isNaN(Number(v))) return 'num';
  return '';
}

function drawGrid() {
  const g = state.grid;
  const table = $('grid');
  const idx = gridRows();
  const { col, dir } = state.gridSort;
  let h = '<thead><tr><th class="rn">#</th>' + g.cols.map((c, i) =>
    `<th><button type="button" data-col="${i}" class="${col === i ? (dir > 0 ? 'asc' : 'desc') : ''}">${esc(c)}</button></th>`
  ).join('') + '</tr></thead><tbody>';
  for (const r of idx.slice(0, GRID_MAX)) {
    const m = g.data[r];
    h += `<tr><td class="rn">${r + 1}</td>`;
    for (const c of g.cols) {
      if (!m.has(c)) { h += '<td></td>'; continue; }
      const v = m.get(c);
      const t = cellText(v);
      h += `<td class="${cellClass(v)}" title="${esc(t.length > 2000 ? t.slice(0, 2000) + '...' : t)}">${esc(t.length > 500 ? t.slice(0, 500) + '...' : t)}</td>`;
    }
    h += '</tr>';
  }
  table.innerHTML = h + '</tbody>';
  const total = g.data.length;
  let note = idx.length === total ? `${total.toLocaleString()} row${total === 1 ? '' : 's'}` : `${idx.length.toLocaleString()} of ${total.toLocaleString()} rows match`;
  note += `, ${g.cols.length} column${g.cols.length === 1 ? '' : 's'}`;
  if (idx.length > GRID_MAX) note += `. Showing the first ${GRID_MAX.toLocaleString()}, search to narrow it down`;
  $('gridCount').textContent = note;
}

function selectTable(i) {
  state.grid = buildGrid(state.tables[i].rows);
  state.gridSort = { col: null, dir: 1 };
  drawGrid();
}

function renderGrid() {
  const a = analyze();
  const sel = $('gridSource');
  if (state.gridFor === a && state.grid) { drawGrid(); return; }
  state.gridFor = a;
  state.grid = null;
  if (!a.ok) {
    sel.innerHTML = '';
    $('grid').innerHTML = '';
    $('gridCount').textContent = a.type ? 'Fix the input error to build a grid.' : 'Paste JSON or XML on the left to see it as a table.';
    return;
  }
  state.tables = tablesFor(rootValue(a));
  sel.innerHTML = state.tables.map((t, i) =>
    `<option value="${i}">${esc(t.path)} (${t.rows.length} row${t.rows.length === 1 ? '' : 's'})</option>`
  ).join('');
  selectTable(0);
}

function gridDelimited(sep) {
  const g = state.grid;
  if (!g) return '';
  const q = (s) => {
    if (sep === '\t') return s.replace(/[\t\r\n]+/g, ' ');
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [g.cols.map(q).join(sep)];
  for (const r of gridRows()) {
    const m = g.data[r];
    lines.push(g.cols.map((c) => q(m.has(c) ? cellText(m.get(c)) : '')).join(sep));
  }
  return lines.join('\r\n');
}

/* =========================================================
   Nested grid (jsongrid.com style)
   Objects render as key/value tables, arrays of objects as
   tables with one column per key. Nested data sits inside
   the cell as its own collapsible table.
   ========================================================= */
const NG_OPEN_DEPTH = 8;        // auto-open nested tables up to this depth
const NG_CELL_BUDGET = 15000;   // stop auto-opening after this many cells
const NG_ROW_BATCH = 200;       // rows per array table before "show more"
const NG_VAL = '\u0000value';   // column for plain items in an array

const ngIsBox = (v) => Array.isArray(v) || v instanceof Map;
const ngIsEmpty = (v) => (Array.isArray(v) ? !v.length : !v.size);
const ngSize = (v) => (Array.isArray(v) ? `[${v.length}]` : `{${v.size}}`);

function ngLeaf(v, path) {
  const t = v === null ? 'null' : v instanceof N ? v.r : String(v);
  const cls = v === null ? 'nul' : v instanceof N ? 'num' : typeof v === 'boolean' ? 'bool' : 'str';
// OLD CODE
// return `<td class="ng-v ${cls}" data-path="${esc(path)}">${esc(t)}</td>`;
// END OLD CODE
  const long = t.length > 60 ? ' long' : '';
  return `<td class="ng-v ${cls}${long}" data-path="${esc(path)}">${esc(t)}</td>`;
}

function ngCell(v, path, depth) {
  if (!ngIsBox(v)) return ngLeaf(v, path);
  return `<td class="ng-c">${ngBlock(v, path, depth)}</td>`;
}

function ngBlock(v, path, depth) {
  if (ngIsEmpty(v)) return `<span class="ng-empty" data-path="${esc(path)}">${Array.isArray(v) ? '[ ]' : '{ }'}</span>`;
  const ref = state.ng.reg.push({ v, path, depth }) - 1;
  const open = depth < NG_OPEN_DEPTH && state.ng.cells < NG_CELL_BUDGET;
  return `<div class="ng" data-ref="${ref}">` +
    `<button type="button" class="ng-head" aria-expanded="${open}" data-path="${esc(path)}">${ngSize(v)}</button>` +
    `<div class="ng-body"${open ? '' : ' hidden'}>${open ? ngTable(v, path, depth) : ''}</div></div>`;
}

function ngCols(arr) {
  const cols = new Set();
  let prim = false;
  for (const x of arr) {
    if (x instanceof Map) for (const k of x.keys()) cols.add(k);
    else prim = true;
  }
  const list = [...cols];
  if (prim) list.unshift(NG_VAL);
  return list;
}

function ngRows(arr, cols, path, depth, start) {
  const end = Math.min(arr.length, start + NG_ROW_BATCH);
  let h = '';
  for (let i = start; i < end; i++) {
    const x = arr[i];
    const rp = childPath(path, i);
    h += `<tr><td class="rn" data-path="${esc(rp)}">${i}</td>`;
    for (const c of cols) {
      state.ng.cells++;
      if (c === NG_VAL) h += x instanceof Map ? '<td class="ng-none"></td>' : ngCell(x, rp, depth + 1);
      else if (x instanceof Map && x.has(c)) h += ngCell(x.get(c), childPath(rp, c), depth + 1);
      else h += '<td class="ng-none"></td>';
    }
    h += '</tr>';
  }
  if (end < arr.length) {
    const ref = state.ng.reg.push({ v: arr, path, depth, cols, next: end }) - 1;
    const left = arr.length - end;
    h += `<tr class="ng-more"><td colspan="${cols.length + 1}"><button type="button" class="link" data-more="${ref}">Show ${Math.min(NG_ROW_BATCH, left)} more (${left} left)</button></td></tr>`;
  }
  return h;
}

function ngTable(v, path, depth) {
  if (v instanceof Map) {
    let h = '<table class="ngt"><tbody>';
    for (const [k, x] of v) {
      state.ng.cells++;
      const p = childPath(path, k);
      h += `<tr><th class="ng-k" data-path="${esc(p)}">${esc(k)}</th>${ngCell(x, p, depth + 1)}</tr>`;
    }
    return h + '</tbody></table>';
  }
  const cols = ngCols(v);
  const head = cols.map((c) => `<th>${c === NG_VAL ? '<span class="p">value</span>' : esc(c)}</th>`).join('');
  return `<table class="ngt"><thead><tr><th class="rn"></th>${head}</tr></thead><tbody>${ngRows(v, cols, path, depth, 0)}</tbody></table>`;
}

function renderNested() {
  const a = analyze();
  const wrap = $('nestedWrap');
  if (state.ng.for === a) { applyNestedSearch(); return; }
  state.ng = { for: a, reg: [], cells: 0 };
  $('gridPath').hidden = true;
  $('gridCount').textContent = '';
  if (!a.ok) {
    wrap.innerHTML = `<p class="empty">${a.type ? 'Fix the input error to build a grid.' : 'Paste JSON or XML on the left to see it as a grid.'}</p>`;
    return;
  }
  const root = rootValue(a);
  if (!ngIsBox(root)) wrap.innerHTML = `<table class="ngt"><tbody><tr>${ngLeaf(root, '$')}</tr></tbody></table>`;
  else if (ngIsEmpty(root)) wrap.innerHTML = `<span class="ng-empty">${Array.isArray(root) ? '[ ]' : '{ }'}</span>`;
  else wrap.innerHTML = ngTable(root, '$', 0);
  if (state.ng.cells >= NG_CELL_BUDGET) $('gridCount').textContent = 'Large document, deeper sections start collapsed';
  applyNestedSearch();
}

function ngExpand(blk) {
  const head = blk.querySelector(':scope > .ng-head');
  const body = blk.querySelector(':scope > .ng-body');
  if (!body.firstChild) {
    const e = state.ng.reg[+blk.dataset.ref];
    state.ng.cells = 0;
    body.innerHTML = ngTable(e.v, e.path, e.depth);
  }
  body.hidden = false;
  head.setAttribute('aria-expanded', 'true');
}

function ngCollapse(blk) {
  blk.querySelector(':scope > .ng-body').hidden = true;
  blk.querySelector(':scope > .ng-head').setAttribute('aria-expanded', 'false');
}

function ngExpandAll() {
  const wrap = $('nestedWrap');
  let opened = 0;
  for (let pass = 0; pass < 12; pass++) {
    const closed = [...wrap.querySelectorAll('.ng-head[aria-expanded="false"]')];
    if (!closed.length) break;
    for (const h of closed) {
      if (opened >= 3000) { toast('Stopped expanding, the document is very large'); applyNestedSearch(); return; }
      ngExpand(h.parentElement);
      opened++;
    }
  }
  applyNestedSearch();
}

function ngCollapseAll() {
  $('nestedWrap').querySelectorAll('.ng').forEach(ngCollapse);
  applyNestedSearch();
}

function applyNestedSearch() {
  const wrap = $('nestedWrap');
  wrap.querySelectorAll('.ng-hit').forEach((el) => el.classList.remove('ng-hit', 'cur'));
  state.hits = [];
  state.hitIdx = -1;
  const q = state.tab === 'grid' && state.gridMode === 'nested' ? searchBox.value.trim().toLowerCase() : '';
  if (q) {
    for (const el of wrap.querySelectorAll('td.ng-v, th.ng-k')) {
      if (el.closest('.ng-body[hidden]')) continue;
      if (el.textContent.toLowerCase().includes(q)) {
        el.classList.add('ng-hit');
        state.hits.push(el);
      }
    }
    if (state.hits.length) state.hitIdx = 0;
    $('gridCount').textContent = 'Searching expanded sections';
  } else if ($('gridCount').textContent === 'Searching expanded sections') {
    $('gridCount').textContent = '';
  }
  focusHit();
}

function setGridMode(m) {
  state.gridMode = m;
  document.querySelectorAll('.seg button[data-gmode]').forEach((b) => b.classList.toggle('on', b.dataset.gmode === m));
  searchBox.value = '';
  $('gridCount').textContent = '';
  $('gridPath').hidden = true;
  state.hits = [];
  updateToolbar();
  renderView();
}

function hitsMode() {
  return state.tab === 'text' || (state.tab === 'grid' && state.gridMode === 'nested');
}

function updateToolbar() {
  const t = state.tab;
  const flat = t === 'grid' && state.gridMode === 'flat';
  const nested = t === 'grid' && !flat;
  searchBox.placeholder = t === 'text' ? 'Search output' : t === 'tree' ? 'Find keys or values' : flat ? 'Filter rows' : 'Find in grid';
  $('prevHit').hidden = !hitsMode();
  $('nextHit').hidden = !hitsMode();
  $('btnCopy').textContent = flat ? 'Copy as TSV' : (t === 'tree' || nested) ? 'Copy path' : 'Copy';
  $('btnDownload').textContent = flat ? 'Download CSV' : 'Download';
  $('btnDownload').hidden = t === 'tree' || nested;
  $('btnUse').hidden = t !== 'text';
  $('nestedTools').hidden = !nested;
  $('flatTools').hidden = !flat;
  $('flatWrap').hidden = !flat;
  $('nestedWrap').hidden = !nested;
  if (flat) $('gridPath').hidden = true;
}

/* =========================================================
   Tabs
   ========================================================= */
function renderView() {
  if (state.tab === 'text') renderText();
// OLD CODE
//   else if (state.tab === 'tree') renderTree();
//   else renderGrid();
// END OLD CODE
  else if (state.tab === 'tree') renderTree();
  else if (state.gridMode === 'flat') renderGrid();
  else renderNested();
}

function switchTab(tab) {
  state.tab = tab;
  document.querySelectorAll('.tabs button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === tab)));
  $('viewText').hidden = tab !== 'text';
  $('viewTree').hidden = tab !== 'tree';
  $('viewGrid').hidden = tab !== 'grid';
// OLD CODE
//   searchBox.value = '';
//   searchBox.placeholder = tab === 'text' ? 'Search output' : tab === 'tree' ? 'Find keys or values' : 'Filter rows';
//   $('prevHit').hidden = tab !== 'text';
//   $('nextHit').hidden = tab !== 'text';
//   $('btnCopy').textContent = tab === 'grid' ? 'Copy as TSV' : tab === 'tree' ? 'Copy path' : 'Copy';
//   $('btnDownload').textContent = tab === 'grid' ? 'Download CSV' : 'Download';
//   $('btnDownload').hidden = tab === 'tree';
//   $('btnUse').hidden = tab !== 'text';
//   renderView();
// END OLD CODE
  searchBox.value = '';
  updateToolbar();
  renderView();
}

/* =========================================================
   Actions
   ========================================================= */
function requireValid() {
  const a = analyze();
  if (!a.type) { toast('Paste some JSON or XML first'); return null; }
  if (!a.ok) {
    toast(a.error.line ? `Fix the error on line ${a.error.line} first` : 'Fix the input error first');
    return null;
  }
  return a;
}

function setOutput(text, type, action) {
  state.outText = text;
  state.outType = type;
  state.lastAction = action || null;
  if (state.tab !== 'text') switchTab('text'); else renderText();
  updateStatus();
}

function doFormat() {
  const a = requireValid();
  if (!a) return;
  const ind = indentStr();
  if (a.type === 'json') setOutput(stringifyJSON(a.value, ind, $('sortKeys').checked, false), 'json', doFormat);
  else setOutput(fmtXml(a.src, ind), 'xml', doFormat);
}

function doMinify() {
  const a = requireValid();
  if (!a) return;
  const aggr = $('aggressive').checked;
  if (a.type === 'json') setOutput(stringifyJSON(a.value, '', $('sortKeys').checked, aggr), 'json', doMinify);
  else setOutput(minXml(a.src, aggr), 'xml', doMinify);
}

function doConvert() {
  const a = requireValid();
  if (!a) return;
  const ind = indentStr();
  if (a.type === 'json') setOutput(jsonToXml(a.value, ind), 'xml', doConvert);
  else setOutput(stringifyJSON(rootValue(a), ind, $('sortKeys').checked, false), 'json', doConvert);
}

function guessType(s) {
  const t = s.trimStart();
  return t[0] === '{' || t[0] === '[' ? 'json' : t[0] === '<' ? 'xml' : 'text';
}

function doEscape() {
  if (!input.value) { toast('Nothing to escape'); return; }
  setOutput(JSON.stringify(input.value), 'text');
}

function doUnescape() {
  const s = input.value.trim();
  if (!s) { toast('Nothing to unescape'); return; }
  let r;
  try { r = JSON.parse(s); } catch {
    try { r = JSON.parse('"' + s + '"'); } catch {
      toast('That does not look like an escaped string');
      return;
    }
  }
  if (typeof r !== 'string') { toast('Input is already plain JSON, nothing to unescape'); return; }
  setOutput(r, guessType(r));
}

async function copyText(t, label) {
  if (!t) { toast('Nothing to copy'); return; }
  try {
    await navigator.clipboard.writeText(t);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = t;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  toast(label || 'Copied');
}

function download(text, name, mime) {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* =========================================================
   Input handling
   ========================================================= */
let saveTimer;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      const v = input.value.length < 2000000 ? input.value : '';
      localStorage.setItem(STORE_KEY, JSON.stringify({
        input: v,
        indent: $('indent').value,
        sort: $('sortKeys').checked,
        aggr: $('aggressive').checked,
        mode: state.mode
      }));
    } catch { /* storage full or blocked, not critical */ }
  }, 500);
}

function restore() {
  try {
    const s = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
    if (!s) return;
    input.value = s.input || '';
    if (s.indent) $('indent').value = s.indent;
    $('sortKeys').checked = !!s.sort;
    $('aggressive').checked = s.aggr !== false;
    if (s.mode) setMode(s.mode, true);
  } catch { /* ignore */ }
}

const afterInput = debounce(() => {
  state.analysis = null;
  analyze();
  updateStatus();
  if (state.tab !== 'text') renderView();
  save();
}, 250);

const gutterLater = debounce(updateGutter, 200);

function onInput() {
  if (input.value.length < 500000) updateGutter(); else gutterLater();
  afterInput();
}

function setInput(text) {
  input.value = text;
  input.scrollTop = 0;
  updateGutter();
  state.analysis = null;
  analyze();
  updateStatus();
  if (state.tab !== 'text') renderView();
  save();
}

function setMode(m, silent) {
  state.mode = m;
// OLD CODE
//   document.querySelectorAll('.seg button').forEach((b) => b.classList.toggle('on', b.dataset.mode === m));
// END OLD CODE
  document.querySelectorAll('.seg button[data-mode]').forEach((b) => b.classList.toggle('on', b.dataset.mode === m));
  if (silent) return;
  state.analysis = null;
  updateStatus();
  if (state.tab !== 'text') renderView();
  save();
}

function loadFile(file) {
  if (!file) return;
  const r = new FileReader();
  r.onload = () => { setInput(String(r.result)); toast(`Loaded ${file.name}`); };
  r.onerror = () => toast('Could not read that file');
  r.readAsText(file);
}

/* =========================================================
   Samples
   ========================================================= */
const SAMPLE_JSON = `{
  "campaign": "Spring Auto Insurance",
  "generatedAt": "2026-11-12T09:30:00Z",
  "trackingId": 9007199254740993,
  "leads": [
    { "id": 1001, "name": "Priya Sharma", "email": "priya.s@example.com", "state": "CA", "score": 87.50,
      "consent": { "tcpa": true, "capturedAt": "2026-11-10T14:02:11Z" }, "tags": ["auto", "bundle"] },
    { "id": 1002, "name": "Marcus Lee", "email": "mlee@example.com", "state": "TX", "score": 64.0,
      "consent": { "tcpa": true, "capturedAt": "2026-11-10T15:47:30Z" }, "tags": ["auto"] },
    { "id": 1003, "name": "Elena Ruiz", "email": "elena.ruiz@example.com", "state": "FL", "score": 91.25,
      "consent": { "tcpa": false, "capturedAt": null }, "tags": [] },
    { "id": 1004, "name": "Tom O'Brien", "email": "tobrien@example.com", "state": "NY", "score": 72.00,
      "consent": { "tcpa": true, "capturedAt": "2026-11-11T08:15:00Z" }, "tags": ["home", "auto"] }
  ]
}`;

const SAMPLE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<!-- Lead export -->
<leads campaign="Spring Auto Insurance" generated="2026-11-12T09:30:00Z">
  <lead id="1001">
    <name>Priya Sharma</name>
    <email>priya.s@example.com</email>
    <state>CA</state>
    <score>87.5</score>
    <consent tcpa="true"></consent>
  </lead>
  <lead id="1002">
    <name>Marcus Lee</name>
    <email>mlee@example.com</email>
    <state>TX</state>
    <score>64</score>
    <consent tcpa="true"></consent>
  </lead>
  <lead id="1003">
    <name>Elena Ruiz</name>
    <email>elena.ruiz@example.com</email>
    <state>FL</state>
    <score>91.25</score>
    <consent tcpa="false"/>
  </lead>
  <note><![CDATA[Scores above 80 go to the priority queue & get a same-day call.]]></note>
</leads>`;

let sampleNext = 'json';

/* =========================================================
   Wire up
   ========================================================= */
input.addEventListener('input', onInput);
input.addEventListener('scroll', () => { gutter.scrollTop = input.scrollTop; });
input.addEventListener('keydown', (e) => {
  if (e.key === 'Tab' && !e.ctrlKey && !e.metaKey && !e.altKey) {
    e.preventDefault();
    input.setRangeText(indentStr(), input.selectionStart, input.selectionEnd, 'end');
    onInput();
  }
});

const editor = $('editor');
editor.addEventListener('dragover', (e) => { e.preventDefault(); editor.classList.add('drop'); });
editor.addEventListener('dragleave', () => editor.classList.remove('drop'));
editor.addEventListener('drop', (e) => {
  e.preventDefault();
  editor.classList.remove('drop');
  loadFile(e.dataTransfer.files[0]);
});
$('fileIn').addEventListener('change', (e) => { loadFile(e.target.files[0]); e.target.value = ''; });

// OLD CODE
// document.querySelectorAll('.seg button').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));
// END OLD CODE
document.querySelectorAll('.seg button[data-mode]').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));
document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => switchTab(b.dataset.tab)));

$('btnFormat').addEventListener('click', doFormat);
$('btnMinify').addEventListener('click', doMinify);
$('btnConvert').addEventListener('click', doConvert);
$('btnEscape').addEventListener('click', doEscape);
$('btnUnescape').addEventListener('click', doUnescape);

['indent', 'sortKeys', 'aggressive'].forEach((id) => $(id).addEventListener('change', () => {
  save();
  if (state.lastAction && state.outText) state.lastAction();
}));

$('btnSample').addEventListener('click', () => {
  setInput(sampleNext === 'json' ? SAMPLE_JSON : SAMPLE_XML);
  sampleNext = sampleNext === 'json' ? 'xml' : 'json';
});
$('btnClear').addEventListener('click', () => {
  setInput('');
  state.outText = '';
  state.outType = '';
  state.lastAction = null;
  renderText();
  updateStatus();
  input.focus();
});

$('btnCopy').addEventListener('click', () => {
  if (state.tab === 'text') copyText(state.outText);
// OLD CODE
//   else if (state.tab === 'grid') copyText(gridDelimited('\t'), 'Copied, paste it into Excel or Sheets');
//   else copyText(state.selectedPath, 'Path copied');
// END OLD CODE
  else if (state.tab === 'grid' && state.gridMode === 'flat') copyText(gridDelimited('\t'), 'Copied, paste it into Excel or Sheets');
  else copyText(state.selectedPath, 'Path copied');
});
$('btnDownload').addEventListener('click', () => {
// OLD CODE
//   if (state.tab === 'grid') {
// END OLD CODE
  if (state.tab === 'grid' && state.gridMode === 'flat') {
    const csv = gridDelimited(',');
    if (!csv) { toast('Nothing to download'); return; }
    download('\uFEFF' + csv, 'table.csv', 'text/csv;charset=utf-8');
    return;
  }
  if (!state.outText) { toast('Nothing to download'); return; }
  const ext = state.outType === 'json' ? 'json' : state.outType === 'xml' ? 'xml' : 'txt';
  const mime = ext === 'json' ? 'application/json' : ext === 'xml' ? 'application/xml' : 'text/plain';
  download(state.outText, `output.${ext}`, mime + ';charset=utf-8');
});
$('btnUse').addEventListener('click', () => {
  if (!state.outText) { toast('Nothing to move'); return; }
  setInput(state.outText);
  toast('Output moved to input');
});
$('btnCopyPath').addEventListener('click', () => copyText(state.selectedPath, 'Path copied'));

$('tree').addEventListener('click', (e) => {
  const el = e.target.closest('[data-path]');
  if (el) showPath(el.dataset.path);
});
$('treeHits').addEventListener('click', (e) => {
  const el = e.target.closest('[data-path]');
  if (el) showPath(el.dataset.path);
});

$('gridSource').addEventListener('change', (e) => selectTable(+e.target.value));
$('grid').addEventListener('click', (e) => {
  const b = e.target.closest('th button');
  if (!b) return;
  const c = +b.dataset.col;
  state.gridSort = state.gridSort.col === c ? { col: c, dir: -state.gridSort.dir } : { col: c, dir: 1 };
  drawGrid();
});

document.querySelectorAll('.seg button[data-gmode]').forEach((b) => b.addEventListener('click', () => setGridMode(b.dataset.gmode)));
$('btnExpandAll').addEventListener('click', ngExpandAll);
$('btnCollapseAll').addEventListener('click', ngCollapseAll);
$('btnCopyGridPath').addEventListener('click', () => copyText(state.selectedPath, 'Path copied'));
$('nestedWrap').addEventListener('click', (e) => {
  const more = e.target.closest('[data-more]');
  if (more) {
    const en = state.ng.reg[+more.dataset.more];
    const tr = more.closest('tr');
    state.ng.cells = 0;
    tr.insertAdjacentHTML('beforebegin', ngRows(en.v, en.cols, en.path, en.depth, en.next));
    tr.remove();
    return;
  }
  const head = e.target.closest('.ng-head');
  if (head) {
    const blk = head.parentElement;
    if (head.getAttribute('aria-expanded') === 'true') ngCollapse(blk); else ngExpand(blk);
    showPath(head.dataset.path);
    if (searchBox.value) applyNestedSearch();
    return;
  }
  const el = e.target.closest('[data-path]');
  if (el) showPath(el.dataset.path);
});

const onSearch = debounce(() => {
  if (state.tab === 'text') renderText();
// OLD CODE
//   else if (state.tab === 'tree') renderTreeHits();
//   else if (state.grid) drawGrid();
// }, 180);
// END OLD CODE
  else if (state.tab === 'tree') renderTreeHits();
  else if (state.gridMode === 'nested') applyNestedSearch();
  else if (state.grid) drawGrid();
}, 180);
searchBox.addEventListener('input', onSearch);
searchBox.addEventListener('keydown', (e) => {
// OLD CODE
//   if (e.key === 'Enter' && state.tab === 'text') { e.preventDefault(); stepHit(e.shiftKey ? -1 : 1); }
// END OLD CODE
  if (e.key === 'Enter' && hitsMode()) { e.preventDefault(); stepHit(e.shiftKey ? -1 : 1); }
  if (e.key === 'Escape') { searchBox.value = ''; onSearch(); }
});
$('prevHit').addEventListener('click', () => stepHit(-1));
$('nextHit').addEventListener('click', () => stepHit(1));

document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
    e.preventDefault();
    if (e.shiftKey) doMinify(); else doFormat();
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f' && document.activeElement !== input) {
    e.preventDefault();
    searchBox.focus();
  }
});

/* init */
restore();
updateGutter();
switchTab('text');
updateStatus();
})();
