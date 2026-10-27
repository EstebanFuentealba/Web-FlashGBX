import { requestTransport } from './lib/transport.js';
import { LKDevice } from './lib/lk.js';
import { CartridgeService, sizeLabel } from './lib/cartridge.js';
import { renderLogo } from './lib/logo.js';
import { createDemo } from './lib/demo.js';

const $ = id => document.getElementById(id);
let lk = null, transport = null, service = null, cart = null, busy = false, demo = false;
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
  const connected = !!service, locked = busy || $('restore-dialog').open;
  for (const id of ['reader-model','transport']) $(id).disabled = connected || locked;
  for (const id of ['console','gba-size']) $(id).disabled = !connected || locked;
  $('connect').disabled = locked || demo;
  $('connect').textContent = connected && !demo ? 'Disconnect' : 'Connect';
  $('inspect').disabled = !connected || locked || !['DMG','AGB'].includes($('console').value);
  $('demo').disabled = connected || locked;
  $('exit-demo').disabled = busy;
  $('verify').disabled = locked;
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
  $('gba-size-field').hidden = $('console').value !== 'AGB';
  $('mode-hint').textContent = $('console').value === 'AGB' ? 'GBA · 3,3 V. Selecciona el tamaño de ROM; partidas GBA aún no disponibles.' : $('console').value === 'DMG' ? 'Game Boy / Color · 5 V. Partidas SRAM y MBC2; el respaldo no incluye RTC.' : 'Selecciona la plataforma antes de alimentar el cartucho.';
}
function showCart() {
  for (const id of ['cart-name','rom-title','cart-code','cart-rtc','cart-logo','cart-checksum','rom-checksum','cart-rom','cart-save','cart-mapper','rom-verification']) {
    $(id).textContent = '—'; $(id).classList.remove('valid');
  }
  if (cart) {
    $('rom-title').textContent = cart.title;
    const header = cart.header;
    $('cart-code').textContent = cart.code ? `AGB-${cart.code}-${header?.[0xbc] ?? '?'}` : '—';
    if (header && cart.mode === 'DMG') {
      $('rom-checksum').textContent = `0x${((header[0x14e] << 8) | header[0x14f]).toString(16).toUpperCase().padStart(4,'0')}`;
      const code = new TextDecoder().decode(header.subarray(0x13f,0x143));
      if ((header[0x143] & 0x80) && /^[A-Z][A-Z0-9]{3}$/.test(code)) $('cart-code').textContent = `DMG-${code}-${header[0x14c]}`;
    }
    $('cart-rtc').textContent = cart.rtc ? 'Presente · lectura no disponible' : 'No disponible';
    renderLogo($('cart-logo'), header, cart.mode);
    $('cart-checksum').textContent = header && !demo ? `Valid (0x${header[cart.mode === 'AGB' ? 0xbd : 0x14d].toString(16).toUpperCase().padStart(2, '0')})` : 'Demo';
    if (header && !demo) $('cart-checksum').classList.add('valid');
    $('cart-system').textContent = cart.system;
    $('cart-name').textContent = cart.title;
    $('cart-rom').textContent = sizeLabel(cart.romSize);
    $('cart-save').textContent = cart.mode === 'AGB' ? 'No soportada' : cart.ramSize ? sizeLabel(cart.ramSize) : 'Sin RAM';
    $('cart-mapper').textContent = cart.mapper || 'No soportado';
    $('cart-note').textContent = cart.unsupported || (demo ? 'Cartucho ficticio. Los archivos de demostración no contienen un juego.' : cart.rtc ? 'El respaldo .sav contiene la partida; no incluye el reloj RTC.' : cart.mode === 'AGB' ? 'ROM lineal. Confirma el tamaño elegido antes de respaldar.' : lk?.info?.powerControl ? 'Cartucho identificado. El lector queda apagado entre operaciones.' : 'Cartucho identificado. Desconecta el cable USB antes de retirar o cambiar el cartucho.');
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
    log(`${label}: completado.`);
    if (transferWork) { progress(1, 'Operación completada'); $('cancel').disabled = true; }
    return result;
  } catch (error) {
    const cancelled = error.name === 'AbortError' || error.name === 'NotFoundError';
    const explanation = error.name === 'NotFoundError' ? 'No se seleccionó un lector.' : error.name === 'SecurityError' ? 'Chrome no pudo acceder al USB. Abre la URL directamente por HTTPS y comprueba los permisos.' : error.message;
    message(explanation, !cancelled); log(`Interrumpido: ${explanation}`);
    if (transferWork) { $('transfer-title').textContent = cancelled ? 'Operación cancelada' : 'Operación interrumpida'; $('cancel').disabled = true; }
    if (lk?.poisoned || transport?.closed) await disconnect();
    return null;
  } finally { if (transferWork) { clearInterval(transferTimer); elapsed(); transferStarted = 0; } await releaseScreen(); busy = false; controller = null; updateControls(); }
}
async function disconnect() {
  try { await lk?.close(); if (!lk) await transport?.close(); }
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
    $('device-name').textContent = info.name;
    $('device-detail').textContent = `L${info.version} · PCB ${info.pcb} · ${transport.label}`;
    log(`Identificado ${info.name}, firmware L${info.version}, PCB ${info.pcb}, ${$('reader-model').value} baud. Control de alimentación: ${info.powerControl ? 'sí' : 'no'}. Flags: 0x${info.flags.toString(16)}.`);
    message('Lector conectado. Elige Game Boy o Game Boy Advance para identificar el cartucho automáticamente.');
  } catch (error) { await disconnect(); throw error; }
}));
async function identifyCartridge() {
  cart = null; showCart();
  if (!service || !['DMG','AGB'].includes($('console').value)) throw new Error('Conecta el lector y selecciona una plataforma.');
  cart = await service.inspect($('console').value, Number($('gba-size').value)); showCart();
  if (cart.unsupported) message(cart.unsupported, true);
  else message(`${cart.title} identificado. ${demo ? 'Datos de demostración.' : 'Listo para respaldar.'}`);
}
function inspectCartridge() { return run('Identificando cartucho', identifyCartridge); }
function requireCartridge({save = false} = {}) {
  if (!cart) throw new Error('No se pudo identificar el cartucho. Comprueba la inserción y pulsa Refresh.');
  if (cart.unsupported) throw new Error(cart.unsupported);
  if (save && (cart.mode !== 'DMG' || !cart.ramSize)) throw new Error(cart.mode === 'AGB' ? 'Las partidas GBA aún no están implementadas.' : 'Este cartucho no tiene memoria de partida compatible.');
  return cart;
}
$('inspect').addEventListener('click', inspectCartridge);
for (const id of ['console','gba-size']) $(id).addEventListener('change', inspectCartridge);
for (const radio of document.querySelectorAll('input[name=platform]')) radio.addEventListener('change', () => {
  if (!service || busy) return;
  $('console').value = radio.value; return inspectCartridge();
});
$('analyze').addEventListener('click', () => {
  message('Analyze Flash Cart: la detección de chips flash y perfiles de programación aún no está implementada en este cliente. Refresh permite leer la cabecera del cartucho.');
});
$('write-rom').addEventListener('click', () => {
  message('Write ROM: la programación de flashcarts aún no está implementada en este cliente. Usa FlashGBX de escritorio para esta operación.');
});
$('backup-rom').addEventListener('click', () => run('Respaldando ROM', async signal => {
  requireCartridge();
  const data = await service.backupROM(cart, { signal, onProgress: (p, label) => progress(p, label, p * cart.romSize * ($('verify').checked ? 2 : 1)), verify: $('verify').checked });
  $('rom-verification').textContent = demo ? 'Demo' : $('verify').checked ? 'Two reads match' : 'Single read';
  $('rom-verification').classList.toggle('valid', !demo && $('verify').checked);
  const ext = demo ? 'bin' : cart.mode === 'AGB' ? 'gba' : cart.system === 'Game Boy Color' ? 'gbc' : 'gb';
  await addDownload(data, `${demo ? 'DEMO_' : ''}${safeName(cart.title)}.${ext}`, demo ? 'Datos ficticios' : $('verify').checked ? 'Dos lecturas coinciden' : 'Una lectura · sin verificación');
  message('Respaldo preparado. Toca Descargar en «Tus respaldos» para guardarlo en el teléfono.');
}, { transferWork: true }));
$('backup-save').addEventListener('click', () => run('Respaldando partida', async signal => {
  requireCartridge({save:true});
  const data = await service.backupSave(cart, { signal, onProgress: (p, label) => progress(p, label, p * cart.ramSize * 2) });
  await addDownload(data, `${demo ? 'DEMO_' : ''}${safeName(cart.title)}_${Date.now()}.sav`, demo ? 'Datos ficticios' : 'Dos lecturas coinciden · sin RTC');
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
  if (file.size !== cart.ramSize) throw new Error(`Tamaño incorrecto: el archivo tiene ${file.size} bytes y el cartucho necesita ${cart.ramSize}. No se escribió nada.`);
  pendingRestore = { data: new Uint8Array(await file.arrayBuffer()), name: file.name, cart };
  backupReady = false; $('restore-consent').checked = false; $('restore-consent').disabled = true;
  $('prepare-restore').disabled = false; $('confirm-restore').disabled = true; $('pre-backup-link').hidden = true; $('restore-status').textContent = '';
  $('restore-description').textContent = `${file.name} · ${file.size} bytes → ${cart.title}. El archivo debe pertenecer a este juego; el tamaño por sí solo no lo garantiza.`;
  $('restore-dialog').showModal();
}));
$('restore-dialog').addEventListener('cancel', event => { if (busy) event.preventDefault(); });
$('restore-dialog').addEventListener('close', () => { pendingRestore = null; backupReady = false; updateControls(); });
$('prepare-restore').addEventListener('click', async () => {
  $('prepare-restore').disabled = true; $('dismiss-restore').disabled = true;
  $('restore-status').textContent = 'Leyendo y verificando la partida actual…';
  const result = await run('Respaldo antes de restaurar', async signal => {
    const data = await service.backupSave(pendingRestore.cart, { signal, onProgress: (p, label) => { progress(p, label); $('restore-status').textContent = `${label} · ${Math.round(p * 100)} %`; } });
    const file = await addDownload(data, `${safeName(cart.title)}_ANTES_${Date.now()}.sav`, 'Respaldo previo verificado');
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
  await run('Restaurando partida', async signal => {
    // Once writing begins, cancellation is disabled to avoid a deliberately partial save.
    $('cancel').hidden = true;
    try { await service.restoreSave(restore.cart, restore.data, { signal, onProgress: progress }); }
    catch (error) { throw new Error(`${error.message} La restauración puede haber quedado incompleta; conserva el respaldo previo.`); }
    message('Partida restaurada. La lectura posterior coincide byte por byte con el archivo.');
  }, { transferWork: true });
});
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
  if (event.device === transport?.device) { controller?.abort(); void disconnect(); message('Se desconectó el USB. Si estabas restaurando una partida, puede haber quedado incompleta.', true); log('Desconexión física del USB.'); }
});
document.addEventListener('visibilitychange', () => { if (busy && document.visibilityState === 'visible') void holdScreen(); });
window.addEventListener('beforeunload', event => { if (busy) { event.preventDefault(); event.returnValue = ''; } });
window.addEventListener('pagehide', () => { void lk?.close(); for (const url of urls) URL.revokeObjectURL(url); });
if (!isSecureContext) { $('environment').textContent = 'El acceso USB necesita HTTPS. HTTP solo funciona en localhost para desarrollo.'; $('environment').classList.add('error'); }
else if (!navigator.usb && !navigator.serial) { $('environment').textContent = 'Este navegador no ofrece acceso USB. Abre la página en Chrome para Android o explora la demostración.'; }
else if (window.self !== window.top) { $('environment').textContent = 'Para conectar el lector, abre esta página directamente en una pestaña de Chrome.'; }
else { $('environment').textContent = 'Para Android: Chrome + adaptador USB OTG. GBFlash debe tener L15 instalado. No se modifica el firmware.'; }
if (!/Android/i.test(navigator.userAgent) && navigator.serial) $('transport').value = 'serial';
updateControls();
