// Demonstration data is generated locally and is not a commercial game ROM.
import { delay } from './lk.js';
import { parseGB } from './cartridge.js';
export function createDemo() {
  const info = { name: 'GBFlash · Demo', version: 15, pcb: 13 };
  const header = new Uint8Array(0x150);
  header.set([0xce,0xed,0x66,0x66,0xcc,0x0d,0,0x0b,3,0x73,0,0x83,0,0x0c,0,0x0d,0,8,0x11,0x1f,0x88,0x89,0,0x0e,0xdc,0xcc,0x6e,0xe6,0xdd,0xdd,0xd9,0x99,0xbb,0xbb,0x67,0x63,0x6e,0x0e,0xec,0xcc,0xdd,0xdc,0x99,0x9f,0xbb,0xb9,0x33,0x3e],0x104);
  header.set(new TextEncoder().encode('POCKET GARDEN'),0x134);
  header[0x143] = 0x80; header[0x147] = 0x1b; header[0x148] = 5; header[0x149] = 3;
  for (let i = 0x134; i <= 0x14c; i++) header[0x14d] = (header[0x14d] - header[i] - 1) & 255;
  const cart = { ...parseGB(header), mode: 'DMG', title: 'POCKET GARDEN', system: 'Game Boy Color', mapper: 'MBC5', romSize: 1024 * 1024, ramSize: 32768, rtc: false, unsupported: '', demo: true };
  const generate = async (size, label, options = {}) => {
    for (let i = 0; i <= 20; i++) {
      if (options.signal?.aborted) throw new DOMException('Demostración cancelada.', 'AbortError');
      options.onProgress?.(i / 20, label); await delay(50);
    }
    const data = new Uint8Array(size);
    data.set(new TextEncoder().encode('FLASHGBX POCKET DEMO — NOT A GAME ROM'));
    return data;
  };
  return { info, service: {
    inspect: async (mode, romSize) => { await delay(250); return mode === 'DMG' ? {...cart} : {...cart, mode:'AGB', system:'Game Boy Advance', mapper:'Lineal', romSize, ramSize:0, header:null}; },
    backupROM: (_, opts) => generate(cart.romSize, 'Simulando respaldo de ROM', opts),
    backupSave: (_, opts) => generate(cart.ramSize, 'Simulando respaldo de partida', opts),
  } };
}
