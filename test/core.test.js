import test from 'node:test';
import assert from 'node:assert/strict';
import { ByteQueue, baudRegister, Ch340Transport } from '../dist/lib/transport.js';
import { LKDevice } from '../dist/lib/lk.js';
import { CartridgeService, parseGB, parseGBA, sameBytes } from '../dist/lib/cartridge.js';
import { FirmwareSimulator, gbROM, gbaROM } from './fixtures.js';

test('byte queue assembles fragmented replies and preserves surplus bytes', async () => {
  const q = new ByteQueue(); const pending = q.read(4);
  q.push(Uint8Array.of(1)); q.push(Uint8Array.of(2,3,4,5,6));
  assert.deepEqual(await pending, Uint8Array.of(1,2,3,4));
  assert.deepEqual(await q.read(2), Uint8Array.of(5,6));
});
test('timed-out sessions stay poisoned; late bytes cannot satisfy a new command', async () => {
  const q = new ByteQueue(); await assert.rejects(q.read(1,5), /no respondió/);
  q.push(Uint8Array.of(1)); await assert.rejects(q.read(1), /no respondió/);
});
test('concurrent readers cannot steal each other’s response', async () => {
  const q = new ByteQueue(), a = q.read(1);
  await assert.rejects(q.read(1), /simultáneas/); q.push(Uint8Array.of(7)); assert.equal((await a)[0],7);
});
test('CH340 uses exact 2 Mbaud for GBFlash, including old-chip short-packet quirk', () => {
  assert.equal(baudRegister(2000000),0xfd83); assert.equal(baudRegister(2000000,0x27),0xfd03);
  assert.equal(baudRegister(1000000),0xfa83); assert.equal(baudRegister(1500000),0xfc83);
  assert.throws(() => baudRegister(9600));
});
test('CH340 discovers actual bulk endpoints and rejects a short USB write', async () => {
  const controls = [], writes = [], reads = []; let rejectRead;
  const alt = { alternateSetting: 0, endpoints: [{type:'interrupt',direction:'in',endpointNumber:1,packetSize:8},{type:'bulk',direction:'in',endpointNumber:4,packetSize:32},{type:'bulk',direction:'out',endpointNumber:5,packetSize:32}] };
  const device = {
    configuration: { interfaces:[{interfaceNumber:2,alternate:alt,alternates:[alt]}] }, opened: false,
    open: async () => { device.opened = true; }, claimInterface: async n => assert.equal(n,2),
    controlTransferIn: async () => ({status:'ok',data:new DataView(Uint8Array.of(0x30,0).buffer)}),
    controlTransferOut: async setup => { controls.push(setup); return {status:'ok'}; },
    transferIn: (endpoint,length) => { reads.push([endpoint,length]); return new Promise((_,reject) => {rejectRead = reject;}); },
    transferOut: async (endpoint,data) => { writes.push(endpoint); return {status:'ok',bytesWritten:data.length - 1}; },
    close: async () => { device.opened = false; rejectRead?.(new Error('closed')); },
  };
  const t = new Ch340Transport(device); await t.open(2000000);
  assert.ok(controls.some(c => c.value === 0x1312 && c.index === 0xfd83));
  assert.deepEqual(reads,[[4,32]]);
  await assert.rejects(t.write(Uint8Array.of(0xa1)),/incompleta/);
  assert.deepEqual(writes,[5]); assert.equal(t.closed,true);
});

async function setup(rom, mapper, ramSize) {
  const wire = new FirmwareSimulator(rom,mapper,ramSize), lk = new LKDevice(wire);
  await lk.identify(); return { wire, lk, service: new CartridgeService(lk) };
}
test('L15 identify parses capability bitfields, without powering the cartridge', async () => {
  const {wire,lk} = await setup(); assert.equal(lk.info.name,'GBFlash'); assert.equal(lk.info.version,15);
  assert.equal(wire.power,false); assert.deepEqual(wire.commands[0],[0xa1]);
});
test('L15 without power control supports repeated GB ROM and SRAM operations', async () => {
  const rom = gbROM(), wire = new FirmwareSimulator(rom, 'MBC1', 32768, 0x06), lk = new LKDevice(wire);
  const info = await lk.identify(), service = new CartridgeService(lk);
  assert.equal(info.powerControl, false); assert.equal(info.flags, 6);
  assert.deepEqual(wire.commands, [[0xa1], [0xa8]]);
  const cart = await service.inspect('DMG');
  const original = await service.backupSave(cart);
  await service.restoreSave(cart, original.map(n => n ^ 0x5a));
  assert.deepEqual(await service.backupSave(cart), wire.ram);
  assert.deepEqual(await service.backupROM(cart), rom);
  assert.equal((await service.inspect('DMG')).title, cart.title);
  assert.ok(wire.commands.some(c => sameBytes(c, [0xf5,0x40,0,0,0,1])));
  assert.equal(wire.power, true); assert.equal(wire.addressInputs, true);
  assert.ok(!wire.commands.some(c => [0xf2,0xf3].includes(c[0])));
});
test('L15 without power control idles after cancellation and operation errors', async () => {
  const wire = new FirmwareSimulator(undefined, 'MBC1', 32768, 0), lk = new LKDevice(wire);
  await lk.identify(); const service = new CartridgeService(lk), cart = await service.inspect('DMG');
  const abort = new AbortController();
  await assert.rejects(service.backupROM(cart, {signal:abort.signal,onProgress:p => { if (p > 0.38) abort.abort(); }}), /cancelada/);
  assert.equal(wire.high, 0); assert.equal(wire.addressInputs, true);
  assert.equal((await service.inspect('DMG')).title, cart.title);
  await assert.rejects(lk.powered('DMG', async () => { throw new Error('test failure'); }), /test failure/);
  assert.equal(wire.addressInputs, true); assert.equal(lk.busy, false);
});
test('L15 without power control selects GBA voltage and audio pin without power commands', async () => {
  const rom = gbaROM(), wire = new FirmwareSimulator(rom, 'ROM', 0, 0), lk = new LKDevice(wire);
  await lk.identify(); const service = new CartridgeService(lk), cart = await service.inspect('AGB', rom.length);
  assert.deepEqual(await service.backupROM(cart, {verify:false}), rom);
  assert.ok(wire.commands.some(c => sameBytes(c, [0xf5,0x40,0,0,0,0])));
  assert.ok(wire.commands.some(c => c[0] === 0xa4));
  assert.ok(!wire.commands.some(c => [0xa5,0xf2,0xf3].includes(c[0])));
  assert.equal(wire.power, true); assert.equal(wire.addressInputs, true);
});
test('MBC1 backup includes otherwise inaccessible banks 00,20,40,60 and verifies a second pass', async () => {
  const rom = gbROM(3,6,3), {service,wire} = await setup(rom,'MBC1',32768);
  const cart = await service.inspect('DMG'); assert.equal(cart.unsupported,'');
  const data = await service.backupROM(cart); assert.ok(sameBytes(rom,data)); assert.equal(wire.power,false);
});
test('MBC5 backup switches the ninth ROM bank bit', async () => {
  const rom = gbROM(27,8,3), {service,wire} = await setup(rom,'MBC5',32768);
  const cart = await service.inspect('DMG');
  const data = await service.backupROM(cart,{verify:false}); assert.ok(sameBytes(rom,data));
  assert.ok(wire.commands.some(c => c[0] === 0xb2 && c[3] === 0x30 && c[5] === 1));
});
test('MBC1 SRAM round-trip writes each bank and verifies every byte', async () => {
  const {service,wire} = await setup(gbROM(),'MBC1',32768), cart = await service.inspect('DMG');
  const original = await service.backupSave(cart); assert.deepEqual(original,wire.ram);
  const replacement = original.map(n => n ^ 0x5a);
  await service.restoreSave(cart,replacement); assert.deepEqual(wire.ram,replacement);
  assert.equal(wire.ramEnabled,false); assert.equal(wire.power,false);
});
test('MBC2 saves normalize unused high nibbles', async () => {
  const {service,wire} = await setup(gbROM(6,3,0),'MBC2',512), cart = await service.inspect('DMG');
  const expected = Uint8Array.from({length:512},(_,i) => i & 15);
  await service.restoreSave(cart,expected);
  assert.deepEqual(await service.backupSave(cart),expected.map(n => n | 0xf0)); assert.equal(wire.power,false);
});
test('wrong size, changed cartridge and unsupported mapper reject before SRAM writes', async () => {
  const {service,wire} = await setup(), cart = await service.inspect('DMG');
  await assert.rejects(service.restoreSave(cart,new Uint8Array(1)),/exactamente/);
  wire.rom[0x134] ^= 1;
  await assert.rejects(service.restoreSave(cart,new Uint8Array(cart.ramSize)),/cambió/);
  await assert.rejects(service.backupROM({...cart,unsupported:'Unsupported mapper'}),/Unsupported/);
  assert.equal(wire.commands.filter(c => c[0] === 0xb3).length,0); assert.equal(wire.power,false);
});
test('write verification detects corrupted SRAM, including odd number of corruptions', async () => {
  const {service,wire} = await setup(), cart = await service.inspect('DMG');
  const originalWrite = wire.write.bind(wire); let corrupted = false;
  wire.write = async bytes => { await originalWrite(bytes); if (bytes[0] === 0xb3 && !corrupted) {wire.ram[0] ^= 1;corrupted = true;} };
  await assert.rejects(service.restoreSave(cart,new Uint8Array(cart.ramSize)),/verificación falló/);
  assert.equal(wire.power,false);
});
test('GBA reads use word addresses and only 3.3 V, never the GB voltage command', async () => {
  const rom = gbaROM(), {service,wire} = await setup(rom,'ROM',0);
  const cart = await service.inspect('AGB',rom.length);
  const data = await service.backupROM(cart,{verify:false}); assert.deepEqual(data,rom);
  assert.ok(wire.commands.some(c => c[0] === 0xa4)); assert.ok(!wire.commands.some(c => c[0] === 0xa5));
  await assert.rejects(service.backupSave(cart),/GB\/GBC/);
});
test('cancelling a ROM backup powers off and returns no partial file', async () => {
  const {service,wire} = await setup(), cart = await service.inspect('DMG'), abort = new AbortController();
  await assert.rejects(service.backupROM(cart,{signal:abort.signal,onProgress:() => abort.abort()}),/cancelada/);
  assert.equal(wire.power,false);
});
test('invalid ACK poisons the session and suppresses further cleanup commands', async () => {
  const wire = new FirmwareSimulator(), lk = new LKDevice(wire);
  await lk.identify(); wire.write = async bytes => { wire.commands.push(Array.from(bytes)); wire.push([2]); };
  const before = wire.commands.length;
  await assert.rejects(lk.powered('DMG',async () => {}),/inesperada/);
  assert.equal(wire.commands.length,before + 1); assert.equal(lk.poisoned,true); assert.equal(wire.closed,true);
});
test('bad header checksums and unsupported GBA sizes fail validation', () => {
  const rom = gbROM(); rom[0x14d] ^= 1; assert.throws(() => parseGB(rom),/inválida/);
  assert.throws(() => parseGBA(gbaROM(),123),/tamaño/);
  assert.equal(parseGB(gbROM(0xfc,1,0)).mapper,null);
});
