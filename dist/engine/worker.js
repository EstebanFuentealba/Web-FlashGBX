// SPDX-License-Identifier: GPL-3.0-or-later
import { loadPyodide } from '../vendor/pyodide/pyodide.mjs';
let python, control, bytes;
function io(op, value = {}) {
  Atomics.store(control,0,0);
  postMessage({type:'io',op,...value});
  const deadline = op === 'prompt' ? Infinity : performance.now() + Math.max(15000,(value.timeout || 0) + 5000);
  while (Atomics.load(control,0) === 0) {
    if (performance.now() > deadline) throw new Error('El transporte no respondió. Reconecta el lector.');
    Atomics.wait(control,0,0,1000);
  }
  if (Atomics.load(control,0) < 0) throw new Error('La transferencia USB falló. Reconecta el lector.');
  return Atomics.load(control,1);
}
self.onmessage = async event => {
  const request = event.data;
  try {
    if (request.type === 'init') {
      control = new Int32Array(request.control); bytes = new Uint8Array(request.bytes);
      postMessage({type:'log',text:'Cargando FlashGBX 5.1 en WebAssembly…'});
      const runtimeRoot=new URL('../vendor/pyodide/',import.meta.url);
      python = await loadPyodide({indexURL:runtimeRoot.protocol==='file:' ? decodeURIComponent(runtimeRoot.pathname) : runtimeRoot.href,
        stdout:text => postMessage({type:'log',text}), stderr:text => postMessage({type:'log',text})});
      await python.loadPackage(['pillow','python-dateutil','packaging']);
      const archive = await fetch(new URL('./flashgbx.zip',import.meta.url));
      if (!archive.ok) throw new Error('No se pudo cargar el motor FlashGBX.');
      python.unpackArchive(await archive.arrayBuffer(),'zip',{extractDir:'/app'});
      python.FS.mkdirTree('/data');
      python.registerJsModule('browser_io', {
        read:(size,timeout) => { const n=io('read',{size,timeout}); return bytes.slice(0,n); },
        write:value => { const data=Uint8Array.from(value.toJs()); return io('write',{data}); },
        waiting:() => io('waiting'), reset:() => io('reset'),
        ask:value => io('prompt',{value:JSON.parse(value)}) === 1,
        cancelled:() => Atomics.load(control,2) === 1,
        emit:value => postMessage({type:'progress',value:JSON.parse(value)}),
      });
      const source = await fetch(new URL('./adapter.py',import.meta.url));
      if (!source.ok) throw new Error('No se pudo cargar el adaptador del motor.');
      await python.runPythonAsync(await source.text());
      const result=JSON.parse(python.runPython('capabilities_json()'));
      postMessage({id:request.id,result}); return;
    }
    if (!python) throw new Error('Motor no inicializado.');
    if (['write-rom','restore-save','erase-save'].includes(request.action)) for (const name of python.FS.readdir('/data').filter(name=>name.startsWith('before-write.'))) python.FS.unlink('/data/'+name);
    for (const file of request.files || []) {
      if (!/^[a-zA-Z0-9_.-]+$/.test(file.name)) throw new Error('Nombre de archivo inválido.');
      python.FS.writeFile('/data/'+file.name,file.data);
    }
    python.globals.set('request_json',JSON.stringify({action:request.action,args:request.args}));
    const result = JSON.parse(python.runPython('dispatch_json(request_json)'));
    const transfers=[];
    result.files=(result.files || []).map(file => {
      const data=python.FS.readFile(file.path); transfers.push(data.buffer);
      return {name:file.name,data};
    });
    postMessage({id:request.id,result},transfers);
  } catch (error) {
    const files=[];
    if (python && request.type==='execute') for (const name of python.FS.readdir('/data').filter(name => name.startsWith('before-write.'))) {
      const data=python.FS.readFile('/data/'+name); files.push({name,data});
    }
    postMessage({id:request.id,error:error.message || String(error),files},files.map(file=>file.data.buffer));
  }
};
