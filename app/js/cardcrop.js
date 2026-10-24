// Findet die Karte im Foto, richtet sie gerade aus und schneidet sie zu (OpenCV.js, liegt in www/vendor).
// Ohne diesen Schritt würden Tisch, Hand oder Schräglage die Texterkennung an den falschen Stellen lesen lassen.
const CARD_W = 630, CARD_H = 880; // Seitenverhältnis 63 × 88 mm
let cvPromise = null;

// Das OpenCV-Modul hat selbst eine `then`-Methode. Mit ihm direkt ein Promise aufzulösen
// führt zu einer Endlosschleife – deshalb wird es immer in ein Objekt verpackt.
function loadOpenCV() {
  if (!cvPromise) {
    cvPromise = new Promise((resolve, reject) => {
      const done = () => resolve({ cv: window.cv });
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

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

/** Ecken sortieren: oben links, oben rechts, unten rechts, unten links. */
function orderCorners(pts) {
  const bySum = [...pts].sort((a, b) => (a.x + a.y) - (b.x + b.y));
  const byDiff = [...pts].sort((a, b) => (a.y - a.x) - (b.y - b.x));
  return [bySum[0], byDiff[0], bySum[3], byDiff[3]];
}

/** Größtes Viereck im Kartenformat in einem Kantenbild. */
function bestQuad(cv, edges, area) {
  const contours = new cv.MatVector();
  const hierarchy = new cv.Mat();
  cv.findContours(edges, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
  let best = null;
  for (let i = 0; i < contours.size(); i++) {
    const c = contours.get(i);
    const a = cv.contourArea(c);
    // Karte muss einen ordentlichen Teil des Bildes einnehmen, aber nicht exakt den Bildrand
    if (a < area * 0.12 || a > area * 0.985) { c.delete(); continue; }
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
 * @returns {{ canvas: HTMLCanvasElement, found: boolean }} – bei Misserfolg das Originalbild
 */
export async function findCard(src) {
  let cv;
  try { ({ cv } = await loadOpenCV()); } catch { return { canvas: src, found: false }; }

  // Auf ~700 px verkleinert suchen – schnell und robust gegen Bildrauschen
  const scale = Math.min(1, 700 / Math.max(src.width, src.height));
  const small = document.createElement('canvas');
  small.width = Math.round(src.width * scale);
  small.height = Math.round(src.height * scale);
  small.getContext('2d').drawImage(src, 0, 0, small.width, small.height);

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
    // Mehrere Durchgänge: normaler Kontrast, schwacher Kontrast, Farbkanten
    const passes = [[gray, 40, 120], [gray, 12, 40], [sat, 20, 60]];
    // Der erste Durchgang mit Treffer gewinnt: schwächere Kanten-Schwellen verbinden sonst Karte und Tisch
    let best = null;
    for (const [channel, lo, hi] of passes) {
      cv.Canny(channel, edges, lo, hi);
      cv.dilate(edges, edges, kernel);
      best = bestQuad(cv, edges, area);
      if (best) break;
    }
    if (!best) return { canvas: src, found: false };

    // Ecken auf das Originalbild hochrechnen und entzerren
    let [tl, tr, br, bl] = best.corners.map(p => ({ x: p.x / scale, y: p.y / scale }));
    // Liegt die Karte quer, eine Vierteldrehung, damit sie hochkant ausgegeben wird
    if (best.landscape) [tl, tr, br, bl] = [bl, tl, tr, br];
    const full = track(cv.imread(src));
    const from = track(cv.matFromArray(4, 1, cv.CV_32FC2, [tl.x, tl.y, tr.x, tr.y, br.x, br.y, bl.x, bl.y]));
    const to = track(cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, CARD_W, 0, CARD_W, CARD_H, 0, CARD_H]));
    const M = track(cv.getPerspectiveTransform(from, to));
    const out = track(new cv.Mat());
    cv.warpPerspective(full, out, M, new cv.Size(CARD_W, CARD_H), cv.INTER_CUBIC, cv.BORDER_REPLICATE);
    const canvas = document.createElement('canvas');
    cv.imshow(canvas, out);
    return { canvas, found: true };
  } catch (err) {
    console.warn('Kartensuche fehlgeschlagen', err);
    return { canvas: src, found: false };
  } finally {
    mats.forEach(m => { try { m.delete(); } catch { /* schon frei */ } });
  }
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
