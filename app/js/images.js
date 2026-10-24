// Bildvergleich: Wie ähnlich sieht der Scan einem Originalbild aus der Datenbank?
// Robust gegen Licht und Farbstich, weil Helligkeit und Farben vorher normalisiert werden.
const GW = 16, GH = 22; // Raster im Kartenformat 63:88
const fpCache = new Map();

export function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Bild nicht ladbar: ${url}`));
    img.src = url;
  });
}

/** Zieht ein Bild auf ein kleines Raster und liefert normalisierte Helligkeit und Farbe. */
export function fingerprint(src) {
  const c = document.createElement('canvas');
  c.width = GW; c.height = GH;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingQuality = 'high';
  // Rand weglassen: der Scan-Ausschnitt hat etwas Spielraum um die Karte
  const sw = src.width ?? src.naturalWidth, sh = src.height ?? src.naturalHeight;
  ctx.drawImage(src, sw * 0.03, sh * 0.03, sw * 0.94, sh * 0.94, 0, 0, GW, GH);
  const d = ctx.getImageData(0, 0, GW, GH).data;

  const n = GW * GH;
  const r = new Float32Array(n), g = new Float32Array(n), b = new Float32Array(n);
  let mr = 0, mg = 0, mb = 0;
  for (let i = 0; i < n; i++) {
    r[i] = d[i * 4]; g[i] = d[i * 4 + 1]; b[i] = d[i * 4 + 2];
    mr += r[i]; mg += g[i]; mb += b[i];
  }
  mr /= n; mg /= n; mb /= n;
  // Grauwelt-Weißabgleich gegen Farbstich
  const lum = new Float32Array(n), cr = new Float32Array(n), cb = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const R = r[i] / (mr || 1), G = g[i] / (mg || 1), B = b[i] / (mb || 1);
    lum[i] = 0.299 * R + 0.587 * G + 0.114 * B;
    cr[i] = R - G;
    cb[i] = B - (R + G) / 2;
  }
  return { lum: zscore(lum), cr, cb, sat: saturation(r, g, b) };
}

function zscore(a) {
  let m = 0;
  for (const v of a) m += v;
  m /= a.length;
  let s = 0;
  for (const v of a) s += (v - m) ** 2;
  s = Math.sqrt(s / a.length) || 1;
  return a.map(v => (v - m) / s);
}

function saturation(r, g, b) {
  let sum = 0;
  for (let i = 0; i < r.length; i++) {
    const max = Math.max(r[i], g[i], b[i]), min = Math.min(r[i], g[i], b[i]);
    sum += max ? (max - min) / max : 0;
  }
  return sum / r.length;
}

function correlation(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s / a.length;
}

function chromaDistance(a, b) {
  let s = 0;
  for (let i = 0; i < a.cr.length; i++) s += Math.abs(a.cr[i] - b.cr[i]) + Math.abs(a.cb[i] - b.cb[i]);
  return s / a.cr.length;
}

/** 0..1 – Struktur (Helligkeitsverlauf) zählt stärker als Farbe. */
export function similarity(fa, fb) {
  const structure = (correlation(fa.lum, fb.lum) + 1) / 2;
  const color = Math.max(0, 1 - chromaDistance(fa, fb) / 0.6);
  return 0.7 * structure + 0.3 * color;
}

/** Fingerabdruck eines Datenbankbilds (zwischengespeichert). */
export async function remoteFingerprint(url) {
  if (!fpCache.has(url)) {
    fpCache.set(url, loadImage(url).then(fingerprint).catch(err => { fpCache.delete(url); throw err; }));
  }
  return fpCache.get(url);
}

/**
 * Vergleicht den Scan mit den Bildern der Kandidaten und ergänzt `imageScore`.
 * Kandidaten ohne ladbares Bild bekommen `imageScore = null`.
 */
export async function rankByImage(scan, candidates, urlOf, limit = 24) {
  const fp = fingerprint(scan);
  await Promise.all(candidates.slice(0, limit).map(async c => {
    const url = urlOf(c);
    if (!url) { c.imageScore = null; return; }
    try { c.imageScore = similarity(fp, await remoteFingerprint(url)); }
    catch { c.imageScore = null; }
  }));
  return fp;
}
