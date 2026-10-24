// Sammlung und Einstellungen – lokal auf dem Gerät gespeichert.
const KEY = 'cv.collection.v1';
const SETTINGS = 'cv.settings.v1';

function load(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
}
function save(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* Speicher voll */ }
}

// Einträge aus Version 1.0 waren alle Pokémon-Karten
let items = load(KEY, []).map(i => ({ game: 'pokemon', ...i }));
const listeners = new Set();
const emit = () => { save(KEY, items); listeners.forEach(fn => fn(items)); };

export const collection = {
  all: () => items,
  onChange: fn => listeners.add(fn),
  // Pokémon-Schlüssel bleiben wie in 1.0, damit bestehende Sammlungen weiter passen
  keyOf: (game, id, variant) => (game === 'pokemon' ? `${id}|${variant}` : `${game}:${id}|${variant}`),
  get(key) { return items.find(i => i.key === key); },

  /** Fügt eine Karte hinzu oder erhöht die Anzahl. */
  add(entry, qty = 1) {
    const key = this.keyOf(entry.game, entry.id, entry.variant);
    const existing = this.get(key);
    if (existing) {
      existing.qty += qty;
      Object.assign(existing, { price: entry.price, priceUpdated: entry.priceUpdated });
    } else {
      items.unshift({ ...entry, key, qty, addedAt: Date.now(), prevPrice: null });
    }
    emit();
    return key;
  },
  /** Ersetzt die Daten eines Eintrags (z. B. bearbeitete Sportkarte). */
  update(key, fields) {
    const it = this.get(key);
    if (!it) return;
    if (fields.price != null && it.price != null && fields.price !== it.price) it.prevPrice = it.price;
    Object.assign(it, fields);
    emit();
  },
  setQty(key, qty) {
    const it = this.get(key);
    if (!it) return;
    if (qty <= 0) items = items.filter(i => i.key !== key);
    else it.qty = qty;
    emit();
  },
  remove(key) { items = items.filter(i => i.key !== key); emit(); },
  clear() { items = []; emit(); },

  /** Neue Preise eintragen; der alte Preis bleibt für die Veränderung erhalten. */
  updatePrices(updates) {
    for (const u of updates) {
      const it = this.get(u.key);
      if (!it || u.price == null) continue;
      if (it.price != null) it.prevPrice = it.price;
      it.price = u.price;
      it.priceUpdated = u.priceUpdated;
    }
    emit();
  },

  /** Summen für eine Kategorie (oder alle). */
  totals(game = 'all') {
    let value = 0, prev = 0, count = 0, unique = 0, comparable = false;
    for (const i of items) {
      if (game !== 'all' && i.game !== game) continue;
      unique++;
      count += i.qty;
      if (i.price != null) value += i.price * i.qty;
      if (i.prevPrice != null && i.price != null) {
        comparable = true;
        prev += i.prevPrice * i.qty;
      } else if (i.price != null) {
        prev += i.price * i.qty;
      }
    }
    return { value, count, unique, change: comparable && prev > 0 ? (value - prev) / prev : null };
  },
};

let settings = { lang: 'de', onboarded: false, scanMode: 'pokemon', ...load(SETTINGS, {}) };
export const prefs = {
  get: k => settings[k],
  set(k, v) { settings[k] = v; save(SETTINGS, settings); },
};
