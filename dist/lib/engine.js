// SPDX-License-Identifier: GPL-3.0-or-later
export class FlashGBXEngine {
  constructor(transport, {onLog = () => {}, onProgress = () => {}, onPrompt = async () => false} = {}) {
    this.transport = transport; this.onLog = onLog; this.onProgress = onProgress; this.onPrompt = onPrompt;
    this.pending = new Map(); this.sequence = 0; this.busy = false;
  }
  async start() {
    if (!globalThis.crossOriginIsolated || typeof SharedArrayBuffer === 'undefined') {
      throw new Error('El motor completo requiere aislamiento de origen (COOP/COEP). Recarga la app desde su URL principal.');
    }
    this.control = new Int32Array(new SharedArrayBuffer(32));
    this.bytes = new Uint8Array(new SharedArrayBuffer(65536));
    this.worker = new Worker(new URL('../engine/worker.js', import.meta.url), {type:'module'});
    this.worker.onmessage = event => {
      const message = event.data;
      if (message.type === 'io') { void this.io(message); return; }
      if (message.type === 'log') { this.onLog(message.text); return; }
      if (message.type === 'progress') { this.onProgress(message.value); return; }
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) { const error=new Error(message.error); error.files=message.files || []; pending.reject(error); } else pending.resolve(message.result);
    };
    this.worker.onerror = event => this.fail(new Error(event.message || 'Falló el motor FlashGBX.'));
    try { this.capabilities = await this.call('init', {control:this.control.buffer, bytes:this.bytes.buffer}); }
    catch(error) { await this.close(); throw error; }
    return this;
  }
  fail(error) {
    Atomics.store(this.control, 0, -1); Atomics.notify(this.control, 0);
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
  async io(message) {
    try {
      let data = new Uint8Array(), count = 0;
      const transport = this.transport;
      switch (message.op) {
        case 'read': data = await transport.queue.readPartial(message.size, message.timeout); count = data.length; break;
        case 'write': await transport.write(message.data); count = message.data.length; break;
        case 'waiting': count = transport.queue.length; break;
        case 'reset': transport.queue.clear(); break;
        case 'prompt': count = await this.onPrompt(message.value) ? 1 : 0; break;
        default: throw new Error('Operación serie desconocida.');
      }
      if (data.length) this.bytes.set(data);
      Atomics.store(this.control, 1, count); Atomics.store(this.control, 0, 1);
    } catch (error) {
      this.onLog(error.message); Atomics.store(this.control, 1, 0); Atomics.store(this.control, 0, -1);
    } finally { Atomics.notify(this.control, 0); }
  }
  call(type, payload = {}) {
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      this.pending.set(id,{resolve,reject}); this.worker.postMessage({id,type,...payload});
    });
  }
  async execute(action, args = {}, files = []) {
    if (this.busy) throw new Error('Ya hay una operación del motor en curso.');
    this.busy = true; Atomics.store(this.control, 2, 0);
    try { return await this.call('execute',{action,args,files}); }
    finally { this.busy = false; }
  }
  cancel() { Atomics.store(this.control, 2, 1); }
  async close() {
    if (!this.worker) return;
    this.fail(new Error('Motor desconectado.')); this.worker.terminate(); this.worker = null;
  }
}
