'use strict';

// Claudeの画面などに埋め込まれて開いたとき用の目印
try { if (window.self !== window.top) document.documentElement.classList.add('embedded'); } catch { document.documentElement.classList.add('embedded'); }
// 古いiPhone（iOS 15.3以前）は画面内ダイアログに対応していない
if (typeof HTMLDialogElement === 'undefined' || !HTMLDialogElement.prototype.showModal) {
  document.body.insertAdjacentHTML('afterbegin', '<p style="margin:0;padding:10px 16px;background:var(--accent);color:var(--accent-ink)">このブラウザは古いため、登録画面を開けません。iPhoneのiOSを最新（15.4以降）にしてください。</p>');
}

/* ================= 定数 ================= */
const STATUSES = [
  // id は以前の記録と合わせるため変えない（tsundoku = 途中でひと休み）
  { id: 'unread',   label: 'まだ読んでない', short: '積読',   color: 'var(--st-unread)' },
  { id: 'reading',  label: '読んでいる',     short: '読書中', color: 'var(--st-reading)' },
  { id: 'tsundoku', label: '途中でひと休み', short: '休憩中', color: 'var(--st-tsundoku)' },
  { id: 'done',     label: '読み終わり',     short: '読了',   color: 'var(--st-done)' },
  { id: 'hard',     label: 'むずかしかった', short: '難しい', color: 'var(--st-hard)' },
];
// 「むずかしかった」本は、ジャンルの棚ではなく専用のボックスにしまう
const HARD_BOX = 'むずかしかったボックス';
// 「どこの本？」 保存する値は以前のまま（購入など）で、画面では「家の本」などと表示する
const SOURCES = ['購入', '図書館', 'レンタル', '借りた', 'もらった', 'その他'];
const SOURCE_INFO = {
  購入:     { label: '家の本',       mark: '家',     cls: 'home' },
  図書館:   { label: '図書館の本',   mark: '図書館', cls: 'lib' },
  レンタル: { label: 'レンタルの本', mark: 'レンタル', cls: 'rent' },
  借りた:   { label: '借りた本',     mark: '借りた', cls: 'rent' },
  もらった: { label: 'もらった本',   mark: 'もらった', cls: 'home' },
  その他:   { label: 'その他',       mark: '',       cls: '' },
};
const sourceInfo = s => SOURCE_INFO[s] || { label: s || 'その他', mark: '', cls: '' };
const DEFAULT_GENRES = ['子育て', '生成AI', 'ビジネス', '小説'];
const NO_GENRE = '未分類';
const SPINE_COLORS = ['#b8653a', '#4f7f5c', '#4a7394', '#a8792a', '#7d62a0', '#3a7f76', '#b45252', '#56679a', '#8c6d45'];

/* ================= IndexedDB ================= */
const db = (() => {
  let opening;
  const open = () => opening ||= new Promise((resolve, reject) => {
    const req = indexedDB.open('yonda', 1);
    req.onupgradeneeded = () => {
      const d = req.result;
      d.createObjectStore('books', { keyPath: 'id' });
      d.createObjectStore('meta');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  const run = async (store, mode, fn) => {
    const d = await open();
    return new Promise((resolve, reject) => {
      const tx = d.transaction(store, mode);
      const req = fn(tx.objectStore(store));
      tx.oncomplete = () => resolve(req && req.result);
      tx.onerror = () => reject(tx.error);
    });
  };
  return {
    allBooks: () => run('books', 'readonly', s => s.getAll()),
    putBook: b => run('books', 'readwrite', s => s.put(b)),
    deleteBook: id => run('books', 'readwrite', s => s.delete(id)),
    getMeta: k => run('meta', 'readonly', s => s.get(k)),
    setMeta: (k, v) => run('meta', 'readwrite', s => s.put(v, k)),
  };
})();

/* ================= 状態 ================= */
let books = [];
let genres = [];
let filterStatus = 'all';
let query = '';
let editing = null;        // フォームで編集中の本（新規ならnull）
let draft = {};            // フォームの一時データ（書影・ジャンル等）
let currentId = null;      // 詳細表示中の本
let clipEditing = null;    // 編集中のページ記録
let clipPhoto = null;

/* ================= ユーティリティ ================= */
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const today = () => new Date().toLocaleDateString('sv-SE');
const statusOf = id => STATUSES.find(s => s.id === id) || STATUSES[0];
const fmtDate = d => d ? d.replaceAll('-', '/') : '';
// 本好きのリス（index.html の <symbol>）。pose: read=読んでいる / hug=本をだっこ
const squirrel = (pose = 'read') => `<svg class="squirrel" viewBox="0 0 100 100" aria-hidden="true"><use href="#sq-${pose}"/></svg>`;

function hashColor(str) {
  let h = 0;
  for (const ch of str) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return SPINE_COLORS[h % SPINE_COLORS.length];
}

function coverHTML(book) {
  const spine = `<div class="spine" style="background:${hashColor(book.title || '?')}">${esc(book.title || 'タイトル未入力')}${book.author ? `<small>${esc(book.author)}</small>` : ''}</div>`;
  if (!book.cover) return spine;
  // 画像が読めなかったら背表紙に差し替える
  return `<img src="${esc(book.cover)}" alt="" loading="lazy" data-fallback>` + `<template>${spine}</template>`;
}
// 書影の読み込み失敗時に背表紙を出す（委譲）
document.addEventListener('error', e => {
  const img = e.target;
  if (img.tagName === 'IMG' && img.hasAttribute('data-fallback')) {
    const tpl = img.nextElementSibling;
    if (tpl && tpl.tagName === 'TEMPLATE') img.replaceWith(tpl.content.cloneNode(true));
  }
}, true);
// NDLの書影は画像がないとき1x1を返すことがあるので、小さすぎる画像も差し替える
document.addEventListener('load', e => {
  const img = e.target;
  if (img.tagName === 'IMG' && img.hasAttribute('data-fallback') && img.naturalWidth < 10) {
    img.dispatchEvent(new Event('error'));
  }
}, true);

// confirm()/prompt() の代わりの画面内ダイアログ。OKなら true（入力ありなら文字列）、キャンセルなら false/null
function ask(message, { input = false, value = '', ok = 'OK', danger = false } = {}) {
  const dlg = $('#dlg-ask'), field = $('#ask-input'), okBtn = $('#ask-ok');
  $('#ask-msg').textContent = message;
  field.hidden = !input;
  field.value = value;
  okBtn.textContent = ok;
  okBtn.classList.toggle('danger', danger);
  return new Promise(resolve => {
    let answered = false;
    $('#ask-form').onsubmit = e => {
      e.preventDefault();
      if (input && !field.value.trim()) { field.focus(); return; }
      answered = true;
      dlg.close();
    };
    dlg.addEventListener('close', () => resolve(answered ? (input ? field.value.trim() : true) : (input ? null : false)), { once: true });
    dlg.showModal();
    if (input) { field.focus(); field.select(); }
  });
}

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2200);
}

function resizeImage(file, max) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * scale);
      c.height = Math.round(img.height * scale);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(img.src);
      resolve(c.toDataURL('image/jpeg', 0.82));
    };
    img.onerror = () => reject(new Error('画像を読み込めませんでした'));
    img.src = URL.createObjectURL(file);
  });
}

/* ================= 書誌検索 ================= */
const normIsbn = s => s.replace(/[^0-9Xx]/g, '').toUpperCase();
const looksLikeIsbn = s => /^(97[89]\d{10}|\d{9}[\dX])$/.test(normIsbn(s));
let netError = false;
const ndlCover = isbn => `https://ndlsearch.ndl.go.jp/thumbnail/${isbn}.jpg`;

function cleanAuthor(a) {
  // openBD は「夏目,漱石,1867-1916」「山田太郎／著 鈴木花子／訳」のような形式
  return (a || '').split(/[\s／]+/)
    .filter(p => p && !/^(著|作|文|絵|訳|編|監修|編著|著・文|原作|画|写真)$/.test(p))
    .map(p => p.replace(/,?\s*\d{4}-(\d{4})?$/, '').replace(/,/g, ''))
    .filter(Boolean).join('、');
}

async function lookupByIsbn(raw) {
  const isbn = normIsbn(raw);
  // 1) openBD（日本の書籍に強い）
  try {
    const res = await fetch(`https://api.openbd.jp/v1/get?isbn=${isbn}`);
    const [hit] = await res.json();
    if (hit && hit.summary) {
      const s = hit.summary;
      return [{ title: s.title, author: cleanAuthor(s.author), cover: s.cover || ndlCover(isbn), isbn }];
    }
  } catch { netError = true; }
  // 2) Google Books
  const g = await googleBooks(`isbn:${isbn}`);
  return g.map(b => ({ ...b, isbn, cover: b.cover || ndlCover(isbn) }));
}

async function googleBooks(q) {
  try {
    const res = await fetch(`https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(q)}&maxResults=8`);
    const j = await res.json();
    return (j.items || []).map(it => {
      const v = it.volumeInfo || {};
      const isbn = (v.industryIdentifiers || []).find(x => x.type === 'ISBN_13')?.identifier || '';
      const thumb = v.imageLinks?.thumbnail?.replace(/^http:/, 'https:') || (isbn ? ndlCover(isbn) : '');
      return { title: [v.title, v.subtitle].filter(Boolean).join(' '), author: (v.authors || []).join('、'), cover: thumb, isbn };
    });
  } catch {
    netError = true;
    return [];
  }
}

/* ================= 本棚の描画 ================= */
function matches(b) {
  if (filterStatus !== 'all' && b.status !== filterStatus) return false;
  if (!query) return true;
  const hay = [b.title, b.author, b.pickMemo, b.review, b.genre, b.source, sourceInfo(b.source).label, ...(b.clips || []).map(c => c.note)].join(' ').toLowerCase();
  return hay.includes(query.toLowerCase());
}

function renderFilters() {
  const counts = Object.fromEntries(STATUSES.map(s => [s.id, 0]));
  books.forEach(b => counts[b.status] = (counts[b.status] || 0) + 1);
  const all = [{ id: 'all', label: 'すべて', n: books.length }, ...STATUSES.map(s => ({ ...s, n: counts[s.id] }))];
  $('#status-filter').innerHTML = all.map(s => `
    <button class="chip" data-status="${s.id}" aria-pressed="${filterStatus === s.id}">
      ${s.color ? `<span class="dot" style="background:${s.color}"></span>` : ''}${esc(s.label)}<span class="n">${s.n}</span>
    </button>`).join('');
}

function renderShelves() {
  if (view === 'insights') renderInsights();
  renderFilters();
  const main = $('#shelves');
  if (!books.length) {
    main.innerHTML = `
      <div class="welcome">
        ${squirrel('read')}
        <h2>本棚はまだ空っぽです</h2>
        <p>気になった本を手に取ったら「本を登録」から記録しましょう。</p>
        <div class="lookup-row">
          <button class="btn primary" data-action="add">本を登録</button>
          <button class="btn ghost" data-action="sample">サンプルを見てみる</button>
        </div>
      </div>`;
    return;
  }
  const list = books.filter(matches).sort((a, b) => (b.pickedAt || '').localeCompare(a.pickedAt || '') || b.createdAt - a.createdAt);
  const order = [...genres, NO_GENRE];
  const groups = new Map(order.map(g => [g, []]));
  list.forEach(b => {
    const g = genres.includes(b.genre) ? b.genre : NO_GENRE;
    groups.get(g).push(b);
  });
  const hard = list.filter(b => b.status === 'hard');
  const filtered = filterStatus !== 'all' || query;
  const html = [];
  for (const [g, all] of groups) {
    const items = all.filter(b => b.status !== 'hard');
    if (!items.length && (filtered || g === NO_GENRE)) continue;
    html.push(`
      <section class="shelf">
        <div class="shelf-head"><h2>${esc(g)}</h2><span class="count">${items.length}冊</span></div>
        <div class="shelf-row">
          ${items.length ? items.map(bookTile).join('') : '<p class="shelf-empty">まだこの棚に本はありません</p>'}
        </div>
      </section>`);
  }
  if (hard.length) {
    html.push(`
      <section class="shelf hard-box">
        <div class="shelf-head">${squirrel('hug')}<h2>${HARD_BOX}</h2><span class="count">${hard.length}冊</span></div>
        <p class="box-note">読み進められなかった本も、手に取った大事な記録。いつかまた開く日のために。</p>
        <div class="shelf-row">${hard.map(bookTile).join('')}</div>
      </section>`);
  }
  main.innerHTML = html.join('') || `<div class="welcome">${squirrel('read')}<p>条件に合う本が見つかりませんでした。</p></div>`;
}

function bookTile(b) {
  const st = statusOf(b.status);
  const n = (b.clips || []).length;
  const src = sourceInfo(b.source);
  return `
    <button class="book" data-id="${b.id}" aria-label="${esc(b.title)}（${st.label}・${esc(src.label)}）">
      ${coverHTML(b)}
      <span class="ribbon" style="background:${st.color}">${st.short}</span>
      ${n ? `<span class="clip-badge">🔖 ${n}</span>` : ''}
      ${src.mark ? `<span class="place-mark ${src.cls}">${src.mark}</span>` : ''}
    </button>`;
}

/* ================= 登録・編集フォーム ================= */
const form = $('#book-form');

function openForm(book = null) {
  editing = book;
  draft = {
    cover: book?.cover || '',
    isbn: book?.isbn || '',
    genre: book?.genre || genres[0] || '',
    source: book?.source || '購入',
    status: book?.status || 'unread',
    rating: book?.rating || 0,
  };
  form.reset();
  $('#form-title').textContent = book ? '記録を編集' : '本を登録';
  form.title.value = book?.title || '';
  form.author.value = book?.author || '';
  form.pickedAt.value = book?.pickedAt || today();
  form.finishedAt.value = book?.finishedAt || '';
  form.pickMemo.value = book?.pickMemo || '';
  form.review.value = book?.review || '';
  $('#isbn').value = book?.isbn || '';
  $('#candidates').innerHTML = '';
  $('#lookup-msg').textContent = '';
  $('#btn-delete').hidden = !book;
  renderFormChips();
  renderCoverPreview();
  $('#dlg-form').showModal();
  if (!book) setTimeout(() => $('#isbn').focus(), 50);
}

function renderFormChips() {
  $('#genre-chips').innerHTML = genres.map(g =>
    `<button type="button" class="chip" role="radio" aria-checked="${draft.genre === g}" data-genre="${esc(g)}">${esc(g)}</button>`
  ).join('') + `<button type="button" class="chip add" data-genre-new>＋ ジャンルを追加</button>`;
  $('#source-chips').innerHTML = SOURCES.map(s =>
    `<button type="button" class="chip" role="radio" aria-checked="${draft.source === s}" data-source="${s}">${sourceInfo(s).label}</button>`
  ).join('');
  $('#status-chips').innerHTML = STATUSES.map(s =>
    `<button type="button" class="chip" role="radio" aria-checked="${draft.status === s.id}" data-st="${s.id}"><span class="dot" style="background:${s.color}"></span>${s.label}</button>`
  ).join('');
  $('#rating').innerHTML = [1, 2, 3, 4, 5].map(n =>
    `<button type="button" class="${n <= draft.rating ? 'on' : ''}" data-rate="${n}" aria-label="${n}つ星">★</button>`
  ).join('');
  $('#finished-field').style.visibility = draft.status === 'done' ? 'visible' : 'hidden';
}

function renderCoverPreview() {
  $('#cover-preview').innerHTML = coverHTML({ title: form.title.value, author: form.author.value, cover: draft.cover });
  $('#btn-cover-clear').hidden = !draft.cover;
}

$('#genre-chips').addEventListener('click', async e => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.hasAttribute('data-genre-new')) {
    const name = await ask('新しいジャンル名', { input: true, ok: '追加' });
    if (!name) return;
    if (!genres.includes(name)) { genres.push(name); await db.setMeta('genres', genres); }
    draft.genre = name;
  } else {
    draft.genre = b.dataset.genre;
  }
  renderFormChips();
});
$('#source-chips').addEventListener('click', e => {
  const b = e.target.closest('[data-source]');
  if (b) { draft.source = b.dataset.source; renderFormChips(); }
});
$('#status-chips').addEventListener('click', e => {
  const b = e.target.closest('[data-st]');
  if (!b) return;
  draft.status = b.dataset.st;
  if (draft.status === 'done' && !form.finishedAt.value) form.finishedAt.value = today();
  renderFormChips();
});
$('#rating').addEventListener('click', e => {
  const b = e.target.closest('[data-rate]');
  if (!b) return;
  const n = +b.dataset.rate;
  draft.rating = draft.rating === n ? 0 : n;
  renderFormChips();
});
form.title.addEventListener('input', () => { if (!draft.cover) renderCoverPreview(); });
form.author.addEventListener('input', () => { if (!draft.cover) renderCoverPreview(); });

// 書誌検索
async function doLookup() {
  const q = $('#isbn').value.trim();
  if (!q) return;
  const btn = $('#btn-lookup');
  btn.disabled = true;
  $('#lookup-msg').textContent = '検索中…';
  netError = false;
  $('#candidates').innerHTML = '';
  try {
    const results = looksLikeIsbn(q) ? await lookupByIsbn(q) : await googleBooks(q);
    if (!results.length) {
      $('#lookup-msg').textContent = netError ? '本の検索サービスにつながりませんでした。手入力するか、書影を撮影して登録してください。' : '見つかりませんでした。手入力してください。';
    } else if (results.length === 1 && looksLikeIsbn(q)) {
      applyCandidate(results[0]);
    } else {
      $('#lookup-msg').textContent = '該当する本を選んでください';
      $('#candidates').innerHTML = results.map((r, i) => `
        <li><button type="button" data-i="${i}">
          ${r.cover ? `<img src="${esc(r.cover)}" alt="" onerror="this.replaceWith(Object.assign(document.createElement('span'),{className:'ph'}))">` : '<span class="ph"></span>'}
          <span><span class="t">${esc(r.title)}</span><br><span class="a">${esc(r.author)}</span></span>
        </button></li>`).join('');
      $('#candidates').onclick = e => {
        const b = e.target.closest('[data-i]');
        if (b) applyCandidate(results[+b.dataset.i]);
      };
    }
  } finally {
    btn.disabled = false;
  }
}
function applyCandidate(r) {
  form.title.value = r.title || '';
  form.author.value = r.author || '';
  if (r.cover && !draft.cover?.startsWith('data:')) draft.cover = r.cover;
  draft.isbn = r.isbn || draft.isbn;
  $('#candidates').innerHTML = '';
  $('#lookup-msg').textContent = '入力しました ✓';
  renderCoverPreview();
}
$('#btn-lookup').addEventListener('click', doLookup);
$('#isbn').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); doLookup(); } });

// バーコード読み取り（対応ブラウザのみ：Android Chrome など）
if ('BarcodeDetector' in window) {
  $('#btn-barcode').hidden = false;
  $('#barcode-file').addEventListener('change', async e => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    $('#lookup-msg').textContent = '読み取り中…';
    try {
      const detector = new BarcodeDetector({ formats: ['ean_13'] });
      const codes = await detector.detect(await createImageBitmap(file));
      const isbn = codes.map(c => c.rawValue).find(v => /^97[89]/.test(v));
      if (!isbn) { $('#lookup-msg').textContent = 'ISBN（978…のバーコード）が見つかりませんでした'; return; }
      $('#isbn').value = isbn;
      doLookup();
    } catch {
      $('#lookup-msg').textContent = '読み取れませんでした';
    }
  });
}

// 書影の撮影・選択
$('#cover-file').addEventListener('change', async e => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  draft.cover = await resizeImage(file, 600);
  renderCoverPreview();
});
$('#btn-cover-clear').addEventListener('click', () => { draft.cover = ''; renderCoverPreview(); });

form.addEventListener('submit', async e => {
  e.preventDefault();
  const title = form.title.value.trim();
  if (!title) { form.title.focus(); toast('タイトルを入力してください'); return; }
  const now = Date.now();
  const book = {
    ...(editing || { id: uid(), createdAt: now, clips: [] }),
    title,
    author: form.author.value.trim(),
    cover: draft.cover,
    isbn: draft.isbn || (looksLikeIsbn($('#isbn').value) ? normIsbn($('#isbn').value) : ''),
    genre: draft.genre,
    source: draft.source,
    status: draft.status,
    pickedAt: form.pickedAt.value,
    finishedAt: draft.status === 'done' ? form.finishedAt.value : '',
    pickMemo: form.pickMemo.value.trim(),
    review: form.review.value.trim(),
    rating: draft.rating,
    updatedAt: now,
  };
  await db.putBook(book);
  upsertLocal(book);
  $('#dlg-form').close();
  renderShelves();
  if (currentId === book.id) renderDetail();
  toast(editing ? '更新しました' : `「${book.title}」を本棚に並べました`);
});

$('#btn-delete').addEventListener('click', async () => {
  if (!editing || !(await ask(`「${editing.title}」の記録を削除しますか？`, { ok: '削除', danger: true }))) return;
  await db.deleteBook(editing.id);
  books = books.filter(b => b.id !== editing.id);
  $('#dlg-form').close();
  $('#dlg-detail').close();
  renderShelves();
  toast('削除しました');
});

function upsertLocal(book) {
  const i = books.findIndex(b => b.id === book.id);
  if (i >= 0) books[i] = book; else books.push(book);
}

/* ================= 詳細 ================= */
function openDetail(id) {
  currentId = id;
  renderDetail();
  $('#dlg-detail').showModal();
}

function renderDetail() {
  const b = books.find(x => x.id === currentId);
  if (!b) return;
  const st = statusOf(b.status);
  const clips = [...(b.clips || [])].sort((x, y) => (parseInt(x.page) || 1e9) - (parseInt(y.page) || 1e9) || x.createdAt - y.createdAt);
  $('#detail-body').innerHTML = `
    <div class="detail-top">
      <div class="detail-cover">${coverHTML(b)}</div>
      <div>
        <h3 class="detail-title">${esc(b.title)}</h3>
        <p class="detail-author">${esc(b.author || '作者未入力')}</p>
        <p class="place-stamp ${sourceInfo(b.source).cls}">${esc(sourceInfo(b.source).label)}</p>
        <div class="meta">
          <span>📚 ${esc(genres.includes(b.genre) ? b.genre : NO_GENRE)}</span>
          ${b.pickedAt ? `<span>手に取った日 ${fmtDate(b.pickedAt)}</span>` : ''}
          ${b.finishedAt ? `<span>読了 ${fmtDate(b.finishedAt)}</span>` : ''}
        </div>
      </div>
    </div>

    <div class="chips wrap status-quick" id="detail-status">
      ${STATUSES.map(s => `<button type="button" class="chip" role="radio" aria-checked="${b.status === s.id}" data-st="${s.id}"><span class="dot" style="background:${s.color}"></span>${s.label}</button>`).join('')}
    </div>

    <div class="memo pick">
      <h4>手に取ったときの気持ち</h4>
      ${b.pickMemo ? `<p>${esc(b.pickMemo)}</p>` : '<p class="empty">まだ書いていません</p>'}
    </div>

    <div class="memo review">
      <h4>${b.status === 'hard' ? 'むずかしかったところ・感想' : '読んだあとの感想'} ${b.rating ? `<span class="stars-view">${'★'.repeat(b.rating)}</span>` : ''}</h4>
      ${b.review ? `<p>${esc(b.review)}</p>` : `<p class="empty">${b.status === 'done' ? '「編集する」から感想を残しましょう' : b.status === 'hard' ? '「編集する」から、どこでつまずいたかを残しておくと、また開くときの手がかりになります' : '読み終わったら書きましょう'}</p>`}
    </div>

    <div class="section-head">
      <h3>🔖 気になったページ <small style="color:var(--ink-soft);font-weight:400">${clips.length ? clips.length + '件' : ''}</small></h3>
      <button type="button" class="btn ghost" id="btn-add-clip">📷 ページを記録</button>
    </div>
    ${clips.length ? `<ul class="clips">${clips.map(c => `
      <li class="clip">
        ${c.photo ? `<button type="button" class="clip-thumb" data-photo="${c.id}" aria-label="写真を拡大"><img src="${c.photo}" alt=""></button>` : ''}
        <div class="clip-body">
          <div class="clip-page">${c.page ? `p.${esc(c.page)}` : 'ページ未記入'}<small>${new Date(c.createdAt).toLocaleDateString('ja-JP')}</small></div>
          ${c.note ? `<p class="clip-note">${esc(c.note)}</p>` : ''}
        </div>
        <button type="button" class="btn text clip-edit" data-clip="${c.id}">編集</button>
      </li>`).join('')}</ul>`
      : '<p class="clips-empty">読んでいて気になったページを、写メとメモで残せます。</p>'}
  `;
}

$('#detail-body').addEventListener('click', async e => {
  const b = books.find(x => x.id === currentId);
  if (!b) return;
  const st = e.target.closest('[data-st]');
  if (st) {
    b.status = st.dataset.st;
    if (b.status === 'done' && !b.finishedAt) b.finishedAt = today();
    if (b.status !== 'done') b.finishedAt = '';
    b.updatedAt = Date.now();
    await db.putBook(b);
    renderDetail();
    renderShelves();
    toast(b.status === 'hard' ? `${HARD_BOX}にしまいました` : `「${statusOf(b.status).label}」にしました`);
    return;
  }
  if (e.target.closest('#btn-add-clip')) return openClip(null);
  const ed = e.target.closest('[data-clip]');
  if (ed) return openClip(b.clips.find(c => c.id === ed.dataset.clip));
  const ph = e.target.closest('[data-photo]');
  if (ph) {
    $('#photo-full').src = b.clips.find(c => c.id === ph.dataset.photo).photo;
    $('#dlg-photo').showModal();
  }
});

$('#btn-edit').addEventListener('click', () => openForm(books.find(x => x.id === currentId)));

/* ================= 気になったページ ================= */
const clipForm = $('#clip-form');

function openClip(clip) {
  clipEditing = clip;
  clipPhoto = clip?.photo || null;
  clipForm.reset();
  clipForm.page.value = clip?.page || '';
  clipForm.note.value = clip?.note || '';
  $('#clip-title').textContent = clip ? 'ページの記録を編集' : '気になったページ';
  $('#btn-clip-delete').hidden = !clip;
  renderClipPhoto();
  $('#dlg-clip').showModal();
}

function renderClipPhoto() {
  const box = $('#clip-photo');
  const shoot = box.querySelector('.clip-shoot');
  box.querySelector('img')?.remove();
  if (clipPhoto) {
    shoot.hidden = true;
    box.insertAdjacentHTML('beforeend', `<img src="${clipPhoto}" alt="記録したページの写真">`);
  } else {
    shoot.hidden = false;
  }
  $('#btn-clip-photo-clear').hidden = !clipPhoto;
}

async function onClipFile(e) {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  // 文字が読めるよう、書影より大きめに保存
  clipPhoto = await resizeImage(file, 1600);
  renderClipPhoto();
  clipForm.page.focus();
}
$('#clip-camera').addEventListener('change', onClipFile);
$('#clip-file').addEventListener('change', onClipFile);
$('#btn-clip-photo-clear').addEventListener('click', () => { clipPhoto = null; renderClipPhoto(); });

clipForm.addEventListener('submit', async e => {
  e.preventDefault();
  const b = books.find(x => x.id === currentId);
  const page = clipForm.page.value.trim();
  const note = clipForm.note.value.trim();
  if (!clipPhoto && !page && !note) { toast('写真・ページ・メモのどれかを入れてください'); return; }
  b.clips ||= [];
  if (clipEditing) {
    Object.assign(clipEditing, { page, note, photo: clipPhoto });
  } else {
    b.clips.push({ id: uid(), page, note, photo: clipPhoto, createdAt: Date.now() });
  }
  b.updatedAt = Date.now();
  await db.putBook(b);
  $('#dlg-clip').close();
  renderDetail();
  renderShelves();
  toast('ページを記録しました');
});

$('#btn-clip-delete').addEventListener('click', async () => {
  const b = books.find(x => x.id === currentId);
  if (!clipEditing || !(await ask('このページの記録を削除しますか？', { ok: '削除', danger: true }))) return;
  b.clips = b.clips.filter(c => c !== clipEditing);
  await db.putBook(b);
  $('#dlg-clip').close();
  renderDetail();
  renderShelves();
});

/* ================= 設定 ================= */
function renderGenreList() {
  $('#genre-list').innerHTML = genres.map((g, i) => `
    <li>
      <span class="name">${esc(g)}</span>
      <button class="icon-btn" data-up="${i}" aria-label="上へ" ${i === 0 ? 'disabled' : ''}>↑</button>
      <button class="icon-btn" data-rename="${i}" aria-label="名前を変更">✎</button>
      <button class="icon-btn" data-remove="${i}" aria-label="削除">🗑</button>
    </li>`).join('');
}

$('#genre-list').addEventListener('click', async e => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.up) {
    const i = +b.dataset.up;
    [genres[i - 1], genres[i]] = [genres[i], genres[i - 1]];
  } else if (b.dataset.rename) {
    const i = +b.dataset.rename, old = genres[i];
    const name = await ask('ジャンル名', { input: true, value: old, ok: '変更' });
    if (!name || name === old) return;
    if (genres.includes(name)) { toast('同じ名前のジャンルがあります'); return; }
    genres[i] = name;
    for (const bk of books.filter(x => x.genre === old)) { bk.genre = name; await db.putBook(bk); }
  } else if (b.dataset.remove) {
    const i = +b.dataset.remove;
    const n = books.filter(x => x.genre === genres[i]).length;
    if (!(await ask(`「${genres[i]}」を削除しますか？${n ? `\n（${n}冊は「${NO_GENRE}」に移ります）` : ''}`, { ok: '削除', danger: true }))) return;
    genres.splice(i, 1);
  }
  await db.setMeta('genres', genres);
  renderGenreList();
  renderShelves();
});

$('#genre-add-form').addEventListener('submit', async e => {
  e.preventDefault();
  const name = $('#new-genre').value.trim();
  if (!name || genres.includes(name)) return;
  genres.push(name);
  $('#new-genre').value = '';
  await db.setMeta('genres', genres);
  renderGenreList();
  renderShelves();
});

$('#btn-export').addEventListener('click', () => {
  if (window.YONDA_DEMO) { toast('お試し版では書き出しできません'); return; }
  const data = JSON.stringify({ app: 'yonda', version: 1, exportedAt: new Date().toISOString(), genres, books });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([data], { type: 'application/json' }));
  a.download = `yonda-backup-${today()}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});

/* ---------- ビブリア（読書管理ビブリア）のCSVを読み込む ---------- */
// 見出し行なしの14列：1タイトル 3作者 5出版社 6ISBN 7登録日 8タグ 9メモ 10書影URL 11楽天URL 12更新日 …
function parseCSV(text) {
  const rows = [];
  let row = [], cell = '', q = false;
  text = text.replace(/^﻿/, '');
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; }
      else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter(r => r.some(c => c.trim()));
}

const looksLikeBiblia = rows => rows.length && rows.every(r => r.length >= 11) && rows.some(r => looksLikeIsbn(r[5] || ''));

// タイトルからジャンルを推測（あなたの本棚にあるジャンルだけ）
const GENRE_HINTS = [
  ['生成AI', /ChatGPT|GPT|生成AI|\bAI\b|ＡＩ|人工知能|プロンプト|Claude|ディープラーニング|機械学習/i],
  ['子育て', /子育て|育て|子ども|子供|わが子|ママ|お母さん|親の|中学受験|学習法|身長/],
  ['ビジネス', /仕事|ビジネス|事業|アイデア|お金|経営|マーケティング|プロトタイピング/],
];
const guessGenre = title => (GENRE_HINTS.find(([g, re]) => genres.includes(g) && re.test(title)) || [''])[0];

// タグ（自宅本／図書館本／〇〇レンタル）→ 手に入れた方法
function sourceFromTag(tag) {
  if (/図書館/.test(tag)) return '図書館';
  if (/自宅|購入|買/.test(tag)) return '購入';
  if (/レンタル|借り/.test(tag)) return '借りた';
  if (/もらっ|頂/.test(tag)) return 'もらった';
  return 'その他';
}

function bibliaToBook(r, base, i) {
  const [title, , author, , , isbn, pickedRaw, tagRaw, memoRaw, cover] = r.map(c => (c || '').trim());
  const tagLines = tagRaw.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  const memo = memoRaw.replace(/\r\n?/g, '\n');
  // 感想に「難解」「むずかしかった」などがあれば、むずかしかったボックスへ
  const hard = /難解|難しかった|むずかしかった|読み進められ|挫折/.test(memo);
  const status = hard ? 'hard' : memo ? 'done' : 'unread';
  const extra = tagLines.slice(1).join(' / ');
  return {
    id: uid(), createdAt: base - i, updatedAt: base,
    title, author, isbn: normIsbn(isbn),
    cover: cover.replace(/_ex=\d+x\d+/, '_ex=400x400'),
    genre: guessGenre(title),
    source: tagLines.length ? sourceFromTag(tagLines[0]) : 'その他',
    status,
    pickedAt: (pickedRaw.match(/^\d{4}\/\d{2}\/\d{2}/) || [''])[0].replaceAll('/', '-'),
    finishedAt: '',
    pickMemo: extra ? `ビブリアのタグ：${tagLines.join(' / ')}` : '',
    review: memo, rating: 0, clips: [],
    importedFrom: 'biblia',
  };
}

async function importBiblia(rows) {
  const have = new Set(books.flatMap(b => [b.isbn && `i:${b.isbn}`, `t:${b.title}`]).filter(Boolean));
  const base = Date.now();
  let added = 0, skipped = 0;
  for (const [i, r] of rows.entries()) {
    const b = bibliaToBook(r, base, i);
    if (!b.title || have.has(`t:${b.title}`) || (b.isbn && have.has(`i:${b.isbn}`))) { skipped++; continue; }
    await db.putBook(b); upsertLocal(b);
    have.add(`t:${b.title}`); if (b.isbn) have.add(`i:${b.isbn}`);
    added++;
  }
  renderShelves();
  toast(`ビブリアから${added}冊を読み込みました${skipped ? `（${skipped}冊は登録済みのためスキップ）` : ''}`);
}

$('#import-file').addEventListener('change', async e => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const text = await file.text();
    if (!text.trim().startsWith('{')) {
      const rows = parseCSV(text);
      if (!looksLikeBiblia(rows)) throw new Error();
      await importBiblia(rows);
      $('#dlg-settings').open && $('#dlg-settings').close();
      return;
    }
    const data = JSON.parse(text);
    if (!Array.isArray(data.books)) throw new Error();
    for (const g of data.genres || []) if (!genres.includes(g)) genres.push(g);
    await db.setMeta('genres', genres);
    for (const b of data.books) { await db.putBook(b); upsertLocal(b); }
    renderGenreList();
    renderShelves();
    toast(`${data.books.length}冊を読み込みました`);
  } catch {
    toast('読み込めないファイルでした');
  }
});

$('#btn-sample').addEventListener('click', addSamples);

/* ================= サンプルデータ ================= */
// サンプル用に「ページを写メした風」の画像を描く（縦書きの本文＋マーカー）
function samplePagePhoto(page, highlight) {
  const W = 600, H = 800, c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d');
  g.fillStyle = '#d9cbb4'; g.fillRect(0, 0, W, H);
  g.save(); g.translate(W / 2, H / 2); g.rotate(-0.03);
  g.fillStyle = '#fbf6ec'; g.shadowColor = 'rgba(0,0,0,.25)'; g.shadowBlur = 18;
  g.fillRect(-250, -350, 500, 700);
  g.restore();
  g.fillStyle = '#3a332c'; g.font = '22px serif';
  const filler = 'あの日の空はどこまでも高く、わたしたちはただ黙って歩いていた。ページをめくる音だけが部屋に響いていた。';
  const lines = [highlight.replace(/[「」]/g, ''), ...Array.from({ length: 9 }, (_, i) => filler.slice(i * 3) + filler)];
  lines.forEach((text, col) => {
    const x = 470 - col * 40;
    if (col === 0) { g.fillStyle = 'rgba(255, 214, 80, .55)'; g.fillRect(x - 15, 80, 30, Math.min(text.length, 26) * 24 + 6); g.fillStyle = '#3a332c'; }
    [...text].slice(0, 26).forEach((ch, i) => g.fillText(ch, x - 11, 104 + i * 24));
  });
  g.font = '16px serif'; g.fillText(String(page || ''), 290, 740);
  return c.toDataURL('image/jpeg', 0.8);
}

async function addSamples() {
  const d = n => new Date(Date.now() - n * 864e5).toLocaleDateString('sv-SE');
  const base = Date.now();
  const samples = [
    { title: 'ちいさな子との毎日', author: '山の木ひかり', genre: '子育て', source: '図書館', status: 'done', pickedAt: d(40), finishedAt: d(25), rating: 4,
      pickMemo: '寝かしつけがうまくいかず、すがるような気持ちで手に取った。', review: '「完璧じゃなくていい」という一文に救われた。家族にも読んでほしい。',
      clips: [{ page: '42', note: '叱る前に3秒数える。今日から試す。' }, { page: '118', note: '子どもの「なんで？」は世界を広げているサイン' }] },
    { title: 'ことばで育つ脳', author: '川辺みのり', genre: '子育て', source: '購入', status: 'reading', pickedAt: d(6),
      pickMemo: '最近しゃべり始めた娘との会話がもっと楽しくなりそうで。', clips: [{ page: '23', note: '絵本の読み聞かせは「問いかけ」をはさむと良い' }] },
    { title: 'はじめての生成AI活用', author: '佐倉テック', genre: '生成AI', source: '購入', status: 'tsundoku', pickedAt: d(20),
      pickMemo: '仕事で使えと言われて焦って購入。半分まで読んで止まってる…' },
    { title: 'プロンプトの教科書', author: '森野ユウ', genre: '生成AI', source: 'レンタル', status: 'unread', pickedAt: d(2),
      pickMemo: '書店で平積みになっていて気になった。' },
    { title: '小さなチームの仕事術', author: '大原けいすけ', genre: 'ビジネス', source: '借りた', status: 'done', pickedAt: d(70), finishedAt: d(50), rating: 3,
      pickMemo: '先輩に「これ読んでみ」と渡された。', review: '会議を短くするコツは即実践できた。後半はやや冗長。' },
    { title: '夜明けの図書室', author: '月島あおい', genre: '小説', source: '図書館', status: 'done', pickedAt: d(15), finishedAt: d(9), rating: 5,
      pickMemo: '表紙の色がきれいで、ジャケ借り。', review: 'ラスト20ページで泣いた。誰かと語りたい。',
      clips: [{ page: '211', note: '「本はいつだって、待っていてくれる」' }] },
    { title: 'ゼロからわかる深層学習の数理', author: '高嶺ひろし', genre: '生成AI', source: '図書館', status: 'hard', pickedAt: d(30),
      pickMemo: 'AIのしくみを根っこから知りたくて借りてみた。', review: '3章の行列計算で手が止まった。高校数学をおさらいしてから、また挑戦したい。' },
    { title: '海辺の郵便局', author: '月島あおい', genre: '小説', source: 'もらった', status: 'unread', pickedAt: d(1),
      pickMemo: '『夜明けの図書室』が良かったと話したら、友だちがくれた。' },
  ];
  for (const [i, s] of samples.entries()) {
    const book = {
      id: uid(), cover: '', isbn: '', finishedAt: '', review: '', rating: 0,
      createdAt: base - i, updatedAt: base, ...s,
      clips: (s.clips || []).map((c, j) => ({ id: uid(), createdAt: base - j * 1000, ...c, photo: samplePagePhoto(c.page, c.note) })),
    };
    if (!genres.includes(book.genre)) genres.push(book.genre);
    await db.putBook(book);
    upsertLocal(book);
  }
  await db.setMeta('genres', genres);
  $('#dlg-settings').open && $('#dlg-settings').close();
  renderShelves();
  toast('サンプルの本を並べました');
}

/* ================= 表示の切り替え（本棚／ふりかえり） ================= */
let view = 'shelf';
function setView(v) {
  view = v;
  $('#tab-shelf').setAttribute('aria-selected', v === 'shelf');
  $('#tab-insights').setAttribute('aria-selected', v === 'insights');
  $('#view-shelf').hidden = v !== 'shelf';
  $('#view-insights').hidden = v !== 'insights';
  if (v === 'insights') renderInsights();
  window.scrollTo({ top: 0 });
}
$('.tabs').addEventListener('click', e => {
  const b = e.target.closest('[data-view]');
  if (b) setView(b.dataset.view);
});

/* ================= ふりかえり ================= */
const daysBetween = (a, b) => Math.round((new Date(b) - new Date(a)) / 864e5);
const pct = (n, d) => d ? Math.round(n / d * 100) : 0;
const genreOf = b => genres.includes(b.genre) ? b.genre : NO_GENRE;

// 気持ちの手がかりになることば（手に取ったときのメモ・感想から数える）
const MOODS = [
  { id: 'worry',   label: '悩み・不安から',     keys: ['悩', '不安', '焦', '困', 'うまくいか', 'すがる', '迷', 'つら', '辛', 'しんど', '疲', '心配'] },
  { id: 'curious', label: '好奇心・ひとめぼれ', keys: ['気にな', '面白', 'おもしろ', '興味', '知りたい', 'ジャケ', '表紙', '平積み', 'ワクワク', 'わくわく'] },
  { id: 'growth',  label: '学び・仕事のため',   keys: ['仕事', '勉強', '学', 'スキル', '役に立', '使え', '実践', '試', 'キャリア', '活か'] },
  { id: 'people',  label: '人とのつながり',     keys: ['薦め', 'すすめ', '勧め', 'くれた', '友', '先輩', '家族', '子ども', '娘', '息子', '話', '語り', '一緒'] },
  { id: 'comfort', label: '癒し・救い',         keys: ['癒', 'ほっと', '安心', 'のんびり', '気分転換', '泣', '救', '元気', '前向き', 'やさし', '優し'] },
];
const MOOD_READING = {
  worry: '悩みや不安があるときに、本に答えを探しにいく傾向がありそうです。',
  curious: '直感やひとめぼれで本を選ぶことが多いようです。',
  growth: '「役に立つか」「明日から使えるか」を大事にして本を選んでいるようです。',
  people: '人とのつながりから本に出会うことが多いようです。',
  comfort: '心をととのえるために本を手に取ることが多いようです。',
};
function countMoods(texts) {
  const counts = Object.fromEntries(MOODS.map(m => [m.id, 0]));
  for (const t of texts) for (const m of MOODS) if (m.keys.some(k => t.includes(k))) counts[m.id]++;
  return counts;
}

// 記録の中によく出てくることば
const STOP_WORDS = new Set(['こと', 'もの', 'ため', 'よう', 'これ', 'それ', 'あれ', 'ここ', 'そこ', 'とき', '自分', '感じ', 'ところ', 'さん', 'たち', 'みたい', 'ほう', '私', 'わたし', '気持ち', 'ページ', '今日', '一文', '本当', '今回', '最近', '途中', '半分']);
function extractWords(text) {
  if (!text) return [];
  let tokens;
  if (typeof Intl !== 'undefined' && Intl.Segmenter) {
    tokens = [...new Intl.Segmenter('ja', { granularity: 'word' }).segment(text)].filter(s => s.isWordLike).map(s => s.segment);
  } else {
    tokens = text.match(/[一-龯々ァ-ヶーA-Za-z]{2,}/g) || [];
  }
  return tokens.filter(w => w.length >= 2 && !/^[ぁ-ゖー]+$/.test(w) && !/^[\d０-９]+$/.test(w) && !STOP_WORDS.has(w));
}
function topWords(texts, n = 24) {
  const freq = new Map();
  for (const t of texts) for (const w of new Set(extractWords(t))) freq.set(w, (freq.get(w) || 0) + 1);
  return [...freq].sort((a, b) => b[1] - a[1]).slice(0, n);
}

function buildNotes(st) {
  const notes = [];
  const { total, done, open, hard, hardByGenre, byGenre, bySource, avgDays, moodPick, ratedByGenre, clipsByGenre, recentGenre } = st;
  const tops = byGenre.filter(([, g]) => g.total === byGenre[0]?.[1].total);
  if (tops.length === 1) {
    const [topG, topGn] = tops[0];
    notes.push(`いちばん多く手に取っているのは「${topG}」の本（${topGn.total}冊・全体の${pct(topGn.total, total)}%）。`);
  } else if (tops.length > 1 && tops.length < byGenre.length) {
    notes.push(`${tops.map(([g]) => `「${g}」`).join('')}の本を同じくらい手に取っています（各${tops[0][1].total}冊）。`);
  } else if (tops.length > 1) {
    notes.push('いまはどのジャンルも同じくらい。幅広く手に取っています。');
  }
  const comparable = byGenre.filter(([, g]) => g.total >= 2);
  if (comparable.length >= 2) {
    const byRate = [...comparable].sort((a, b) => b[1].done / b[1].total - a[1].done / a[1].total);
    const [hi, lo] = [byRate[0], byRate[byRate.length - 1]];
    if (hi[1].done / hi[1].total > lo[1].done / lo[1].total) {
      notes.push(`「${hi[0]}」は最後まで読みきる率が高く（${pct(hi[1].done, hi[1].total)}%）、「${lo[0]}」は途中やまだ読んでないままになりやすいようです（読了${pct(lo[1].done, lo[1].total)}%）。`);
    }
  }
  if (total >= 4 && open / total >= 0.5) notes.push(`手に取った本の${pct(open, total)}%がまだ読んでないか、途中でひと休み中。読みたい気持ちが先に走るタイプかもしれません。`);
  else if (total >= 4 && done / total >= 0.6) notes.push(`手に取った本の${pct(done, total)}%を読み終えています。決めた本はきちんと読みきるタイプのようです。`);
  if (hard) {
    const [hg, hn] = hardByGenre[0];
    notes.push(hn >= 2
      ? `${HARD_BOX}には${hard}冊。「${hg}」の本が多め（${hn}冊）なので、入門書を一冊はさむと読みやすくなるかもしれません。`
      : `${HARD_BOX}には${hard}冊。むずかしい本にも手をのばしている、挑戦の記録です。`);
  }
  if (avgDays != null) notes.push(`手に取ってから読み終わるまで、平均${avgDays}日。`);
  const [topS, topSn] = bySource[0] || [];
  if (topS && total >= 3) notes.push(`「${sourceInfo(topS).label}」がいちばん多め（${pct(topSn, total)}%）。`);
  const topRated = ratedByGenre.filter(r => r.n >= 2).sort((a, b) => b.avg - a.avg)[0];
  if (topRated) notes.push(`満足度が高いのは「${topRated.genre}」の本（平均★${topRated.avg.toFixed(1)}）。`);
  const moodTop = Object.entries(moodPick).sort((a, b) => b[1] - a[1])[0];
  if (moodTop && moodTop[1] >= 2) notes.push(`手に取るきっかけは「${MOODS.find(m => m.id === moodTop[0]).label}」が多め。${MOOD_READING[moodTop[0]]}`);
  if (clipsByGenre[0] && clipsByGenre[0][1] >= 2) notes.push(`気になったページをいちばん残しているのは「${clipsByGenre[0][0]}」の本（${clipsByGenre[0][1]}件）。心が動きやすい分野なのかもしれません。`);
  if (recentGenre) notes.push(`最近30日は「${recentGenre}」の本をよく手に取っています。`);
  return notes;
}

function computeStats() {
  const total = books.length;
  const done = books.filter(b => b.status === 'done').length;
  const open = books.filter(b => b.status === 'unread' || b.status === 'tsundoku').length;
  const hmap = new Map();
  for (const b of books.filter(b => b.status === 'hard')) hmap.set(genreOf(b), (hmap.get(genreOf(b)) || 0) + 1);
  const hardByGenre = [...hmap].sort((a, b) => b[1] - a[1]);
  const hard = hardByGenre.reduce((a, [, n]) => a + n, 0);
  const clips = books.flatMap(b => (b.clips || []).map(c => ({ ...c, genre: genreOf(b) })));

  const gmap = new Map();
  for (const b of books) {
    const g = gmap.get(genreOf(b)) || { total: 0, done: 0 };
    g.total++; if (b.status === 'done') g.done++;
    gmap.set(genreOf(b), g);
  }
  const byGenre = [...gmap].sort((a, b) => b[1].total - a[1].total);

  const smap = new Map();
  for (const b of books) smap.set(b.source, (smap.get(b.source) || 0) + 1);
  const bySource = [...smap].sort((a, b) => b[1] - a[1]);

  const spans = books.filter(b => b.status === 'done' && b.pickedAt && b.finishedAt).map(b => daysBetween(b.pickedAt, b.finishedAt)).filter(d => d >= 0);
  const avgDays = spans.length ? Math.round(spans.reduce((a, b) => a + b, 0) / spans.length) : null;

  const rmap = new Map();
  for (const b of books.filter(b => b.rating)) {
    const r = rmap.get(genreOf(b)) || { genre: genreOf(b), sum: 0, n: 0 };
    r.sum += b.rating; r.n++; rmap.set(genreOf(b), r);
  }
  const ratedByGenre = [...rmap.values()].map(r => ({ ...r, avg: r.sum / r.n }));

  const cmap = new Map();
  for (const c of clips) cmap.set(c.genre, (cmap.get(c.genre) || 0) + 1);
  const clipsByGenre = [...cmap].sort((a, b) => b[1] - a[1]);

  // 直近30日に手に取った本のジャンル（3冊以上のとき）
  const recent = books.filter(b => b.pickedAt && daysBetween(b.pickedAt, today()) <= 30);
  let recentGenre = null;
  if (recent.length >= 3) {
    const rc = new Map();
    recent.forEach(b => rc.set(genreOf(b), (rc.get(genreOf(b)) || 0) + 1));
    const [g, n] = [...rc].sort((a, b) => b[1] - a[1])[0];
    if (n >= 2) recentGenre = g;
  }

  // 月ごと（直近6か月）
  const months = [];
  const now = new Date();
  for (let i = 5; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    months.push({
      key, label: `${d.getMonth() + 1}月`,
      picked: books.filter(b => (b.pickedAt || '').startsWith(key)).length,
      done: books.filter(b => (b.finishedAt || '').startsWith(key)).length,
    });
  }

  const moodPick = countMoods(books.map(b => b.pickMemo).filter(Boolean));
  const moodReview = countMoods(books.map(b => b.review).filter(Boolean));
  const words = topWords([...books.flatMap(b => [b.pickMemo, b.review]), ...clips.map(c => c.note)].filter(Boolean));
  const memoCount = books.filter(b => b.pickMemo).length + books.filter(b => b.review).length + clips.filter(c => c.note).length;

  return { total, done, open, hard, hardByGenre, clips: clips.length, byGenre, bySource, avgDays, ratedByGenre, clipsByGenre, recentGenre, months, moodPick, moodReview, words, memoCount };
}

function barsHTML(rows, max) {
  // rows: [{label, value, strong?}] — strong は「読了」部分
  return `<div class="bars">${rows.map(r => `
    <div class="bar-row" title="${esc(r.title || `${r.label}：${r.value}`)}">
      <span class="lbl">${esc(r.label)}</span>
      <span class="bar-track">
        ${r.strong ? `<span class="bar-fill done" style="width:${r.strong / max * 100}%"></span>` : ''}
        ${r.value - (r.strong || 0) > 0 ? `<span class="bar-fill" style="width:${(r.value - (r.strong || 0)) / max * 100}%"></span>` : ''}
      </span>
      <span class="val">${esc(r.valText ?? r.value)}</span>
    </div>`).join('')}</div>`;
}

function moodBars(counts) {
  const rows = MOODS.map(m => ({ label: m.label, value: counts[m.id] })).filter(r => r.value);
  if (!rows.length) return '<p class="ins-empty">まだ手がかりになることばがありません</p>';
  const max = Math.max(...rows.map(r => r.value));
  return barsHTML(rows.sort((a, b) => b.value - a.value).map(r => ({ ...r, valText: `${r.value}件` })), max);
}

function renderInsights() {
  const root = $('#view-insights');
  if (!books.length) {
    root.innerHTML = `<div class="welcome">${squirrel('hug')}<h2>まだふりかえる本がありません</h2><p>本を登録して、気持ちや感想を書きためていくと、ここにあなたの読書の傾向があらわれます。</p></div>`;
    return;
  }
  const st = computeStats();
  const notes = buildNotes(st);
  const maxG = Math.max(...st.byGenre.map(([, g]) => g.total));
  const maxS = Math.max(...st.bySource.map(([, n]) => n));
  const maxM = Math.max(1, ...st.months.flatMap(m => [m.picked, m.done]));
  const maxW = st.words[0]?.[1] || 1;

  root.innerHTML = `
    <p class="ins-lead">気持ちのメモや感想がたまるほど、くせや傾向がはっきり見えてきます。いまの記録：本${st.total}冊・メモ${st.memoCount}件</p>

    <section class="ins-card">
      <div class="ins-stats">
        <div class="ins-stat"><b>${st.total}</b><span>手に取った本</span></div>
        <div class="ins-stat"><b>${st.done}</b><span>読み終わり</span></div>
        <div class="ins-stat"><b>${st.open}</b><span>まだ・ひと休み中</span></div>
        ${st.hard ? `<div class="ins-stat"><b>${st.hard}</b><span>むずかしかった</span></div>` : ''}
        <div class="ins-stat"><b>${st.clips}</b><span>気になったページ</span></div>
      </div>
    </section>

    <section class="ins-card">
      <h2>あなたの読書のくせ</h2>
      <p class="sub">記録から自動で見つけた傾向です</p>
      ${notes.length ? `<ul class="ins-notes">${notes.map(n => `<li>${esc(n)}</li>`).join('')}</ul>` : '<p class="ins-empty">もう少し記録がたまると、ここに傾向が出てきます。</p>'}
    </section>

    <section class="ins-card ai-card" id="ai-card" hidden>
      <h2>Claudeに読み解いてもらう</h2>
      <p class="sub">気持ちのメモ・感想・気になったページのメモをClaudeが読んで、思考のくせや関心の流れを言葉にします。</p>
      <div class="ai-actions">
        <button type="button" class="btn primary" id="btn-ai">読み解いてもらう</button>
        <button type="button" class="btn ghost" id="btn-ai-stop" hidden>止める</button>
      </div>
      <div class="ai-out" id="ai-out" aria-live="polite"></div>
      <p class="ai-note" id="ai-note">押すと、本のタイトルと記録の文章をClaudeに送ります。あなたのClaudeの利用枠を使います。</p>
    </section>

    <section class="ins-card">
      <h2>ジャンル別</h2>
      <div class="legend"><span><i style="background:var(--bar-strong)"></i>読み終わり</span><span><i style="background:var(--bar)"></i>それ以外</span></div>
      ${barsHTML(st.byGenre.map(([g, n]) => ({ label: g, value: n.total, strong: n.done, valText: `${n.done}/${n.total}冊`, title: `${g}：${n.total}冊のうち${n.done}冊読了` })), maxG)}
    </section>

    <section class="ins-card">
      <h2>手に取るとき・読んだあとの気持ち</h2>
      <p class="sub">メモに出てくることばから分類しています</p>
      <div class="mood-cols">
        <div><h3>手に取ったときのきっかけ</h3>${moodBars(st.moodPick)}</div>
        <div><h3>読んだあとに残ったもの</h3>${moodBars(st.moodReview)}</div>
      </div>
    </section>

    <section class="ins-card">
      <h2>よく出てくることば</h2>
      <p class="sub">気持ちのメモ・感想・ページのメモから</p>
      ${st.words.length ? `<div class="words">${st.words.map(([w, c]) => `<span style="font-size:${(0.85 + c / maxW * 0.9).toFixed(2)}rem;font-weight:${c / maxW > 0.6 ? 700 : 500}" title="${esc(w)}：${c}件">${esc(w)}<small>${c}</small></span>`).join('')}</div>` : '<p class="ins-empty">メモがたまると、ここに出てきます。</p>'}
    </section>

    <section class="ins-card">
      <h2>月ごとの記録</h2>
      <div class="legend"><span><i style="background:var(--bar)"></i>手に取った</span><span><i style="background:var(--bar-strong)"></i>読み終わった</span></div>
      <div class="months">
        ${st.months.map(m => `
          <div class="month" title="${m.label}：手に取った${m.picked}冊・読み終わった${m.done}冊">
            <div class="cols">
              <span class="col" style="height:${m.picked / maxM * 100}%"></span>
              <span class="col done" style="height:${m.done / maxM * 100}%"></span>
            </div>
            <span class="m">${m.label}</span>
          </div>`).join('')}
      </div>
    </section>

    <section class="ins-card">
      <h2>どこの本？</h2>
      ${barsHTML(st.bySource.map(([s, n]) => ({ label: sourceInfo(s).label, value: n, valText: `${n}冊` })), maxS)}
    </section>
  `;
  setupAI();
}

/* ---------- Claudeに読み解いてもらう（公開版のみ） ---------- */
let samplePromise = null;
const getSample = () => samplePromise ||= (window.claude?.use ? window.claude.use('sample').catch(() => null) : Promise.resolve(null));
let aiCtl = null;
let aiText = '';

async function setupAI() {
  const sample = await getSample();
  const card = $('#ai-card');
  if (!sample || !card) return;
  card.hidden = false;
  if (aiText) $('#ai-out').textContent = aiText;
  $('#btn-ai').onclick = () => runAI(sample);
  $('#btn-ai-stop').onclick = () => aiCtl?.abort();
}

function recordsForAI() {
  const clip = (s, n = 300) => (s || '').slice(0, n);
  return books.slice(0, 120).map(b => {
    const lines = [`■『${b.title}』${b.author ? ` ${b.author}` : ''}／ジャンル:${genreOf(b)}／どこの本:${sourceInfo(b.source).label}／状況:${statusOf(b.status).label}${b.rating ? `／★${b.rating}` : ''}${b.pickedAt ? `／手に取った日:${b.pickedAt}` : ''}${b.finishedAt ? `／読了:${b.finishedAt}` : ''}`];
    if (b.pickMemo) lines.push(`手に取ったときの気持ち：${clip(b.pickMemo)}`);
    if (b.review) lines.push(`読後の感想：${clip(b.review, 500)}`);
    for (const c of (b.clips || []).filter(c => c.note).slice(0, 8)) lines.push(`気になったページ${c.page ? `(p.${c.page})` : ''}：${clip(c.note, 200)}`);
    return lines.join('\n');
  }).join('\n\n');
}

async function runAI(sample) {
  const out = $('#ai-out'), btn = $('#btn-ai'), stop = $('#btn-ai-stop'), note = $('#ai-note');
  aiCtl = new AbortController();
  btn.disabled = true; stop.hidden = false;
  out.textContent = '読み解いています…（30秒ほどかかることがあります）';
  const prompt = `あなたは、ある人の読書記録をいっしょにふりかえる、やさしく率直な聞き手です。
以下はその人が「手に取った本」の記録です（タイトル、ジャンル、家の本か図書館の本かなど、読書の状況、手に取ったときの気持ち、読後の感想、気になったページのメモ）。

この記録だけを根拠に、日本語で次の4つを書いてください。
【関心の流れ】いま何に関心が向いていて、どう移り変わっているか
【思考のくせ】ものの考え方や、本との付き合い方に見えるくせ（よい面と、気をつけるとよい面の両方）
【気持ちのパターン】どんな気持ちのときに本を手に取り、読んだあと何が残っているか
【次の一冊へのヒント】次に手に取るとよさそうなテーマや、読み方の小さな提案（具体的な書名は挙げなくてよい）

ルール：
- 記録の中のことばを「」で短く引用して根拠を示す
- 断定しすぎず、「〜かもしれません」くらいの温度で
- 診断や評価ではなく、本人が自分を知るための手がかりとして書く
- 見出しは【】で囲み、各見出しの下は2〜4文。マークダウン記法（#や*）は使わない
- 全体で600字程度

記録：
${recordsForAI()}`;
  try {
    const { text, truncated } = await sample(prompt, {
      signal: aiCtl.signal,
      cache: { gcTime: 864e5 },
      onText: ({ text }) => { out.textContent = text; },
    });
    aiText = text;
    note.textContent = truncated ? '途中で切れてしまいました。もう一度試すと続きが出ることがあります。' : `${new Date().toLocaleString('ja-JP')} 時点の記録をもとにしています。`;
    btn.textContent = 'もう一度読み解いてもらう';
  } catch (e) {
    out.textContent = e.text || '';
    const msg = {
      cancelled: '止めました。',
      not_granted: 'Claudeの利用が許可されなかったため、使えません。',
      sampling_disabled: 'このアカウントではClaudeの読み解きを使えません。',
      rate_limited: '少し時間をおいてから、もう一度押してください。',
      session_expired: 'Claudeにもう一度ログインしてから試してください。',
      refused: 'この内容では読み解きができませんでした。',
      prompt_too_large: '記録が多すぎて送りきれませんでした。',
    }[e.code] || 'うまくいきませんでした。時間をおいてもう一度試してください。';
    note.textContent = msg;
    if (['not_granted', 'sampling_disabled', 'not_declared', 'capability_disabled', 'capability_removed'].includes(e.code)) btn.hidden = true;
  } finally {
    btn.disabled = false; stop.hidden = true;
  }
}

/* ================= 今日のひとこと ================= */
let dailyItems = [];
let dailyIndex = 0;

function buildDailyPool() {
  const pool = [];
  const t = today();
  for (const b of books) {
    for (const c of b.clips || []) {
      if (c.note || c.photo) pool.push({ text: c.note || '（写真で残したページ）', from: `『${b.title}』${c.page ? ` p.${c.page}` : ''} で気になったページ`, photo: c.photo, bookId: b.id, w: 3 });
    }
    if (b.review) pool.push({ text: b.review, from: b.status === 'hard' ? `『${b.title}』に挑んだあなた` : `『${b.title}』を読み終えたあなた${b.finishedAt ? `（${fmtDate(b.finishedAt)}）` : ''}`, bookId: b.id, w: 3 });
    if (b.pickMemo && b.pickedAt) {
      const d = daysBetween(b.pickedAt, t);
      pool.push({ text: b.pickMemo, from: `${d > 0 ? `${d}日前、` : '今日、'}『${b.title}』を手に取ったあなた`, bookId: b.id, w: 2 });
    }
    if (b.status === 'hard' && b.pickedAt && daysBetween(b.pickedAt, t) >= 30) pool.push({
      text: `${HARD_BOX}の『${b.title}』。あれから少し経ちました。いまなら、すこし読めるかもしれません。`,
      from: '本棚からのおたより', bookId: b.id, w: 1,
    });
    if ((b.status === 'tsundoku' || b.status === 'unread') && b.pickedAt) {
      const d = daysBetween(b.pickedAt, t);
      if (d >= 7) pool.push({
        text: b.status === 'tsundoku' ? `『${b.title}』をひと休みして${d}日。今日は続きを5ページだけ、開いてみませんか？` : `『${b.title}』を手に取って${d}日。最初の1ページ、のぞいてみませんか？`,
        from: b.pickMemo ? `手に取ったときは「${b.pickMemo.slice(0, 40)}${b.pickMemo.length > 40 ? '…' : ''}」` : '本棚からのおたより', bookId: b.id, w: 1,
      });
    }
  }
  if (!pool.length) {
    pool.push(
      { text: '気になった本を手に取ったら、そのときの気持ちをひとこと残してみましょう。', from: 'Yonda! より' },
      { text: '今日は1ページだけでも。', from: 'Yonda! より' },
      { text: 'そのとき手に取った理由は、そのときにしか書けません。', from: 'Yonda! より' },
    );
  }
  // 日付で決まる順番に並べる（同じ日は同じひとことから始まる）
  let seed = [...t].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 7);
  const rand = () => (seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32;
  return pool.map(p => ({ p, k: rand() / (p.w || 1) })).sort((a, b) => a.k - b.k).map(x => x.p);
}

function renderDaily() {
  const item = dailyItems[dailyIndex % dailyItems.length];
  $('#daily-date').textContent = new Date().toLocaleDateString('ja-JP', { month: 'long', day: 'numeric', weekday: 'short' });
  $('#daily-body').innerHTML = `
    <p class="daily-quote">${esc(item.text)}</p>
    ${item.photo ? `<img class="daily-photo" src="${item.photo}" alt="記録したページの写真">` : ''}
    <p class="daily-from">— ${esc(item.from)}</p>`;
  $('#btn-daily-open').hidden = !item.bookId;
  $('#btn-daily-next').hidden = dailyItems.length < 2;
}

function openDaily() {
  dailyItems = buildDailyPool();
  dailyIndex = 0;
  renderDaily();
  $('#dlg-daily').showModal();
}
$('#btn-daily').addEventListener('click', openDaily);
$('#btn-daily-next').addEventListener('click', () => { dailyIndex++; renderDaily(); });
$('#btn-daily-open').addEventListener('click', () => {
  const item = dailyItems[dailyIndex % dailyItems.length];
  $('#dlg-daily').close();
  if (item.bookId) openDetail(item.bookId);
});

/* ================= 今日の一冊 ================= */
// 「まだ読んでない」「途中でひと休み」の本から、1日1冊をランダムにおすすめする
const pickCandidates = () => books.filter(b => b.status === 'unread' || b.status === 'tsundoku');
let pickId = null;

function randomPick(excludeId) {
  const list = pickCandidates();
  const others = list.filter(b => b.id !== excludeId);
  const from = others.length ? others : list;
  return from.length ? from[Math.floor(Math.random() * from.length)] : null;
}

// 今日の一冊を決める（同じ日は同じ本。前の日と同じ本はなるべく避ける）
async function todaysPick() {
  const list = pickCandidates();
  let saved = null;
  try { saved = await db.getMeta('pickOfDay'); } catch { /* 保存できない環境 */ }
  if (saved?.date === today() && list.some(b => b.id === saved.id)) return books.find(b => b.id === saved.id);
  const b = randomPick(saved?.id);
  if (b) { try { await db.setMeta('pickOfDay', { date: today(), id: b.id }); } catch { /* 表示はする */ } }
  return b;
}

function pickMessage(b) {
  const d = b.pickedAt ? daysBetween(b.pickedAt, today()) : 0;
  const lib = b.source === '図書館' || b.source === 'レンタル' || b.source === '借りた';
  if (b.status === 'tsundoku') {
    return `途中でひと休みしている本です。前のところから、5ページだけ続きをどうですか？${lib ? '返す前に、もうひと押し。' : ''}`;
  }
  return `${d >= 1 ? `手に取って${d}日。` : ''}最初の1ページ、のぞいてみませんか？${lib ? '借りている本なので、返す前に少しだけでも。' : ''}`;
}

function renderPick() {
  const b = books.find(x => x.id === pickId);
  $('#pick-date').textContent = new Date().toLocaleDateString('ja-JP', { month: 'long', day: 'numeric', weekday: 'short' });
  if (!b) {
    $('#pick-body').innerHTML = `<p class="pick-msg">「まだ読んでない」「途中でひと休み」の本がありません。今は読みたい本を読みきれているようです。</p>`;
    ['#btn-pick-next', '#btn-pick-open', '#btn-pick-start'].forEach(s => $(s).hidden = true);
    return;
  }
  const st = statusOf(b.status);
  const src = sourceInfo(b.source);
  $('#pick-body').innerHTML = `
    <div class="pick">
      <div class="pick-cover">${coverHTML(b)}</div>
      <div class="pick-info">
        <p class="pick-lead">リスのおすすめ</p>
        <h3 class="pick-title">${esc(b.title)}</h3>
        ${b.author ? `<p class="pick-author">${esc(b.author)}</p>` : ''}
        <p class="pick-tags">
          <span class="pick-st" style="background:${st.color}">${st.label}</span>
          ${src.mark ? `<span class="place-mark ${src.cls}">${src.label}</span>` : ''}
        </p>
      </div>
    </div>
    <p class="pick-msg">${esc(pickMessage(b))}</p>
    ${b.pickMemo ? `<p class="daily-from">手に取ったときは「${esc(b.pickMemo.slice(0, 80))}${b.pickMemo.length > 80 ? '…' : ''}」</p>` : ''}`;
  $('#btn-pick-next').hidden = pickCandidates().length < 2;
  $('#btn-pick-open').hidden = false;
  $('#btn-pick-start').hidden = false;
  $('#btn-pick-start').textContent = b.status === 'tsundoku' ? '続きを読む' : '読み始める';
}

async function openPick() {
  pickId = (await todaysPick())?.id || null;
  renderPick();
  $('#dlg-pick').showModal();
}
$('#btn-pick').addEventListener('click', openPick);
$('#btn-pick-next').addEventListener('click', async () => {
  const b = randomPick(pickId);
  if (!b) return;
  pickId = b.id;
  try { await db.setMeta('pickOfDay', { date: today(), id: b.id }); } catch { /* 表示はする */ }
  renderPick();
});
$('#btn-pick-open').addEventListener('click', () => {
  $('#dlg-pick').close();
  if (pickId) openDetail(pickId);
});
$('#btn-pick-start').addEventListener('click', async () => {
  const b = books.find(x => x.id === pickId);
  if (!b) return;
  b.status = 'reading';
  b.updatedAt = Date.now();
  await db.putBook(b);
  $('#dlg-pick').close();
  renderShelves();
  toast(`『${b.title.slice(0, 20)}${b.title.length > 20 ? '…' : ''}』を「読んでいる」にしました。いってらっしゃい！`);
});

// 1日1回、その日はじめて開いたときに自動で出す
// （「まだ読んでない」「途中でひと休み」の本があれば今日の一冊、なければ今日のひとこと）
async function maybeShowDaily() {
  try {
    if ((await db.getMeta('dailyShown')) === today()) return;
  } catch { /* 保存できなくても表示はする */ }
  const [open, dlg] = pickCandidates().length ? [openPick, '#dlg-pick'] : [openDaily, '#dlg-daily'];
  // 自分で閉じたときに「今日は見た」とする（途中で読み込み直しが入っても、もう一度出せるように）
  $(dlg).addEventListener('close', () => db.setMeta('dailyShown', today()).catch(() => {}), { once: true });
  setTimeout(open, 400);
}

/* ================= 全体のイベント ================= */
$('#btn-add').addEventListener('click', () => openForm());
$('#btn-add-top').addEventListener('click', () => openForm());
$('#btn-settings').addEventListener('click', () => { renderGenreList(); $('#dlg-settings').showModal(); });
$('#search').addEventListener('input', e => { query = e.target.value.trim(); renderShelves(); });
$('#status-filter').addEventListener('click', e => {
  const b = e.target.closest('[data-status]');
  if (b) { filterStatus = b.dataset.status; renderShelves(); }
});
$('#shelves').addEventListener('click', e => {
  const book = e.target.closest('.book');
  if (book) return openDetail(book.dataset.id);
  const act = e.target.closest('[data-action]')?.dataset.action;
  if (act === 'add') openForm();
  if (act === 'sample') addSamples();
});

// 閉じるボタンと、背景クリックで閉じる
document.querySelectorAll('dialog').forEach(dlg => {
  dlg.addEventListener('click', e => {
    if (e.target.closest('[data-close]') || e.target === dlg) dlg.close();
  });
});
$('#dlg-detail').addEventListener('close', () => { currentId = null; });

/* ================= 起動 ================= */
// お試し版（window.YONDA_DEMO）では、初回にサンプルを並べた状態で開く
const DEMO = !!window.YONDA_DEMO;

(async function init() {
  try {
    genres = (await db.getMeta('genres')) || DEFAULT_GENRES.slice();
    books = await db.allBooks();
    if (DEMO && !books.length && !(await db.getMeta('seeded'))) {
      await db.setMeta('seeded', true);
      await addSamples();
    }
  } catch {
    genres = DEFAULT_GENRES.slice();
    toast('このブラウザでは記録を保存できません（プライベートモードなど）');
  }
  renderShelves();
  if (books.length) maybeShowDaily();
  if (!DEMO && 'serviceWorker' in navigator && location.protocol.startsWith('http')) {
    navigator.serviceWorker.register('sw.js').then(reg => reg.update()).catch(() => {});
    // 新しい版に入れ替わったら、一度だけ読み込み直して最新の画面にする
    const hadController = !!navigator.serviceWorker.controller;
    let reloaded = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      // 何か画面を開いている最中なら読み込み直さない（次に開いたときに新しい版になる）
      if (!hadController || reloaded || document.querySelector('dialog[open]')) return;
      reloaded = true;
      location.reload();
    });
  }
})();
