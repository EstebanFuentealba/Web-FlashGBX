// Node-only harness for exercising the browser worker's exact RPC/SAB code.
import {parentPort,workerData} from 'node:worker_threads';
import {readFile} from 'node:fs/promises';
globalThis.self=globalThis;
globalThis.postMessage=(message,transfers)=>parentPort.postMessage(message,transfers);
globalThis.fetch=async input=>{
  const url=new URL(String(input));
  if(url.protocol!=='file:')throw new Error('Engine tests must stay offline');
  try {return new Response(new Uint8Array(await readFile(url)));}catch{return new Response('',{status:404});}
};
await import(workerData.url);
parentPort.on('message',data=>self.onmessage({data}));
