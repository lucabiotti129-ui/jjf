import * as api from './api.js';
import * as ygo from './yugioh.js';
import { readCard, readYugioh, readText, warmUp } from './ocr.js';
import { rankByImage } from './images.js';
import { findCard, locateCard, warpCard, cardQuality, cropReady, warmUpCrop, rotate180 } from './cardcrop.js';
import { checkPokemon, checkYugioh, MANUAL_TIPS } from './fakecheck.js';
import { savePhoto, photoUrl, deletePhoto, clearPhotos } from './photos.js';
import { collection, prefs } from './store.js';

const $ = sel => document.querySelector(sel);
const $$ = sel => [...document.querySelectorAll(sel)];
const eur = new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' });
const dollar = new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'USD' });
const money = v => (v == null ? '–' : eur.format(v));
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtDate = d => new Date(d).toLocaleDateString('de-DE');
const pct = v => `${Math.abs(v * 100).toFixed(1).replace('.', ',')} %`;
const lang = () => prefs.get('lang') || 'de';

const GAMES = {
  pokemon: { label: 'Pokémon', badge: 'PKM' },
  yugioh: { label: 'Yu-Gi-Oh!', badge: 'YGO' },
  soccer: { label: 'Fußball', badge: '⚽' },
  football: { label: 'Football', badge: '🏈' },
};
const isSport = game => game === 'soccer' || game === 'football';
const ATTRIBUTES = { LIGHT: 'Licht', DARK: 'Finsternis', EARTH: 'Erde', WATER: 'Wasser', FIRE: 'Feuer', WIND: 'Wind', DIVINE: 'Göttlich' };

/* ---------------- Navigation ---------------- */
let current = 'collection';

function go(view) {
  if (view === current) return;
  if (current === 'scan') stopCamera();
  current = view;
  $$('.view').forEach(v => v.classList.toggle('active', v.dataset.view === view));
  $$('.tab').forEach(t => t.classList.toggle('active', t.dataset.goto === view));
  document.body.classList.toggle('scanning', view === 'scan');
  if (view === 'scan') { startCamera(); warmUp(); warmUpCrop(); }
  if (view === 'search' && searchGame !== 'sport') setTimeout(() => $('#search-input').focus(), 250);
}

document.addEventListener('click', e => {
  const btn = e.target.closest('[data-goto]');
  if (btn) { closeSheet(); go(btn.dataset.goto); }
  const sport = e.target.closest('[data-add-sport]');
  if (sport) openSportForm({ game: sport.dataset.addSport });
});

/* ---------------- Toast ---------------- */
let toastTimer;
function toast(msg, ms = 2600) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  t.style.animation = 'none'; void t.offsetWidth; t.style.animation = '';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}

/* ---------------- Kachel ---------------- */
function tile({ name, sub, image, photoId, price, qty, priceLabel, badge, match, icon = '' }) {
  const el = document.createElement('button');
  el.className = 'tile';
  const hasPic = image || photoId;
  el.innerHTML = `
    <div class="tile-img skeleton">
      ${hasPic ? `<img alt="" loading="lazy" decoding="async">` : `<div class="noimg">${icon ? `<span class="noimg-icon">${icon}</span>` : ''}${esc(name)}</div>`}
      ${badge ? `<span class="game-badge">${esc(badge)}</span>` : ''}
      ${qty > 1 ? `<span class="qty-badge">${qty}×</span>` : ''}
      ${match != null ? `<span class="match-badge ${match >= 80 ? '' : match >= 55 ? 'mid' : 'low'}">${match} %</span>` : ''}
    </div>
    ${sub ? `<div class="tile-sub">${esc(sub)}</div>` : ''}
    <div class="tile-name">${esc(name)}</div>
    ${priceLabel !== undefined ? `<div class="tile-price ${price == null ? 'na' : ''}">${esc(priceLabel)}</div>` : ''}`;
  const img = el.querySelector('img');
  if (img) {
    img.onload = () => { img.classList.add('loaded'); img.parentElement.classList.remove('skeleton'); };
    img.onerror = () => {
      img.parentElement.classList.remove('skeleton');
      img.replaceWith(Object.assign(document.createElement('div'), { className: 'noimg', textContent: name }));
    };
    if (image) img.src = image;
    else photoUrl(photoId).then(url => { if (url) img.src = url; else img.onerror(); });
  } else {
    el.querySelector('.tile-img').classList.remove('skeleton');
  }
  return el;
}

/* ---------------- Sammlung ---------------- */
let collectionGame = 'all';

function renderCollection() {
  const items = collection.all();
  const t = collection.totals(collectionGame);
  $('#value-label').textContent = collectionGame === 'all' ? 'Sammlungswert' : `Wert · ${GAMES[collectionGame].label}`;
  $('#total-value').textContent = money(t.value);
  $('#total-count').textContent = `${t.count} ${t.count === 1 ? 'Karte' : 'Karten'}${t.unique !== t.count ? ` · ${t.unique} verschiedene` : ''}`;
  const ch = $('#total-change');
  if (t.change != null && Math.abs(t.change) >= 0.0005) {
    ch.textContent = `${t.change > 0 ? '▲' : '▼'} ${pct(t.change)}`;
    ch.className = `change ${t.change > 0 ? 'up' : 'down'}`;
  } else {
    ch.textContent = '';
  }
  ch.previousElementSibling.hidden = !ch.textContent;

  document.body.dataset.game = collectionGame;
  showHeroArt(items.filter(i => collectionGame === 'all' || i.game === collectionGame));

  $$('#game-chips .chip').forEach(c => {
    const g = c.dataset.game;
    const n = g === 'all' ? items.length : items.filter(i => i.game === g).length;
    c.classList.toggle('on', g === collectionGame);
    c.querySelector('span').textContent = n || '';
  });

  const inGame = items.filter(i => collectionGame === 'all' || i.game === collectionGame);
  const anyPriced = inGame.some(i => !isSport(i.game));
  $('#game-chips').hidden = items.length === 0;
  $('#collection-empty').hidden = inGame.length > 0;
  $('#collection-toolbar').hidden = inGame.length === 0;
  $('#btn-refresh').hidden = !anyPriced;
  $('#empty-text').textContent = items.length === 0
    ? 'Scanne deine erste Karte – Pokémon, Yu-Gi-Oh!, Fußball oder Football.'
    : `Noch keine ${GAMES[collectionGame]?.label ?? ''}-Karten in deiner Sammlung.`;
  $('#collection-empty .btn').textContent = isSport(collectionGame) ? 'Karte hinzufügen' : items.length ? 'Karte scannen' : 'Erste Karte scannen';

  const q = $('#collection-filter').value.trim().toLowerCase();
  const sort = $('#collection-sort').value;
  const list = inGame
    .filter(i => !q || `${i.name} ${i.setName} ${i.team || ''}`.toLowerCase().includes(q))
    .sort({
      value: (a, b) => (b.price ?? -1) * b.qty - (a.price ?? -1) * a.qty,
      added: (a, b) => b.addedAt - a.addedAt,
      name: (a, b) => a.name.localeCompare(b.name, 'de'),
      set: (a, b) => (a.setName || '').localeCompare(b.setName || '', 'de') || String(a.localId).localeCompare(String(b.localId), 'de', { numeric: true }),
    }[sort]);

  $('#collection-grid').replaceChildren(...list.map(i => {
    const el = tile({
      name: i.name,
      sub: subOf(i),
      image: i.image ? (i.game === 'pokemon' ? `${i.image}/low.webp` : i.image) : '',
      photoId: i.photoId,
      qty: i.qty,
      price: i.price,
      priceLabel: i.price == null ? 'Kein Preis' : money(i.price),
      badge: collectionGame === 'all' ? GAMES[i.game]?.badge : '',
      icon: isSport(i.game) ? GAMES[i.game].badge : '',
    });
    el.onclick = () => (isSport(i.game) ? openSportForm({ item: i }) : openCard(i.game, { id: i.id, lang: i.lang }, { item: i }));
    return el;
  }));
}

/** Titelbild wie ein großes Spielplakat: die wertvollste Karte der Kategorie. */
let heroKey = '';
async function showHeroArt(list) {
  const art = $('#hero-art');
  const top = [...list].filter(i => i.image || i.photoId).sort((a, b) => (b.price ?? 0) - (a.price ?? 0))[0];
  const key = top ? top.key : '';
  if (key === heroKey) return;
  heroKey = key;
  if (!top) { art.style.backgroundImage = ''; delete art.dataset.art; return; }
  let url = '';
  if (top.game === 'pokemon') url = `${top.image}/high.webp`;
  else if (top.game === 'yugioh') url = top.image.replace('/cards_small/', '/cards/');
  else url = await photoUrl(top.photoId);
  if (!url || heroKey !== key) return;
  const img = new Image();
  img.onload = () => {
    if (heroKey !== key) return;
    art.dataset.art = isSport(top.game) ? 'photo' : top.game;
    art.style.backgroundImage = `url("${url}")`;
  };
  img.src = url;
}

function subOf(i) {
  if (i.game === 'pokemon') return `${i.setName} · ${variantLabel(i.variant)}`;
  if (i.game === 'yugioh') return `${i.localId || ''} · ${i.variantLabel || ''}`;
  return [i.team, i.setName].filter(Boolean).join(' · ');
}

const variantLabel = key => ({ normal: 'Normal', holo: 'Holo', reverse: 'Reverse', firstEdition: '1. Ed.' }[key] || key);

$('#collection-filter').addEventListener('input', renderCollection);
$('#collection-sort').addEventListener('change', renderCollection);
$$('#game-chips .chip').forEach(c => c.onclick = () => { collectionGame = c.dataset.game; renderCollection(); });
$('#collection-empty .btn').addEventListener('click', e => {
  if (isSport(collectionGame)) { e.stopPropagation(); openSportForm({ game: collectionGame }); return; }
  if (collectionGame === 'pokemon' || collectionGame === 'yugioh') setScanMode(collectionGame);
}, true);
collection.onChange(renderCollection);

$('#btn-refresh').addEventListener('click', async () => {
  const btn = $('#btn-refresh');
  if (btn.classList.contains('spinning')) return;
  btn.classList.add('spinning');
  const label = btn.querySelector('span');
  const items = collection.all().filter(i => !isSport(i.game) && (collectionGame === 'all' || i.game === collectionGame));
  const updates = [];
  let done = 0, failed = 0;
  const queue = [...items];
  const worker = async () => {
    while (queue.length) {
      const it = queue.shift();
      try {
        let value = null, updated = new Date().toISOString();
        if (it.game === 'pokemon') {
          const p = api.priceFor(await api.getCard(it.id, it.lang), it.variant);
          value = p?.value; updated = p?.updated || updated;
        } else if (it.game === 'yugioh') {
          value = (await ygo.priceFor(await ygo.getCard(it.id, it.lang), it.variant))?.value;
        }
        if (value != null) updates.push({ key: it.key, price: value, priceUpdated: updated });
      } catch { failed++; }
      label.textContent = `Aktualisiere … ${++done}/${items.length}`;
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  collection.updatePrices(updates);
  btn.classList.remove('spinning');
  label.textContent = 'Aktualisieren';
  toast(failed ? `${failed} Preise konnten nicht geladen werden` : 'Preise sind aktuell');
});

/* ---------------- Bottom-Sheet ---------------- */
let sheetToken = 0;

function openSheet(id) {
  const s = $(id);
  s.classList.remove('closing');
  s.hidden = false;
  s.querySelector('.sheet-panel').scrollTop = 0;
}
function closeSheet(id) {
  const sheets = id ? [$(id)] : $$('.sheet');
  let closed = false;
  for (const s of sheets) {
    if (s.hidden || s.classList.contains('closing')) continue;
    closed = true;
    s.classList.add('closing');
    setTimeout(() => { s.hidden = true; s.classList.remove('closing'); }, 190);
  }
  if (!id || id === '#sheet') sheetToken++;
  return closed;
}
$$('.sheet [data-close]').forEach(el => el.addEventListener('click', () => closeSheet(`#${el.closest('.sheet').id}`)));

function skeletonDetail() {
  $('#sheet-body').innerHTML = `
    <div class="detail-head">
      <div class="detail-img skeleton"></div>
      <div class="detail-info" style="flex:1">
        <div class="skeleton" style="height:26px;border-radius:8px;width:80%"></div>
        <div class="skeleton" style="height:14px;border-radius:6px;width:60%;margin-top:8px"></div>
      </div>
    </div>
    <div class="price-box"><div class="skeleton" style="height:70px;border-radius:12px"></div></div>`;
}

/* ---------------- Kartendaten je Spiel ---------------- */
async function loadModel(game, brief, item) {
  if (game === 'pokemon') {
    const card = await api.getCard(brief.id, item?.lang || brief.lang || lang());
    if (!card) return null;
    const official = card.set?.cardCount?.official;
    return {
      game, card, name: card.name,
      lines: [card.set?.name || '', `Nr. ${card.localId}${official ? ` / ${official}` : ''}`],
      tags: [card.rarity].filter(Boolean),
      image: api.imageUrl(card, 'high'),
      imageLow: card.image ? `${card.image}/low.webp` : '',
      credit: card.illustrator ? `Illustration: ${card.illustrator}` : '',
      variants: api.variantsOf(card),
      async price(v) {
        const p = api.priceFor(card, v);
        return p && {
          value: p.value, label: 'Trendpreis',
          stats: [['Ab', money(p.low)], ['Ø 7 Tage', money(p.avg7)], ['Ø 30 Tage', money(p.avg30)]],
          foot: `Cardmarket${p.updated ? ` · Stand ${fmtDate(p.updated)}` : ''}`,
          updated: p.updated,
        };
      },
      entry: v => ({
        game, id: card.id, lang: card.lang, name: card.name, setName: card.set?.name || '',
        localId: card.localId, image: card.image || '', rarity: card.rarity || '', variant: v,
      }),
    };
  }
  if (game === 'yugioh') {
    const card = await ygo.getCard(brief.id, item?.lang || brief.lang || lang());
    if (!card) return null;
    const code = item?.localId || brief.setCode || '';
    let variants = ygo.variantsOf(card, code);
    if (!variants.length) variants = [{ key: '|', label: 'Standard' }];
    return {
      game, card, name: card.name,
      lines: [card.humanReadableCardType || card.type || '', code ? `Set-Code ${code}` : `${(card.card_sets || []).length} Drucke`],
      tags: [ATTRIBUTES[card.attribute] || card.attribute, card.race].filter(Boolean),
      image: ygo.imageUrl(card, 'large'),
      imageLow: ygo.imageUrl(card, 'small'),
      credit: card.atk != null ? `ATK ${card.atk} / DEF ${card.def ?? '–'}` : '',
      variants,
      async price(v) {
        const p = await ygo.priceFor(card, v);
        return p && {
          value: p.value, label: p.usd ? 'Marktpreis (umgerechnet)' : 'Cardmarket ab',
          stats: [['TCGplayer', p.usd ? dollar.format(p.usd) : '–'], ['Cardmarket ab', money(p.cmLow)], ['Dollarkurs', `${p.rate.toFixed(2).replace('.', ',')} €`]],
          foot: p.setName ? `Preis für den Druck aus „${p.setName}“` : 'Preise über YGOPRODeck',
        };
      },
      entry: v => {
        const [c, r] = v.split('|');
        return {
          game, id: String(card.id), lang: card.lang, name: card.name,
          setName: (card.card_sets || []).find(s => s.set_code === c)?.set_name || '',
          localId: c, image: ygo.imageUrl(card, 'small'), rarity: r, variant: v, variantLabel: r || 'Standard',
        };
      },
    };
  }
  return null;
}

/**
 * Kartendetails mit Preis.
 * @param scan { canvas, ocr } – nur direkt nach einem Scan, ermöglicht den Echtheits-Check
 */
async function openCard(game, brief, { item = null, alternatives = [], recognized = '', scan = null } = {}) {
  const token = ++sheetToken;
  skeletonDetail();
  openSheet('#sheet');

  let model = null;
  try { model = await loadModel(game, brief, item); } catch { model = null; }
  if (token !== sheetToken) return;
  const body = $('#sheet-body');
  if (!model) {
    body.innerHTML = `<div class="empty small"><h2>Keine Verbindung</h2><p>Die Karte konnte nicht geladen werden. Prüfe deine Internetverbindung.</p>
      <button class="btn secondary" id="retry-card">Erneut versuchen</button></div>`;
    $('#retry-card').onclick = () => openCard(game, brief, { item, alternatives, recognized, scan });
    return;
  }

  const variants = model.variants;
  const wanted = item?.variant || (brief.setCode && brief.rarity ? `${brief.setCode}|${brief.rarity}` : '');
  let variant = variants.some(v => v.key === wanted) ? wanted : variants[0].key;
  let qty = item ? item.qty : 1;
  let price = null;
  const useSelect = variants.length > 4;

  body.innerHTML = `
    <div class="detail-head">
      <div class="detail-img">${model.image ? `<img alt="${esc(model.name)}" src="${esc(model.image)}">` : ''}</div>
      <div class="detail-info">
        <h2>${esc(model.name)}</h2>
        ${model.lines.filter(Boolean).map(l => `<div class="meta-line">${esc(l)}</div>`).join('')}
        <div class="tag-row">
          ${model.tags.map(t => `<span class="tag">${esc(t)}</span>`).join('')}
          ${recognized ? `<span class="tag match-tag">✓ ${esc(recognized)}</span>` : ''}
          ${item ? `<span class="tag">In Sammlung</span>` : ''}
        </div>
        ${model.credit ? `<div class="meta-line" style="margin-top:auto">${esc(model.credit)}</div>` : ''}
      </div>
    </div>
    <div class="label">Version</div>
    ${useSelect
      ? `<select id="variant-select" style="width:100%" ${item ? 'disabled' : ''}>${variants.map(v => `<option value="${esc(v.key)}">${esc(v.label)}</option>`).join('')}</select>`
      : `<div class="segmented" id="variant-seg">${variants.map(v => `<button data-v="${esc(v.key)}" ${item && v.key !== item.variant ? 'disabled style="opacity:.35"' : ''}>${esc(v.label)}</button>`).join('')}</div>`}
    <div class="price-box" id="price-box"><div class="skeleton" style="height:70px;border-radius:12px"></div></div>
    <div class="row-between">
      <div class="label" style="margin:0">Anzahl</div>
      <div class="stepper"><button id="qty-minus" aria-label="Weniger">−</button><span id="qty">${qty}</span><button id="qty-plus" aria-label="Mehr">+</button></div>
    </div>
    <div class="actions">
      ${item
        ? `<button class="btn danger" id="btn-remove">Entfernen</button><button class="btn secondary" data-close-sheet>Fertig</button>`
        : `<button class="btn primary" id="btn-add">Zur Sammlung hinzufügen</button>`}
    </div>
    ${scan ? `<div class="fake-box" id="fake-box">
      <div class="row-between"><h3>🛡️ Echtheits-Check</h3><button class="chip-btn" id="btn-fake">Echtheit prüfen</button></div>
      <p>Vergleicht deinen Scan mit den Daten der echten Karte: Nummer, Name, ${game === 'pokemon' ? 'KP, Attacken, Bild und Farben' : 'Set-Code und Passcode'}.</p>
    </div>` : ''}
    ${alternatives.length > 1 ? `<div class="alts"><div class="label">Nicht die richtige Karte?</div><div class="alts-scroll" id="alts"></div></div>` : ''}`;

  const renderPrice = async () => {
    const box = $('#price-box');
    const v = variant;
    price = await model.price(v).catch(() => null);
    if (v !== variant || token !== sheetToken) return;
    if (!price) {
      box.innerHTML = `<div class="price-main"><div><small>Preis</small><b style="font-size:22px;color:var(--muted)">Kein Preis verfügbar</b></div></div>
        <div class="price-foot">Für diese Version gibt es aktuell keine Preisdaten.</div>`;
      return;
    }
    let change = '';
    if (item && item.prevPrice != null && item.price != null && item.prevPrice !== item.price) {
      const c = (item.price - item.prevPrice) / item.prevPrice;
      change = `<span class="change ${c > 0 ? 'up' : 'down'}">${c > 0 ? '▲' : '▼'} ${pct(c)}</span>`;
    }
    box.innerHTML = `
      <div class="price-main"><div><small>${esc(price.label)}</small><b>${money(price.value)}</b></div>${change}</div>
      <div class="price-stats">${price.stats.map(([k, val]) => `<div><small>${esc(k)}</small><b>${esc(val)}</b></div>`).join('')}</div>
      <div class="price-foot">${esc(price.foot)}${qty > 1 ? ` · ${qty}× = ${money(price.value * qty)}` : ''}</div>`;
  };
  const markVariant = () => {
    $$('#variant-seg button').forEach(b => b.classList.toggle('on', b.dataset.v === variant));
    if ($('#variant-select')) $('#variant-select').value = variant;
  };
  $$('#variant-seg button').forEach(b => b.onclick = () => { variant = b.dataset.v; markVariant(); renderPrice(); });
  $('#variant-select')?.addEventListener('change', e => { variant = e.target.value; renderPrice(); });
  markVariant();
  renderPrice();

  const setQty = n => {
    qty = Math.max(item ? 0 : 1, n);
    $('#qty').textContent = qty;
    if (item) {
      collection.setQty(item.key, qty);
      if (qty === 0) { closeSheet('#sheet'); toast('Aus der Sammlung entfernt'); return; }
    }
    renderPrice();
  };
  $('#qty-minus').onclick = () => setQty(qty - 1);
  $('#qty-plus').onclick = () => setQty(qty + 1);

  $('[data-close-sheet]')?.addEventListener('click', () => closeSheet('#sheet'));
  $('#btn-remove')?.addEventListener('click', () => {
    collection.remove(item.key);
    closeSheet('#sheet');
    toast('Aus der Sammlung entfernt');
  });
  $('#btn-add')?.addEventListener('click', async () => {
    const p = price?.value != null ? price : await model.price(variant).catch(() => null);
    collection.add({ ...model.entry(variant), price: p?.value ?? null, priceUpdated: p?.updated ?? new Date().toISOString() }, qty);
    closeSheet('#sheet');
    toast(`${model.name} wurde zur Sammlung hinzugefügt`);
    if (current === 'scan') resumeCamera();
  });

  $('#btn-fake')?.addEventListener('click', () => runFakeCheck(game, model, scan, token));

  if (alternatives.length > 1) {
    const alts = $('#alts');
    alternatives.slice(0, 15).forEach(a => {
      const el = tile({ name: a.name, sub: a.setName || a.setCode || '', image: game === 'pokemon' && a.image ? `${a.image}/low.webp` : a.image || '' });
      if (String(a.id) === String(model.card.id)) el.classList.add('sel');
      el.onclick = () => openCard(game, a, { alternatives, recognized: '', scan });
      alts.append(el);
    });
  }
}

/* ---------------- Echtheits-Check ---------------- */
async function runFakeCheck(game, model, scan, token) {
  const box = $('#fake-box');
  box.innerHTML = `<div class="row-between"><h3>🛡️ Echtheits-Check</h3></div>
    <p id="fake-status">Karte wird geprüft …</p><div class="progress"><div id="fake-progress"></div></div>`;
  const progress = p => { const bar = $('#fake-progress'); if (bar) bar.style.width = `${Math.round(p * 100)}%`; };
  let result;
  try {
    result = game === 'pokemon'
      ? await checkPokemon({ canvas: scan.canvas, card: model.card, ocr: scan.ocr, imageUrl: model.imageLow, progress })
      : await checkYugioh({ card: model.card, ocr: scan.ocr });
  } catch (err) {
    console.error(err);
    if (token === sheetToken) box.innerHTML = '<p>Der Check ist fehlgeschlagen. Bitte versuche es nochmal.</p>';
    return;
  }
  if (token !== sheetToken) return;
  const icons = { ok: '✓', warn: '!', bad: '✕', na: '–' };
  box.innerHTML = `
    <div class="row-between"><h3>🛡️ Echtheits-Check</h3></div>
    <div class="verdict ${result.verdict}"><span class="v-icon">${icons[result.verdict]}</span>${esc(result.title)}</div>
    <div class="check-list">${result.checks.map(c => `
      <div class="check"><i class="${c.status}">${icons[c.status]}</i><div><b>${esc(c.label)}</b><small>${esc(c.detail)}</small></div></div>`).join('')}
    </div>
    <details class="tips"><summary>So prüfst du selbst weiter →</summary>
      <ol>${(MANUAL_TIPS[game] || []).map(([t, d]) => `<li><b>${esc(t)}:</b> ${esc(d)}</li>`).join('')}</ol>
    </details>
    <p class="disclaimer">Ein Handyfoto kann eine Karte nicht sicher als echt beweisen – der Check findet typische Fehler von Fälschungen. Wertvolle Karten lässt du am besten von Profis prüfen (z. B. PSA oder CGC).</p>`;
}

/* ---------------- Was hat die App gesehen? ---------------- */
function readSummary(game, ocr) {
  const parts = [];
  if (game === 'yugioh') {
    if (ocr?.setCodes?.length) parts.push(`Set-Code ${ocr.setCodes[0].printed}`);
    if (ocr?.passcodes?.length) parts.push(`Passcode ${ocr.passcodes[0]}`);
  } else if (ocr?.numbers?.length) {
    parts.push(`Nummer ${ocr.numbers[0].num}/${ocr.numbers[0].total}`);
  }
  const name = api.cleanName(ocr?.nameText || '').split(' ').filter(w => w.length >= 3).slice(0, 3).join(' ');
  if (name) parts.push(`Name „${name}“`);
  return parts.length ? parts.join(' · ') : 'Nichts lesbar';
}

/** Vorschau des Ausschnitts, den die App gelesen hat – zeigt sofort, ob Licht oder Ausschnitt das Problem waren. */
function seenBox(game, scan) {
  if (!scan?.canvas) return '';
  const thumb = document.createElement('canvas');
  const s = 160 / scan.canvas.width;
  thumb.width = 160;
  thumb.height = Math.round(scan.canvas.height * s);
  thumb.getContext('2d').drawImage(scan.canvas, 0, 0, thumb.width, thumb.height);
  return `<div class="seen"><img alt="Dein Scan" src="${thumb.toDataURL('image/jpeg', 0.75)}">
    <div><b>So hat die App deine Karte gesehen</b><small>Gelesen: ${esc(readSummary(game, scan.ocr))}</small></div></div>`;
}

/* ---------------- Trefferauswahl ---------------- */
function showChoices(game, candidates, scan) {
  ++sheetToken;
  $('#sheet-body').innerHTML = `
    <div class="choice-head">
      <h2 class="sheet-title" style="margin:0">Welche Karte ist es?</h2>
      <p>Die App ist sich nicht ganz sicher. Tippe auf deine Karte.</p>
    </div>
    ${seenBox(game, scan)}
    <div class="choice-grid" id="choices"></div>
    <div class="actions">
      <button class="btn secondary" id="ch-retry">Nochmal scannen</button>
      <button class="btn secondary" id="ch-search">Selbst suchen</button>
    </div>`;
  const list = candidates.slice(0, 12);
  $('#choices').replaceChildren(...list.map(c => {
    const match = c.imageScore != null ? Math.round(Math.max(0, Math.min(1, (c.imageScore - 0.55) / 0.25)) * 100) : null;
    const el = tile({
      name: c.name,
      sub: [c.setName || c.setCode, c.localId].filter(Boolean).join(' · '),
      image: game === 'pokemon' && c.image ? `${c.image}/low.webp` : c.image || '',
      match,
    });
    el.onclick = () => openCard(game, c, { alternatives: list, recognized: 'Von dir gewählt', scan });
    return el;
  }));
  openSheet('#sheet');
  $('#ch-retry').onclick = () => { closeSheet('#sheet'); resumeCamera(); };
  $('#ch-search').onclick = () => { closeSheet('#sheet'); setSearchGame(game); go('search'); };
}

/* ---------------- Sportkarten ---------------- */
async function openSportForm({ item = null, game = null, canvas = null, name = '' } = {}) {
  ++sheetToken;
  const g = item?.game || game || prefs.get('sportGame') || 'soccer';
  let sport = g;
  let photo = canvas;
  let qty = item?.qty ?? 1;
  const existingUrl = item?.photoId ? await photoUrl(item.photoId) : '';

  $('#sheet-body').innerHTML = `
    <h2 class="sheet-title">${item ? 'Karte bearbeiten' : 'Sportkarte hinzufügen'}</h2>
    <div class="form">
      <div class="segmented wide" id="sport-seg">
        <button data-sport="soccer">⚽ Fußball</button><button data-sport="football">🏈 Football</button>
      </div>
      <div class="form-head">
        <button class="photo-pick" id="photo-pick">${photo || existingUrl ? '<img alt="">' : 'Foto<br>hinzufügen'}</button>
        <div class="grow">
          <div class="field"><label>Spieler / Name *</label><input id="f-name" autocomplete="off" value="${esc(item?.name || name)}" placeholder="z. B. Jamal Musiala"></div>
          <div class="field"><label>Mannschaft</label><input id="f-team" autocomplete="off" value="${esc(item?.team || '')}" placeholder="z. B. FC Bayern"></div>
        </div>
      </div>
      <div class="field"><label>Serie</label><input id="f-set" autocomplete="off" value="${esc(item?.setName || '')}" placeholder="z. B. Topps Match Attax 2025/26"></div>
      <div class="field-row">
        <div class="field"><label>Kartennummer</label><input id="f-num" autocomplete="off" value="${esc(item?.localId || '')}" placeholder="z. B. 123"></div>
        <div class="field"><label>Besonderheit</label><input id="f-note" autocomplete="off" value="${esc(item?.note || '')}" placeholder="z. B. Limited"></div>
      </div>
      <div class="field-row">
        <div class="field"><label>Wert pro Karte (€)</label><input id="f-price" inputmode="decimal" autocomplete="off" value="${item?.price != null ? item.price.toFixed(2).replace('.', ',') : ''}" placeholder="0,00"></div>
        <div class="field"><label>Anzahl</label><div class="stepper" style="width:100%;justify-content:space-between"><button id="qty-minus">−</button><span id="qty">${qty}</span><button id="qty-plus">+</button></div></div>
      </div>
      <div class="hint">💡 Für Sportkarten gibt es keine freie Preisdatenbank. Echte Preise findest du z. B. bei eBay: Spieler + Serie suchen und links „Verkaufte Artikel“ anhaken.</div>
      <div class="actions">
        ${item ? '<button class="btn danger" id="f-delete">Löschen</button>' : ''}
        <button class="btn primary" id="f-save">${item ? 'Speichern' : 'Zur Sammlung hinzufügen'}</button>
      </div>
    </div>`;
  openSheet('#sheet');

  const showPhoto = () => {
    const img = $('#photo-pick img');
    if (!img) return;
    img.src = photo ? photo.toDataURL('image/jpeg', 0.8) : existingUrl;
  };
  showPhoto();
  const markSport = () => $$('#sport-seg button').forEach(b => b.classList.toggle('on', b.dataset.sport === sport));
  markSport();
  $$('#sport-seg button').forEach(b => b.onclick = () => { sport = b.dataset.sport; markSport(); });
  $('#qty-minus').onclick = () => { qty = Math.max(1, qty - 1); $('#qty').textContent = qty; };
  $('#qty-plus').onclick = () => { qty += 1; $('#qty').textContent = qty; };
  $('#photo-pick').onclick = () => {
    const input = $('#sport-photo-input');
    input.onchange = async () => {
      const file = input.files?.[0];
      input.value = '';
      if (!file) return;
      photo = await imageToCanvas(file).catch(() => null);
      if (photo && !$('#photo-pick img')) $('#photo-pick').innerHTML = '<img alt="">';
      showPhoto();
    };
    input.click();
  };

  $('#f-delete')?.addEventListener('click', () => {
    collection.remove(item.key);
    deletePhoto(item.photoId);
    closeSheet('#sheet');
    toast('Karte gelöscht');
  });
  $('#f-save').onclick = async () => {
    const nameVal = $('#f-name').value.trim();
    if (!nameVal) { $('#f-name').focus(); toast('Bitte gib einen Namen ein'); return; }
    const raw = $('#f-price').value.trim().replace(/\s|€/g, '').replace(',', '.');
    const priceVal = raw ? parseFloat(raw) : null;
    const fields = {
      game: sport,
      name: nameVal,
      team: $('#f-team').value.trim(),
      setName: $('#f-set').value.trim(),
      localId: $('#f-num').value.trim(),
      note: $('#f-note').value.trim(),
      price: Number.isFinite(priceVal) ? priceVal : null,
      priceUpdated: new Date().toISOString(),
    };
    prefs.set('sportGame', sport);
    if (item) {
      if (photo) fields.photoId = await savePhoto(item.photoId || item.id, photo);
      collection.update(item.key, fields);
      collection.setQty(item.key, qty);
      toast('Gespeichert');
    } else {
      const id = `m${Date.now()}`;
      if (photo) fields.photoId = await savePhoto(id, photo);
      collection.add({ ...fields, id, variant: 'std' }, qty);
      toast(`${nameVal} wurde zur Sammlung hinzugefügt`);
    }
    closeSheet('#sheet');
    if (current === 'scan') resumeCamera();
  };
}

/** Rät den Spielernamen aus dem Kartentext (meist groß gedruckt, 2–3 Wörter). */
function guessName(text) {
  const lines = (text || '').split('\n').map(l => l.replace(/[^A-Za-zÀ-ÿ.' -]/g, ' ').replace(/\s+/g, ' ').trim());
  const cands = lines.filter(l => {
    const words = l.split(' ').filter(w => w.length >= 2);
    return words.length >= 1 && words.length <= 3 && l.length >= 5 && l.length <= 28;
  });
  cands.sort((a, b) => score(b) - score(a));
  return cands[0] ? cands[0].toLowerCase().replace(/(^|[\s-])\p{L}/gu, m => m.toUpperCase()) : '';
  function score(l) {
    const upper = (l.match(/[A-ZÄÖÜ]/g) || []).length / l.replace(/\s/g, '').length;
    return upper + (l.split(' ').length === 2 ? 0.5 : 0) + l.length / 100;
  }
}

/* ---------------- Kamera ---------------- */
const video = $('#video');
const overlay = $('#overlay');
let stream = null;
let torchOn = false;
let caps = {};

async function startCamera() {
  $('#camera-error').hidden = true;
  if (stream) return;
  liveStatus('Kamera startet …');
  try {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('unsupported');
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 3840 }, height: { ideal: 2160 } },
    });
    if (current !== 'scan') { stopCamera(); return; }
    video.srcObject = stream;
    await video.play().catch(() => {});
    const track = stream.getVideoTracks()[0];
    caps = track.getCapabilities?.() || {};
    $('#btn-torch').hidden = !caps.torch;
    // Dauerhaft scharf stellen, belichten und Weißabgleich, wenn das Handy es kann
    const auto = {};
    if (caps.focusMode?.includes('continuous')) auto.focusMode = 'continuous';
    if (caps.exposureMode?.includes('continuous')) auto.exposureMode = 'continuous';
    if (caps.whiteBalanceMode?.includes('continuous')) auto.whiteBalanceMode = 'continuous';
    if (Object.keys(auto).length) track.applyConstraints({ advanced: [auto] }).catch(() => {});
    setupZoom(track);
    startLive();
  } catch (err) {
    stream = null;
    $('#camera-error-text').textContent = err?.name === 'NotAllowedError'
      ? 'Du hast den Kamerazugriff abgelehnt. Erlaube ihn in den Einstellungen deines Handys oder wähle ein Foto.'
      : 'Die Kamera konnte nicht gestartet werden. Du kannst stattdessen ein Foto aus deiner Galerie wählen.';
    $('#camera-error').hidden = false;
  }
}

function stopCamera() {
  stopLive();
  stream?.getTracks().forEach(t => t.stop());
  stream = null;
  torchOn = false;
  caps = {};
  $('#btn-torch').classList.remove('on');
  $('#zoom-ctrl').hidden = true;
  video.srcObject = null;
}
function resumeCamera() { if (video.paused && stream) video.play().catch(() => {}); }

$('#btn-camera-retry').onclick = startCamera;
$('#btn-torch').onclick = async () => {
  const track = stream?.getVideoTracks()[0];
  if (!track) return;
  torchOn = !torchOn;
  await track.applyConstraints({ advanced: [{ torch: torchOn }] }).catch(() => { torchOn = false; });
  $('#btn-torch').classList.toggle('on', torchOn);
};

/** Zoom-Stufen 1× / 2× / 3× – mit Zoom kann man weiter weg bleiben, dann stellt die Kamera besser scharf. */
function setupZoom(track) {
  const box = $('#zoom-ctrl');
  const z = caps.zoom;
  if (!z || !(z.max > z.min)) { box.hidden = true; return; }
  const levels = [1, 2, 3].map(f => z.min * f).filter(v => v <= z.max + 1e-6);
  let active = track.getSettings?.().zoom ?? z.min;
  box.innerHTML = levels.map(v => `<button data-z="${v}">${Math.round(v / z.min)}×</button>`).join('');
  const mark = () => box.querySelectorAll('button').forEach(b => b.classList.toggle('on', Math.abs(parseFloat(b.dataset.z) - active) < 0.05));
  box.querySelectorAll('button').forEach(b => b.onclick = async () => {
    active = parseFloat(b.dataset.z);
    mark();
    await track.applyConstraints({ advanced: [{ zoom: active }] }).catch(() => {});
  });
  mark();
  box.hidden = false;
}

/** Abbildung Kamerabild ↔ Bildschirm (das Video füllt den Bildschirm wie object-fit: cover). */
function videoBox() {
  const vw = video.videoWidth, vh = video.videoHeight;
  const r = video.getBoundingClientRect();
  const scale = Math.max(r.width / vw, r.height / vh);
  return { vw, vh, r, scale, offX: (r.width - vw * scale) / 2, offY: (r.height - vh * scale) / 2 };
}

/** Antippen zum Scharfstellen auf genau diese Stelle. */
video.addEventListener('click', async e => {
  const track = stream?.getVideoTracks()[0];
  if (!track || !video.videoWidth) return;
  const b = videoBox();
  const ring = $('#focus-ring');
  ring.hidden = true;
  ring.style.left = `${e.clientX - b.r.left}px`;
  ring.style.top = `${e.clientY - b.r.top}px`;
  void ring.offsetWidth;
  ring.hidden = false;
  clearTimeout(ring._t);
  ring._t = setTimeout(() => { ring.hidden = true; }, 1200);
  const x = Math.min(1, Math.max(0, (e.clientX - b.r.left - b.offX) / b.scale / b.vw));
  const y = Math.min(1, Math.max(0, (e.clientY - b.r.top - b.offY) / b.scale / b.vh));
  const mode = caps.focusMode?.includes('single-shot') ? 'single-shot' : caps.focusMode?.includes('continuous') ? 'continuous' : null;
  try {
    await track.applyConstraints({ advanced: [{ pointsOfInterest: [{ x, y }], ...(mode ? { focusMode: mode } : {}) }] });
    if (mode === 'single-shot') setTimeout(() => track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }).catch(() => {}), 2500);
  } catch { /* Handy unterstützt keinen Fokuspunkt */ }
});

/** Schneidet den Bereich des Rahmens (plus Rand) aus dem Kamerabild aus – letzter Ausweg. */
function captureFrame(padFactor = 0.02) {
  if (!video.videoWidth) return null;
  const b = videoBox();
  const fr = $('#scan-frame').getBoundingClientRect();
  const pad = padFactor * fr.width;
  let sx = (fr.left - b.r.left - b.offX - pad) / b.scale;
  let sy = (fr.top - b.r.top - b.offY - pad) / b.scale;
  let sw = (fr.width + pad * 2) / b.scale;
  let sh = (fr.height + pad * 2) / b.scale;
  sx = Math.max(0, sx); sy = Math.max(0, sy);
  sw = Math.min(b.vw - sx, sw); sh = Math.min(b.vh - sy, sh);
  const c = document.createElement('canvas');
  c.width = Math.round(sw); c.height = Math.round(sh);
  c.getContext('2d').drawImage(video, sx, sy, sw, sh, 0, 0, c.width, c.height);
  return c;
}

/**
 * Bild für den Scan aufnehmen und die Karte gerade ausschneiden:
 * 1. Foto in voller Kamera-Auflösung (ohne Blitz – der spiegelt auf Karten),
 * 2. sonst das Videobild mit dem live gefundenen Rahmen,
 * 3. sonst der Bereich des Rahmens.
 */
async function captureForScan(quad) {
  const track = stream?.getVideoTracks()[0];
  if (track && 'ImageCapture' in window) {
    try {
      const ic = new ImageCapture(track);
      const settings = {};
      try {
        const pc = await ic.getPhotoCapabilities();
        if (pc?.imageWidth?.max) Object.assign(settings, { imageWidth: pc.imageWidth.max, imageHeight: pc.imageHeight?.max });
        if (pc?.fillLightMode?.includes('off')) settings.fillLightMode = 'off';
      } catch { /* Standard-Einstellungen */ }
      const blob = await Promise.race([
        ic.takePhoto(settings),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Zeitüberschreitung')), 4500)),
      ]);
      const photo = await imageToCanvas(blob, 3000);
      const found = await findCard(photo);
      if (found.found) return found.canvas;
    } catch { /* weiter mit dem Videobild */ }
  }
  if (!video.videoWidth) return null;
  const frame = document.createElement('canvas');
  frame.width = video.videoWidth;
  frame.height = video.videoHeight;
  frame.getContext('2d').drawImage(video, 0, 0);
  if (quad && performance.now() - quad.at < 1500) {
    try { return await warpCard(frame, quad.corners); } catch { /* unten weiter */ }
  }
  const found = await findCard(frame);
  return found.found ? found.canvas : captureFrame(0.02);
}

function imageToCanvas(file, maxSide = 2400) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const s = Math.min(1, maxSide / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * s); c.height = Math.round(img.height * s);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      resolve(c);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Bild konnte nicht geladen werden')); };
    img.src = url;
  });
}

/* ---------------- Live-Erkennung im Kamerabild ---------------- */
const SHARP_MIN = 0.35;  // Schärfe (Laplace-Varianz ÷ Kontrast) – scharf ≈ 2–4, darunter ist die Schrift zu weich
// Anteil fast weißer Pixel. Helle Karten haben schon ohne Spiegelung bis ~11 % – nur große Lichtflecken melden
const GLARE_MAX = 0.18;
const STEADY = 0.012;    // maximale Bewegung der Ecken pro Bild (Anteil der Bilddiagonale)
const HOLD_MS = 900;     // so lange muss die Karte ruhig und scharf sein, bis Auto-Scan auslöst
const live = { running: false, timer: null, prev: null, steadySince: 0, quad: null, locked: false, misses: 0, small: document.createElement('canvas') };
let autoScan = prefs.get('autoScan') ?? true;

function liveStatus(text, state = '') {
  const el = $('#live-status');
  if (el.textContent !== text) el.textContent = text;
  el.className = `live-status ${state}`;
}

function setShutterProgress(p) {
  $('#shutter-progress').style.strokeDashoffset = String(258 * (1 - p));
  $('#btn-shutter').classList.toggle('armed', p > 0);
}

function drawQuad(corners, state) {
  const dpr = window.devicePixelRatio || 1;
  const w = Math.round(overlay.clientWidth * dpr), h = Math.round(overlay.clientHeight * dpr);
  if (overlay.width !== w || overlay.height !== h) { overlay.width = w; overlay.height = h; }
  const ctx = overlay.getContext('2d');
  ctx.clearRect(0, 0, w, h);
  $('.scanner').classList.toggle('tracking', !!corners);
  if (!corners) return;
  const b = videoBox();
  const pts = corners.map(p => ({ x: (p.x * b.scale + b.offX) * dpr, y: (p.y * b.scale + b.offY) * dpr }));
  const color = state === 'ok' ? '61, 220, 132' : '255, 209, 92';
  ctx.beginPath();
  pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
  ctx.closePath();
  ctx.fillStyle = `rgba(${color}, .14)`;
  ctx.fill();
  ctx.lineJoin = 'round';
  ctx.lineWidth = 3 * dpr;
  ctx.strokeStyle = `rgb(${color})`;
  ctx.stroke();
  ctx.fillStyle = `rgb(${color})`;
  pts.forEach(p => { ctx.beginPath(); ctx.arc(p.x, p.y, 5 * dpr, 0, Math.PI * 2); ctx.fill(); });
}

function startLive() {
  if (live.running) return;
  live.running = true;
  live.prev = null;
  live.steadySince = 0;
  warmUpCrop();
  liveTick();
}

function stopLive() {
  live.running = false;
  clearTimeout(live.timer);
  live.quad = null;
  drawQuad(null);
  setShutterProgress(0);
}

async function liveTick() {
  if (!live.running) return;
  const ready = current === 'scan' && stream && !busy && $('#sheet').hidden && !video.paused && video.videoWidth;
  if (!ready) { live.timer = setTimeout(liveTick, 300); return; }
  if (!cropReady()) { liveStatus('Bilderkennung lädt …'); live.timer = setTimeout(liveTick, 300); return; }
  const t0 = performance.now();
  const vw = video.videoWidth, vh = video.videoHeight;
  const s = Math.min(1, 480 / Math.max(vw, vh));
  const sm = live.small;
  sm.width = Math.round(vw * s);
  sm.height = Math.round(vh * s);
  sm.getContext('2d').drawImage(video, 0, 0, sm.width, sm.height);
  const quad = await locateCard(sm, { maxSide: 480, minArea: 0.05 });
  if (!live.running) return;

  if (quad) {
    const corners = quad.corners.map(p => ({ x: p.x / s, y: p.y / s }));
    const q = cardQuality(await warpCard(sm, quad.corners, 160, 224));
    if (!live.running) return; // Kamera wurde inzwischen verlassen
    const move = live.prev
      ? Math.max(...corners.map((p, i) => Math.hypot(p.x - live.prev[i].x, p.y - live.prev[i].y))) / Math.hypot(vw, vh)
      : 1;
    live.prev = corners;
    live.quad = { corners, at: performance.now() };

    live.misses = 0;
    // Nach einem Scan erst wieder auslösen, wenn eine neue Karte kommt (oder die alte deutlich bewegt wurde)
    if (live.locked && move > 0.15) live.locked = false;

    let state = 'ok', msg = 'Erkannt – stillhalten';
    if (quad.area < 0.1) { state = 'warn'; msg = 'Etwas näher ran'; }
    else if (q.glare > GLARE_MAX) { state = 'warn'; msg = 'Spiegelung – Karte kippen'; }
    else if (q.sharpness < SHARP_MIN) { state = 'warn'; msg = 'Unscharf – stillhalten'; }
    if (state === 'ok' && move < STEADY && !live.locked) live.steadySince ||= performance.now();
    else live.steadySince = 0;
    const held = live.steadySince ? (performance.now() - live.steadySince) / HOLD_MS : 0;

    drawQuad(corners, state);
    if (live.locked && state === 'ok') msg = 'Gescannt – nächste Karte';
    else if (autoScan && state === 'ok' && live.steadySince) msg = 'Erkannt – Scan startet';
    liveStatus(msg, state);
    setShutterProgress(autoScan ? Math.min(1, held) : 0);
    if (autoScan && held >= 1) {
      live.steadySince = 0;
      live.locked = true;
      setShutterProgress(0);
      await shoot();
      live.timer = setTimeout(liveTick, 400);
      return;
    }
  } else {
    // Zwei Bilder ohne Karte: die alte Karte ist weg, Auto-Scan ist wieder bereit
    if (++live.misses >= 2) live.locked = false;
    live.prev = null;
    live.steadySince = 0;
    live.quad = null;
    drawQuad(null);
    liveStatus('Karte ins Bild halten');
    setShutterProgress(0);
  }
  live.timer = setTimeout(liveTick, Math.max(60, 170 - (performance.now() - t0)));
}

/** Auslösen: Foto aufnehmen, Karte ausschneiden, erkennen. */
async function shoot() {
  if (busy) return;
  const quad = live.quad;
  setStatus('Foto wird aufgenommen …', 0.01);
  const card = await captureForScan(quad).catch(() => null);
  setStatus(null);
  if (card) await scan(card, true);
}

$('#btn-auto').onclick = () => {
  autoScan = !autoScan;
  prefs.set('autoScan', autoScan);
  $('#btn-auto').classList.toggle('on', autoScan);
  $('#btn-auto').setAttribute('aria-pressed', String(autoScan));
  toast(autoScan ? 'Auto-Scan an: Die App löst selbst aus' : 'Auto-Scan aus: Tippe selbst auf den Auslöser');
};
$('#btn-auto').classList.toggle('on', autoScan);
$('#btn-auto').setAttribute('aria-pressed', String(autoScan));

/* ---------------- Scan-Modus ---------------- */
let scanMode = prefs.get('scanMode') || 'pokemon';
const MODE_UI = {
  pokemon: 'Karte auf einen dunklen Untergrund legen – Nummer unten muss lesbar sein',
  yugioh: 'Karte auf einen dunklen Untergrund legen – Set-Code unter dem Bild muss lesbar sein',
  sport: 'Ganze Karte ins Bild halten – Foto und Name werden übernommen',
};
function setScanMode(mode) {
  scanMode = mode;
  prefs.set('scanMode', mode);
  $$('#scan-mode button').forEach(b => b.classList.toggle('on', b.dataset.mode === mode));
  $('#scan-hint').textContent = MODE_UI[mode];
}
$$('#scan-mode button').forEach(b => b.onclick = () => setScanMode(b.dataset.mode));

/* ---------------- Scan-Ablauf ---------------- */
let busy = false;

function setStatus(text, progress, card = null) {
  const s = $('#scan-status');
  s.hidden = text == null;
  $('.scanner').classList.toggle('busy', text != null);
  if (text != null) $('#scan-status-text').textContent = text;
  if (progress != null) $('#scan-progress').style.width = `${Math.round(progress * 100)}%`;
  const thumb = $('#scan-thumb');
  if (text == null) thumb.hidden = true;
  else if (card) {
    const c = document.createElement('canvas');
    c.width = 128; c.height = Math.round(card.height * 128 / card.width);
    c.getContext('2d').drawImage(card, 0, 0, c.width, c.height);
    thumb.src = c.toDataURL('image/jpeg', 0.8);
    thumb.hidden = false;
  }
}

async function scan(source, cropped = false) {
  if (busy || !source) return;
  busy = true;
  $('#btn-shutter').disabled = true;
  video.pause();
  try {
    let canvas = source;
    // Hat das Bild selbst schon Kartenformat (63 : 88), ist es bereits zugeschnitten –
    // sonst würde die Suche ein Rechteck innerhalb der Karte finden (z. B. den Bildrahmen)
    const ratio = Math.min(source.width, source.height) / Math.max(source.width, source.height);
    if (!cropped && (ratio < 0.69 || ratio > 0.745)) {
      setStatus('Karte wird im Foto gesucht …', 0.02);
      canvas = (await findCard(source)).canvas;
    }
    setStatus('Karte wird gelesen …', 0.03, canvas);
    if (scanMode === 'sport') await scanSport(canvas);
    else if (scanMode === 'yugioh') await scanYugioh(canvas);
    else await scanPokemon(canvas);
  } catch (err) {
    console.error(err);
    setStatus(null);
    toast(navigator.onLine === false ? 'Keine Internetverbindung' : 'Scan fehlgeschlagen – bitte nochmal versuchen');
    resumeCamera();
  } finally {
    busy = false;
    $('#btn-shutter').disabled = false;
  }
}

const reading = p => setStatus('Karte wird gelesen …', 0.05 + p * 0.55);

async function scanPokemon(canvas) {
  setStatus('Karte wird gelesen …', 0.02);
  const totals = await api.setTotals().catch(() => new Set());
  const best = list => Math.max(0, ...list.map(c => c.score));
  let ocr = await readCard(canvas, reading, totals);
  setStatus('Karte wird gesucht …', 0.6);
  let candidates = await api.identify(ocr, lang());
  // Unsicher? Vielleicht steht die Karte auf dem Kopf – dann die Richtung nehmen, die besser passt
  if (best(candidates) < 0.85) {
    const turned = rotate180(canvas);
    const again = await readCard(turned, reading, totals);
    const other = await api.identify(again, lang());
    if (best(other) > best(candidates)) { ocr = again; canvas = turned; candidates = other; }
  }
  setStatus('Bild wird verglichen …', 0.8);
  // Karten mit gleichem Namen sehen oft ganz anders aus – das Bild entscheidet
  await rankByImage(canvas, candidates, c => (c.image ? `${c.image}/low.webp` : ''), 40);
  const { confident, label } = api.decide(candidates);
  for (const c of candidates.slice(0, 15)) if (!c.setName) c.setName = await api.setName(api.setIdOf(c.id));
  // Weder Nummer noch Name noch Bild passen richtig: lieber ehrlich „nicht erkannt“ als eine zufällige Karte
  const top = candidates[0];
  const weak = !confident && top && top.score < 0.6 && (top.imageScore == null || top.imageScore < 0.64);
  await finishScan('pokemon', weak ? [] : candidates, confident, label, { canvas, ocr }, ocr.nameText);
}

async function scanYugioh(canvas) {
  setStatus('Karte wird gelesen …', 0.02);
  let ocr = await readYugioh(canvas, reading, ygo);
  if (!ocr.setCodes.length && !ocr.passcodes.length) {
    const turned = rotate180(canvas);
    const again = await readYugioh(turned, reading, ygo);
    if (again.setCodes.length || again.passcodes.length) { ocr = again; canvas = turned; }
  }
  setStatus('Karte wird gesucht …', 0.75);
  const candidates = await ygo.identify(ocr, lang());
  const [top, second] = candidates;
  const confident = !!top && (top.via === 'number' || (top.score >= 0.95 && (!second || second.score < 0.9)));
  const label = top?.via === 'number' ? top.numberText : 'Name erkannt';
  const weak = !confident && top && top.score < 0.6;
  await finishScan('yugioh', weak ? [] : candidates, confident, label, { canvas, ocr }, ocr.nameText);
}

async function finishScan(game, candidates, confident, label, scanData, nameText) {
  setStatus('Fertig', 1);
  await new Promise(r => setTimeout(r, 150));
  setStatus(null);
  if (!candidates.length) showNotFound(game, api.cleanName(nameText), scanData);
  else if (confident) openCard(game, candidates[0], { alternatives: candidates.slice(0, 15), recognized: label, scan: scanData });
  else showChoices(game, candidates, scanData);
}

async function scanSport(canvas) {
  setStatus('Text wird gelesen …', 0.05);
  const text = await readText(canvas, p => setStatus('Text wird gelesen …', 0.05 + p * 0.9)).catch(() => '');
  setStatus(null);
  openSportForm({ canvas, name: guessName(text) });
}

function showNotFound(game, guess, scan = null) {
  ++sheetToken;
  const what = game === 'yugioh' ? 'Set-Code (z. B. LOB-DE001) unter dem Bild' : 'Nummer unten (z. B. 025/165)';
  $('#sheet-body').innerHTML = `
    <div class="empty small" style="padding-top:10px">
      <h2>Karte nicht erkannt</h2>
    </div>
    ${seenBox(game, scan)}
    <p class="search-tip" style="margin:12px 2px">So klappt es besser:</p>
    <div class="list">
      <div class="list-item"><div><b>Richtige Kartenart?</b><small>Oben im Scanner Pokémon, Yu-Gi-Oh! oder Sport wählen</small></div></div>
      <div class="list-item"><div><b>Gutes Licht</b><small>Keine Spiegelungen auf der Karte – Hülle wenn möglich entfernen</small></div></div>
      <div class="list-item"><div><b>Dunkler Untergrund</b><small>Karte auf einen dunklen Tisch oder Stoff legen – dann findet die App die Ränder</small></div></div>
      <div class="list-item"><div><b>Scharf halten</b><small>${what} muss lesbar sein – kurz stillhalten</small></div></div>
    </div>
    <div class="actions">
      <button class="btn secondary" id="nf-retry">Nochmal scannen</button>
      <button class="btn primary" id="nf-search">Selbst suchen</button>
    </div>`;
  openSheet('#sheet');
  $('#nf-retry').onclick = () => { closeSheet('#sheet'); resumeCamera(); };
  $('#nf-search').onclick = () => {
    closeSheet('#sheet');
    setSearchGame(game);
    go('search');
    if (guess) { $('#search-input').value = guess; runSearch(); }
  };
}

$('#btn-shutter').onclick = () => { live.locked = true; shoot(); };
const pickPhoto = () => $('#file-input').click();
$('#btn-gallery').onclick = pickPhoto;
$('#btn-gallery-2').onclick = pickPhoto;
$('#file-input').onchange = async e => {
  const file = e.target.files?.[0];
  e.target.value = '';
  if (!file) return;
  try { scan(await imageToCanvas(file)); } catch (err) { toast(err.message); }
};
// Nach dem Schließen eines Ergebnisses weiter scannen
new MutationObserver(() => { if ($('#sheet').hidden && current === 'scan' && !busy) resumeCamera(); })
  .observe($('#sheet'), { attributes: true, attributeFilter: ['hidden'] });

/* ---------------- Suche ---------------- */
let searchGame = 'pokemon';
let searchToken = 0;

function setSearchGame(game) {
  searchGame = isSport(game) ? 'sport' : game;
  $$('#search-game button').forEach(b => b.classList.toggle('on', b.dataset.game === searchGame));
  const sport = searchGame === 'sport';
  $('#sport-panel').hidden = !sport;
  $('#search-form').hidden = sport;
  $('#search-tip').hidden = sport;
  $('#search-results').hidden = sport;
  $('#search-empty').hidden = true;
  $('#search-input').placeholder = searchGame === 'yugioh' ? 'Name, z. B. Dark Magician' : 'Name, z. B. Glurak oder Pikachu 025';
  $('#search-tip').innerHTML = searchGame === 'yugioh'
    ? 'Tipp: Deutsche und englische Namen funktionieren, z. B. <b>Blauäugiger</b>'
    : 'Tipp: Name und Nummer kombinieren, z. B. <b>Pikachu 25</b>';
  if (!sport && $('#search-input').value) runSearch();
}
$$('#search-game button').forEach(b => b.onclick = () => setSearchGame(b.dataset.game));

async function runSearch() {
  const q = $('#search-input').value.trim();
  const grid = $('#search-results');
  $('#search-empty').hidden = true;
  if (q.length < 2 || searchGame === 'sport') { grid.replaceChildren(); return; }
  const token = ++searchToken;
  const game = searchGame;
  grid.innerHTML = Array.from({ length: 6 }, () => '<div class="tile"><div class="tile-img skeleton"></div></div>').join('');
  let list = [];
  try { list = game === 'yugioh' ? await ygo.search(q, lang()) : await api.searchCards(q, lang()); } catch { /* unten behandelt */ }
  if (token !== searchToken) return;
  if (game === 'pokemon') {
    const sets = await api.getSets().catch(() => []);
    const setNames = new Map(sets.map(s => [s.id, s.name]));
    list.forEach(c => { c.setName = setNames.get(api.setIdOf(c.id)) || api.setIdOf(c.id); });
    // Karten mit Bild zuerst
    list.sort((a, b) => !!b.image - !!a.image);
  }
  $('#search-empty').hidden = list.length > 0;
  grid.replaceChildren(...list.map(c => {
    const el = game === 'yugioh'
      ? tile({ name: c.name, sub: c.humanReadableCardType || c.type || '', image: ygo.imageUrl(c, 'small') })
      : tile({ name: c.name, sub: `${c.setName} · ${c.localId}`, image: c.image ? `${c.image}/low.webp` : '' });
    el.onclick = () => openCard(game, c);
    return el;
  }));
}
let searchDebounce;
$('#search-input').addEventListener('input', () => { clearTimeout(searchDebounce); searchDebounce = setTimeout(runSearch, 450); });
$('#search-form').addEventListener('submit', e => { e.preventDefault(); clearTimeout(searchDebounce); $('#search-input').blur(); runSearch(); });

/* ---------------- Einstellungen ---------------- */
function markLang() { $$('#lang-switch button').forEach(b => b.classList.toggle('on', b.dataset.lang === lang())); }
$('#btn-settings').onclick = () => { markLang(); disarmClear(); openSheet('#settings'); };
$$('#lang-switch button').forEach(b => b.onclick = () => {
  prefs.set('lang', b.dataset.lang);
  markLang();
  if ($('#search-input').value) runSearch();
});
$('#btn-tutorial').onclick = () => { closeSheet('#settings'); showOnboarding(); };

let clearTimer;
function disarmClear() {
  clearTimeout(clearTimer);
  $('#btn-clear').classList.remove('armed');
  $('#clear-hint').textContent = 'Entfernt alle Karten auf diesem Gerät';
}
$('#btn-clear').onclick = () => {
  const btn = $('#btn-clear');
  if (!collection.all().length) { toast('Die Sammlung ist schon leer'); return; }
  if (!btn.classList.contains('armed')) {
    btn.classList.add('armed');
    $('#clear-hint').textContent = 'Nochmal tippen, um wirklich alles zu löschen';
    clearTimer = setTimeout(disarmClear, 4000);
    return;
  }
  disarmClear();
  collection.clear();
  clearPhotos();
  closeSheet('#settings');
  toast('Sammlung wurde geleert');
};

/* ---------------- Tutorial ---------------- */
let obIndex = 0;
const obCount = $$('.ob-slide').length;

function showOnboarding() { obIndex = 0; renderOb(); $('#onboarding').hidden = false; }
function finishOnboarding() { prefs.set('onboarded', true); $('#onboarding').hidden = true; }
function renderOb() {
  $('#ob-track').style.transform = `translateX(${-obIndex * 100}%)`;
  $$('#ob-dots i').forEach((d, i) => d.classList.toggle('on', i === obIndex));
  $('#ob-next').textContent = obIndex === obCount - 1 ? "Los geht's" : 'Weiter';
  $('#ob-skip').style.visibility = obIndex === obCount - 1 ? 'hidden' : 'visible';
}
$('#ob-next').onclick = () => { if (obIndex < obCount - 1) { obIndex++; renderOb(); } else finishOnboarding(); };
$('#ob-skip').onclick = finishOnboarding;
let touchX = null;
$('#onboarding').addEventListener('touchstart', e => { touchX = e.touches[0].clientX; }, { passive: true });
$('#onboarding').addEventListener('touchend', e => {
  if (touchX == null) return;
  const dx = e.changedTouches[0].clientX - touchX;
  touchX = null;
  if (Math.abs(dx) < 50) return;
  obIndex = Math.min(obCount - 1, Math.max(0, obIndex + (dx < 0 ? 1 : -1)));
  renderOb();
});

/* ---------------- Android-Zurück-Taste ---------------- */
const CapApp = window.Capacitor?.Plugins?.App;
CapApp?.addListener('backButton', () => {
  if (!$('#onboarding').hidden) { if (obIndex > 0) { obIndex--; renderOb(); } else finishOnboarding(); return; }
  if (closeSheet()) return;
  if (current !== 'collection') { go('collection'); return; }
  CapApp.exitApp();
});

/* ---------------- Start ---------------- */
setScanMode(scanMode);
setSearchGame('pokemon');
renderCollection();
api.getSets().catch(() => {});
ygo.usdToEur().catch(() => {});
if (!prefs.get('onboarded')) showOnboarding();

// Web-App im Browser (iPhone): Sammlung möglichst dauerhaft speichern und Tipp zum Home-Bildschirm
if (!window.Capacitor?.isNativePlatform?.()) {
  navigator.storage?.persist?.().catch(() => {});
  const iOS = /iPhone|iPad|iPod/.test(navigator.userAgent);
  const standalone = navigator.standalone || matchMedia('(display-mode: standalone)').matches;
  if (iOS && !standalone && !prefs.get('homeHint')) {
    setTimeout(() => {
      toast('Tipp: Tippe unten auf „Teilen“ und dann auf „Zum Home-Bildschirm“ – dann hast du CardVault wie eine App.', 9000);
      prefs.set('homeHint', true);
    }, prefs.get('onboarded') ? 1500 : 60000);
  }
}
