// Kartendaten und Preise über die freie TCGdex-API (https://tcgdex.dev).
const BASE = 'https://api.tcgdex.net/v2';
const SET_CACHE_MS = 24 * 60 * 60 * 1000;

const memo = new Map();

async function getJSON(url, tries = 3) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url);
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      // Bei Überlastung antwortet der Server manchmal mit Klartext statt JSON
      return JSON.parse(text);
    } catch (err) {
      lastErr = err;
      await new Promise(r => setTimeout(r, 600 * (i + 1)));
    }
  }
  throw lastErr;
}

function cached(key, fn) {
  if (!memo.has(key)) memo.set(key, fn().catch(err => { memo.delete(key); throw err; }));
  return memo.get(key);
}

// TCG-Pocket-Sets (digitale Karten) ausblenden
const isPocketSet = id => /^(A\d|B\d|P-[AB])/.test(id);

/** Alle Sets (DE + EN zusammengeführt), einen Tag lang zwischengespeichert. */
export function getSets() {
  return cached('sets', async () => {
    try {
      const saved = JSON.parse(localStorage.getItem('cv.sets') || 'null');
      if (saved && Date.now() - saved.t < SET_CACHE_MS) return saved.sets;
    } catch { /* Cache ignorieren */ }
    const [de, en] = await Promise.all([
      getJSON(`${BASE}/de/sets`).catch(() => []),
      getJSON(`${BASE}/en/sets`).catch(() => []),
    ]);
    const byId = new Map();
    (en || []).forEach((s, i) => byId.set(s.id, { ...s, order: i }));
    (de || []).forEach(s => byId.set(s.id, { ...byId.get(s.id), ...s, nameEn: byId.get(s.id)?.name }));
    const sets = [...byId.values()].filter(s => !isPocketSet(s.id));
    sets.forEach((s, i) => { if (s.order == null) s.order = i; });
    try { localStorage.setItem('cv.sets', JSON.stringify({ t: Date.now(), sets })); } catch { /* voll */ }
    return sets;
  });
}

export async function setName(id) {
  const sets = await getSets();
  return sets.find(s => s.id === id)?.name || id;
}

function getSet(lang, id) {
  return cached(`set:${lang}:${id}`, () => getJSON(`${BASE}/${lang}/sets/${encodeURIComponent(id)}`));
}

/** Vollständige Karte inkl. Preise. Fällt auf Englisch zurück, wenn es keine deutsche Version gibt. */
export async function getCard(id, lang = 'de') {
  const order = lang === 'de' ? ['de', 'en'] : ['en', 'de'];
  for (const l of order) {
    const card = await getJSON(`${BASE}/${l}/cards/${encodeURIComponent(id)}`);
    if (!card) continue;
    // Alte deutsche Karten haben oft kein Bild – dann das englische nehmen
    if (!card.image) {
      const other = await getJSON(`${BASE}/${l === 'de' ? 'en' : 'de'}/cards/${encodeURIComponent(id)}`).catch(() => null);
      if (other?.image) card.image = other.image;
    }
    return { ...card, lang: l };
  }
  return null;
}

/** Suche nach Name (Teiltreffer), optional mit Kartennummer. */
export async function searchCards(query, lang = 'de') {
  const { name, number } = parseQuery(query);
  if (!name) return [];
  const params = new URLSearchParams({ name, 'pagination:itemsPerPage': '250' });
  const langs = lang === 'de' ? ['de', 'en'] : ['en', 'de'];
  let list = [];
  for (const l of langs) {
    list = (await getJSON(`${BASE}/${l}/cards?${params}`) || []).filter(c => !isPocketSet(c.id));
    if (number) list = list.filter(c => normalizeId(c.localId) === normalizeId(number));
    if (list.length) { list.forEach(c => { c.lang = l; }); break; }
  }
  return sortByRecency(list);
}

function parseQuery(q) {
  const m = q.trim().match(/^(.*?)\s*#?(\d{1,3})(?:\s*\/\s*\d{1,3})?$/);
  if (m && m[1]) return { name: m[1].trim(), number: String(parseInt(m[2], 10)) };
  return { name: q.trim(), number: null };
}

async function sortByRecency(list) {
  const sets = await getSets();
  const order = new Map(sets.map(s => [s.id, s.order]));
  return list.sort((a, b) => (order.get(setIdOf(b.id)) ?? -1) - (order.get(setIdOf(a.id)) ?? -1));
}

export const setIdOf = cardId => cardId.slice(0, cardId.lastIndexOf('-'));

/** Alle vorkommenden Set-Größen – für die unscharfe Nummernsuche. */
export async function setTotals() {
  const sets = await getSets();
  return new Set(sets.flatMap(s => [s.cardCount?.official, s.cardCount?.total]).filter(Boolean));
}

/**
 * Findet Karten anhand der gedruckten Nummer (z. B. 025/165).
 * Die Gesamtzahl grenzt die möglichen Sets ein, der erkannte Name (DE oder EN) entscheidet bei Gleichstand.
 */
export async function findByNumber({ prefix = '', num, total }, nameText = '', lang = 'de') {
  const sets = await getSets();
  const totalN = parseInt(total, 10);
  let candidates = sets.filter(s => s.cardCount?.official === totalN);
  if (!candidates.length) candidates = sets.filter(s => s.cardCount?.total === totalN);
  candidates = candidates.sort((a, b) => b.order - a.order).slice(0, 10);

  const wanted = normalizeId(prefix ? `${prefix}${num}` : num);
  const langs = lang === 'de' ? ['de', 'en'] : ['en', 'de'];
  const results = [];
  await Promise.all(candidates.map(async (s) => {
    const versions = await Promise.all(langs.map(l => getSet(l, s.id).catch(() => null)));
    const hits = versions.map((set, i) => {
      const card = set?.cards?.find(c => normalizeId(c.localId) === wanted);
      return card && { ...card, lang: langs[i], setName: set.name };
    }).filter(Boolean);
    if (!hits.length) return;
    // Name in beiden Sprachen vergleichen (englische Karte, deutsche App und umgekehrt)
    const score = Math.max(...hits.map(h => similarity(h.name, nameText)));
    results.push({ ...hits[0], score: score + s.order / 10000 });
  }));
  return results.sort((a, b) => b.score - a.score);
}

const normalizeId = id => String(id).toUpperCase().replace(/^([A-Z]*)0*(\d)/, '$1$2');

/**
 * Sammelt aus dem OCR-Ergebnis alle in Frage kommenden Karten (über Nummer und Name).
 * Die endgültige Reihenfolge entscheidet danach der Bildvergleich.
 * `score` ist die Text-Übereinstimmung (Nummer + Name), `numberText` die gelesene Nummer.
 */
export async function identify(ocr, lang = 'de') {
  const pool = new Map();
  const add = (list, via, numberText = '') => {
    for (const c of list) {
      const prev = pool.get(c.id);
      if (!prev || c.score > prev.score) pool.set(c.id, { ...c, via, numberText: numberText || prev?.numberText || '' });
    }
  };
  const best = () => Math.max(0, ...[...pool.values()].map(c => c.score));

  for (const n of ocr.numbers) {
    add(await findByNumber(n, ocr.nameText, lang), 'number', `${n.prefix}${n.num}/${n.total}`);
  }
  if (best() < 0.85) {
    for (const n of (ocr.fuzzy || []).slice(0, 5)) {
      const r = (await findByNumber(n, ocr.nameText, lang)).filter(c => c.score >= 0.5);
      add(r, 'number', `${parseInt(n.num, 10)}/${n.total}`);
    }
  }
  if (best() < 0.85) {
    // Über den Namen suchen; Karten mit passender Nummer nach oben
    let byName = await findByName(ocr.nameText, lang);
    if (!byName.length && ocr.fullText) byName = await findByName(ocr.fullText, lang);
    const sets = await getSets();
    const counts = new Map(sets.map(s => [s.id, [s.cardCount?.official, s.cardCount?.total]]));
    const all = [...ocr.numbers, ...(ocr.fuzzy || [])];
    for (const c of byName) {
      const local = normalizeId(c.localId);
      const setCounts = counts.get(setIdOf(c.id)) || [];
      const hits = all.filter(n => normalizeId(n.num) === local);
      if (hits.some(n => setCounts.includes(parseInt(n.total, 10)))) c.score += 0.5;
      // Nur die Nummer passt: zählt nur bei sauber gelesenen Nummern, nicht bei geratenen
      else if (hits.some(n => !n.fuzzy)) c.score += 0.25;
    }
    add(byName, 'name');
  }
  return [...pool.values()].sort((a, b) => b.score - a.score);
}

/** Bild und Text zusammen bewerten und entscheiden, ob das Ergebnis sicher genug ist. */
export function decide(candidates) {
  for (const c of candidates) {
    c.total = Math.min(c.score, 1.5) + (c.imageScore == null ? 0 : 2.5 * (c.imageScore - 0.6));
  }
  candidates.sort((a, b) => b.total - a.total);
  const [top, second] = candidates;
  if (!top) return { confident: false, label: '' };
  const imgMargin = top.imageScore != null && second?.imageScore != null ? top.imageScore - second.imageScore : 1;
  const textSure = top.via === 'number' && top.score >= 0.85 && (top.imageScore == null || top.imageScore >= 0.6);
  const imageSure = top.imageScore != null && top.imageScore >= 0.72 && imgMargin >= 0.035;
  const label = top.via === 'number' && top.numberText ? top.numberText : imageSure ? 'Bild erkannt' : 'Name erkannt';
  return { confident: textSure || imageSure, label };
}

/** Freitext-Fallback, wenn keine Nummer erkannt wurde. */
export async function findByName(nameText, lang = 'de') {
  const words = cleanName(nameText).split(' ').filter(w => w.length >= 4).sort((a, b) => b.length - a.length);
  // Ganzes Wort, dann nur der Anfang („PikachwWER“ → „Pikac“)
  const queries = [...new Set(words.slice(0, 3).flatMap(w => [w, w.slice(0, 5)]))];
  for (const w of queries) {
    const list = await searchCards(w, lang).catch(() => []);
    if (list.length) {
      list.forEach(c => { c.score = similarity(c.name, nameText); });
      return list.sort((a, b) => b.score - a.score).slice(0, 40);
    }
  }
  return [];
}

export function cleanName(text) {
  return (text || '')
    .replace(/\b(BASIS|PHASE ?\d|STAGE ?\d|BASIC|KP|HP|LV\.?|ENTWICKELT SICH AUS|EVOLVES FROM)\b/gi, ' ')
    .replace(/[^A-Za-zÄÖÜäöüß\- ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const fold = s => (s || '').toLowerCase()
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/ß/g, 'ss').replace(/[^a-z0-9]/g, '');

/** 0..1 – wie gut passt ein Kartenname zum erkannten Text? */
export function similarity(name, text) {
  const a = fold(name), b = fold(text);
  if (!a || !b) return 0;
  if (b.includes(a)) return 1;
  let best = 0;
  // Bestes Fenster im erkannten Text gegen den Namen vergleichen
  for (let i = 0; i <= Math.max(0, b.length - a.length); i++) {
    const win = b.slice(i, i + a.length);
    best = Math.max(best, 1 - levenshtein(a, win) / Math.max(a.length, win.length));
  }
  return best;
}

function levenshtein(a, b) {
  const dp = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j];
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[b.length];
}

export function imageUrl(card, quality = 'low') {
  return card?.image ? `${card.image}/${quality}.webp` : '';
}

/** Welche Versionen gibt es von der Karte? */
export function variantsOf(card) {
  const v = card?.variants || {};
  const list = [];
  if (v.normal) list.push({ key: 'normal', label: 'Normal' });
  if (v.holo) list.push({ key: 'holo', label: 'Holo' });
  if (v.reverse) list.push({ key: 'reverse', label: 'Reverse Holo' });
  if (v.firstEdition) list.push({ key: 'firstEdition', label: '1. Edition' });
  if (!list.length) list.push({ key: 'normal', label: 'Normal' });
  return list;
}

/** Cardmarket-Preise für eine Version. Holo/Reverse nutzen die „-holo“-Werte. */
export function priceFor(card, variant = 'normal') {
  const cm = card?.pricing?.cardmarket;
  if (!cm) return null;
  const holo = variant === 'holo' || variant === 'reverse';
  const pick = key => {
    const h = cm[`${key}-holo`], n = cm[key];
    const val = holo ? (h || n) : (n || h);
    return typeof val === 'number' && val > 0 ? val : null;
  };
  const trend = pick('trend'), avg30 = pick('avg30'), avg7 = pick('avg7'), low = pick('low'), avg = pick('avg');
  const value = trend ?? avg30 ?? avg7 ?? avg ?? low;
  if (value == null) return null;
  return { value, trend, avg30, avg7, low, updated: cm.updated, productId: cm.idProduct };
}
