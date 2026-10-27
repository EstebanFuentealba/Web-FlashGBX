import { requestTransport } from './lib/transport.js';
import { LKDevice } from './lib/lk.js';
import { CartridgeService, sizeLabel } from './lib/cartridge.js';
import { renderLogo } from './lib/logo.js';
import { createDemo } from './lib/demo.js';

const $ = id => document.getElementById(id);
let lk = null, transport = null, service = null, cart = null, busy = false, demo = false;
let toolsEngine = null;
let controller = null, wakeLock = null, pendingRestore = null, backupReady = false;
const logs = [], urls = [];
let transferStarted = 0, transferTimer = null;
function elapsed() {
  const seconds = (performance.now() - transferStarted) / 1000;
  $('transfer-elapsed').textContent = `${Math.floor(seconds)} s`;
  return seconds;
}

function log(message) {
  logs.push(`${new Date().toLocaleTimeString('es-CL')}  ${message}`);
  if (logs.length > 150) logs.shift();
  $('log').textContent = logs.join('\n');
}
function message(text, error = false) {
  $('message').textContent = text; $('message').classList.toggle('error', error); $('message').hidden = !text;
}
function updateControls() {
  const connected = !!service, locked = busy || $('restore-dialog').open || $('engine-prompt').open;
  for (const id of ['reader-model','transport']) $(id).disabled = connected || locked;
  for (const id of ['console','gba-size']) $(id).disabled = !connected || locked;
  $('connect').disabled = locked || demo;
  $('connect').textContent = connected && !demo ? 'Disconnect' : 'Connect';
  $('inspect').disabled = !connected || locked || !['DMG','AGB'].includes($('console').value);
  $('demo').disabled = connected || locked;
  $('exit-demo').disabled = busy;
  $('verify').disabled = locked;
  $('save-type').disabled = locked || !service?.isFullEngine;
  $('cart-profile').disabled = locked || !service?.isFullEngine || !$('console').value;
  for (const id of ['read-rtc','edit-rtc','erase-save','dump-report']) $(id).disabled = locked || !service?.isFullEngine || !cart;
  $('firmware-update').disabled = locked || !service?.isFullEngine || lk?.info?.name !== 'GBFlash';
  for (const id of ['load-engine','camera-extract','convert-isx','engine-execute','engine-file','include-rtc','chip-erase','engine-options']) $(id).disabled = locked;
  const selected = connected && ['DMG','AGB'].includes($('console').value) && !locked;
  for (const id of ['inspect','analyze','backup-rom','backup-save','write-rom','restore']) $(id).disabled = !selected;
  $('connection-badge').textContent = demo ? 'DEMOSTRACIÓN' : connected ? 'CONECTADO' : 'SIN CONEXIÓN';
  $('connection-badge').classList.toggle('connected', connected && !demo);
  $('device-led').classList.toggle('on', connected && !demo);
  $('demo-banner').hidden = !demo;
  $('power-notice').hidden = demo || !service || lk?.info?.powerControl !== false;
  for (const radio of document.querySelectorAll('input[name=platform]')) { radio.disabled = !connected || locked; radio.checked = radio.value === $('console').value; }
  $('cartridge-title').textContent = `${$('console').value === 'AGB' ? 'Game Boy Advance' : 'Game Boy'} Cartridge Information`;
  $('system-badge').hidden = !cart;
  $('system-badge').textContent = cart?.system === 'Game Boy Color' ? 'CGB' : cart?.mode === 'AGB' ? 'AGB' : 'DMG';
  $('cart-empty').hidden = !!cart; $('cart-info').hidden = !cart;
  $('gba-size-field').hidden = !$('console').value || (!service?.isFullEngine && $('console').value !== 'AGB');
  $('mode-hint').textContent = $('console').value === 'AGB' ? 'GBA · 3,3 V. Analyze Flash Cart detecta el chip y el tipo de partida.' : $('console').value === 'DMG' ? 'Game Boy / Color · 5 V. Usa Analyze Flash Cart para identificar el perfil de programación.' : 'Selecciona la plataforma antes de alimentar el cartucho.';
}
function showCart() {
  for (const id of ['cart-name','rom-title','cart-code','cart-rtc','cart-logo','cart-checksum','rom-checksum','cart-rom','cart-save','cart-mapper','rom-verification']) {
    $(id).textContent = '—'; $(id).classList.remove('valid');
  }
  if (cart) {
    $('rom-title').textContent = cart.title;
    const header = cart.header;
    $('cart-code').textContent = cart.productCode ? `${cart.productCode}-${cart.revision}` : `Desconocido · revisión ${cart.revision ?? '?'}`;
    if (header && cart.mode === 'DMG') {
      $('rom-checksum').textContent = `0x${((header[0x14e] << 8) | header[0x14f]).toString(16).toUpperCase().padStart(4,'0')}`;
    }
    $('cart-rtc').textContent = cart.rtc ? 'Presente · lectura no disponible' : 'No disponible';
    renderLogo($('cart-logo'), header, cart.mode);
    const checksumValid=!cart.engine || cart.details.header_checksum_correct;
    $('cart-checksum').textContent = header && !demo ? `${checksumValid ? 'Valid' : 'Invalid'} (0x${header[cart.mode === 'AGB' ? 0xbd : 0x14d].toString(16).toUpperCase().padStart(2, '0')})` : 'Demo';
    if (header && !demo && checksumValid) $('cart-checksum').classList.add('valid');
    $('cart-system').textContent = cart.system;
    $('cart-name').textContent = cart.gameName || cart.title;
    $('cart-rom').textContent = sizeLabel(cart.romSize);
    $('cart-save').textContent = cart.ramSize ? sizeLabel(cart.ramSize) : 'Sin RAM';
    $('cart-mapper').textContent = cart.mapper || 'No soportado';
    $('cart-note').textContent = cart.unsupported || (demo ? 'Cartucho ficticio. Los archivos de demostración no contienen un juego.' : cart.rtc ? (cart.rtcString || 'RTC disponible; se incluye en la partida cuando la opción está activada.') : cart.mode === 'AGB' ? 'ROM lineal. Confirma el tamaño elegido antes de respaldar.' : lk?.info?.powerControl ? 'Cartucho identificado. El lector queda apagado entre operaciones.' : 'Cartucho identificado. Desconecta el cable USB antes de retirar o cambiar el cartucho.');
  }
  updateControls();
}
function progress(value, label, bytes) {
  $('transfer').hidden = false; $('progress').value = value;
  $('progress-value').textContent = `${Math.round(value * 100)}%`;
  $('transfer-title').textContent = label;
  if (transferStarted) {
    const seconds = elapsed();
    if (Number.isFinite(bytes) && !demo) {
      $('transfer-bytes').textContent = sizeLabel(Math.round(bytes));
      $('transfer-rate').textContent = seconds > 0 ? `${(bytes / seconds / 1024).toFixed(2)} KiB/s` : '—';
    }
  }
}
async function holdScreen() {
  if (!navigator.wakeLock || document.visibilityState !== 'visible') return;
  try { wakeLock = await navigator.wakeLock.request('screen'); }
  catch { log('No se pudo mantener la pantalla encendida. Mantén Chrome en primer plano.'); }
}
async function releaseScreen() { try { await wakeLock?.release(); } catch {} wakeLock = null; }
async function run(label, work, { transferWork = false } = {}) {
  if (busy) return;
  busy = true; controller = new AbortController(); updateControls(); message(''); log(label);
  if (transferWork) {
    transferStarted = performance.now(); $('transfer-bytes').textContent = '—'; $('transfer-rate').textContent = '—';
    progress(0, label); transferTimer = setInterval(elapsed, 500);
    $('cancel').hidden = false; $('cancel').disabled = false;
  }
  try {
    // USB chooser must be called before any await that would consume user activation.
    if (transferWork) await holdScreen();
    const result = await work(controller.signal);
    for (const file of service?.takeFiles?.() || []) await addDownload(file.data,file.name,'FlashGBX 5.1');
    log(`${label}: completado.`);
    if (transferWork) { progress(1, 'Operación completada'); $('cancel').disabled = true; }
    return result;
  } catch (error) {
    const cancelled = error.name === 'AbortError' || error.name === 'NotFoundError';
    const explanation = error.name === 'NotFoundError' ? 'No se seleccionó un lector.' : error.name === 'SecurityError' ? 'Chrome no pudo acceder al USB. Abre la URL directamente por HTTPS y comprueba los permisos.' : error.message;
    for (const file of service?.takeFiles?.() || []) await addDownload(file.data,file.name,'Respaldo conservado tras error');
    message(explanation, !cancelled); log(`Interrumpido: ${explanation}`);
    if (transferWork) { $('transfer-title').textContent = cancelled ? 'Operación cancelada' : 'Operación interrumpida'; $('cancel').disabled = true; }
    if (lk?.poisoned || transport?.closed) await disconnect();
    return null;
  } finally { if (transferWork) { clearInterval(transferTimer); elapsed(); transferStarted = 0; } await releaseScreen(); busy = false; controller = null; updateControls(); }
}
async function disconnect() {
  try { await service?.close?.(); await lk?.close(); if (!lk) await transport?.close(); }
  finally {
    lk = null; transport = null; service = null; cart = null; demo = false;
    $('console').value = '';
    $('device-name').textContent = 'GBFlash'; $('device-detail').textContent = 'USB OTG · Firmware L15';
    showCart();
  }
}
function objectFile(data, filename, type = 'application/octet-stream') {
  const url = URL.createObjectURL(new Blob([data], { type })); urls.push(url);
  return { url, filename };
}
function safeName(value) { return value.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 60) || 'cartucho'; }
async function addDownload(data, filename, label) {
  const file = objectFile(data, filename);
  const digest = globalThis.crypto?.subtle ? Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', data)), b => b.toString(16).padStart(2, '0')).join('') : 'No disponible en este contexto';
  const item = document.createElement('div'); item.className = 'download-item';
  const details = document.createElement('div'), title = document.createElement('strong'), meta = document.createElement('p'), hash = document.createElement('p');
  title.textContent = filename; meta.textContent = `${sizeLabel(data.length)} · ${label}`; hash.textContent = `SHA-256: ${digest}`;
  details.append(title, meta, hash);
  const link = document.createElement('a'); link.className = 'button secondary'; link.href = file.url; link.download = filename; link.textContent = 'Descargar ↓';
  item.append(details, link); $('download-list').prepend(item); $('downloads').hidden = false;
  return file;
}
$('connect').addEventListener('click', () => run(service ? 'Desconectando' : 'Conectando lector', async () => {
  document.querySelector('.options').open = false;
  if (service) { await disconnect(); return; }
  try {
    transport = await requestTransport($('transport').value);
    await transport.open(Number($('reader-model').value));
    lk = new LKDevice(transport);
    const info = await lk.identify(); service = new CartridgeService(lk);
    if (globalThis.crossOriginIsolated) {
      await toolsEngine?.close(); toolsEngine=null;
      const {EngineCartridgeService} = await import('./lib/engine-service.js');
      service = await EngineCartridgeService.connect(lk,{baud:Number($('reader-model').value),onLog:log,onPrompt:askEngine,settings:engineSettings,onEngineProgress:event => {
        if (event.abortable === false) $('cancel').disabled = true;
      }});
      $('engine-status').textContent = `FlashGBX ${service.capabilities.version} · ${service.capabilities.profiles.DMG} perfiles GB/GBC · ${service.capabilities.profiles.AGB} perfiles GBA`;
      populateEngineControls();
    } else if (typeof Worker !== 'undefined') throw new Error('El motor completo requiere aislamiento de origen. Recarga la app desde su URL principal con COOP/COEP.');
    $('device-name').textContent = info.name;
    $('device-detail').textContent = `L${info.version} · PCB ${info.pcb} · ${transport.label}`;
    log(`Identificado ${info.name}, firmware L${info.version}, PCB ${info.pcb}, ${$('reader-model').value} baud. Control de alimentación: ${info.powerControl ? 'sí' : 'no'}. Flags: 0x${info.flags.toString(16)}.`);
    message('Lector conectado. Elige Game Boy o Game Boy Advance para identificar el cartucho automáticamente.');
  } catch (error) { await disconnect(); throw error; }
}));
async function identifyCartridge() {
  cart = null; showCart();
  if (!service || !['DMG','AGB'].includes($('console').value)) throw new Error('Conecta el lector y selecciona una plataforma.');
  cart = await service.inspect($('console').value, Number($('gba-size').value)); showCart(); populateEngineControls();
  if (cart.metadataStatus === 'unavailable') log('No se pudo consultar db_DMG.json; se muestran los datos disponibles en la cabecera.');
  if (cart.unsupported) message(cart.unsupported, true);
  else message(`${cart.title} identificado. ${demo ? 'Datos de demostración.' : 'Listo para respaldar.'}`);
}
function inspectCartridge() { return run('Identificando cartucho', identifyCartridge); }
function requireCartridge({save = false} = {}) {
  if (!cart) throw new Error('No se pudo identificar el cartucho. Comprueba la inserción y pulsa Refresh.');
  if (cart.unsupported) throw new Error(cart.unsupported);
  if (save && !service?.isFullEngine && (cart.mode !== 'DMG' || !cart.ramSize)) throw new Error(cart.mode === 'AGB' ? 'Las partidas GBA aún no están implementadas.' : 'Este cartucho no tiene memoria de partida compatible.');
  return cart;
}
$('inspect').addEventListener('click', inspectCartridge);
$('console').addEventListener('change', inspectCartridge);
$('gba-size').addEventListener('change', () => {
  if (service?.isFullEngine && cart) { cart.romSize=Number($('gba-size').value); showCart(); return; }
  return inspectCartridge();
});
for (const radio of document.querySelectorAll('input[name=platform]')) radio.addEventListener('change', () => {
  if (!service || busy) return;
  $('console').value = radio.value; return inspectCartridge();
});
$('analyze').addEventListener('click', () => run('Analizando flashcart', async signal => {
  if (!service?.isFullEngine) throw new Error('Conecta un lector para analizar el chip con FlashGBX.');
  const result = await service.analyze(cart,{signal,onProgress:progress});
  cart=result.cart; showCart(); populateEngineControls();
  $('flash-analysis').textContent=JSON.stringify(result.analysis,null,2); $('flash-analysis').hidden=false; $('engine-tools').open=true;
  message(result.analysis.profile ? 'Flashcart identificado. Revisa el perfil seleccionado antes de programar.' : 'No hay un perfil de flashcart identificado automáticamente. Revisa los identificadores y CFI del análisis.');
}, {transferWork:true}));
$('write-rom').addEventListener('click', () => {
  if (!service?.isFullEngine) { message('Conecta un lector para programar ROMs con FlashGBX.',true); return; }
  if (Number($('cart-profile').value)<=0) { message('Ejecuta Analyze Flash Cart o selecciona el perfil de programación del cartucho.',true); return; }
  $('rom-file').value=''; $('rom-file').click();
});
$('rom-file').addEventListener('change', () => run('Preparando programación de ROM', async () => {
  const file=$('rom-file').files[0]; if (!file) return;
  const profile=service.profiles[cart.mode].find(p => p.index===Number($('cart-profile').value));
  if (profile.size && file.size>profile.size) throw new Error('La ROM excede la capacidad del perfil seleccionado.');
  if (file.size<1024) throw new Error('La ROM debe tener al menos 1 KiB.');
  pendingRestore={kind:'rom',data:new Uint8Array(await file.arrayBuffer()),name:file.name,cart:{...cart,romSize:profile.size || cart.romSize}};
  showRestoreDialog(`Programar ${file.name} (${sizeLabel(file.size)}) en ${profile.name} · ${profile.voltage} V. Se borrará y reemplazará la ROM del cartucho.`,true);
}));
$('backup-rom').addEventListener('click', () => run('Respaldando ROM', async signal => {
  requireCartridge();
  const data = await service.backupROM(cart, { signal, onProgress: (p, label, bytes) => progress(p, label, bytes ?? p * cart.romSize * ($('verify').checked ? 2 : 1)), verify: $('verify').checked });
  $('rom-verification').textContent = demo ? 'Demo' : $('verify').checked ? 'Two reads match' : 'Single read';
  $('rom-verification').classList.toggle('valid', !demo && $('verify').checked);
  const ext = demo ? 'bin' : cart.mode === 'AGB' ? 'gba' : cart.system === 'Game Boy Color' ? 'gbc' : 'gb';
  await addDownload(data, `${demo ? 'DEMO_' : ''}${safeName(cart.title)}.${ext}`, demo ? 'Datos ficticios' : $('verify').checked ? 'Dos lecturas coinciden' : 'Una lectura · sin verificación');
  message('Respaldo preparado. Toca Descargar en «Tus respaldos» para guardarlo en el teléfono.');
}, { transferWork: true }));
$('backup-save').addEventListener('click', () => run('Respaldando partida', async signal => {
  requireCartridge({save:true});
  const data = await service.backupSave(cart, { signal, onProgress: (p, label, bytes) => progress(p, label, bytes ?? p * cart.ramSize * 2) });
  await addDownload(data, `${demo ? 'DEMO_' : ''}${safeName(cart.title)}_${Date.now()}.sav`, demo ? 'Datos ficticios' : service.isFullEngine ? 'FlashGBX · RTC según opción' : 'Dos lecturas coinciden · sin RTC');
  message('Partida verificada y preparada. Toca Descargar para conservar el archivo.');
}, { transferWork: true }));
$('cancel').addEventListener('click', () => { controller?.abort(); $('cancel').disabled = true; $('transfer-title').textContent = 'Terminando el bloque actual…'; });
$('restore').addEventListener('click', () => {
  try {
    requireCartridge({save:true});
    if (demo) throw new Error('La demostración no escribe partidas en hardware.');
    $('save-file').value = ''; $('save-file').click();
  } catch (error) { message(error.message, true); }
});
$('save-file').addEventListener('change', () => run('Preparando restauración', async () => {
  const file = $('save-file').files[0]; if (!file) return;
  const data=new Uint8Array(await file.arrayBuffer());
  if (service.isFullEngine) await service.validateSave(data);
  if (!service.isFullEngine && file.size !== cart.ramSize) throw new Error(`Tamaño incorrecto: el archivo tiene ${file.size} bytes y el cartucho necesita ${cart.ramSize}. No se escribió nada.`);
  pendingRestore = { kind:'save',data, name:file.name, cart };
  showRestoreDialog(`${file.name} · ${file.size} bytes → ${cart.title}. El archivo debe pertenecer a este juego; el tamaño por sí solo no lo garantiza.`);
}));
function showRestoreDialog(description,rom=false) {
  backupReady = false; $('restore-consent').checked = false; $('restore-consent').disabled = true;
  $('prepare-restore').disabled = false; $('confirm-restore').disabled = true; $('pre-backup-link').hidden = true; $('restore-status').textContent = '';
  $('restore-heading').textContent=rom ? 'La ROM del cartucho será reemplazada.' : 'Tu partida actual será reemplazada.';
  $('restore-instructions').textContent=rom ? 'Primero lee y descarga la ROM actual. Después podrás programar el archivo seleccionado, con verificación de lectura posterior.' : 'Primero lee y descarga una copia de la partida actual. Después podrás escribir el archivo seleccionado.';
  $('confirm-restore').textContent=rom ? '2. Programar ROM y verificar' : '2. Restaurar y verificar';
  $('restore-description').textContent=description;
  $('restore-dialog').showModal(); updateControls();
}
$('restore-dialog').addEventListener('cancel', event => { if (busy) event.preventDefault(); });
$('restore-dialog').addEventListener('close', () => { pendingRestore = null; backupReady = false; updateControls(); });
$('prepare-restore').addEventListener('click', async () => {
  $('prepare-restore').disabled = true; $('dismiss-restore').disabled = true;
  $('restore-status').textContent = 'Leyendo y verificando la partida actual…';
  const result = await run('Respaldo antes de restaurar', async signal => {
    const data = await service[pendingRestore.kind==='rom' ? 'backupROM' : 'backupSave'](pendingRestore.cart, { signal, verify:true, onProgress: (p, label, bytes) => { progress(p, label, bytes); $('restore-status').textContent = `${label} · ${Math.round(p * 100)} %`; } });
    const file = await addDownload(data, `${safeName(cart.title)}_ANTES_${Date.now()}.${pendingRestore.kind==='rom' ? cart.mode==='AGB' ? 'gba' : 'gb' : 'sav'}`, 'Respaldo previo verificado');
    $('pre-backup-link').href = file.url; $('pre-backup-link').download = file.filename; $('pre-backup-link').hidden = false;
    $('restore-status').textContent = 'Respaldo listo. Descárgalo antes de continuar.'; return true;
  }, { transferWork: true });
  if (!result) $('restore-status').textContent = $('message').textContent;
  $('prepare-restore').disabled = !!result || !service; $('dismiss-restore').disabled = false;
});
$('pre-backup-link').addEventListener('click', () => { backupReady = true; $('restore-consent').disabled = false; });
$('restore-consent').addEventListener('change', () => { $('confirm-restore').disabled = !backupReady || !$('restore-consent').checked || !service || busy; });
$('confirm-restore').addEventListener('click', async () => {
  if (!backupReady || !$('restore-consent').checked || !pendingRestore || busy) return;
  const restore = pendingRestore;
  $('restore-dialog').close();
  await run(restore.kind==='rom' ? 'Programando ROM' : 'Restaurando partida', async signal => {
    // Once writing begins, cancellation is disabled to avoid a deliberately partial save.
    $('cancel').hidden = true;
    try { await service[restore.kind==='rom' ? 'writeROM' : 'restoreSave'](restore.cart, restore.data, { signal, filename:restore.name, onProgress: progress }); }
    catch (error) { throw new Error(`${error.message} La restauración puede haber quedado incompleta; conserva el respaldo previo.`); }
    message(restore.kind==='rom' ? 'ROM programada y verificada por FlashGBX. Pulsa Refresh para releer la cabecera.' : 'Partida restaurada. La lectura posterior coincide byte por byte con el archivo.');
    if (restore.kind==='rom') { cart=null; showCart(); }
  }, { transferWork: true });
});
function engineSettings() {
  return {...JSON.parse($('engine-options').value || '{}'),profile:Number($('cart-profile').value) || 0,saveType:$('save-type').value || 'auto',rtc:$('include-rtc').checked,chipErase:$('chip-erase').checked};
}
function populateEngineControls() {
  if (!service?.isFullEngine) return;
  const mode=$('console').value;
  if (!mode) return;
  const profile=$('cart-profile'), save=$('save-type');
  const changed=save.dataset.mode!==mode;
  const previous=changed ? 'auto' : save.value;
  profile.replaceChildren();
  for (const item of service.profiles[mode] || []) {
    const option=document.createElement('option'); option.value=item.index; option.textContent=item.name; profile.append(option);
  }
  profile.value=String(cart?.profile || 0);
  const rom=$('gba-size'); rom.replaceChildren();
  for (const size of service.capabilities.romSizes[mode]) { const option=document.createElement('option');option.value=size;option.textContent=sizeLabel(size);rom.append(option); }
  rom.value=String(cart?.romSize || 33554432);
  save.replaceChildren();
  const auto=document.createElement('option'); auto.value='auto'; auto.textContent=`Auto · ${cart?.ramSize ? sizeLabel(cart.ramSize) : 'sin detectar'}`; save.append(auto);
  for (const item of service.capabilities.saveTypes[mode]) {
    const option=document.createElement('option'); option.value=item.value; option.textContent=`${item.name}${item.size ? ' ('+sizeLabel(item.size)+')' : ''}`; save.append(option);
  }
  save.dataset.mode=mode; save.value=previous; save.hidden=false;
  $('rtc-values').value=JSON.stringify(cart?.rtcDict || {},null,2); updateControls();
}
$('save-type').addEventListener('change', () => {
  if (!service?.isFullEngine || !cart) return;
  const selected=service.capabilities.saveTypes[cart.mode].find(item => String(item.value)===$('save-type').value);
  if (selected) cart.ramSize=selected.size;
  showCart();
});
function askEngine(value) {
  return new Promise(resolve => {
    const dialog=$('engine-prompt'), reconnect=value.user_action==='RECONNECT_USB';
    if (service) service.awaitingReconnect=reconnect;
    $('engine-prompt-title').textContent=value.title || 'FlashGBX'; $('engine-prompt-text').textContent=value.msg || '';
    $('engine-prompt-ok').textContent=reconnect ? 'Reconectar USB' : 'Continuar';
    const finish=answer => { dialog.close(); if (service) service.awaitingReconnect=false; resolve(answer); };
    $('engine-prompt-cancel').onclick=() => finish(false);
    dialog.oncancel=event => {event.preventDefault();finish(false);};
    $('engine-prompt-ok').onclick=async () => {
      if (!reconnect) {finish(true);return;}
      try {
        const replacement=await requestTransport($('transport').value);
        await replacement.open(Number($('reader-model').value));
        transport=replacement; lk.transport=replacement; service.engine.transport=replacement; finish(true);
      } catch(error) { $('engine-prompt-text').textContent=error.message; }
    };
    dialog.showModal();
  });
}
async function getToolsEngine() {
  if (service?.isFullEngine) return service.engine;
  if (!toolsEngine) {
    const {FlashGBXEngine}=await import('./lib/engine.js');
    toolsEngine=await new FlashGBXEngine(null,{onLog:log,onPrompt:askEngine}).start();
  }
  return toolsEngine;
}
async function tool(action,args={},needsFile=false) {
  const engine=await getToolsEngine(), files=[];
  if (needsFile) {
    const file=$('engine-file').files[0];
    if (!file) throw new Error('Selecciona primero un archivo de trabajo.');
    const extension=file.name.split('.').pop().toLowerCase().replace(/[^a-z0-9]/g,'') || 'bin';
    const name=`input.${extension}`; files.push({name,data:new Uint8Array(await file.arrayBuffer())}); args.path=`/data/${name}`;
  }
  const result=service?.isFullEngine ? await service.execute(action,args,files) : await engine.execute(action,args,files);
  if (result.cart) {cart=result.cart;showCart();populateEngineControls();}
  for (const file of result.files || []) await addDownload(file.data,file.name,'FlashGBX 5.1');
  return result;
}
$('load-engine').addEventListener('click', () => run('Cargando herramientas FlashGBX',async () => {
  document.querySelector('.options').open=false; $('engine-tools').open=true;
  const engine=await getToolsEngine(); $('engine-status').textContent=`FlashGBX ${engine.capabilities.version} · motor local WebAssembly`;
}));
$('read-rtc').addEventListener('click', () => run('Leyendo RTC',() => tool('read-rtc')));
$('edit-rtc').addEventListener('click', () => run('Escribiendo RTC',async () => {
  const rtcDict=JSON.parse($('rtc-values').value);
  if (!await askEngine({title:'Escribir RTC',msg:JSON.stringify(rtcDict,null,2)})) return;
  return tool('write-rtc',{confirmed:true,rtcDict});
}));
$('erase-save').addEventListener('click', () => run('Borrando partida',async () => {
  const data=await service.backupSave(cart,{onProgress:progress});
  await addDownload(data,`${safeName(cart.title)}_ANTES_BORRAR.sav`,'Respaldo previo');
  if (!await askEngine({title:'Borrar partida',msg:'La partida del cartucho será borrada. El respaldo anterior está disponible en Tus respaldos. Descárgalo antes de continuar.'})) return;
  $('cancel').disabled=true;
  return tool('erase-save',{confirmed:true});
},{transferWork:true}));
$('dump-report').addEventListener('click', () => run('Generando informe',() => tool('dump-report')));
$('camera-extract').addEventListener('click', () => run('Extrayendo fotos Game Boy Camera',() => tool('camera-extract',{palette:$('camera-palette').value},true)));
$('convert-isx').addEventListener('click', () => run('Convirtiendo ISX',() => tool('convert-isx',{},true)));
$('engine-execute').addEventListener('click', () => run('Ejecutando consola FlashGBX',async () => {
  const result=await tool('console',{code:$('engine-code').value},!!$('engine-file').files[0]);
  $('engine-output').textContent=result.output+(result.result==null ? '' : '\n'+JSON.stringify(result.result,null,2));
}));
$('firmware-update').addEventListener('click', () => run('Actualizando firmware GBFlash',async () => {
  const file=$('engine-file').files[0];
  if (!file || !file.name.toLowerCase().endsWith('.zip')) throw new Error('Selecciona el ZIP de firmware GBFlash correspondiente al lector.');
  if (!await askEngine({title:'Actualizar firmware GBFlash',msg:`Se programará ${file.name} en ${lk.info.name}, PCB ${lk.info.pcb}. Mantén el USB conectado hasta terminar.`})) return;
  $('cancel').disabled=true;
  const result=await tool('firmware-gbflash',{confirmed:true},true);
  if (result.reconnect) {await disconnect();message('Firmware actualizado. Desconecta físicamente el USB y vuelve a conectar el lector.');}
},{transferWork:true}));
$('demo').addEventListener('click', () => {
  document.querySelector('.options').open = false;
  const d = createDemo(); demo = true; service = d.service;
  $('console').value = ''; cart = null; showCart(); $('device-name').textContent = d.info.name; $('device-detail').textContent = 'Simulación local · sin hardware';
  message('Esta demostración genera archivos ficticios. Selecciona Game Boy o Game Boy Advance para explorar.'); updateControls();
});
$('exit-demo').addEventListener('click', async () => { await disconnect(); message('Demostración cerrada. Puedes conectar tu lector.'); });
document.addEventListener('click', event => {
  const options = document.querySelector('.options');
  if (!options.contains(event.target)) options.open = false;
});
document.addEventListener('keydown', event => { if (event.key === 'Escape') document.querySelector('.options').open = false; });
$('export-log').addEventListener('click', () => {
  const content = `FlashGBX Pocket 0.1.0\n${navigator.userAgent}\nSecure: ${isSecureContext}\nWebUSB: ${!!navigator.usb}\nWebSerial: ${!!navigator.serial}\n\n${logs.join('\n')}`;
  const file = objectFile(content, 'flashgbx-diagnostico.txt', 'text/plain');
  const a = document.createElement('a'); a.href = file.url; a.download = file.filename; a.click();
});
navigator.usb?.addEventListener('disconnect', event => {
  if (service?.awaitingReconnect) return;
  if (event.device === transport?.device) { controller?.abort(); void disconnect(); message('Se desconectó el USB. Si estabas restaurando una partida, puede haber quedado incompleta.', true); log('Desconexión física del USB.'); }
});
document.addEventListener('visibilitychange', () => { if (busy && document.visibilityState === 'visible') void holdScreen(); });
window.addEventListener('beforeunload', event => { if (busy) { event.preventDefault(); event.returnValue = ''; } });
window.addEventListener('pagehide', () => { void service?.close?.(); void toolsEngine?.close(); void lk?.close(); for (const url of urls) URL.revokeObjectURL(url); });
if (!isSecureContext) { $('environment').textContent = 'El acceso USB necesita HTTPS. HTTP solo funciona en localhost para desarrollo.'; $('environment').classList.add('error'); }
else if (!navigator.usb && !navigator.serial) { $('environment').textContent = 'Este navegador no ofrece acceso USB. Abre la página en Chrome para Android o explora la demostración.'; }
else if (window.self !== window.top) { $('environment').textContent = 'Para conectar el lector, abre esta página directamente en una pestaña de Chrome.'; }
else { $('environment').textContent = 'Para Android: Chrome + adaptador USB OTG. GBFlash debe tener L15 instalado. No se modifica el firmware.'; }
if (!/Android/i.test(navigator.userAgent) && navigator.serial) $('transport').value = 'serial';
updateControls();
