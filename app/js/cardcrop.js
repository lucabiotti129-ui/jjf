// Findet die Karte im Bild, richtet sie gerade aus und schneidet sie zu (OpenCV.js, liegt in www/vendor).
// Wird live auf dem Kamerabild benutzt (Rahmen um die Karte) und auf dem fertigen Foto.
const CARD_W = 630, CARD_H = 880; // Seitenverhältnis 63 × 88 mm
let cvPromise = null;
let cvReady = false;

// Das OpenCV-Modul hat selbst eine `then`-Methode. Mit ihm direkt ein Promise aufzulösen
// führt zu einer Endlosschleife – deshalb wird es immer in ein Objekt verpackt.
function loadOpenCV() {
  if (!cvPromise) {
    cvPromise = new Promise((resolve, reject) => {
      const done = () => { cvReady = true; resolve({ cv: window.cv }); };
      const ready = () => {
        const cv = window.cv;
        if (cv?.Mat) return done();
        cv.onRuntimeInitialized = done;
      };
      if (window.cv) return ready();
      const s = document.createElement('script');
      s.src = new URL('vendor/opencv/opencv.js', location.href).href;
      s.async = true;
      s.onload = ready;
      s.onerror = () => reject(new Error('OpenCV konnte nicht geladen werden'));
      document.head.append(s);
    }).catch(err => { cvPromise = null; throw err; });
  }
  return cvPromise;
}

/** Lädt die Bildverarbeitung schon im Hintergrund. */
export function warmUpCrop() { loadOpenCV().catch(() => {}); }
export const cropReady = () => cvReady;

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

/** Ecken sortieren: oben links, oben rechts, unten rechts, unten links. */
function orderCorners(pts) {
  const bySum = [...pts].sort((a, b) => (a.x + a.y) - (b.x + b.y));
  const byDiff = [...pts].sort((a, b) => (a.y - a.x) - (b.y - b.x));
  return [bySum[0], byDiff[0], bySum[3], byDiff[3]];
}

/** Größtes Viereck im Kartenformat in einem Kantenbild. */
function bestQuad(cv, edges, area, minArea) {
  const contours = new cv.MatVector();
  const hierarchy = new cv.Mat();
  cv.findContours(edges, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
  let best = null;
  for (let i = 0; i < contours.size(); i++) {
    const c = contours.get(i);
    const a = cv.contourArea(c);
    // Karte muss einen ordentlichen Teil des Bildes einnehmen, aber nicht exakt den Bildrand
    if (a < area * minArea || a > area * 0.985) { c.delete(); continue; }
    let pts = null;
    const approx = new cv.Mat();
    cv.approxPolyDP(c, approx, 0.02 * cv.arcLength(c, true), true);
    if (approx.rows === 4 && cv.isContourConvex(approx)) {
      pts = [];
      for (let j = 0; j < 4; j++) pts.push({ x: approx.data32S[j * 2], y: approx.data32S[j * 2 + 1] });
    } else {
      // Abgerundete Ecken, Finger oder Tischmaserung am Rand: äußere Hülle der Form prüfen
      const hull = new cv.Mat();
      cv.convexHull(c, hull, false, true);
      const r = cv.minAreaRect(hull);
      if (cv.contourArea(hull) / (r.size.width * r.size.height) > 0.88) {
        pts = cv.RotatedRect.points(r).map(p => ({ x: p.x, y: p.y }));
      }
      hull.delete();
    }
    approx.delete();
    c.delete();
    if (!pts) continue;
    const [tl, tr, br, bl] = orderCorners(pts);
    const w = (dist(tl, tr) + dist(bl, br)) / 2, h = (dist(tl, bl) + dist(tr, br)) / 2;
    const ratio = Math.min(w, h) / Math.max(w, h);
    if (ratio < 0.6 || ratio > 0.82) continue; // Karte ist 0,716
    if (!best || a > best.a) best = { a, corners: [tl, tr, br, bl], landscape: w > h };
  }
  contours.delete();
  hierarchy.delete();
  return best;
}

/**
 * Sucht ein Rechteck mit Kartenformat im Bild.
 * @returns {{ corners: Array<{x,y}>, area: number } | null} Ecken im Koordinatensystem von `src`,
 *   schon so gedreht, dass die Karte hochkant ausgegeben wird; `area` = Anteil am Bild
 */
export async function locateCard(src, { maxSide = 700, minArea = 0.12 } = {}) {
  let cv;
  try { ({ cv } = await loadOpenCV()); } catch { return null; }

  // Verkleinert suchen – schnell und robust gegen Bildrauschen
  const scale = Math.min(1, maxSide / Math.max(src.width, src.height));
  let small = src;
  if (scale < 1) {
    small = document.createElement('canvas');
    small.width = Math.round(src.width * scale);
    small.height = Math.round(src.height * scale);
    small.getContext('2d').drawImage(src, 0, 0, small.width, small.height);
  }

  const mats = [];
  const track = m => { mats.push(m); return m; };
  try {
    const img = track(cv.imread(small));
    const gray = track(new cv.Mat());
    cv.cvtColor(img, gray, cv.COLOR_RGBA2GRAY);
    cv.GaussianBlur(gray, gray, new cv.Size(5, 5), 0);
    // Farbsättigung als zweites Bild: hilft, wenn Karte und Tisch gleich hell sind
    const hsv = track(new cv.Mat());
    const rgb = track(new cv.Mat());
    cv.cvtColor(img, rgb, cv.COLOR_RGBA2RGB);
    cv.cvtColor(rgb, hsv, cv.COLOR_RGB2HSV);
    const channels = track(new cv.MatVector());
    cv.split(hsv, channels);
    const sat = track(channels.get(1));
    cv.GaussianBlur(sat, sat, new cv.Size(5, 5), 0);

    const area = small.width * small.height;
    const kernel = track(cv.Mat.ones(5, 5, cv.CV_8U));
    const edges = track(new cv.Mat());
    // Mehrere Durchgänge: normaler Kontrast, schwacher Kontrast, Farbkanten.
    // Der erste Durchgang mit Treffer gewinnt: schwächere Schwellen verbinden sonst Karte und Tisch.
    const passes = [[gray, 40, 120], [gray, 12, 40], [sat, 20, 60]];
    let best = null;
    for (const [channel, lo, hi] of passes) {
      cv.Canny(channel, edges, lo, hi);
      cv.dilate(edges, edges, kernel);
      best = bestQuad(cv, edges, area, minArea);
      if (best) break;
    }
    if (!best) return null;

    let [tl, tr, br, bl] = best.corners.map(p => ({ x: p.x / scale, y: p.y / scale }));
    // Liegt die Karte quer, eine Vierteldrehung, damit sie hochkant ausgegeben wird
    if (best.landscape) [tl, tr, br, bl] = [bl, tl, tr, br];
    return { corners: [tl, tr, br, bl], area: best.a / area };
  } catch (err) {
    console.warn('Kartensuche fehlgeschlagen', err);
    return null;
  } finally {
    mats.forEach(m => { try { m.delete(); } catch { /* schon frei */ } });
  }
}

/** Entzerrt den Bereich zwischen den vier Ecken zu einer geraden Karte. */
export async function warpCard(src, corners, width = CARD_W, height = CARD_H) {
  const { cv } = await loadOpenCV();
  const [tl, tr, br, bl] = corners;
  const mats = [];
  const track = m => { mats.push(m); return m; };
  try {
    const full = track(cv.imread(src));
    const from = track(cv.matFromArray(4, 1, cv.CV_32FC2, [tl.x, tl.y, tr.x, tr.y, br.x, br.y, bl.x, bl.y]));
    const to = track(cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, width, 0, width, height, 0, height]));
    const M = track(cv.getPerspectiveTransform(from, to));
    const out = track(new cv.Mat());
    cv.warpPerspective(full, out, M, new cv.Size(width, height), cv.INTER_CUBIC, cv.BORDER_REPLICATE);
    const canvas = document.createElement('canvas');
    cv.imshow(canvas, out);
    return canvas;
  } finally {
    mats.forEach(m => { try { m.delete(); } catch { /* schon frei */ } });
  }
}

/**
 * Sucht die Karte im Foto und schneidet sie gerade aus.
 * @returns {{ canvas: HTMLCanvasElement, found: boolean }} – bei Misserfolg das Originalbild
 */
export async function findCard(src) {
  const quad = await locateCard(src);
  if (!quad) return { canvas: src, found: false };
  try {
    return { canvas: await warpCard(src, quad.corners), found: true };
  } catch {
    return { canvas: src, found: false };
  }
}

/**
 * Bildqualität einer ausgeschnittenen Karte.
 * sharpness: Varianz des Laplace-Filters (unscharf < ~60), glare: Anteil fast weißer Pixel (Spiegelung).
 */
export function cardQuality(card) {
  const w = 160, h = 224;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(card, 0, 0, w, h);
  const d = ctx.getImageData(0, 0, w, h).data;
  const g = new Float32Array(w * h);
  let bright = 0;
  for (let i = 0; i < w * h; i++) {
    const r = d[i * 4], gr = d[i * 4 + 1], b = d[i * 4 + 2];
    g[i] = 0.299 * r + 0.587 * gr + 0.114 * b;
    if (r > 245 && gr > 245 && b > 245) bright++;
  }
  let sum = 0, sum2 = 0, gs = 0, gs2 = 0, n = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const lap = 4 * g[i] - g[i - 1] - g[i + 1] - g[i - w] - g[i + w];
      sum += lap; sum2 += lap * lap;
      gs += g[i]; gs2 += g[i] * g[i];
      n++;
    }
  }
  const lapVar = sum2 / n - (sum / n) ** 2;
  const grayVar = gs2 / n - (gs / n) ** 2;
  // Durch den Kontrast teilen: sonst wirken kontrastreiche Karten immer „scharf“ und ruhige immer „unscharf“
  return { sharpness: lapVar / (grayVar + 50), glare: bright / (w * h) };
}

/** Dreht ein Bild um 180° (Karte stand auf dem Kopf). */
export function rotate180(src) {
  const c = document.createElement('canvas');
  c.width = src.width; c.height = src.height;
  const ctx = c.getContext('2d');
  ctx.translate(c.width, c.height);
  ctx.rotate(Math.PI);
  ctx.drawImage(src, 0, 0);
  return c;
}
