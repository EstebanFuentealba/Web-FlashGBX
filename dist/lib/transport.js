// SPDX-License-Identifier: GPL-3.0-or-later
// CH340 register protocol: see THIRD_PARTY_NOTICES.md. No generic CDC polyfill.
export const USB_FILTERS = [{ vendorId: 0x1a86, productId: 0x7523 }];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export function baudRegister(baud, version = 0x30) {
  // Exact rates used by LK readers: 48 MHz / (8 * divisor).
  const div = { 1000000: 6, 1500000: 4, 2000000: 3 }[baud];
  if (!div) throw new Error('Velocidad CH340 no soportada.');
  return ((256 - div) << 8) | 3 | (version > 0x27 ? 0x80 : 0);
}

export class ByteQueue {
  constructor() { this.chunks = []; this.length = 0; this.waiter = null; this.error = null; }
  push(bytes) {
    if (this.error || !bytes.length) return;
    this.chunks.push(bytes.slice()); this.length += bytes.length;
    if (this.length > 1024 * 1024) return this.fail(new Error('Desbordamiento del búfer USB. Reconecta el lector.'));
    this.flush();
  }
  fail(error) {
    if (this.error) return;
    this.error = error;
    if (this.waiter) { clearTimeout(this.waiter.timer); this.waiter.reject(error); this.waiter = null; }
  }
  flush() {
    const w = this.waiter;
    if (!w || this.length < w.size) return;
    const out = new Uint8Array(w.size);
    let offset = 0;
    while (offset < out.length) {
      const first = this.chunks[0], n = Math.min(first.length, out.length - offset);
      out.set(first.subarray(0, n), offset); offset += n; this.length -= n;
      if (n === first.length) this.chunks.shift(); else this.chunks[0] = first.subarray(n);
    }
    clearTimeout(w.timer); this.waiter = null; w.resolve(out);
  }
  read(size, timeout = 4000) {
    if (this.error) return Promise.reject(this.error);
    if (!Number.isInteger(size) || size < 1 || size > 65536) return Promise.reject(new Error('Longitud de lectura inválida.'));
    if (this.waiter) return Promise.reject(new Error('No se permiten lecturas simultáneas.'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail(new Error('El lector no respondió a tiempo. Desconecta y vuelve a conectar el USB.')), timeout);
      this.waiter = { size, resolve, reject, timer }; this.flush();
    });
  }
}

class BufferedTransport {
  constructor() { this.queue = new ByteQueue(); this.closed = false; }
  async bounded(promise, timeout = 4000) {
    let timer;
    try {
      return await Promise.race([promise, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Tiempo de espera USB agotado. Reconecta el lector.')), timeout);
      })]);
    } catch (error) { this.queue.fail(error); void this.close(); throw error; }
    finally { clearTimeout(timer); }
  }
  async readExactly(size) {
    try { return await this.queue.read(size); }
    catch (error) { void this.close(); throw error; }
  }
}

export class Ch340Transport extends BufferedTransport {
  constructor(device) { super(); this.device = device; this.label = 'WebUSB · CH340'; }
  async control(request, value, index = 0) {
    const r = await this.bounded(this.device.controlTransferOut({ requestType: 'vendor', recipient: 'device', request, value, index }));
    if (r.status !== 'ok') throw new Error('El CH340 rechazó la configuración USB.');
  }
  async open(baud = 2000000) {
    try {
      await this.bounded(this.device.open());
      if (!this.device.configuration) await this.bounded(this.device.selectConfiguration(1));
      const candidates = this.device.configuration.interfaces.flatMap(iface => iface.alternates.map(alt => ({ iface, alt })));
      const match = candidates.find(({ alt }) => alt.endpoints.some(e => e.type === 'bulk' && e.direction === 'in') && alt.endpoints.some(e => e.type === 'bulk' && e.direction === 'out'));
      if (!match) throw new Error('El dispositivo no tiene los canales USB esperados para CH340.');
      this.interfaceNumber = match.iface.interfaceNumber;
      await this.bounded(this.device.claimInterface(this.interfaceNumber));
      if (match.iface.alternate.alternateSetting !== match.alt.alternateSetting) await this.bounded(this.device.selectAlternateInterface(this.interfaceNumber, match.alt.alternateSetting));
      this.input = match.alt.endpoints.find(e => e.type === 'bulk' && e.direction === 'in');
      this.output = match.alt.endpoints.find(e => e.type === 'bulk' && e.direction === 'out');
      const version = await this.bounded(this.device.controlTransferIn({ requestType: 'vendor', recipient: 'device', request: 0x5f, value: 0, index: 0 }, 2));
      if (version.status !== 'ok' || version.data?.byteLength !== 2) throw new Error('No se pudo identificar el CH340.');
      this.chipVersion = version.data.getUint8(0);
      await this.control(0xa1, 0, 0);
      await this.control(0x9a, 0x1312, baudRegister(baud, this.chipVersion));
      if (this.chipVersion >= 0x30) await this.control(0x9a, 0x2518, 0xc3); // 8N1, RX + TX
      await this.control(0xa4, 0xff, 0); // Leave DTR / RTS deasserted; do not reset MCU.
      this.pumpPromise = this.pump();
      await sleep(100);
    } catch (error) { await this.close(); throw error; }
  }
  async pump() {
    try {
      while (!this.closed) {
        // Read one USB packet. Large requests can wait for a full buffer at exact packet boundaries.
        const r = await this.device.transferIn(this.input.endpointNumber, this.input.packetSize);
        if (this.closed) return;
        if (r.status !== 'ok' || !r.data) throw new Error('Error de lectura USB. Reconecta el lector.');
        if (r.data.byteLength) this.queue.push(new Uint8Array(r.data.buffer, r.data.byteOffset, r.data.byteLength));
        else await sleep(1);
      }
    } catch (error) { if (!this.closed) { this.queue.fail(error); void this.close(); } }
  }
  async write(data) {
    if (this.closed || this.queue.error) throw this.queue.error || new Error('USB desconectado.');
    for (let offset = 0; offset < data.length; offset += 64) {
      const chunk = data.subarray(offset, offset + 64);
      const r = await this.bounded(this.device.transferOut(this.output.endpointNumber, chunk));
      if (r.status !== 'ok' || r.bytesWritten !== chunk.length) {
        const error = new Error('Escritura USB incompleta. Reconecta el lector.');
        this.queue.fail(error); void this.close(); throw error;
      }
    }
  }
  async close() {
    if (this.closed) return;
    this.closed = true; this.queue.fail(new Error('USB desconectado.'));
    // close() cancels a pending transferIn; do not wait for the input pump before closing.
    try { if (this.device.opened) await this.device.close(); } catch { /* physical disconnect */ }
  }
}

export class SerialTransport extends BufferedTransport {
  constructor(port) { super(); this.port = port; this.label = 'Web Serial'; }
  async open(baud = 2000000) {
    try {
      await this.bounded(this.port.open({ baudRate: baud, dataBits: 8, stopBits: 1, parity: 'none', flowControl: 'none', bufferSize: 65536 }));
      this.reader = this.port.readable.getReader(); this.writer = this.port.writable.getWriter();
      this.pumpPromise = this.pump();
    } catch (error) { await this.close(); throw error; }
  }
  async pump() {
    try {
      while (!this.closed) { const { value, done } = await this.reader.read(); if (done) break; this.queue.push(value); }
      if (!this.closed) { this.queue.fail(new Error('El puerto serie se cerró.')); void this.close(); }
    } catch (error) { if (!this.closed) { this.queue.fail(error); void this.close(); } }
  }
  async write(data) {
    if (this.closed || this.queue.error) throw this.queue.error || new Error('Puerto desconectado.');
    await this.bounded(this.writer.write(data));
  }
  async close() {
    if (this.closed) return;
    this.closed = true; this.queue.fail(new Error('Puerto desconectado.'));
    try { await this.reader?.cancel(); } catch { /* already closed */ }
    try { this.reader?.releaseLock(); } catch { /* already released */ }
    try { await this.writer?.abort(); this.writer?.releaseLock(); } catch { /* disconnected */ }
    try { await this.port.close(); } catch { /* already closed */ }
  }
}

export async function requestTransport(kind = 'usb') {
  if (!globalThis.isSecureContext) throw new Error('Abre la aplicación por HTTPS. Una dirección HTTP de la red local no permite acceso USB.');
  if (kind === 'serial') {
    if (!navigator.serial) throw new Error('Web Serial no está disponible. En Android selecciona WebUSB.');
    const port = await navigator.serial.requestPort({ filters: [{ usbVendorId: 0x1a86, usbProductId: 0x7523 }] });
    return new SerialTransport(port);
  }
  if (!navigator.usb) throw new Error('WebUSB no está disponible. Usa Chrome en Android con USB OTG.');
  const device = await navigator.usb.requestDevice({ filters: USB_FILTERS });
  return new Ch340Transport(device);
}
