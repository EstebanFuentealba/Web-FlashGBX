import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {loadPyodide} from '../dist/vendor/pyodide/pyodide.mjs';
import {EngineFirmware} from './engine-firmware.js';

const root=new URL('../dist/',import.meta.url);
async function runtime() {
  const py=await loadPyodide({indexURL:new URL('vendor/pyodide/',root).pathname,stdout:()=>{},stderr:()=>{}});
  await py.loadPackage(['pillow','python-dateutil','packaging']);
  py.unpackArchive(new Uint8Array(await readFile(new URL('engine/flashgbx.zip',root))),'zip',{extractDir:'/app'});
  const wire=new EngineFirmware(), events=[];
  py.registerJsModule('browser_io',{read:n=>wire.read(n),write:bytes=>wire.write(bytes.toJs()),waiting:()=>wire.waiting,reset:()=>wire.reset(),ask:()=>false,cancelled:()=>false,emit:json=>events.push(JSON.parse(json))});
  await py.runPythonAsync(await readFile(new URL('engine/adapter.py',root),'utf8'));
  const run=(action,args={})=>{py.globals.set('req',JSON.stringify({action,args}));try{return JSON.parse(py.runPython('dispatch_json(req)'));}catch(e){throw new Error(e.message);}};
  return {py,wire,events,run};
}
test('unmodified FlashGBX 5.1 loads offline in WebAssembly with every GB/GBA profile',async () => {
  const {py,wire,events,run}=await runtime();
  const capabilities=JSON.parse(py.runPython('capabilities_json()'));
  assert.equal(capabilities.version,'5.1');assert.equal(capabilities.profiles.DMG,169);assert.equal(capabilities.profiles.AGB,97);
  assert.equal(capabilities.saveTypes.AGB[5].size,131072);
  run('connect',{name:'GBFlash',baud:2000000});
  const card=run('inspect',{mode:'DMG'}).cart;
  assert.equal(card.title,'TEST GARDEN');assert.equal(card.romSize,131072);assert.equal(card.ramSize,8192);
  assert.equal(wire.power,false);
  const original=wire.rom.slice();
  const backup=run('backup-rom',{romSize:original.length,verify:true,profile:0});
  assert.deepEqual(py.FS.readFile(backup.files[0].path),original);
  const save=run('backup-save',{rtc:false});
  assert.deepEqual(py.FS.readFile(save.files[0].path),wire.ram);
  const next=wire.ram.map(x=>x^0x5a);py.FS.writeFile('/data/input.sav',next);
  run('validate-save',{size:next.length});
  run('restore-save',{confirmed:true,rtc:false});assert.deepEqual(wire.ram,next);
  assert.ok(events.some(e=>e.action==='FINISHED'));
  // Restrict the simulated cartridge to one real upstream AMD profile.
  py.runPython("profile_name='DIY cart with AM29F010 @ WR'\ndevice.UpdateFlashCarts({'DMG':{profile_name:profiles['DMG'][profile_name]},'AGB':{}})");
  const detected=run('analyze',{checkSaveType:false});
  assert.equal(detected.analysis.profile,1);assert.match(detected.analysis.flashId,/01 20/);
  const replacement=original.map((byte,i)=>i<0x150?byte:byte^0x5a);py.FS.writeFile('/data/input.rom',replacement);
  run('write-rom',{profile:1,confirmed:true,skipBackup:true,chipErase:true,mbc:0x1b});
  assert.deepEqual(wire.rom,replacement);assert.ok(wire.commands.includes(0xd3));assert.ok(wire.commands.includes(0xd5));
});
test('browser engine extracts Camera photos and exposes the original core to its console',async () => {
  const {py,run}=await runtime();
  const save=new Uint8Array(131072).fill(255);py.FS.writeFile('/data/input.sav',save);
  const camera=run('camera-extract',{palette:'dmg'});
  assert.equal(camera.files[0].name,'camera.zip');
  assert.equal(py.runPython("len(zipfile.ZipFile('/data/camera.zip').namelist())"),32);
  assert.equal(py.runPython("zipfile.ZipFile('/data/camera.zip').read('IMG_00.png')[:8].hex()"),'89504e470d0a1a0a');
  const console=run('console',{code:"print(len(profiles['DMG']))\nresult=PocketCamera.PALETTE_NAMES"});
  assert.match(console.output,/169/);assert.ok(console.result.includes('grayscale'));
});
