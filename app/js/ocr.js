// Texterkennung direkt auf dem Gerät (Tesseract.js, Dateien liegen in www/vendor).
const abs = p => new URL(p, location.href).href;

let workerPromise = null;
let onProgress = () => {};

function getWorker() {
  if (!workerPromise) {
    workerPromise = Tesseract.createWorker(['deu', 'eng'], 1, {
      workerPath: abs('vendor/tesseract/worker.min.js'),
      corePath: abs('vendor/tesseract/core/'),
      langPath: abs('vendor/tesseract/lang/'),
      gzip: false,
      workerBlobURL: false,
      logger: m => { if (m.status === 'recognizing text') onProgress(m.progress); },
    }).catch(err => { workerPromise = null; throw err; });
  }
  return workerPromise;
}

/** Lädt die Erkennung schon im Hintergrund, damit der erste Scan schneller geht. */
export function warmUp() { getWorker().catch(() => {}); }

/** Schneidet einen Bereich (Anteile 0..1) aus, vergrößert ihn und erhöht den Kontrast. */
function region(src, x, y, w, h, targetW = 1400, otsu = false) {
  const sx = src.width * x, sy = src.height * y, sw = src.width * w, sh = src.height * h;
  const scale = Math.min(5, targetW / sw);
  const c = document.createElement('canvas');
  c.width = Math.round(sw * scale);
  c.height = Math.round(sh * scale);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, sx, sy, sw, sh, 0, 0, c.width, c.height);

  const img = ctx.getImageData(0, 0, c.width, c.height);
  const d = img.data;
  const hist = new Array(256).fill(0);
  let min = 255, max = 0;
  for (let i = 0; i < d.length; i += 4) {
    const g = Math.round(d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114);
    d[i] = g;
    hist[g]++;
    if (g < min) min = g;
    if (g > max) max = g;
  }
  if (otsu === 'adaptive' || otsu === 'adaptive-invert') {
    adaptive(d, c.width, c.height, otsu === 'adaptive-invert');
  } else {
    const threshold = otsu ? otsuThreshold(hist, d.length / 4) : 0;
    const range = Math.max(1, max - min);
    for (let i = 0; i < d.length; i += 4) {
      const v = otsu ? (d[i] > threshold ? 255 : 0) : ((d[i] - min) / range) * 255;
      d[i] = d[i + 1] = d[i + 2] = v;
    }
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

/**
 * Schwarz-weiß nach lokaler Helligkeit: robust bei gemustertem Hintergrund (Goldrahmen, JPEG-Rauschen).
 * Dunkle Schrift wird schwarz; mit `invert` wird helle Schrift schwarz.
 */
function adaptive(d, w, h, invert) {
  const integral = new Float64Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) {
      row += d[(y * w + x) * 4];
      integral[(y + 1) * (w + 1) + x + 1] = integral[y * (w + 1) + x + 1] + row;
    }
  }
  const r = Math.max(8, Math.round(Math.min(w, h) / 3));
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - r), y1 = Math.min(h, y + r + 1);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - r), x1 = Math.min(w, x + r + 1);
      const sum = integral[y1 * (w + 1) + x1] - integral[y0 * (w + 1) + x1] - integral[y1 * (w + 1) + x0] + integral[y0 * (w + 1) + x0];
      const mean = sum / ((x1 - x0) * (y1 - y0));
      const g = d[(y * w + x) * 4];
      const ink = invert ? g > mean + 18 : g < mean - 18;
      const i = (y * w + x) * 4;
      d[i] = d[i + 1] = d[i + 2] = ink ? 0 : 255;
    }
  }
}

function otsuThreshold(hist, total) {
  let sum = 0;
  for (let t = 0; t < 256; t++) sum += t * hist[t];
  let sumB = 0, wB = 0, best = 0, threshold = 128;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += t * hist[t];
    const between = wB * wF * (sumB / wB - (sum - sumB) / wF) ** 2;
    if (between > best) { best = between; threshold = t; }
  }
  return threshold;
}

async function read(worker, canvas, params) {
  await worker.setParameters(params);
  const { data } = await worker.recognize(canvas);
  return data.text || '';
}

const DIGIT_FIX = { O: '0', D: '0', Q: '0', I: '1', L: '1', T: '7', S: '5', B: '8', Z: '2', G: '6' };
const toDigits = s => s.replace(/[A-Z]/g, ch => DIGIT_FIX[ch] ?? ch);

/** Sucht Kartennummern wie „025/165“, „TG05/TG30“ oder „SV049/SV122“ im Text. */
export function parseNumbers(text) {
  const out = [];
  const seen = new Set();
  const re = /([A-Z]{0,4})\s?([0-9OIDQLSBZG]{1,3})\s?[\/|]\s?([A-Z]{0,4})\s?([0-9OIDQLSBZG]{2,3})/g;
  const t = text.toUpperCase();
  let m;
  while ((m = re.exec(t))) {
    const [, p1, n1, , n2] = m;
    const num = toDigits(n1), total = toDigits(n2);
    if (!/^\d+$/.test(num) || !/^\d+$/.test(total)) continue;
    const nN = parseInt(num, 10), tN = parseInt(total, 10);
    if (tN < 10 || tN > 400 || nN === 0) continue;
    // Mit Präfix (Trainer-Galerie usw.) und ohne – beide Varianten probieren
    const options = [];
    if (/^(TG|GG|SV|RC|SH)$/.test(p1)) options.push({ prefix: p1, num, total });
    options.push({ prefix: '', num, total });
    // „I25“ war vielleicht „125“: als Ziffer gelesene Buchstaben vor der Nummer
    if (p1 && p1.length + n1.length <= 3 && /^\d+$/.test(toDigits(p1))) {
      options.push({ prefix: '', num: toDigits(p1) + num, total });
    }
    for (const o of options) {
      const key = `${o.prefix}${o.num}/${o.total}`;
      if (!seen.has(key)) { seen.add(key); out.push(o); }
    }
  }
  return out;
}

/**
 * Kursive Nummern auf Full-Art-Karten: der Schrägstrich wird oft als 1, 4 oder 7 gelesen
 * („238419“ statt „238/191“). Liefert mögliche Aufteilungen, die zu echten Set-Größen passen.
 */
export function fuzzyNumbers(text, setTotals) {
  const out = [];
  const seen = new Set();
  const runs = text.toUpperCase().split(/\s+/).map(toDigits).map(t => t.replace(/[^0-9]/g, '')).filter(t => t.length >= 4);
  for (const run of runs) {
    for (let start = 0; start < run.length; start++) {
      for (let nl = 1; nl <= 3; nl++) {
        for (const sep of [0, 1]) {
          for (let tl = 2; tl <= 3; tl++) {
            const end = start + nl + sep + tl;
            if (end > run.length) continue;
            const num = run.slice(start, start + nl);
            const total = run.slice(start + nl + sep, end);
            const nN = parseInt(num, 10), tN = parseInt(total, 10);
            if (!nN || total[0] === '0' || !setTotals.has(tN) || nN > tN * 2) continue;
            if (sep && !'147'.includes(run[start + nl])) continue;
            const key = `${nN}/${tN}`;
            if (seen.has(key)) continue;
            seen.add(key);
            // Treffer, die den ganzen Block erklären, zuerst
            const rank = (start === 0 && end === run.length ? 0 : 2) + (sep ? 0 : 1);
            out.push({ prefix: '', num, total, fuzzy: true, rank });
          }
        }
      }
    }
  }
  return out.sort((a, b) => a.rank - b.rank).slice(0, 8);
}

const NUM_PARAMS = { tessedit_pageseg_mode: '11', tessedit_char_whitelist: '0123456789/ABCDEFGHIJKLMNOPQRSTUVWXYZ' };

/**
 * Liest eine Karte aus einem Canvas, das nur die Karte zeigt.
 * @param setTotals Menge aller Set-Größen (für die unscharfe Nummernsuche)
 */
export async function readCard(card, progress = () => {}, setTotals = new Set()) {
  const worker = await getWorker();
  let stage = 0;
  const stages = 4;
  onProgress = p => progress((stage + p) / stages);

  // 1. Nummer: untere Kartenkante über die volle Breite (alte Karten haben sie rechts)
  const texts = [await read(worker, region(card, 0, 0.885, 1, 0.115), NUM_PARAMS)];
  stage = 1;

  // 2. Linke Hälfte stärker vergrößert und schwarz-weiß – zweite Meinung bei unscharfen Bildern
  texts.push(await read(worker, region(card, 0, 0.895, 0.5, 0.095, 1400, true), NUM_PARAMS));
  let numbers = parseNumbers(texts.join('\n'));
  // 2b. Full-Art-Karten: Schrift auf buntem Bild – lokal schwarz-weiß lesen
  if (!numbers.length) {
    texts.push(await read(worker, region(card, 0, 0.895, 0.5, 0.095, 1400, 'adaptive'), NUM_PARAMS));
    numbers = parseNumbers(texts.join('\n'));
  }
  stage = 2;

  // 3. Name: oberer Streifen ohne KP-Angabe rechts, einmal als Zeile, einmal als Block
  const nameLine = await read(worker, region(card, 0.04, 0.02, 0.72, 0.1, 1100, true), {
    tessedit_pageseg_mode: '7', tessedit_char_whitelist: '',
  });
  const nameBlock = await read(worker, region(card, 0.04, 0.02, 0.72, 0.1, 1100), {
    tessedit_pageseg_mode: '6', tessedit_char_whitelist: '',
  });
  const nameText = `${nameLine} ${nameBlock}`;
  stage = 3;

  // 4. Immer noch keine Nummer? Ganze Karte lesen (z. B. Foto mit Rand drumherum)
  let fullText = '';
  if (!numbers.length) {
    fullText = await read(worker, region(card, 0, 0, 1, 1, 1600), { tessedit_pageseg_mode: '11', tessedit_char_whitelist: '' });
    numbers = parseNumbers(fullText);
  }
  // Nur die Nummernzeile, nicht der ganze Kartentext (sonst stören KP- und Schadenswerte)
  const fuzzy = fuzzyNumbers(texts.join(' '), setTotals);
  progress(1);
  onProgress = () => {};
  return { numbers, fuzzy, nameText, fullText };
}

const CODE_PARAMS = { tessedit_pageseg_mode: '11', tessedit_char_whitelist: '0123456789-ABCDEFGHIJKLMNOPQRSTUVWXYZ' };

/** Yu-Gi-Oh!: Name oben, Set-Code unter dem Bild, Passcode unten links. */
export async function readYugioh(card, progress = () => {}, yugioh) {
  const worker = await getWorker();
  let stage = 0;
  const stages = 3;
  onProgress = p => progress((stage + p) / stages);

  // Set-Code steht rechts unter dem Bild; lokal schwarz-weiß gelesen klappt es auch auf dem Goldrahmen
  let setCodes = [];
  const codeTries = [
    [[0.45, 0.70, 0.53, 0.05], 'adaptive'],
    [[0.02, 0.685, 0.96, 0.09], 'adaptive'],
    [[0.45, 0.70, 0.53, 0.05], 'adaptive-invert'], // helle Schrift auf dunklem Rahmen (Xyz, Link)
  ];
  for (const [[x, y, w, h], mode] of codeTries) {
    setCodes = yugioh.parseSetCodes(await read(worker, region(card, x, y, w, h, 1600, mode), CODE_PARAMS));
    if (setCodes.length) break;
  }
  stage = 1;
  const passText = await read(worker, region(card, 0, 0.93, 0.5, 0.07, 1400, 'adaptive'), {
    tessedit_pageseg_mode: '11', tessedit_char_whitelist: '0123456789',
  });
  const passcodes = yugioh.parsePasscodes(passText);
  stage = 2;
  const nameText = await read(worker, region(card, 0.05, 0.03, 0.78, 0.075, 1200, true), {
    tessedit_pageseg_mode: '7', tessedit_char_whitelist: '',
  });
  // Set-Code nicht gefunden? Ganze Karte durchsuchen (Foto mit Rand, schräg gehalten)
  let fullText = '';
  if (!setCodes.length && !passcodes.length) {
    fullText = await read(worker, region(card, 0, 0, 1, 1, 1600), CODE_PARAMS);
    setCodes = yugioh.parseSetCodes(fullText);
    passcodes.push(...yugioh.parsePasscodes(fullText));
  }
  progress(1);
  onProgress = () => {};
  return { setCodes, passcodes, nameText, fullText };
}

/** Ganzer Kartentext (Sportkarten und Echtheits-Check). */
export async function readText(card, progress = () => {}) {
  const worker = await getWorker();
  onProgress = progress;
  const text = await read(worker, region(card, 0, 0, 1, 1, 1600), { tessedit_pageseg_mode: '11', tessedit_char_whitelist: '' });
  onProgress = () => {};
  return text;
}

/** KP-Angabe oben rechts auf Pokémon-Karten (z. B. „KP 200“ oder „120 HP“). */
export async function readHp(card) {
  const worker = await getWorker();
  const text = await read(worker, region(card, 0.55, 0.015, 0.42, 0.085, 1000, true), {
    tessedit_pageseg_mode: '7', tessedit_char_whitelist: '0123456789KPH ',
  });
  const nums = (text.match(/\d{2,3}/g) || []).map(Number).filter(n => n >= 30 && n <= 400 && n % 10 === 0);
  return nums[0] ?? null;
}

/** Liest einen beliebigen Bereich (Anteile 0..1) – für Tests und Sonderfälle. */
export async function readRegion(card, [x, y, w, h], params, { targetW = 1400, otsu = false } = {}) {
  const worker = await getWorker();
  return read(worker, region(card, x, y, w, h, targetW, otsu), params);
}
