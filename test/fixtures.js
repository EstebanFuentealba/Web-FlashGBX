import { ByteQueue } from '../dist/lib/transport.js';
const logo = [0xce,0xed,0x66,0x66,0xcc,0x0d,0x00,0x0b,0x03,0x73,0x00,0x83,0x00,0x0c,0x00,0x0d,0x00,0x08,0x11,0x1f,0x88,0x89,0x00,0x0e,0xdc,0xcc,0x6e,0xe6,0xdd,0xdd,0xd9,0x99,0xbb,0xbb,0x67,0x63,0x6e,0x0e,0xec,0xcc,0xdd,0xdc,0x99,0x9f,0xbb,0xb9,0x33,0x3e];
export function gbROM(type = 3, romCode = 6, ramCode = 3) {
  const data = new Uint8Array(32768 * 2 ** romCode);
  for (let i = 0; i < data.length; i++) data[i] = ((i >>> 14) + ((i >>> 22) * 17) + i % 251) & 255;
  data.set(logo, 0x104); data.fill(0,0x134,0x150);
  data.set(new TextEncoder().encode('TEST GARDEN'),0x134);
  data[0x147] = type; data[0x148] = romCode; data[0x149] = ramCode;
  for (let i = 0x134; i <= 0x14c; i++) data[0x14d] = (data[0x14d] - data[i] - 1) & 255;
  return data;
}
export const GBA_LOGO = Uint8Array.from('24ffae51699aa2213d84820a84e409ad11248b98c0817f21a352be199309ce2010464a4af82731ec58c7e83382e3cebf85f4df94ce4b09c194568ac01372a7fc9f844d73a3ca9a615897a327fc039876231dc7610304ae56bf38840040a70efdff52fe036f9530f197fbc08560d68025a963be03014e38e2f9a234ffbb3e0344780090cb88113a9465c07c6387f03cafd625e48b380aac7221d4f807'.match(/../g), b => parseInt(b,16));
export function gbaROM() {
  const data = new Uint8Array(1048576);
  for (let i = 0; i < data.length; i++) data[i] = i % 251;
  data.set(GBA_LOGO,4);
  data.set(new TextEncoder().encode('GARDEN TEST '),0xa0);
  data[0xb2] = 0x96;
  let checksum = -0x19;
  for (let i = 0xa0; i <= 0xbc; i++) checksum -= data[i];
  data[0xbd] = checksum & 255;
  return data;
}

// Independent byte-level firmware simulator. It models bank registers, SRAM access,
// ACKs, word addressing and response fragmentation, without a browser or hardware.
export class FirmwareSimulator {
  constructor(rom = gbROM(), mapper = 'MBC1', ramSize = 32768, flags = 1) {
    this.rom = rom; this.mapper = mapper; this.ram = new Uint8Array(ramSize).map((_,i) => (i * 7) & 255);
    this.flags = flags; this.powerControl = !!(flags & 1); this.addressInputs = false;
    this.queue = new ByteQueue(); this.commands = []; this.closed = false; this.power = !this.powerControl; this.reset();
  }
  reset() { this.v8 = {}; this.v16 = {}; this.v32 = {}; this.low = 1; this.high = 0; this.ramBank = 0; this.bankMode = 0; this.ramEnabled = false; }
  push(bytes) { const data = Uint8Array.from(bytes); for (let i = 0; i < data.length; i += 23) this.queue.push(data.subarray(i, i + 23)); }
  async readExactly(n) { return this.queue.read(n, 500); }
  async close() { this.closed = true; this.queue.fail(new Error('closed')); }
  async write(bytes) {
    if (this.closed) throw new Error('closed');
    this.commands.push(Array.from(bytes));
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), cmd = bytes[0];
    if (!this.powerControl && ([0xf2,0xf3].includes(cmd) || (cmd === 0xa6 && ((bytes[1] === 4 && view.getUint32(2) === 1) || (bytes[1] === 1 && view.getUint32(2) === 0x0f))))) throw new Error('unsupported power command');
    if (cmd === 0xa1) {
      const name = new TextEncoder().encode('GBFlash\0');
      this.push([8,0x4c,0,15,13,0,0,0,1,name.length,...name,this.flags,0]); return;
    }
    if (cmd === 0xa6) {
      const vars = { 1: this.v8, 2: this.v16, 4: this.v32 }[bytes[1]];
      vars[view.getUint32(2)] = view.getUint32(6); this.push([1]); return;
    }
    if ([0xa2,0xa3].includes(cmd)) { if (this.powerControl) this.reset(); this.addressInputs = false; this.mode = cmd === 0xa2 ? 'AGB' : 'DMG'; }
    if (cmd === 0xa8) this.addressInputs = true;
    if (cmd === 0xf2) this.power = true;
    if (cmd === 0xf3) this.power = false;
    if (cmd === 0xb2) {
      const address = view.getUint32(1), value = bytes[5];
      if (address < 0x2000) this.ramEnabled = value === 10;
      else if (address < 0x4000) {
        if (this.mapper === 'MBC5' && address >= 0x3000) this.high = value & 1;
        else this.low = value;
      } else if (address < 0x6000) {
        this.ramBank = value;
        if (this.mapper === 'MBC1') this.high = value;
      } else this.bankMode = value;
    }
    if ([0xb1,0xc1,0xc3].includes(cmd)) {
      const length = this.v16[0], address = this.v32[0];
      if (!this.power || this.addressInputs) throw new Error('read without active bus');
      if (cmd === 0xc1) { this.push(this.rom.subarray(address * 2, address * 2 + length)); return; }
      if (this.v8[8] && this.mode === 'DMG') {
        if (!this.ramEnabled && this.mapper !== 'ROM') throw new Error('RAM not enabled');
        const offset = this.ramBank * 8192 + address - 0xa000;
        this.push(this.ram.subarray(offset,offset + length)); return;
      }
      let bank = 0;
      if (address < 0x4000) bank = this.mapper === 'MBC1' && this.bankMode ? this.high * 32 : 0;
      else if (this.mapper === 'MBC1') bank = this.high * 32 + (this.low & 31 || 1);
      else if (this.mapper === 'MBC5') bank = this.high * 256 + this.low;
      else if (this.mapper === 'ROM') bank = 1;
      else bank = this.low || 1;
      const offset = bank * 16384 + (address & 0x3fff);
      this.push(this.rom.subarray(offset, offset + length)); return;
    }
    if (cmd === 0xb3) {
      if (!this.power || this.v8[9] !== 1 || this.v8[1] !== 4 || (!this.ramEnabled && this.mapper !== 'ROM')) throw new Error('invalid RAM write state');
      if (bytes.length !== this.v16[0] + 1) throw new Error('invalid write length');
      this.ram.set(bytes.subarray(1), this.ramBank * 8192 + this.v32[0] - 0xa000);
      if (this.corrupt) this.ram[0] ^= 1;
    }
    this.push([1]);
  }
}
