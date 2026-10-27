// SPDX-License-Identifier: GPL-3.0-or-later
// Same lookup key as FlashGBX RomFileDMG.GetDatabaseEntry: SHA-1 of [0, 0x180).
let databasePromise;
export async function loadGBDatabase() {
  if (!databasePromise) {
    databasePromise = fetch(new URL('../config/db_DMG.json', import.meta.url), {signal:AbortSignal.timeout(5000)})
      .then(response => {
        if (!response.ok) throw new Error('Base de juegos no disponible.');
        return response.json();
      }).catch(error => { databasePromise = null; throw error; });
  }
  return databasePromise;
}
export async function lookupGBMetadata(header, { database, subtle = globalThis.crypto?.subtle } = {}) {
  if (header.length < 0x180) throw new Error('La identificación por base de datos requiere 384 bytes.');
  if (!subtle) return { entry:null, status:'unavailable' };
  const digest = await subtle.digest('SHA-1', header.subarray(0,0x180));
  const key = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2,'0')).join('');
  try {
    const db = database ?? await loadGBDatabase();
    const entry = Object.hasOwn(db,key) ? db[key] : null;
    return { entry, status:entry ? 'matched' : 'unknown', hash:key };
  } catch { return { entry:null, status:'unavailable', hash:key }; }
}
export function applyGBMetadata(cart, result) {
  const entry = result.entry;
  return {
    ...cart,
    gameName: entry?.gn || cart.title,
    productCode: cart.productCode || (/^(DMG|CGB)-[A-Z0-9]{4}$/.test(entry?.gc) ? entry.gc : ''),
    metadataStatus: result.status,
    headerHash: result.hash,
  };
}
