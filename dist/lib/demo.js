// Demonstration data is generated locally and is not a commercial game ROM.
import { delay } from './lk.js';
export function createDemo() {
  const info = { name: 'GBFlash · Demo', version: 15, pcb: 13 };
  const cart = { mode: 'DMG', title: 'POCKET GARDEN', system: 'Game Boy Color', mapper: 'MBC5', romSize: 1024 * 1024, ramSize: 32768, rtc: false, unsupported: '', demo: true };
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
    inspect: async () => { await delay(250); return { ...cart }; },
    backupROM: (_, opts) => generate(cart.romSize, 'Simulando respaldo de ROM', opts),
    backupSave: (_, opts) => generate(cart.ramSize, 'Simulando respaldo de partida', opts),
  } };
}
