// Yu-Gi-Oh!-Karten und Preise über die freie YGOPRODeck-API (https://ygoprodeck.com/api-guide/).
const BASE = 'https://db.ygoprodeck.com/api/v7';
const RATE_KEY = 'cv.usdEur';
const memo = new Map();

async function getJSON(url) {
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch(url);
      if (res.status === 400 || res.status === 404) return null; // „keine Karte gefunden“
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      return data?.error ? null : data;
    } catch (err) {
      if (i === 2) throw err;
      await new Promise(r => setTimeout(r, 600 * (i + 1)));
    }
  }
  return null;
}

function cached(key, fn) {
  if (!memo.has(key)) memo.set(key, fn().catch(err => { memo.delete(key); throw err; }));
  return memo.get(key);
}

/** Dollar→Euro-Kurs der EZB (über frankfurter.dev), einen Tag zwischengespeichert. */
export function usdToEur() {
  return cached('rate', async () => {
    try {
      const saved = JSON.parse(localStorage.getItem(RATE_KEY) || 'null');
      if (saved && Date.now() - saved.t < 864e5) return saved.rate;
    } catch { /* ignorieren */ }
    try {
      const data = await getJSON('https://api.frankfurter.dev/v1/latest?base=USD&symbols=EUR');
      const rate = data?.rates?.EUR;
      if (rate) {
        try { localStorage.setItem(RATE_KEY, JSON.stringify({ t: Date.now(), rate })); } catch { /* voll */ }
        return rate;
      }
    } catch { /* offline */ }
    return 0.9;
  });
}

const DIGIT_FIX = { O: '0', D: '0', Q: '0', I: '1', L: '1', S: '5', B: '8', Z: '2', G: '6' };
const toDigits = s => s.replace(/[A-Z]/g, ch => DIGIT_FIX[ch] ?? ch);

/**
 * Set-Codes wie „LOB-DE001“, „MP23-EN123“ oder alte deutsche „LOB-G001“.
 * Die Datenbank kennt nur die englischen Codes, deshalb wird die Sprache auf EN umgestellt.
 */
export function parseSetCodes(text) {
  const out = [];
  const seen = new Set();
  const re = /\b([A-Z0-9]{2,5})\s?[-–]\s?([A-Z]{0,2})\s?([0-9OIDQLSBZG]{3})\b/g;
  let m;
  const t = (text || '').toUpperCase();
  while ((m = re.exec(t))) {
    const [, set, region, rawNum] = m;
    if (!/[A-Z]/.test(set)) continue;
    const num = toDigits(rawNum);
    if (!/^\d{3}$/.test(num)) continue;
    const code = `${set}-EN${num}`;
    if (!seen.has(code)) { seen.add(code); out.push({ code, printed: `${set}-${region}${num}` }); }
  }
  return out;
}

/** 8-stellige Passcodes unten links auf der Karte = Karten-ID in der Datenbank. */
export function parsePasscodes(text) {
  return [...new Set((toDigits((text || '').toUpperCase()).match(/\b\d{8}\b/g) || []))];
}

export function getCard(id, lang = 'de') {
  return cached(`card:${lang}:${id}`, async () => {
    const q = `id=${encodeURIComponent(id)}`;
    let used = lang;
    let data = lang === 'de' ? await getJSON(`${BASE}/cardinfo.php?${q}&language=de`).catch(() => null) : null;
    if (!data) { data = await getJSON(`${BASE}/cardinfo.php?${q}`); used = 'en'; }
    const card = data?.data?.[0];
    return card ? { ...card, lang: used } : null;
  });
}

function bySetCode(code) {
  return cached(`set:${code}`, () => getJSON(`${BASE}/cardsetsinfo.php?setcode=${encodeURIComponent(code)}`));
}

/** Suche nach Name (Teiltreffer). */
export async function search(query, lang = 'de') {
  const q = query.trim();
  if (q.length < 2) return [];
  const params = `fname=${encodeURIComponent(q)}&num=60&offset=0`;
  let data = lang === 'de' ? await getJSON(`${BASE}/cardinfo.php?${params}&language=de`).catch(() => null) : null;
  let l = lang;
  if (!data?.data?.length) { data = await getJSON(`${BASE}/cardinfo.php?${params}`); l = 'en'; }
  return (data?.data || []).map(c => ({ ...c, lang: l }));
}

/**
 * Kandidaten aus dem OCR-Ergebnis: Set-Code (am sichersten), dann Passcode, dann Name.
 * @returns Array von { id, name, image, setCode, score, via, numberText }
 */
export async function identify(ocr, lang = 'de') {
  const out = new Map();
  const put = (card, extra) => {
    if (!card) return;
    const prev = out.get(card.id);
    if (!prev || extra.score > prev.score) out.set(card.id, { ...brief(card), ...extra });
  };

  for (const sc of ocr.setCodes.slice(0, 4)) {
    const info = await bySetCode(sc.code).catch(() => null);
    if (!info?.id) continue;
    const card = await getCard(info.id, lang).catch(() => null);
    const nameScore = card ? Math.max(similar(card.name, ocr.nameText), similar(card.name_en || info.name, ocr.nameText)) : 0;
    put(card, { setCode: info.set_code, rarity: info.set_rarity, score: 1 + nameScore * 0.5, via: 'number', numberText: sc.printed });
  }
  for (const pc of ocr.passcodes.slice(0, 2)) {
    const card = await getCard(pc, lang).catch(() => null);
    put(card, { score: 1.2, via: 'number', numberText: `Passcode ${pc}` });
  }
  if (!out.size) {
    const words = (ocr.nameText || '').replace(/[^A-Za-zÄÖÜäöüß\- ]/g, ' ').split(/\s+/).filter(w => w.length >= 4);
    const query = words.sort((a, b) => b.length - a.length).slice(0, 2).join(' ');
    for (const q of [query, words[0]].filter(Boolean)) {
      const list = await search(q, lang).catch(() => []);
      list.forEach(c => put(c, { score: similar(c.name, ocr.nameText), via: 'name' }));
      if (list.length) break;
    }
  }
  return [...out.values()].sort((a, b) => b.score - a.score);
}

const fold = s => (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ß/g, 'ss').replace(/[^a-z0-9]/g, '');
function similar(name, text) {
  const a = fold(name), b = fold(text);
  if (!a || !b) return 0;
  if (b.includes(a)) return 1;
  // Anteil gemeinsamer Buchstaben-Dreiergruppen
  const grams = s => new Set(Array.from({ length: Math.max(0, s.length - 2) }, (_, i) => s.slice(i, i + 3)));
  const ga = grams(a), gb = grams(b);
  let hit = 0;
  ga.forEach(g => { if (gb.has(g)) hit++; });
  return ga.size ? hit / ga.size : 0;
}

export function brief(card) {
  return { id: card.id, name: card.name, image: imageUrl(card, 'small'), lang: card.lang, game: 'yugioh' };
}

export function imageUrl(card, size = 'small') {
  const img = card?.card_images?.[0];
  if (!img) return '';
  return size === 'small' ? img.image_url_small : img.image_url;
}

/** Drucke dieser Karte als Versionen; mit bekanntem Set-Code nur dessen Seltenheiten. */
export function variantsOf(card, setCode = '') {
  const sets = card?.card_sets || [];
  let list = setCode ? sets.filter(s => s.set_code === setCode) : sets;
  if (!list.length) list = sets;
  const seen = new Set();
  return list
    .filter(s => { const k = `${s.set_code}|${s.set_rarity}`; if (seen.has(k)) return false; seen.add(k); return true; })
    .sort((a, b) => parseFloat(b.set_price || 0) - parseFloat(a.set_price || 0))
    .slice(0, 24)
    .map(s => ({ key: `${s.set_code}|${s.set_rarity}`, label: setCode ? s.set_rarity : `${s.set_code} · ${s.set_rarity}`, setName: s.set_name }));
}

/** Preis einer Version: TCGplayer-Marktpreis (USD) in Euro umgerechnet, dazu der günstigste Cardmarket-Preis. */
export async function priceFor(card, variantKey) {
  const rate = await usdToEur();
  const [code, rarity] = (variantKey || '').split('|');
  const set = (card?.card_sets || []).find(s => s.set_code === code && s.set_rarity === rarity);
  const usd = parseFloat(set?.set_price || '0') || null;
  const cmLow = parseFloat(card?.card_prices?.[0]?.cardmarket_price || '0') || null;
  const value = usd ? Math.round(usd * rate * 100) / 100 : cmLow;
  if (value == null) return null;
  return { value, usd, cmLow, rate, setName: set?.set_name || '' };
}
