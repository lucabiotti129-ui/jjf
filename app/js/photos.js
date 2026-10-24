// Eigene Kartenfotos (Sportkarten, Scans) in IndexedDB – localStorage wäre dafür zu klein.
const DB = 'cardvault-photos';
const STORE = 'photos';
let dbPromise = null;
const urls = new Map();

function db() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

function tx(mode, fn) {
  return db().then(d => new Promise((resolve, reject) => {
    const t = d.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    t.oncomplete = () => resolve(req?.result);
    t.onerror = () => reject(t.error);
  }));
}

/** Verkleinert ein Canvas auf Vorschaugröße und speichert es. */
export async function savePhoto(id, canvas, maxW = 480) {
  const s = Math.min(1, maxW / canvas.width);
  const c = document.createElement('canvas');
  c.width = Math.round(canvas.width * s);
  c.height = Math.round(canvas.height * s);
  c.getContext('2d').drawImage(canvas, 0, 0, c.width, c.height);
  const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.82));
  await tx('readwrite', st => st.put(blob, id));
  urls.delete(id);
  return id;
}

/** Objekt-URL eines gespeicherten Fotos (oder '' wenn keins da ist). */
export async function photoUrl(id) {
  if (!id) return '';
  if (!urls.has(id)) {
    const blob = await tx('readonly', st => st.get(id)).catch(() => null);
    urls.set(id, blob ? URL.createObjectURL(blob) : '');
  }
  return urls.get(id);
}

export function deletePhoto(id) {
  if (!id) return Promise.resolve();
  urls.delete(id);
  return tx('readwrite', st => st.delete(id)).catch(() => {});
}

export function clearPhotos() {
  urls.clear();
  return tx('readwrite', st => st.clear()).catch(() => {});
}
