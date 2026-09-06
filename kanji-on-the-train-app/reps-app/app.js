/* ---------- Register service worker ---------- */
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js'));
}

/* ---------- IndexedDB ---------- */
const DB_NAME = 'reps-db';
const DB_VERSION = 1;
let db;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const d = e.target.result;
      if (!d.objectStoreNames.contains('decks')) {
        d.createObjectStore('decks', { keyPath: 'id' });
      }
      if (!d.objectStoreNames.contains('cards')) {
        const store = d.createObjectStore('cards', { keyPath: 'id' });
        store.createIndex('deckId', 'deckId', { unique: false });
      }
    };
    req.onsuccess = (e) => resolve(e.target.result);
    req.onerror = (e) => reject(e.target.error);
  });
}

function tx(storeName, mode) {
  return db.transaction(storeName, mode).objectStore(storeName);
}

function idbGetAll(storeName, indexName, query) {
  return new Promise((resolve, reject) => {
    const store = tx(storeName, 'readonly');
    const source = indexName ? store.index(indexName) : store;
    const req = query ? source.getAll(query) : source.getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbGet(storeName, key) {
  return new Promise((resolve, reject) => {
    const req = tx(storeName, 'readonly').get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbPut(storeName, value) {
  return new Promise((resolve, reject) => {
    const req = tx(storeName, 'readwrite').put(value);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/* ---------- Scheduler (SM-2 style) ----------
   Grades: 1=Again, 2=Hard, 3=Good, 4=Easy
   Persisted state per card: interval (days), ease, reps, state, dueAt (ms), history[]
*/
function previewIntervals(card) {
  // Returns human-readable interval labels for the four buttons, without mutating the card.
  const again = '<10m';
  const clone = (g) => {
    const c = { ...card };
    applyGrade(c, g, true);
    return c.interval;
  };
  const fmt = (days) => days < 1 ? '<1d' : days === 1 ? '1d' : days < 30 ? `${days}d` : days < 365 ? `${Math.round(days/30)}mo` : `${(days/365).toFixed(1)}y`;
  return {
    again,
    hard: fmt(clone(2)),
    good: fmt(clone(3)),
    easy: fmt(clone(4)),
  };
}

function applyGrade(card, grade, dryRun) {
  const now = Date.now();
  if (grade === 1) {
    card.reps = 0;
    card.interval = 1;
    card.ease = Math.max(1.3, card.ease - 0.2);
    card.state = 'learning';
    card.dueAt = now + 10 * 60 * 1000; // resurfaces same session; persisted due is effectively "soon"
    card.persistedDueAt = now + 1 * 86400000; // if not seen again this session, due tomorrow
  } else {
    card.reps += 1;
    if (card.reps === 1) card.interval = 1;
    else if (card.reps === 2) card.interval = 6;
    else card.interval = Math.round(card.interval * card.ease);

    if (grade === 2) card.ease = Math.max(1.3, card.ease - 0.15);
    else if (grade === 4) card.ease = card.ease + 0.15;

    if (card.interval > 1) {
      const fuzz = 1 + (Math.random() * 0.1 - 0.05);
      card.interval = Math.max(1, Math.round(card.interval * fuzz));
    }
    card.state = card.interval >= 21 ? 'mature' : 'learning';
    card.dueAt = now + card.interval * 86400000;
    card.persistedDueAt = card.dueAt;
  }
  if (!dryRun) {
    card.history = card.history || [];
    card.history.push({ date: now, grade });
  }
  return card;
}

/* ---------- apkg import ---------- */
let sqlJsPromise = null;
function getSqlJs() {
  if (!sqlJsPromise) {
    sqlJsPromise = initSqlJs({
      locateFile: () => 'https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.10.3/sql-wasm.wasm',
    });
  }
  return sqlJsPromise;
}

async function importDeck(manifestEntry, statusEl) {
  const { id, name, file } = manifestEntry;
  statusEl && (statusEl.textContent = `Fetching ${name}…`);
  const resp = await fetch(file, { cache: 'no-store' });
  if (!resp.ok) throw new Error(`Could not fetch ${file}`);
  const buf = new Uint8Array(await resp.arrayBuffer());

  statusEl && (statusEl.textContent = `Unpacking ${name}…`);
  const files = fflate.unzipSync(buf);

  let dbBytes = null;
  if (files['collection.anki21b']) {
    throw new Error(
      `${name}: this .apkg uses newer zstd-compressed export. Re-export from Anki with "Support older Anki versions" checked.`
    );
  } else if (files['collection.anki21']) {
    dbBytes = files['collection.anki21'];
  } else if (files['collection.anki2']) {
    dbBytes = files['collection.anki2'];
  } else {
    throw new Error(`${name}: no readable collection found inside the package.`);
  }

  statusEl && (statusEl.textContent = `Reading ${name}…`);
  const SQL = await getSqlJs();
  const sdb = new SQL.Database(dbBytes);
  const res = sdb.exec('SELECT id, flds FROM notes');
  sdb.close();

  if (!res.length) return { imported: 0 };

  const rows = res[0].values; // [[noteId, flds], ...]
  const existing = await idbGetAll('cards', 'deckId', id);
  const existingIds = new Set(existing.map((c) => c.id));

  let imported = 0;
  for (const [noteId, flds] of rows) {
    const cardId = `${id}:${noteId}`;
    if (existingIds.has(cardId)) continue; // preserve existing progress
    const fields = String(flds).split('\x1f');
    const front = (fields[0] || '').trim();
    const back = (fields[1] || '').trim();
    if (!front) continue;
    await idbPut('cards', {
      id: cardId,
      deckId: id,
      front,
      back,
      interval: 0,
      ease: 2.5,
      reps: 0,
      state: 'new',
      suspended: false,
      dueAt: Date.now(),
      history: [],
    });
    imported++;
  }

  await idbPut('decks', { id, name, importedAt: Date.now(), sourceFile: file });
  return { imported };
}

async function syncAllDecks(statusEl) {
  statusEl && (statusEl.textContent = 'Checking for decks…');
  try {
    const resp = await fetch('decks.json', { cache: 'no-store' });
    if (!resp.ok) throw new Error('no manifest');
    const manifest = await resp.json();
    let total = 0;
    for (const entry of manifest.decks) {
      try {
        const { imported } = await importDeck(entry, statusEl);
        total += imported;
      } catch (err) {
        console.error(err);
        statusEl && (statusEl.textContent = err.message);
        await new Promise((r) => setTimeout(r, 2500));
      }
    }
    statusEl && (statusEl.textContent = total > 0 ? `Added ${total} new card${total === 1 ? '' : 's'}.` : 'Up to date.');
  } catch (err) {
    statusEl && (statusEl.textContent = 'Offline — showing decks already on this phone.');
  }
  setTimeout(() => { if (statusEl) statusEl.textContent = ''; }, 3500);
}

/* ---------- Deck list screen ---------- */
const deckListEl = document.getElementById('deckList');
const statusEl = document.getElementById('status');
const syncBtn = document.getElementById('syncBtn');

async function renderDeckList() {
  const decks = await idbGetAll('decks');
  if (!decks.length) {
    deckListEl.innerHTML = `<div class="empty-state">No decks yet.<br>Tap "Sync decks" to fetch from the repo (needs a connection once).</div>`;
    return;
  }
  const now = Date.now();
  const rows = [];
  for (const deck of decks) {
    const cards = await idbGetAll('cards', 'deckId', deck.id);
    const due = cards.filter((c) => !c.suspended && c.dueAt <= now).length;
    const newCt = cards.filter((c) => c.state === 'new').length;
    const learningCt = cards.filter((c) => c.state === 'learning').length;
    const matureCt = cards.filter((c) => c.state === 'mature').length;
    rows.push({ deck, due, newCt, learningCt, matureCt, total: cards.length });
  }
  deckListEl.innerHTML = rows.map((r) => `
    <div class="deck-row" data-deck="${r.deck.id}">
      <div>
        <div class="deck-name">${escapeHtml(r.deck.name)}</div>
        <div class="deck-sub">${r.newCt} new · ${r.learningCt} learning · ${r.matureCt} mature</div>
      </div>
      <div class="deck-due ${r.due === 0 ? 'zero' : ''}">${r.due}</div>
    </div>
  `).join('');
  deckListEl.querySelectorAll('.deck-row').forEach((row) => {
    row.addEventListener('click', () => openDeck(row.dataset.deck));
  });
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (m) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
}

syncBtn.addEventListener('click', async () => {
  await syncAllDecks(statusEl);
  await renderDeckList();
});

/* ---------- Review screen ---------- */
const deckScreen = document.getElementById('deckScreen');
const reviewScreen = document.getElementById('reviewScreen');
const cardArea = document.getElementById('cardArea');
const CARD_AREA_TEMPLATE = cardArea.innerHTML;
let cardFront, cardBack, backWrap;
function bindCardAreaRefs() {
  cardFront = document.getElementById('cardFront');
  cardBack = document.getElementById('cardBack');
  backWrap = document.getElementById('backWrap');
}
bindCardAreaRefs();
const tapHint = document.getElementById('tapHint');
const gradeRow = document.getElementById('gradeRow');
const progressFill = document.getElementById('progressFill');
const backBtn = document.getElementById('backBtn');
const undoBtn = document.getElementById('undoBtn');

let session = null; // { deckId, queue: [cardId,...], seen: Set, requeueCount: Map, totalCount, doneCount, current: card, lastAction: {...} }

async function openDeck(deckId) {
  cardArea.innerHTML = CARD_AREA_TEMPLATE;
  bindCardAreaRefs();
  const now = Date.now();
  const cards = await idbGetAll('cards', 'deckId', deckId);
  const due = cards.filter((c) => !c.suspended && c.dueAt <= now).sort((a, b) => a.dueAt - b.dueAt);
  session = {
    deckId,
    queue: due.map((c) => c.id),
    seen: new Set(),
    requeueCount: new Map(),
    totalCount: due.length,
    doneCount: 0,
    lastAction: null,
  };
  deckScreen.classList.remove('active');
  reviewScreen.classList.add('active');
  showNextCard();
}

function closeReview() {
  reviewScreen.classList.remove('active');
  deckScreen.classList.add('active');
  session = null;
  renderDeckList();
}
backBtn.addEventListener('click', closeReview);

async function showNextCard() {
  updateProgress();
  if (!session.queue.length) {
    renderDone();
    return;
  }
  const cardId = session.queue.shift();
  const card = await idbGet('cards', cardId);
  session.current = card;
  backWrap.style.display = 'none';
  gradeRow.classList.remove('visible');
  tapHint.style.display = 'block';
  cardFront.textContent = card.front;
  cardBack.textContent = card.back;
}

function updateProgress() {
  const pct = session.totalCount === 0 ? 100 : Math.min(100, Math.round((session.doneCount / session.totalCount) * 100));
  progressFill.style.width = pct + '%';
}

cardArea.addEventListener('click', () => {
  if (!session || !session.current) return;
  if (backWrap.style.display === 'none') {
    backWrap.style.display = 'block';
    gradeRow.classList.add('visible');
    tapHint.style.display = 'none';
    const preview = previewIntervals(session.current);
    document.getElementById('ivlAgain').textContent = preview.again;
    document.getElementById('ivlHard').textContent = preview.hard;
    document.getElementById('ivlGood').textContent = preview.good;
    document.getElementById('ivlEasy').textContent = preview.easy;
  }
});

gradeRow.addEventListener('click', async (e) => {
  const btn = e.target.closest('.grade-btn');
  if (!btn || !session || !session.current) return;
  const grade = parseInt(btn.dataset.grade, 10);
  await handleGrade(grade);
});

async function handleGrade(grade) {
  const card = session.current;
  const alreadySeen = session.seen.has(card.id);

  if (!alreadySeen) {
    const snapshot = JSON.parse(JSON.stringify(card));
    applyGrade(card, grade);
    await idbPut('cards', card);
    session.seen.add(card.id);
    session.doneCount++;
    session.lastAction = { cardId: card.id, snapshot, wasRequeued: false, doneCountBefore: session.doneCount - 1 };

    if (grade === 1) {
      const pos = Math.min(session.queue.length, 4);
      session.queue.splice(pos, 0, card.id);
      session.lastAction.wasRequeued = true;
      session.lastAction.requeuePos = pos;
    }
    undoBtn.classList.add('visible');
  } else {
    // Same-session re-encounter: extra practice only, no further persistence.
    session.lastAction = null;
    undoBtn.classList.remove('visible');
    const count = session.requeueCount.get(card.id) || 0;
    if (grade === 1 && count < 2) {
      session.requeueCount.set(card.id, count + 1);
      const pos = Math.min(session.queue.length, 4);
      session.queue.splice(pos, 0, card.id);
    }
  }
  showNextCard();
}

undoBtn.addEventListener('click', async () => {
  if (!session || !session.lastAction) return;
  const { cardId, snapshot, wasRequeued } = session.lastAction;
  await idbPut('cards', snapshot);
  session.seen.delete(cardId);
  session.doneCount = Math.max(0, session.doneCount - 1);
  if (wasRequeued) {
    const idx = session.queue.indexOf(cardId);
    if (idx !== -1) session.queue.splice(idx, 1);
  }
  session.queue.unshift(cardId);
  session.lastAction = null;
  undoBtn.classList.remove('visible');
  showNextCard();
});

function renderDone() {
  updateProgress();
  cardArea.innerHTML = `
    <div class="done-panel">
      <div class="big">All caught up</div>
      <div class="small">${session.doneCount} review${session.doneCount === 1 ? '' : 's'} this session</div>
      <button id="doneBackBtn">Back to decks</button>
    </div>
  `;
  tapHint.style.display = 'none';
  gradeRow.classList.remove('visible');
  document.getElementById('doneBackBtn').addEventListener('click', closeReview);
}

/* ---------- Boot ---------- */
(async function boot() {
  db = await openDB();
  await renderDeckList();
  syncAllDecks(statusEl).then(renderDeckList);
})();
