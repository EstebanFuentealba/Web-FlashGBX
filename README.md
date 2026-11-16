# FlashGBX Pocket

Cliente web para GBFlash/GBxCart RW con firmware LK L15. Ejecuta el motor original de **FlashGBX 5.1 dentro del navegador**, mediante Pyodide/WebAssembly y un Web Worker. No necesita servidor Python, aplicación de escritorio ni backend de procesamiento. Android usa WebUSB/CH340; el escritorio puede usar Web Serial.

Los recursos de Python, sus dependencias, el código fuente de FlashGBX, las bases de datos y los perfiles se sirven con la aplicación. Las ROMs, partidas y fotos se procesan en memoria local y no se envían a un servicio externo. El espacio de trabajo se pierde al recargar: descarga los archivos que quieras conservar.

## Funciones

| Función | Implementación |
| --- | --- |
| Identificación | `ReadHeader` original; nombre, código y revisión, cabecera, logo, mapper y RTC |
| Analyze Flash Cart | Detección original de identificadores, CFI, perfiles, capacidad y tipo de partida |
| Backup ROM | Motor original GB/GBC/GBA, mappers y perfiles; segunda lectura opcional e informe de dump |
| Write ROM | Perfil elegido o detectado, respaldo previo descargable, confirmación y verificación posterior |
| Partidas | SRAM, EEPROM, Flash y tipos especiales GB/GBC/GBA del motor; selección automática/manual |
| RTC | Lectura, edición de registros y anexado a respaldos según opción |
| Batteryless SRAM | Región detectada o `bl_offset`, `bl_size`, `bl_layout` en opciones avanzadas |
| Erase Save Data | Respaldo anterior y confirmación; algoritmos originales de memoria |
| Game Boy Camera | Extracción local de 32 imágenes en ZIP con las seis paletas originales |
| ISX | Conversión local a ROM GB |
| Informes | Informe original de dump y diagnóstico del cliente |
| Firmware GBFlash | Actualizador original con ZIP proporcionado por el usuario |
| Consola | Python del motor: `device`, `header`, `profiles`, `DMG_Mapper`, `PocketCamera`; exportación de archivos |

Se incluyen **169 perfiles GB/GBC y 97 GBA**, además del perfil de cartucho ROM genérico. Las reglas y algoritmos de cartuchos se ejecutan desde el código original empaquetado en `dist/engine/flashgbx.zip`; no se reimplementan como respuestas simuladas a los botones.

El alcance de hardware del transporte de esta aplicación continúa siendo **GBFlash/GBxCart RW por CH340/LK L15**. Incluir los módulos de Joey Jr y Game Bub en el paquete de fuentes no equivale a haber implementado sus transportes USB. Las ventanas nativas Qt se sustituyen por la interfaz web; no se ejecutan en Android. No se declara paridad física validada con todos los cartuchos, lectores o perfiles de FlashGBX de escritorio.

## Uso

1. Inserta el cartucho con el USB físicamente desconectado.
2. Abre la aplicación directamente por HTTPS en Chrome; en Android usa un adaptador USB OTG y cable de datos.
3. En Options elige lector y transporte. GBFlash usa 2 Mbaud; en macOS se recomienda 1 Mbaud para GBxCart RW.
4. Pulsa Connect y concede acceso al lector. La primera conexión carga el motor WebAssembly.
5. Elige Game Boy (5 V) o Game Boy Advance (3,3 V). La información aparece automáticamente.
6. Usa Analyze Flash Cart para detectar el chip, tipo de partida y perfil de programación. Revisa Profile y Save Type; ambos permiten selección manual.
7. Usa Backup ROM o Backup Save Data y descarga el archivo de Tus respaldos.
8. Write ROM y Write Save Data requieren crear y descargar un respaldo previo y confirmar el reemplazo. La verificación posterior de escritura está activada.
9. En Herramientas de FlashGBX están RTC, borrado de partida, informes, Camera, conversión ISX, consola y firmware GBFlash.
10. Desconecta físicamente el USB antes de cambiar el cartucho. Algunas revisiones mantienen la alimentación al cerrar la conexión; la interfaz lo indica.

La consola trabaja sobre el mismo motor y dispositivo. Los archivos de entrada se cargan como `/data/input.<extensión>`. Guarda resultados como `/data/export-<nombre>` para ofrecerlos como descargas. Las opciones avanzadas aceptan JSON, por ejemplo `{"bl_offset":"0xFC0000","bl_size":"0x10000","bl_layout":0}`. Los cambios de mapper se indican con `mbc` y no se deducen del nombre de un archivo.

## Requisitos del navegador y alojamiento

Se requiere Chrome con WebUSB en Android, contexto seguro y `SharedArrayBuffer`. La aplicación sirve estos encabezados para que Python pueda esperar respuestas serie dentro de un worker sin bloquear la interfaz:

```text
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
Cross-Origin-Resource-Policy: same-origin
Permissions-Policy: usb=(self), serial=(self)
```

Sirve el directorio `dist/` completo, incluido `engine/` y `vendor/`. No basta con copiar los HTML/JS principales. El paquete estático ocupa aproximadamente 16 MiB. Los encabezados están en `dist/_headers`; el servidor de desarrollo también los añade. No uses la aplicación dentro de un iframe.

## Desarrollo

Usa Node 22 o superior; la validación del motor WebAssembly se ejecuta con Node 24.

```sh
npm run check
npm test
npm run dev
```

El servidor escucha en `http://localhost:4173`; puedes cambiar el puerto con `PORT=4174 npm run dev`. Desde Android conectado por ADB:

```sh
adb reverse tcp:4173 tcp:4173
```

Abre `http://localhost:4173` en Chrome del teléfono. HTTP sobre una IP de LAN no habilita WebUSB.

## GitHub Pages

En el repositorio de GitHub, abre **Settings → Pages** y elige **GitHub Actions** como origen. El workflow `.github/workflows/pages.yml` ejecuta las pruebas y publica `dist/` al hacer push a `main`. También puedes iniciarlo manualmente desde **Actions → Deploy to GitHub Pages** en `main`.

Abre la URL HTTPS que muestra el despliegue directamente en Chrome. En la primera visita, la página se recarga al activarse el service worker que añade los encabezados de aislamiento requeridos por el motor WebAssembly.

## Cloudflare

`wrangler.jsonc` publica `dist/` como Worker Static Assets. No hay un backend Python.

```sh
npm ci
npm run cf:whoami
npm run deploy:check
npm run deploy
```

Publicar no está incluido en una prueba local. La antigua metadata de Sites en `.openai/hosting.json` no se utiliza con Wrangler.

## Arquitectura y pruebas

- `dist/lib/transport.js`: WebUSB/CH340, Web Serial y cola de bytes. Las lecturas cortas de pyserial pueden expirar sin desincronizar la sesión.
- `dist/lib/engine.js`: RPC y memoria compartida entre el transporte real y Python.
- `dist/engine/worker.js`: runtime WebAssembly, archivos y ejecución en un worker.
- `dist/engine/adapter.py`: adaptación de pyserial y operaciones del motor original.
- `dist/lib/engine-service.js`: integración con los botones de la interfaz.
- `dist/engine/source.json`: procedencia, versión y SHA-256 del paquete original.
- `test/engine.test.js`: ejecuta FlashGBX original en WebAssembly con un simulador independiente de L15/NOR; ROM, SRAM, detección, programación, CRC32 y Camera.
- `test/worker.test.js`: ejecuta el worker real y el enlace de memoria compartida; incluye fallo de verificación y recuperación del respaldo anterior.

También se prueban USB, fragmentación, timeouts, bancos de mapper, errores de cabecera, logos, metadatos y estados de interfaz. La carga del motor y la consola se comprueban en el navegador. **Falta validar las nuevas operaciones con un GBFlash físico y Android.** El hecho de reutilizar el motor de escritorio no demuestra que cada combinación de chip, perfil y revisión física funcione en este transporte.

Mantén Chrome en primer plano durante las operaciones. Una desconexión o cierre durante una escritura puede dejar datos parciales; conserva el respaldo anterior. No se reintenta una operación completa de escritura automáticamente desde la interfaz.

## Licencias

GPL-3.0-or-later para este cliente y FlashGBX. Pyodide se distribuye con su licencia MPL-2.0 y las dependencias contienen sus licencias dentro de los wheels. Consulta [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md), `dist/vendor/pyodide/LICENSE` y el código fuente completo empaquetado en `dist/engine/flashgbx.zip`.
