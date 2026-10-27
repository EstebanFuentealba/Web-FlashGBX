// SPDX-License-Identifier: GPL-3.0-or-later
// Cartridge bitmap formats documented by FlashGBX RomFileDMG/RomFileAGB.
export function decodeLogo(header, mode) {
  if (mode === 'DMG') {
    if (header.length < 0x134) throw new Error('Logo GB incompleto.');
    const pixels = new Uint8Array(48 * 8), bytes = header.subarray(0x104, 0x134);
    for (let y = 0; y < 8; y++) for (let x = 0; x < 48; x++) {
      const byte = bytes[Math.floor(y / 4) * 24 + Math.floor(x / 4) * 2 + (y >> 1 & 1)];
      pixels[y * 48 + x] = byte >> ((y & 1 ? 0 : 4) + 3 - x % 4) & 1;
    }
    return { width: 48, height: 8, pixels };
  }
  if (mode !== 'AGB' || header.length < 0xa0) throw new Error('Logo GBA incompleto.');
  const tree = [0x40,0,0,0,1,0x81,0x82,0x82,0x83,0x0f,0x83,0x0c,0xc3,3,0x83,1,0x83,4,0xc3,8,0x0e,2,0xc2,0x0d,0xc2,7,0x0b,6,0x0a,5,9];
  const stream = Uint8Array.from([0x24,0xd4,0,0,tree.length / 2,...tree,...header.subarray(4,0xa0)]);
  const unpacked = new Uint8Array(212);
  let node = 5, nibble = 0;
  for (let offset = 6 + stream[4] * 2; offset + 1 < stream.length && nibble < 424; offset += 4) {
    const other = offset ^ 2;
    const word = ((stream[other] | stream[other + 1] << 8) << 16) | stream[offset] | stream[offset + 1] << 8;
    for (let bit = 31; bit >= 0 && nibble < 424; bit--) {
      const branch = word >>> bit & 1, descriptor = stream[node];
      if (node < 5 || node >= 5 + tree.length) throw new Error('Arbol del logo GBA inválido.');
      node = (node & ~1) + (descriptor & 63) * 2 + 2 + branch;
      if (descriptor & (branch ? 0x40 : 0x80)) {
        if (node >= 5 + tree.length) throw new Error('Logo GBA inválido.');
        unpacked[nibble >> 1] |= (stream[node] & 15) << ((nibble & 1) * 4);
        nibble++; node = 5;
      }
    }
  }
  if (nibble !== 424) throw new Error('Logo GBA truncado.');
  const size = unpacked[1] | unpacked[2] << 8 | unpacked[3] << 16;
  if (unpacked[0] !== 0x82 || size !== 208) throw new Error('Filtro del logo GBA inválido.');
  const bitmap = new Uint8Array(208);
  let previous = 0;
  for (let i = 0; i < 208; i += 2) {
    previous = (previous + unpacked[i + 4] + (unpacked[i + 5] << 8)) & 0xffff;
    bitmap[i] = previous & 255; bitmap[i + 1] = previous >> 8;
  }
  const pixels = new Uint8Array(104 * 16);
  for (let y = 0; y < 16; y++) for (let x = 0; x < 104; x++) {
    pixels[y * 104 + x] = bitmap[(y >> 3) * 104 + (x >> 3) * 8 + y % 8] >> (x % 8) & 1;
  }
  return { width: 104, height: 16, pixels };
}

export function renderLogo(container, header, mode) {
  container.replaceChildren();
  if (!header) { container.textContent = '—'; return; }
  try {
    const {width,height,pixels} = decodeLogo(header, mode);
    const canvas = document.createElement('canvas');
    canvas.width = width; canvas.height = height;
    canvas.setAttribute('role','img'); canvas.setAttribute('aria-label','Boot logo leído del cartucho');
    const context = canvas.getContext('2d');
    context.fillStyle = '#d8d8d8';
    pixels.forEach((pixel, i) => { if (pixel) context.fillRect(i % width, Math.floor(i / width), 1, 1); });
    container.append(canvas);
  } catch { container.textContent = 'Logo no decodificable'; }
}
