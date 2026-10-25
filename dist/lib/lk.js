// SPDX-License-Identifier: GPL-3.0-or-later
// Protocol reference: Lesserkuma/FlashGBX_LK_Firmware, L15.
export const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
export function u32(value) { return [(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255]; }

export class LKDevice {
  constructor(transport) { this.transport = transport; this.info = null; this.mode = null; this.busy = false; this.poisoned = false; }
  async send(bytes) {
    if (this.poisoned) throw new Error('Sesión desincronizada. Reconecta el lector.');
    try { await this.transport.write(Uint8Array.from(bytes)); }
    catch (error) { this.poisoned = true; throw error; }
  }
  async read(size) {
    try { return await this.transport.readExactly(size); }
    catch (error) { this.poisoned = true; throw error; }
  }
  async invalid(message) {
    this.poisoned = true; await this.transport.close(); throw new Error(message);
  }
  async ack(bytes) {
    await this.send(bytes);
    const reply = (await this.read(1))[0];
    if (reply !== 1) await this.invalid(`Respuesta L15 inesperada (0x${reply.toString(16)}). Reconecta el lector.`);
  }
  async variable(size, key, value) { await this.ack([0xa6, size, ...u32(key), ...u32(value)]); }
  async identify() {
    await this.send([0xa1]);
    const size = (await this.read(1))[0];
    if (size !== 8) return this.invalid('El lector no respondió con una cabecera LK válida. Revisa firmware y velocidad.');
    const bytes = await this.read(size), view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const version = view.getUint16(1, false);
    if (bytes[0] !== 0x4c || version !== 15) return this.invalid(`Esta versión necesita firmware L15. Respuesta: ${String.fromCharCode(bytes[0])}${version}.`);
    const nameSize = (await this.read(1))[0];
    if (nameSize < 2 || nameSize > 64) return this.invalid('Nombre de dispositivo LK inválido.');
    const name = new TextDecoder().decode(await this.read(nameSize)).replace(/\0/g, '');
    const flags = await this.read(2);
    if (!['GBFlash', 'GBxCart RW'].includes(name)) return this.invalid(`El lector ${name} todavía no está soportado.`);
    if (!(flags[0] & 1)) return this.invalid('Esta revisión no permite controlar la alimentación del cartucho y aún no está soportada.');
    this.info = { name, version, pcb: bytes[3], build: view.getUint32(4, false), powerControl: true, flags: flags[0] };
    await this.ack([0xf3]);
    return this.info;
  }
  async powered(mode, task) {
    if (this.busy) throw new Error('Ya hay una operación en curso.');
    if (!this.info || !['DMG', 'AGB'].includes(mode)) throw new Error('Lector o modo inválido.');
    this.busy = true;
    try {
      await this.ack([0xf3]);
      await this.ack([mode === 'AGB' ? 0xa2 : 0xa3]);
      await this.ack([mode === 'AGB' ? 0xa4 : 0xa5]);
      this.mode = mode;
      await this.variable(1, 0x08, 0); // SRAM CS pulse off for ROM
      await this.variable(1, 0x09, 0);
      await this.variable(1, mode === 'AGB' ? 0x0c : 0x0b, 0); // conservative read method
      if (mode === 'AGB') await this.variable(1, 0x10, 0);
      await this.variable(4, 1, 5000); // firmware timeout if the tab disappears
      await this.variable(1, 0x0f, 1);
      await this.ack([0xf2]);
      await delay(100);
      await this.ack([mode === 'AGB' ? 0xc9 : 0xb4]);
      return await task();
    } finally {
      try { if (!this.poisoned && !this.transport.closed) await this.ack([0xf3]); }
      finally { this.busy = false; }
    }
  }
  async readROM(address, size) {
    if (!Number.isInteger(size) || size < 1 || size > 4096 || address < 0 || !Number.isInteger(address)) throw new Error('Bloque ROM inválido.');
    if (this.mode === 'AGB' && (address % 2 || size % 2)) throw new Error('Las lecturas GBA deben estar alineadas a 16 bits.');
    await this.variable(1, 1, 1);
    await this.variable(1, 8, 0);
    await this.variable(4, 0, this.mode === 'AGB' ? address / 2 : address);
    await this.variable(2, 0, size);
    await this.send([this.mode === 'AGB' ? 0xc1 : 0xb1]);
    return this.read(size);
  }
  async mapperWrite(address, value) {
    if (this.mode !== 'DMG') throw new Error('Cambio de banco solo disponible en modo GB.');
    await this.variable(1, 1, 2);
    await this.variable(1, 9, 0);
    await this.ack([0xb2, ...u32(address), value & 255]);
  }
  async readRAM(address, size) {
    if (size < 1 || size > 4096) throw new Error('Bloque SRAM inválido.');
    await this.variable(1, 1, 3);
    await this.variable(1, 8, 1);
    await this.variable(4, 0, this.mode === 'DMG' ? address + 0xa000 : address);
    await this.variable(2, 0, size);
    await this.send([this.mode === 'DMG' ? 0xb1 : 0xc3]);
    return this.read(size);
  }
  async writeRAM(address, data) {
    if (!data.length || data.length > 256) throw new Error('Bloque de escritura SRAM inválido.');
    await this.variable(1, 1, 4);
    await this.variable(1, 9, 1);
    await this.variable(4, 0, this.mode === 'DMG' ? address + 0xa000 : address);
    await this.variable(2, 0, data.length);
    // Command and payload are queued together; never leave the MCU waiting for UI work.
    await this.ack([this.mode === 'DMG' ? 0xb3 : 0xc4, ...data]);
  }
  async close() { await this.transport.close(); }
}
