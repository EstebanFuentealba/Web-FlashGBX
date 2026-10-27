// SPDX-License-Identifier: GPL-3.0-or-later
import { lookupGBMetadata, applyGBMetadata } from './metadata.js';
const text = bytes => new TextDecoder('ascii').decode(bytes).replace(/[^\x20-\x7e]/g, '').trim();
export const sameBytes = (a, b) => a.length === b.length && a.every((value, i) => value === b[i]);
export const sizeLabel = n => n >= 1048576 ? `${n / 1048576} MiB` : `${n / 1024} KiB`;
const GB_LOGO = Uint8Array.from([0xce,0xed,0x66,0x66,0xcc,0x0d,0x00,0x0b,0x03,0x73,0x00,0x83,0x00,0x0c,0x00,0x0d,0x00,0x08,0x11,0x1f,0x88,0x89,0x00,0x0e,0xdc,0xcc,0x6e,0xe6,0xdd,0xdd,0xd9,0x99,0xbb,0xbb,0x67,0x63,0x6e,0x0e,0xec,0xcc,0xdd,0xdc,0x99,0x9f,0xbb,0xb9,0x33,0x3e]);

export function parseGB(header) {
  if (header.length < 0x150) throw new Error('Cabecera GB incompleta.');
  let checksum = 0;
  for (let i = 0x134; i <= 0x14c; i++) checksum = (checksum - header[i] - 1) & 255;
  if (checksum !== header[0x14d] || !sameBytes(header.subarray(0x104, 0x134), GB_LOGO)) throw new Error('Cabecera GB inválida. Comprueba el modo, los contactos y la inserción del cartucho.');
  const cgb = [0x80,0xc0].includes(header[0x143]);
  const rawTitle = header.subarray(0x134, cgb ? 0x143 : 0x144);
  const candidate = text(header.subarray(0x13f,0x143));
  const code = cgb && /^[ABHKV][A-Z0-9]{2}[ABDEFIJKPSUXY]$/.test(candidate) ? candidate : '';
  const title = text(code ? rawTitle.subarray(0,11) : rawTitle) || 'SIN TITULO';
  const type = header[0x147];
  const mapper = [0,8,9].includes(type) ? 'ROM' : [1,2,3].includes(type) ? 'MBC1' : [5,6].includes(type) ? 'MBC2' : [15,16,17,18,19].includes(type) ? 'MBC3' : [25,26,27,28,29,30].includes(type) ? 'MBC5' : null;
  const romSize = header[0x148] <= 8 ? 32768 * 2 ** header[0x148] : ({ 0x52: 72, 0x53: 80, 0x54: 96 }[header[0x148]] || 0) * 16384;
  const hasRAM = [2,3,5,6,8,9,16,18,19,26,27,29,30].includes(type);
  const ramSize = !hasRAM ? 0 : mapper === 'MBC2' ? 512 : [0,2048,8192,32768,131072,65536][header[0x149]];
  let unsupported = !mapper ? `Mapper 0x${type.toString(16)} aún no soportado.` : '';
  if (!romSize || ramSize === undefined) unsupported = 'Tamaños de memoria no soportados.';
  if (mapper === 'ROM' && (romSize !== 32768 || ramSize > 8192)) unsupported = 'Cartucho sin mapper con tamaños no estándar.';
  if (mapper === 'MBC1' && (romSize > 2097152 || ramSize > 32768)) unsupported = 'Variante MBC1 no soportada.';
  if (mapper === 'MBC2' && romSize > 262144) unsupported = 'Variante MBC2 no soportada.';
  if (mapper === 'MBC3' && (romSize > 2097152 || ramSize > 32768)) unsupported = 'MBC30 y variantes ampliadas aún no soportadas.';
  if (mapper === 'MBC5' && [28,29,30].includes(type) && ramSize > 65536) unsupported = 'Variante MBC5 con rumble no soportada.';
  return { mode: 'DMG', title, code, productCode: code ? `DMG-${code}` : '', revision: header[0x14c], system: cgb ? 'Game Boy Color' : 'Game Boy', mapper, type, romSize, ramSize: ramSize || 0, rtc: [15,16].includes(type), unsupported, header: header.slice(0,0x150) };
}

export function parseGBA(header, romSize) {
  if (header.length < 0xc0) throw new Error('Cabecera GBA incompleta.');
  let checksum = 0;
  for (let i = 0xa0; i <= 0xbc; i++) checksum = (checksum - header[i]) & 255;
  checksum = (checksum - 0x19) & 255;
  if (checksum !== header[0xbd] || header[0xb2] !== 0x96) throw new Error('Cabecera GBA inválida. Comprueba el modo y los contactos del cartucho.');
  if (![1,2,4,8,16,32].map(n => n * 1048576).includes(romSize)) throw new Error('Selecciona el tamaño de ROM GBA.');
  return { mode: 'AGB', title: text(header.subarray(0xa0,0xac)) || 'SIN TITULO', code: text(header.subarray(0xac,0xb0)), productCode: `AGB-${text(header.subarray(0xac,0xb0))}`, revision: header[0xbc], system: 'Game Boy Advance', mapper: 'Lineal', romSize, ramSize: 0, rtc: false, unsupported: '', header: header.slice(0,0xc0) };
}

export async function selectROMBank(lk, cart, bank) {
  switch (cart.mapper) {
    case 'ROM': return bank * 0x4000;
    case 'MBC1':
      await lk.mapperWrite(0x6000, bank % 32 === 0 ? 1 : 0);
      await lk.mapperWrite(0x4000, bank >> 5);
      await lk.mapperWrite(0x2000, (bank & 31) || 1);
      return bank % 32 === 0 ? 0 : 0x4000;
    case 'MBC2': await lk.mapperWrite(0x2100, bank || 1); return bank ? 0x4000 : 0;
    case 'MBC3': await lk.mapperWrite(0x2000, bank || 1); return bank ? 0x4000 : 0;
    case 'MBC5':
      await lk.mapperWrite(0x2000, bank & 255);
      await lk.mapperWrite(0x3000, (bank >> 8) & 1);
      return bank ? 0x4000 : 0;
    default: throw new Error('Mapper no soportado.');
  }
}
const cancelled = signal => { if (signal?.aborted) throw new DOMException('Operación cancelada.', 'AbortError'); };

export class CartridgeService {
  constructor(lk, { resolveMetadata = lookupGBMetadata } = {}) { this.lk = lk; this.resolveMetadata = resolveMetadata; }
  async inspect(mode, gbaSize = 32 * 1048576) {
    let header;
    const cart = await this.lk.powered(mode, async () => {
      header = await this.lk.readROM(0, mode === 'DMG' ? 0x180 : 0xc0);
      const cart = mode === 'DMG' ? parseGB(header) : parseGBA(header, gbaSize);
      // MBC1 multicarts use a different bank layout. Detect the repeated logo at bank 16.
      if (cart.mapper === 'MBC1' && cart.romSize >= 512 * 1024) {
        await selectROMBank(this.lk, cart, 16);
        const other = await this.lk.readROM(0x4104, 48);
        if (sameBytes(other, GB_LOGO)) cart.unsupported = 'Posible multicart MBC1M: su distribución de bancos aún no está soportada.';
      }
      return cart;
    });
    // Resolve descriptive metadata after returning the hardware to idle.
    return mode === 'DMG' ? applyGBMetadata(cart, await this.resolveMetadata(header)) : cart;
  }
  async checkIdentity(cart) {
    if (cart.unsupported) throw new Error(cart.unsupported);
    const fresh = await this.lk.readROM(0, cart.header.length);
    if (!sameBytes(fresh, cart.header)) throw new Error('El cartucho cambió o la lectura es inestable. Vuelve a identificarlo.');
  }
  async backupROM(cart, { signal, onProgress = () => {}, verify = true } = {}) {
    return this.lk.powered(cart.mode, async () => {
      cancelled(signal); await this.checkIdentity(cart);
      const data = new Uint8Array(cart.romSize), passes = verify ? 2 : 1;
      try {
        for (let pass = 0; pass < passes; pass++) {
          if (cart.mode === 'AGB') {
            for (let offset = 0; offset < data.length; offset += 4096) {
              cancelled(signal);
              const block = await this.lk.readROM(offset, Math.min(4096, data.length - offset));
              if (!pass) data.set(block, offset);
              else if (!sameBytes(data.subarray(offset, offset + block.length), block)) throw new Error(`La segunda lectura no coincide en 0x${offset.toString(16)}. No se generó un respaldo verificado.`);
              onProgress((pass * data.length + offset + block.length) / (passes * data.length), pass ? 'Verificando ROM' : 'Leyendo ROM');
            }
          } else {
            for (let bank = 0; bank < data.length / 16384; bank++) {
              cancelled(signal);
              const address = await selectROMBank(this.lk, cart, bank);
              for (let offset = 0; offset < 16384; offset += 4096) {
                cancelled(signal);
                const block = await this.lk.readROM(address + offset, 4096), position = bank * 16384 + offset;
                if (!pass) data.set(block, position);
                else if (!sameBytes(data.subarray(position, position + block.length), block)) throw new Error(`La segunda lectura no coincide en el banco ${bank}. Revisa los contactos.`);
                onProgress((pass * data.length + position + block.length) / (passes * data.length), pass ? 'Verificando ROM' : 'Leyendo ROM');
              }
            }
          }
        }
      } finally {
        await this.resetMBC1(cart);
      }
      return data;
    });
  }
  async resetMBC1(cart) {
    // Without a power switch, bank registers survive between operations.
    if (cart.mapper === 'MBC1' && !this.lk.poisoned && !this.lk.transport.closed) await selectROMBank(this.lk, cart, 0);
  }
  async selectRAM(cart, bank) {
    if (cart.mapper === 'MBC1') { await this.lk.mapperWrite(0x6000, 1); await this.lk.mapperWrite(0x4000, bank); }
    else if (['MBC3','MBC5'].includes(cart.mapper)) await this.lk.mapperWrite(0x4000, bank);
  }
  async accessRAM(cart, task) {
    if (cart.mode !== 'DMG' || !cart.ramSize) throw new Error('Esta versión admite partidas GB/GBC con SRAM o MBC2.');
    if (cart.mapper !== 'ROM') await this.lk.mapperWrite(0, 0x0a);
    try { return await task(); }
    finally {
      if (!this.lk.poisoned && !this.lk.transport.closed && cart.mapper !== 'ROM') await this.lk.mapperWrite(0, 0);
      await this.resetMBC1(cart);
    }
  }
  async readSaveBlocks(cart, signal, onProgress) {
    const data = new Uint8Array(cart.ramSize);
    for (let base = 0; base < data.length; base += 8192) {
      cancelled(signal); await this.selectRAM(cart, base / 8192);
      const bankLength = Math.min(8192, data.length - base);
      for (let offset = 0; offset < bankLength; offset += 4096) {
        cancelled(signal);
        const block = await this.lk.readRAM(offset, Math.min(4096, bankLength - offset));
        data.set(cart.mapper === 'MBC2' ? block.map(n => n | 0xf0) : block, base + offset);
        onProgress((base + offset + block.length) / data.length);
      }
    }
    return data;
  }
  async backupSave(cart, { signal, onProgress = () => {} } = {}) {
    return this.lk.powered(cart.mode, async () => {
      cancelled(signal); await this.checkIdentity(cart);
      return this.accessRAM(cart, async () => {
        const data = await this.readSaveBlocks(cart, signal, p => onProgress(p / 2, 'Leyendo partida'));
        const check = await this.readSaveBlocks(cart, signal, p => onProgress(0.5 + p / 2, 'Verificando partida'));
        if (!sameBytes(data, check)) throw new Error('Las dos lecturas de la partida no coinciden. Revisa los contactos.');
        return data;
      });
    });
  }
  async restoreSave(cart, data, { signal, onProgress = () => {} } = {}) {
    if (data.length !== cart.ramSize || !data.length) throw new Error(`El archivo debe tener exactamente ${cart.ramSize} bytes.`);
    return this.lk.powered(cart.mode, async () => {
      cancelled(signal); await this.checkIdentity(cart);
      return this.accessRAM(cart, async () => {
        for (let base = 0; base < data.length; base += 8192) {
          await this.selectRAM(cart, base / 8192);
          const bankLength = Math.min(8192, data.length - base);
          for (let offset = 0; offset < bankLength; offset += 256) {
            cancelled(signal);
            const block = data.subarray(base + offset, base + Math.min(offset + 256, bankLength));
            await this.lk.writeRAM(offset, cart.mapper === 'MBC2' ? block.map(n => n & 15) : block);
            onProgress((base + offset + block.length) / data.length * 0.6, 'Escribiendo partida');
          }
        }
        const actual = await this.readSaveBlocks(cart, signal, p => onProgress(0.6 + p * 0.4, 'Verificando escritura'));
        const expected = cart.mapper === 'MBC2' ? data.map(n => n | 0xf0) : data;
        if (!sameBytes(expected, actual)) throw new Error('La verificación falló: la partida escrita no coincide. Conserva el respaldo previo y vuelve a intentarlo.');
      });
    });
  }
}
