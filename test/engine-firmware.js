// Independent synchronous L15/NOR simulator for the upstream WebAssembly engine.
import { gbROM } from './fixtures.js';
export function crc32(data) { let crc=0xffffffff; for (const byte of data) {crc^=byte;for(let bit=0;bit<8;bit++) crc=(crc>>>1)^((crc&1)?0xedb88320:0);} return (crc^0xffffffff)>>>0; }
export class EngineFirmware {
  constructor() { this.rom=gbROM(0x1b,2,2);this.ram=new Uint8Array(8192).map((_,i)=>i&255);this.input=[];this.output=[];this.variables={1:{0:1},2:{},4:{1:5000}};this.bank=1;this.ramBank=0;this.power=false;this.ramEnabled=false;this.idMode=false;this.cfiMode=false;this.history=[];this.commands=[];this.writes=0; }
  push(data) { this.output.push(...data); }
  read(n) {return Uint8Array.from(this.output.splice(0,n));}
  get waiting() {return this.output.length;}
  reset() {this.output=[];}
  address() {return this.variables[4][0]||0;}
  offset(address=this.address()) {return address<0x4000 ? address : (this.bank%8)*0x4000+(address&0x3fff);}
  readROM(address,n) {
    if(this.idMode) {const out=new Uint8Array(n);if(address===0){out[0]=1;out[1]=0x20;}return out;}
    if(this.cfiMode) return new Uint8Array(n).fill(0xff);
    const out=new Uint8Array(n);for(let i=0;i<n;i++)out[i]=this.rom[this.offset(address+i)%this.rom.length];return out;
  }
  flash(address,value) {
    if(value===0xf0 || value===0xff){this.idMode=false;this.cfiMode=false;this.history=[];return;}
    this.history.push(value);this.history=this.history.slice(-6);
    if(value===0x90){this.idMode=true;this.cfiMode=false;}
    if(value===0x98){this.cfiMode=true;this.idMode=false;}
    if(this.history.join(',')==='170,85,128,170,85,16'){this.rom.fill(0xff);this.history=[];this.idMode=false;this.cfiMode=false;}
  }
  write(data) {
    this.input.push(...data);
    while(this.input.length) {
      const cmd=this.input[0], size=this.variables[2][0]||0;
      let length=1;
      if(cmd===0xa6)length=10;else if(cmd===0xad || cmd===0xb2 || cmd===0xd1)length=6;else if(cmd===0xf5)length=6;else if(cmd===0xfe)length=2;else if(cmd===0xa7)length=40;else if(cmd===0xb8){if(this.input.length<2)return;length=2+this.input[1]*5;}else if(cmd===0xd5)length=5;else if(cmd===0xb3 || cmd===0xd3)length=1+size;else if(cmd===0xd4){if(this.input.length<3)return;length=3+this.input[2]*6;}
      if(this.input.length<length)return;
      const packet=Uint8Array.from(this.input.splice(0,length)), view=new DataView(packet.buffer);this.commands.push(cmd);
      if(cmd===0xa1){const name=new TextEncoder().encode('GBFlash\0');this.push([8,0x4c,0,15,13,0x68,0,0,0,name.length,...name,1,0]);continue;}
      if(cmd===0xa6){this.variables[packet[1]][view.getUint32(2)]=view.getUint32(6);this.push([1]);continue;}
      if(cmd===0xad){const val=this.variables[packet[1]][view.getUint32(2)]||0;this.push([(val>>>24)&255,(val>>>16)&255,(val>>>8)&255,val&255]);continue;}
      if(cmd===0xfe){this.push([packet[1]^255]);continue;}
      if(cmd===0xf4){this.push([this.power?1:0]);continue;}
      if(cmd===0xf2)this.power=true;
      if(cmd===0xf3)this.power=false;
      if(cmd===0xa3)this.variables[1][0]=1;
      if(cmd===0xa2)this.variables[1][0]=2;
      if(cmd===0xb4){this.bank=1;this.ramBank=0;}
      if(cmd===0xb2){const address=view.getUint32(1), value=packet[5];if(address<0x2000)this.ramEnabled=value===10;else if(address<0x3000)this.bank=(this.bank&256)|value;else if(address<0x4000)this.bank=(this.bank&255)|((value&1)<<8);else if(address<0x6000)this.ramBank=value;}
      if(cmd===0xd1)this.flash(view.getUint32(1),packet[5]);
      if(cmd===0xd4)for(let i=0;i<packet[2];i++)this.flash(view.getUint32(3+i*6),view.getUint16(7+i*6));
      if(cmd===0xb1){const address=this.address();if(this.variables[1][1]===3 || this.variables[1][8])this.push(this.ram.subarray(this.ramBank*8192+address-0xa000,this.ramBank*8192+address-0xa000+size));else this.push(this.readROM(address,size));this.variables[4][0]=address+size;continue;}
      if(cmd===0xb3){const offset=this.ramBank*8192+this.address()-0xa000;this.ram.set(packet.subarray(1),offset);this.variables[4][0]+=size;this.writes++;}
      if(cmd===0xd3){this.rom.set(packet.subarray(1),this.offset());if(this.corruptProgram)this.rom[this.offset()+size-1]^=1;this.variables[4][0]+=size;this.writes++;}
      if(cmd===0xd5){const crc=(crc32(this.readROM(this.address(),view.getUint32(1))) ^ (this.badCRC ? 1 : 0))>>>0;this.push([(crc>>>24)&255,(crc>>>16)&255,(crc>>>8)&255,crc&255]);continue;}
      this.push([1]);
    }
    return data.length;
  }
}
