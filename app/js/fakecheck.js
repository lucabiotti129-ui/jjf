// Echtheits-Check: vergleicht den Scan mit den echten Kartendaten.
// Ein Handyfoto kann eine Karte nicht sicher als echt beweisen – es findet aber typische Fehler von Fälschungen.
import { readHp, readText } from './ocr.js';
import { fingerprint, remoteFingerprint, similarity } from './images.js';
import { similarity as textSimilarity } from './api.js';

const fold = s => (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '');

/** Ergebnis: { verdict: 'ok'|'warn'|'bad', title, checks: [{ label, status, detail }] } */
function summarize(checks) {
  const bad = checks.filter(c => c.status === 'bad').length;
  const warn = checks.filter(c => c.status === 'warn').length;
  const ok = checks.filter(c => c.status === 'ok').length;
  const unread = checks.filter(c => c.status === 'na').length;
  if (bad) return { verdict: 'bad', title: 'Wahrscheinlich gefälscht', checks };
  if (warn >= 2) return { verdict: 'warn', title: 'Auffällig – genauer prüfen', checks };
  // Grünes Licht nur, wenn genug geprüft werden konnte
  if (ok < 3 || unread >= 2) return { verdict: 'warn', title: 'Zu wenig lesbar – bitte selbst prüfen', checks };
  return { verdict: 'ok', title: 'Keine Auffälligkeiten gefunden', checks };
}

export async function checkPokemon({ canvas, card, ocr, imageUrl, progress = () => {} }) {
  const checks = [];

  // 1. Nummer: passt die gedruckte Nummer zu dieser Karte?
  const local = String(parseInt(card.localId, 10) || card.localId);
  const counts = [card.set?.cardCount?.official, card.set?.cardCount?.total].filter(Boolean);
  const read = ocr?.numbers || [];
  const match = read.find(n => String(parseInt(n.num, 10)) === local && counts.includes(parseInt(n.total, 10)));
  if (match) checks.push({ label: 'Kartennummer', status: 'ok', detail: `${match.num}/${match.total} gehört zu dieser Karte` });
  else if (read.length) checks.push({ label: 'Kartennummer', status: 'warn', detail: `Gelesen: ${read[0].num}/${read[0].total} – erwartet ${card.localId}/${counts[0] ?? '?'}` });
  else checks.push({ label: 'Kartennummer', status: 'na', detail: 'Nummer war nicht lesbar' });
  progress(0.15);

  // 2. Name
  const nameScore = textSimilarity(card.name, ocr?.nameText || '');
  if (nameScore >= 0.8) checks.push({ label: 'Name', status: 'ok', detail: `„${card.name}“ richtig geschrieben` });
  else if (nameScore >= 0.5) checks.push({ label: 'Name', status: 'warn', detail: 'Name nur teilweise lesbar – auf Schreibfehler achten' });
  else checks.push({ label: 'Name', status: 'na', detail: 'Name war nicht lesbar' });

  // 3. KP – gefälschte Karten haben oft absurde Werte (z. B. KP 1000)
  if (card.hp) {
    const hp = await readHp(canvas).catch(() => null);
    if (hp === card.hp) checks.push({ label: 'KP', status: 'ok', detail: `KP ${hp} stimmt` });
    else if (hp) checks.push({ label: 'KP', status: 'bad', detail: `Gedruckt: KP ${hp} – echte Karte hat KP ${card.hp}` });
    else checks.push({ label: 'KP', status: 'na', detail: 'KP-Angabe nicht lesbar' });
  }
  progress(0.35);

  // 4. Attacken – Fälschungen haben oft falsche oder erfundene Attacken
  const attacks = (card.attacks || []).map(a => a.name).filter(Boolean);
  if (attacks.length) {
    const text = await readText(canvas, p => progress(0.35 + p * 0.45)).catch(() => '');
    const found = attacks.filter(a => textSimilarity(a, text) >= 0.75);
    if (found.length === attacks.length) checks.push({ label: 'Attacken', status: 'ok', detail: `${found.join(', ')} gefunden` });
    else if (found.length) checks.push({ label: 'Attacken', status: 'ok', detail: `${found.length} von ${attacks.length} Attacken gefunden` });
    else if (fold(text).length > 120) checks.push({ label: 'Attacken', status: 'warn', detail: `Erwartet: ${attacks.join(', ')} – nicht gefunden` });
    else checks.push({ label: 'Attacken', status: 'na', detail: 'Kartentext nicht lesbar' });
  }
  progress(0.85);

  // 5. Bild und Farben im Vergleich zum Original
  if (imageUrl) {
    try {
      const scan = fingerprint(canvas);
      const orig = await remoteFingerprint(imageUrl);
      const sim = similarity(scan, orig);
      // Licht und Hüllen verändern ein Foto stark – das Bild allein ist nie ein Beweis für eine Fälschung
      if (sim >= 0.7) checks.push({ label: 'Bild', status: 'ok', detail: 'Motiv und Aufbau stimmen mit dem Original überein' });
      else if (sim >= 0.6) checks.push({ label: 'Bild', status: 'warn', detail: 'Bild weicht etwas ab (Licht, Hülle oder Schräglage?)' });
      else checks.push({ label: 'Bild', status: 'warn', detail: 'Bild weicht stark vom Original ab – bei gutem Licht nochmal scannen' });

      const ratio = scan.sat / (orig.sat || 1);
      if (ratio > 1.5) checks.push({ label: 'Farben', status: 'warn', detail: 'Farben deutlich kräftiger als beim Original – typisch für Fälschungen' });
      else if (ratio < 0.5) checks.push({ label: 'Farben', status: 'warn', detail: 'Farben deutlich blasser als beim Original' });
      else checks.push({ label: 'Farben', status: 'ok', detail: 'Farbsättigung im normalen Bereich' });
    } catch {
      checks.push({ label: 'Bild', status: 'na', detail: 'Originalbild nicht verfügbar' });
    }
  }
  progress(1);
  return summarize(checks);
}

export async function checkYugioh({ card, ocr, setCode }) {
  const checks = [];
  const prints = new Set((card.card_sets || []).map(s => s.set_code));

  const codes = ocr?.setCodes || [];
  if (codes.some(c => prints.has(c.code))) checks.push({ label: 'Set-Code', status: 'ok', detail: `${codes.find(c => prints.has(c.code)).printed} gibt es für diese Karte` });
  else if (codes.length) checks.push({ label: 'Set-Code', status: 'bad', detail: `${codes[0].printed} gehört nicht zu „${card.name}“` });
  else checks.push({ label: 'Set-Code', status: 'na', detail: 'Set-Code war nicht lesbar' });

  const pass = ocr?.passcodes || [];
  if (pass.includes(String(card.id))) checks.push({ label: 'Passcode', status: 'ok', detail: `${card.id} stimmt` });
  else if (pass.length) checks.push({ label: 'Passcode', status: 'bad', detail: `Gedruckt: ${pass[0]} – echt wäre ${card.id}` });
  else checks.push({ label: 'Passcode', status: 'na', detail: 'Passcode unten links nicht lesbar' });

  const names = [card.name, card.name_en].filter(Boolean);
  const nameScore = Math.max(0, ...names.map(n => textSimilarity(n, ocr?.nameText || '')));
  if (nameScore >= 0.8) checks.push({ label: 'Name', status: 'ok', detail: 'Name richtig geschrieben' });
  else if (nameScore >= 0.5) checks.push({ label: 'Name', status: 'warn', detail: 'Name nur teilweise lesbar – auf Schreibfehler achten' });
  else checks.push({ label: 'Name', status: 'na', detail: 'Name war nicht lesbar' });

  if (setCode && !prints.has(setCode)) checks.push({ label: 'Druck', status: 'warn', detail: 'Dieser Druck ist für die Karte nicht bekannt' });
  return summarize(checks);
}

/** Dinge, die man nur mit der Karte in der Hand prüfen kann. */
export const MANUAL_TIPS = {
  pokemon: [
    ['Lichttest', 'Halte die Handy-Taschenlampe hinter die Karte. Echte Karten haben eine dunkle Mittelschicht und lassen kaum Licht durch.'],
    ['Rückseite', 'Das Blau ist bei echten Karten satt mit dunklen Flecken. Fälschungen sind oft heller, lila oder unscharf.'],
    ['Schrift', 'Falsche Schriftart, Rechtschreibfehler oder seltsame Symbole sind ein klares Zeichen für eine Fälschung.'],
    ['Oberfläche', 'Echte Karten sind leicht matt. Sehr glänzende oder wachsartige Karten sind verdächtig.'],
  ],
  yugioh: [
    ['Hologramm', 'Unten rechts muss ein Hologramm-Siegel (Auge des Anubis) sein, das im Licht glitzert.'],
    ['Rückseite', 'Das braune Muster ist scharf, die Farben satt und nicht verwaschen.'],
    ['Schrift', 'Auf Schreibfehler und falsche Schriftarten im Kartentext achten.'],
    ['Karton', 'Echte Karten fühlen sich fest an. Sehr dünne oder biegsame Karten sind verdächtig.'],
  ],
};
