import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash, webcrypto } from 'node:crypto';
import { lookupGBMetadata, applyGBMetadata } from '../dist/lib/metadata.js';
import { parseGB, CartridgeService } from '../dist/lib/cartridge.js';
import { LKDevice } from '../dist/lib/lk.js';
import { gbROM, FirmwareSimulator } from './fixtures.js';
const hash = data => createHash('sha1').update(data.subarray(0,0x180)).digest('hex');

test('bundled FlashGBX database contains the three Frogger USA revisions', async () => {
  const db=JSON.parse(await readFile(new URL('../dist/config/db_DMG.json',import.meta.url),'utf8'));
  assert.equal(db['2b6674d412ab628205394cbc6ad78bb0576ced76'].gc,'DMG-AFRE');
  assert.equal(db['2b6674d412ab628205394cbc6ad78bb0576ced76'].gn,'Frogger');
  assert.equal(Object.values(db).filter(e => e.gc==='DMG-AFRE').length,3);
});
test('metadata matches all 384 header bytes and keeps the revision from the cartridge', async () => {
  const rom=gbROM(), database={[hash(rom)]:{gn:'Frogger',gc:'DMG-AFRE'}};
  const result=await lookupGBMetadata(rom,{database,subtle:webcrypto.subtle});
  const cart=applyGBMetadata(parseGB(rom),result);
  assert.equal(cart.productCode,'DMG-AFRE'); assert.equal(cart.revision,0);
  assert.equal(cart.gameName,'Frogger'); assert.equal(cart.title,'TEST GARDEN');
  rom[0x17f]^=1;
  const unknown=applyGBMetadata(parseGB(rom),await lookupGBMetadata(rom,{database,subtle:webcrypto.subtle}));
  assert.equal(unknown.productCode,''); assert.equal(unknown.metadataStatus,'unknown');
  assert.equal(unknown.gameName,'TEST GARDEN');
});
test('GB title parsing preserves long CGB titles and extracts actual embedded product codes', () => {
  const rom=gbROM(); rom.fill(0,0x134,0x144); rom.set(new TextEncoder().encode('LONG TITLE TEST'),0x134); rom[0x143]=0x80;
  const fix=() => {rom[0x14d]=0;for(let i=0x134;i<=0x14c;i++) rom[0x14d]=(rom[0x14d]-rom[i]-1)&255;};
  fix(); assert.equal(parseGB(rom).title,'LONG TITLE TEST'); assert.equal(parseGB(rom).productCode,'');
  rom.set(new TextEncoder().encode('AFRE'),0x13f); rom[0x14c]=2; fix();
  assert.equal(parseGB(rom).productCode,'DMG-AFRE'); assert.equal(parseGB(rom).revision,2);
  assert.equal(applyGBMetadata(parseGB(rom),{entry:{gc:'DMG-XXXX'},status:'matched'}).productCode,'DMG-AFRE');
});
test('metadata lookup runs after hardware cleanup and receives the full header', async () => {
  const wire=new FirmwareSimulator(), lk=new LKDevice(wire); await lk.identify();
  const service=new CartridgeService(lk,{resolveMetadata:async header => {
    assert.equal(wire.power,false); assert.equal(header.length,0x180);
    return {entry:{gn:'Test name',gc:'DMG-AFRE'},status:'matched'};
  }});
  assert.equal((await service.inspect('DMG')).productCode,'DMG-AFRE');
});
test('missing digest support and short headers have explicit outcomes', async () => {
  assert.equal((await lookupGBMetadata(gbROM(),{subtle:null})).status,'unavailable');
  await assert.rejects(lookupGBMetadata(new Uint8Array(0x150)),/384/);
});
