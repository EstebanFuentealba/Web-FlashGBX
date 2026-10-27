import test from 'node:test';
import assert from 'node:assert/strict';
import {ByteQueue} from '../dist/lib/transport.js';
import {FlashGBXEngine} from '../dist/lib/engine.js';
test('serial short reads preserve the stream and late bytes for the next command',async () => {
 const queue=new ByteQueue();queue.push(Uint8Array.of(1,2));
 assert.deepEqual(await queue.readPartial(4,5),Uint8Array.of(1,2));assert.equal(queue.error,null);
 queue.push(Uint8Array.of(3));assert.deepEqual(await queue.read(1),Uint8Array.of(3));
 assert.deepEqual(await queue.readPartial(1,0),new Uint8Array());
});
test('shared USB bridge returns reads, writes and transport failures to its worker',async () => {
 const queue=new ByteQueue(), writes=[];
 const engine=new FlashGBXEngine({queue,write:async data=>writes.push(Array.from(data))});
 engine.control=new Int32Array(new SharedArrayBuffer(32));engine.bytes=new Uint8Array(new SharedArrayBuffer(65536));
 queue.push(Uint8Array.of(7,8));await engine.io({op:'read',size:2,timeout:5});
 assert.equal(Atomics.load(engine.control,0),1);assert.equal(Atomics.load(engine.control,1),2);assert.deepEqual(Array.from(engine.bytes.slice(0,2)),[7,8]);
 await engine.io({op:'write',data:Uint8Array.of(0xa1)});assert.deepEqual(writes,[[0xa1]]);
 queue.fail(new Error('unplugged'));await engine.io({op:'read',size:1,timeout:5});assert.equal(Atomics.load(engine.control,0),-1);
});
