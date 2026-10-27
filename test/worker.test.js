import test from 'node:test';
import assert from 'node:assert/strict';
import {Worker as NodeWorker} from 'node:worker_threads';
import {FlashGBXEngine} from '../dist/lib/engine.js';
import {EngineFirmware} from './engine-firmware.js';
class BrowserWorker {
 constructor(url) {
  this.worker=new NodeWorker(new URL('./engine-worker-harness.js',import.meta.url),{workerData:{url:url.href}});
  this.worker.on('message',data=>this.onmessage?.({data}));this.worker.on('error',error=>this.onerror?.(error));
 }
 postMessage(data){this.worker.postMessage(data);}
 terminate(){return this.worker.terminate();}
}
test('actual browser worker executes USB RPC, flash detection and verified ROM programming through shared memory',async () => {
 globalThis.Worker=BrowserWorker;globalThis.crossOriginIsolated=true;
 const wire=new EngineFirmware();
 const transport={queue:{get length(){return wire.waiting;},readPartial:async n=>wire.read(n),clear:()=>wire.reset()},write:async data=>wire.write(data)};
 const engine=new FlashGBXEngine(transport);
 try {
  await engine.start();assert.equal(engine.capabilities.profiles.DMG,169);
  await engine.execute('connect',{name:'GBFlash',baud:2000000});
  const info=await engine.execute('inspect',{mode:'DMG'});assert.equal(info.cart.title,'TEST GARDEN');
  const save=await engine.execute('backup-save',{rtc:false});assert.deepEqual(save.files[0].data,wire.ram);
  await engine.execute('console',{code:"profile_name='DIY cart with AM29F010 @ WR'\ndevice.UpdateFlashCarts({'DMG':{profile_name:profiles['DMG'][profile_name]},'AGB':{}})"});
  const detected=await engine.execute('analyze',{checkSaveType:false});assert.equal(detected.analysis.profile,1);
  const beforeWrites=wire.writes;
  await assert.rejects(engine.execute('write-rom',{profile:1,confirmed:false}),/Confirma/);assert.equal(wire.writes,beforeWrites);
  const rom=wire.rom.map((b,i)=>i<0x150?b:b^0x77);
  await engine.execute('write-rom',{profile:1,confirmed:true,skipBackup:true,chipErase:true},[{name:'input.rom',data:rom}]);
  assert.deepEqual(wire.rom,rom);assert.equal(wire.power,false);
  await engine.execute('inspect',{mode:'DMG'});
  wire.badCRC=true;wire.corruptProgram=true;
  const next=rom.map((b,i)=>i<0x150?b:b^0x55);
  await assert.rejects(engine.execute('write-rom',{profile:1,confirmed:true,skipBackup:false,chipErase:true},[{name:'input.rom',data:next}]),error=>{
    assert.ok(error.files.some(file=>file.name==='before-write.rom'));
    assert.deepEqual(error.files.find(file=>file.name==='before-write.rom').data,rom);return true;
  });
 } finally {await engine.close();delete globalThis.Worker;delete globalThis.crossOriginIsolated;}
});
