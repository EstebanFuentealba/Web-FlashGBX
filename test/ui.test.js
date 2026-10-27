import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { LKDevice } from '../dist/lib/lk.js';
import { CartridgeService, sizeLabel } from '../dist/lib/cartridge.js';
import { createDemo } from '../dist/lib/demo.js';
import { FirmwareSimulator, gbROM, gbaROM } from './fixtures.js';

// Minimal DOM boundary for exercising the real app and L15 simulator together.
class Element {
  constructor() { this.value=''; this.disabled=false; this.hidden=false; this.textContent=''; this.listeners={}; this.open=false; this.checked=false; this.children=[]; this.classList={toggle(){},remove(){},add(){}}; }
  addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
  async emit(type) { if (!this.disabled) for (const fn of this.listeners[type] ?? []) await fn({target:this}); }
  replaceChildren() { this.children=[]; }
  append(...children) { this.children.push(...children); }
  prepend(child) { this.children.unshift(child); }
  contains() { return false; }
  setAttribute() {}
  getContext() { return {fillRect(){}}; }
}
async function app(rom, resolveMetadata) {
  const html = await readFile(new URL('../dist/index.html',import.meta.url),'utf8');
  const elements = Object.fromEntries([...html.matchAll(/id="([^"]+)"/g)].map(m => [m[1], new Element()]));
  const radios = ['DMG','AGB'].map(value => Object.assign(new Element(),{value}));
  elements.transport.value='serial'; elements['reader-model'].value='2000000'; elements['gba-size'].value='33554432'; elements.verify.checked=true;
  const options=new Element(), wire=new FirmwareSimulator(rom);
  wire.open=async () => {}; wire.label='simulated serial';
  const Service = class extends CartridgeService { constructor(lk) { super(lk, resolveMetadata ? {resolveMetadata} : {}); } };
  const document = {getElementById:id => elements[id], querySelector:() => options, querySelectorAll:() => radios, addEventListener(){}, createElement:() => new Element()};
  const window={addEventListener(){}}; window.self=window; window.top=window;
  const source=(await readFile(new URL('../dist/app.js',import.meta.url),'utf8')).replace(/^import .*;\n/gm,'');
  const logoSource=(await readFile(new URL('../dist/lib/logo.js',import.meta.url),'utf8')).replace(/export function/g,'function');
  vm.runInNewContext(logoSource+'\n'+source,{document,window,navigator:{userAgent:'test',serial:{}},isSecureContext:true,requestTransport:async () => wire,LKDevice,CartridgeService:Service,sizeLabel,createDemo,AbortController,TextEncoder,TextDecoder,performance,setInterval,clearInterval,URL,Blob,console});
  return {elements,radios,wire};
}
const actionIds=['inspect','analyze','backup-rom','backup-save','write-rom','restore'];
test('Connect enables platform radios; selecting one auto-identifies and enables all six actions', async () => {
  const {elements:e,radios,wire}=await app(gbROM(0,0,0));
  assert.ok(radios.every(r => r.disabled)); assert.ok(actionIds.every(id => e[id].disabled));
  await e.connect.emit('click');
  assert.ok(radios.every(r => !r.disabled)); assert.ok(actionIds.every(id => e[id].disabled));
  assert.equal(wire.commands.filter(c => c[0]===0xb1).length,0);
  const selecting=radios[0].emit('change');
  assert.ok(radios.every(r => r.disabled)); assert.ok(actionIds.every(id => e[id].disabled));
  await selecting;
  assert.equal(e['cart-name'].textContent,'TEST GARDEN');
  assert.ok(actionIds.every(id => !e[id].disabled));
  assert.equal(e['cart-logo'].children.length,1);
  await e['backup-save'].emit('click');
  assert.match(e.message.textContent,/no tiene memoria/);
  await e['write-rom'].emit('click'); assert.match(e.message.textContent,/Conecta.*programar/);
  await e.analyze.emit('click'); assert.match(e.message.textContent,/Conecta.*analizar/);
  await e.connect.emit('click');
  assert.ok(radios.every(r => r.disabled)); assert.ok(actionIds.every(id => e[id].disabled));
  assert.equal(e['cart-name'].textContent,'—');
});
test('failed automatic identification leaves Refresh available and blocks backup execution', async () => {
  const rom=gbROM(); rom[0x14d]^=1;
  const {elements:e,radios,wire}=await app(rom);
  await e.connect.emit('click'); await radios[0].emit('change');
  assert.match(e.message.textContent,/inválida/); assert.equal(e.inspect.disabled,false);
  const before=wire.commands.length;
  await e['backup-rom'].emit('click');
  assert.match(e.message.textContent,/No se pudo identificar/); assert.equal(wire.commands.length,before);
});

test('GBA selection and size changes re-read the cartridge automatically', async () => {
  const {elements:e,radios,wire}=await app(gbaROM());
  await e.connect.emit('click'); await radios[1].emit('change');
  assert.equal(e['cart-name'].textContent,'GARDEN TEST');
  assert.equal(e['cart-logo'].children[0].width,104);
  assert.ok(actionIds.every(id => !e[id].disabled));
  e['gba-size'].value='1048576'; await e['gba-size'].emit('change');
  assert.equal(e['cart-rom'].textContent,'1 MiB');
  assert.equal(wire.commands.filter(c => c[0]===0xc1).length,2);
  await e.restore.emit('click'); assert.match(e.message.textContent,/partidas GBA/);
});

test('database product code and header revision appear together without changing ROM Title', async () => {
  const {elements:e,radios}=await app(gbROM(), async () => ({entry:{gn:'Frogger',gc:'DMG-AFRE'},status:'matched'}));
  await e.connect.emit('click'); await radios[0].emit('change');
  assert.equal(e['cart-code'].textContent,'DMG-AFRE-0');
  assert.equal(e['cart-name'].textContent,'Frogger');
  assert.equal(e['rom-title'].textContent,'TEST GARDEN');
});
