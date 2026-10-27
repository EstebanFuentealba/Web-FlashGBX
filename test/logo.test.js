import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeLogo } from '../dist/lib/logo.js';
import { gbROM, gbaROM } from './fixtures.js';

test('GB cartridge logo decodes to the expected 48 by 8 bitmap', () => {
  const rom = gbROM(), logo = decodeLogo(rom, 'DMG');
  assert.equal(logo.width,48); assert.equal(logo.height,8);
  assert.equal(logo.pixels.reduce((a,b) => a+b),179);
  assert.equal(Array.from(logo.pixels.slice(0,48), p => p ? '#' : ' ').join(''), '##   ## ##                             ##       ');
  rom[0x104] ^= 0x80;
  assert.equal(decodeLogo(rom,'DMG').pixels[0],0);
});
test('GBA cartridge logo decompresses and unfilters into the expected bitmap', () => {
  const logo = decodeLogo(gbaROM(),'AGB');
  assert.equal(logo.width,104); assert.equal(logo.height,16);
  assert.equal(logo.pixels.reduce((a,b) => a+b),682);
  assert.ok(logo.pixels.slice(0,104).every(p => p === 0));
  assert.deepEqual(Array.from(logo.pixels.slice(104+97,104+101)),[1,1,1,1]);
});
test('truncated and corrupt compressed logos are rejected without unbounded decoding', () => {
  assert.throws(() => decodeLogo(new Uint8Array(10),'DMG'), /incompleto/);
  assert.throws(() => decodeLogo(new Uint8Array(10),'AGB'), /incompleto/);
  assert.throws(() => decodeLogo(new Uint8Array(0xc0),'AGB'), /GBA/);
});
