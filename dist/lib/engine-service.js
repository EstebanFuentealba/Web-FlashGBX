// SPDX-License-Identifier: GPL-3.0-or-later
import { FlashGBXEngine } from './engine.js';
export class EngineCartridgeService {
  static async connect(lk, options = {}) {
    const service = new EngineCartridgeService(lk, options);
    service.engine = await new FlashGBXEngine(lk.transport,{
      onLog:options.onLog, onPrompt:options.onPrompt,
      onProgress:event => {
        options.onEngineProgress?.(event);
        if (event.action === 'ABORT' || event.action === 'ERROR' || (event.action==='FINISHED' && event.verified===false)) service.lastError=event.info_msg || event.text;
        service.progress?.(event.total ? Math.max(0,Math.min(1,event.position/event.total)) : 0,event.text || event.method || event.action,event.position);
      },
    }).start();
    service.capabilities = service.engine.capabilities;
    let result;
    try { result=await service.engine.execute('connect',{name:lk.info.name,baud:options.baud}); }
    catch(error) { await service.engine.close(); throw error; }
    service.profiles=result.profiles;
    return service;
  }
  constructor(lk, options) { this.lk=lk; this.options=options; this.extraFiles=[]; this.isFullEngine=true; }
  settings() { return this.options.settings?.() || {}; }
  async execute(action,args={},files=[],options={}) {
    this.progress=options.onProgress; this.lastError=null;
    const abort=() => this.engine.cancel(); options.signal?.addEventListener('abort',abort,{once:true});
    try {
      if (options.signal?.aborted) throw new DOMException('Operación cancelada.','AbortError');
      const result=await this.engine.execute(action,{...this.settings(),...args},files);
      if (result.cart) result.cart.header=Uint8Array.from(result.cart.header);
      if (result.profiles) this.profiles=result.profiles;
      return result;
    } catch(error) { this.extraFiles.push(...(error.files || [])); throw new Error(this.lastError || error.message); }
    finally { options.signal?.removeEventListener('abort',abort); this.progress=null; }
  }
  async inspect(mode,romSize) { return (await this.execute('inspect',{mode,romSize})).cart; }
  async analyze(cart,options={}) { return this.execute('analyze',{},[],options); }
  async backupROM(cart,options={}) {
    const result=await this.execute('backup-rom',{romSize:cart.romSize,verify:options.verify !== false},[],options);
    const index=result.files.findIndex(file => /\.(gb|gba)$/.test(file.name));
    if (index<0) throw new Error('El motor no generó la ROM.');
    const file=result.files.splice(index,1)[0]; this.extraFiles.push(...result.files); return file.data;
  }
  async backupSave(cart,options={}) {
    const result=await this.execute('backup-save',{},[],options);
    if (!result.files.length) throw new Error('El motor no generó la partida.');
    return result.files[0].data;
  }
  async validateSave(data) { await this.execute('validate-save',{size:data.length}); }
  async restoreSave(cart,data,options={}) {
    const result=await this.execute('restore-save',{confirmed:true},[{name:'input.sav',data}],options);
    this.extraFiles.push(...result.files);
  }
  async writeROM(cart,data,options={}) {
    const result=await this.execute('write-rom',{confirmed:true,skipBackup:true,path:options.filename?.toLowerCase().endsWith('.isx') ? '/data/input.isx' : '/data/input.rom'},[{name:options.filename?.toLowerCase().endsWith('.isx') ? 'input.isx' : 'input.rom',data}],options);
    this.extraFiles.push(...result.files);
  }
  takeFiles() { return this.extraFiles.splice(0); }
  async close() { await this.engine.close(); }
}
