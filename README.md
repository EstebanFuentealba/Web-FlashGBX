# FlashGBX Pocket

Cliente web independiente del protocolo FlashGBX LK L15. La interfaz reproduce la distribución de FlashGBX de escritorio: información del cartucho, funciones, estado de transferencia y barra de conexión. Conserva los nombres de funciones en inglés y los mensajes y ayuda en español; se adapta a pantallas de 390 px y superiores. Connect habilita los radios de plataforma; elegir uno lee automáticamente la cabecera y habilita los seis botones. Analyze Flash Cart y Write ROM muestran su limitación al pulsarlos, porque aún no están implementados. Las operaciones sin memoria de partida compatible también se explican al pulsarlas. El logo se decodifica desde la cabecera GB/GBC o GBA. Aplicación estática, sin dependencias de ejecución, backend, cuentas propias, telemetría ni subida de ROMs/partidas. Los recursos, el controlador y los datos se procesan en el navegador; el alojamiento puede tener su propia autenticación.

## Dispositivo objetivo

- **GBFlash, firmware L15, CH340 USB VID:PID `1A86:7523`, 2.000.000 baudios, 8N1.**
- Android con USB host/OTG, Chrome y cable de datos. Algunos teléfonos necesitan habilitar OTG.
- Se usa **WebUSB con un controlador CH340 propio**. El polyfill CDC ACM de Google no controla el CH340.
- El firmware se conserva. No se actualiza ni flashea el lector desde esta app.
- Se incluyen perfiles GBxCart RW a 1 y 1,5 Mbaud y Web Serial para escritorio; tampoco tienen validación física.
- Un controlador del sistema o una aplicación que reclame la interfaz USB puede impedir el acceso. No se garantiza compatibilidad con todos los teléfonos.

## Funciones implementadas

| Función | Alcance |
| --- | --- |
| Identificación | Firma L, versión exacta 15, nombre de lector y capacidades; admite revisiones con y sin control de alimentación |
| ROM GB/GBC | ROM sin mapper, MBC1 estándar, MBC2, MBC3 y MBC5; revisión de cabecera |
| ROM GBA | Cartuchos lineales de 1, 2, 4, 8, 16 y 32 MiB; tamaño elegido manualmente |
| Verificación de ROM | Segunda lectura opcional; activada por defecto; SHA-256 del archivo |
| Partidas GB/GBC | Lectura SRAM o MBC2 con segunda lectura obligatoria |
| Restauración GB/GBC | Archivo del tamaño exacto, respaldo previo descargable y confirmación; lectura posterior y comparación byte por byte |
| Alimentación | 5 V GB/GBC, 3,3 V GBA; apagado entre operaciones y autoapagado a 5 segundos cuando la placa lo permite; en otras revisiones se dejan las líneas de dirección como entradas y el cartucho sigue alimentado |
| Errores | Timeout, transferencia incompleta, ACK inválido y desconexión invalidan la sesión; no se reintentan escrituras automáticamente |
| Demostración | Datos ficticios, sin conexión al hardware; descargas marcadas DEMO |

**No implementado:** programación de ROMs en flashcarts, actualización de firmware, partidas GBA (SRAM/EEPROM/Flash), registros RTC, MBC1M y mappers especiales, cartuchos GBA con mapeo especial o autoidentificación del tamaño de ROM. La comparación de dos lecturas prueba consistencia, no autenticidad ni que el tamaño GBA seleccionado sea correcto. SHA-256 tampoco es una comparación contra una base de datos.

Los archivos MBC2 tienen 512 bytes con el nibble alto normalizado a `F`. Un `.sav` con RTC adicional no se acepta como archivo de SRAM exacto. El nombre y tamaño de un `.sav` no demuestran que pertenezca al juego: el usuario debe elegir el respaldo correcto.

## Uso desde Android

1. Asegúrate de que GBFlash tenga L15 instalado con la herramienta de escritorio correspondiente.
2. Inserta el cartucho con el lector desconectado.
3. Abre la URL HTTPS de la aplicación directamente en Chrome. Si el alojamiento es privado, inicia sesión con la cuenta propietaria.
4. Conecta el lector mediante OTG y toca **Conectar por USB**. El perfil predeterminado es GBFlash a 2 Mbaud.
5. Selecciona GB/GBC o GBA para identificar automáticamente el cartucho. La selección controla el voltaje, así que debe coincidir con el cartucho. Las revisiones sin control de alimentación muestran un aviso permanente: desconecta físicamente el USB antes de retirar o cambiar el cartucho; cerrar la conexión desde la app no corta la alimentación.
6. Usa **Refresh** si necesitas releer el cartucho, realiza el respaldo y toca **Descargar** para conservar el archivo.
7. Para restaurar una partida GB/GBC, selecciona un `.sav`. La app requiere leer y descargar un respaldo previo antes de habilitar la escritura. Conserva Chrome en primer plano y el cable conectado hasta terminar.
8. Desconecta el lector antes de retirar o cambiar el cartucho.

La lista de descargas vive en memoria y se vacía al recargar. Los archivos no se guardan automáticamente. No hay service worker: una nueva sesión necesita cargar la aplicación desde su alojamiento. El manifest permite acceso desde la pantalla de inicio donde Chrome lo admita, pero no se promete instalación/offline en todas las versiones.

## Desarrollo

Para desarrollo de la aplicación basta Node 20 o superior. Para publicar con la versión fijada de Wrangler, usa Node 22 o superior e instala las dependencias de desarrollo con `npm ci`. La aplicación desplegada no tiene dependencias externas de ejecución.

```sh
npm run check
npm test
npm run dev
```

El servidor escucha solo en `127.0.0.1:4173`. Para probar desde un teléfono conectado por ADB:

```sh
adb reverse tcp:4173 tcp:4173
```

Luego abre `http://localhost:4173` en Chrome del teléfono. No uses HTTP en una IP de LAN para WebUSB. Como alternativa, sirve `dist/` en un hosting HTTPS con `Permissions-Policy: usb=(self), serial=(self)` y abre la app como documento principal, no dentro de un iframe. Los headers para hosting estático compatible están en `dist/_headers`.

## Publicar en Cloudflare con Wrangler

El destino principal es un **Worker con Static Assets**: Wrangler publica únicamente `dist/` por HTTPS en `flashgbx-pocket.<subdominio-de-la-cuenta>.workers.dev`. No requiere un script Worker, una base de datos ni un proceso de build. La URL es pública; el acceso al USB sigue requiriendo permiso local en Chrome. Las ROMs y partidas permanecen en el navegador.

```sh
cd android-app # desde la raíz del repositorio
npm ci
npx wrangler login # solo cuando no haya una sesión válida
npm run cf:whoami
npm run deploy:check
npm run deploy
```

`wrangler.jsonc` configura el nombre, la fecha de compatibilidad y el directorio de assets. Si tienes varias cuentas, selecciona la cuenta al publicar o proporciona `CLOUDFLARE_ACCOUNT_ID` mediante una variable de entorno. No guardes tokens en los archivos del proyecto. `npm run cf:dev` prueba el mismo alojamiento de assets localmente en `http://localhost:8787`.

`dist/_headers` se procesa tanto en Workers Static Assets como en Pages. Incluye la política necesaria para WebUSB/Web Serial en el documento principal. Los archivos no encontrados devuelven 404; no se usa un fallback de SPA que pudiera ocultar un módulo JavaScript faltante.

Para usar **Pages** en lugar del Worker, crea un proyecto Pages y sube el mismo directorio, sin ejecutar además el despliegue del Worker:

```sh
npx wrangler pages project create flashgbx-pocket --production-branch main
npx wrangler pages deploy dist --project-name flashgbx-pocket --branch main
```

La metadata anterior en `.openai/hosting.json` pertenece al borrador sin publicar de Sites; no se utiliza ni se sube con Wrangler.

## Organización del código

- `dist/lib/transport.js`: cola de bytes, CH340/WebUSB y Web Serial; plazos y cierre de sesiones fallidas.
- `dist/lib/lk.js`: protocolo L15, comandos con ACK, variables big-endian, alimentación y operaciones de memoria.
- `dist/lib/cartridge.js`: cabeceras, mappers, respaldos y restauración verificada.
- `dist/app.js`: estado de interfaz, exclusión de operaciones, archivos locales y confirmación de restauración.
- `dist/lib/demo.js`: simulación visual separada del transporte real.
- `test/fixtures.js`: simulador independiente del firmware a nivel de comandos binarios.
- `test/core.test.js`: pruebas de protocolo, USB, bancos, verificación y fallos.

## Validación y límites

Las pruebas automatizadas cubren revisiones L15 sin control de alimentación (identificación, ROM, SRAM, cancelación y reposo), fragmentación de respuestas, bytes sobrantes, timeout, lectores concurrentes, configuración CH340, endpoints USB dinámicos, escrituras USB parciales, identificación L15, bancos MBC1 0x20/0x40/0x60, noveno bit de MBC5, SRAM de varios bancos, MBC2, cambio de cartucho, archivo incorrecto, corrupción en la escritura, dirección GBA en palabras, voltaje GBA, cancelación y ACK inválido. La demo permite comprobar el flujo visual y las descargas sin tocar hardware.

**Pendiente: pruebas físicas Android + GBFlash.** Antes de considerar este cliente equivalente a FlashGBX de escritorio, comprobar en hardware:

1. Identificación L15, versión de placa y apagado entre operaciones.
2. Respaldo de ROM y comparación SHA-256 contra un dump de FlashGBX de escritorio del mismo cartucho.
3. Partida GB/GBC: comparar contra respaldo de escritorio.
4. Restaurar en un cartucho de prueba, comparar la lectura posterior y abrir el juego en la consola.
5. Desconexiones, Android en segundo plano y alimentación con el teléfono concreto.

Un teléfono en suspensión puede detener las tareas del navegador. El bloqueo de pantalla se solicita cuando la API está disponible, pero no sustituye mantener la app abierta. Un cierre o desconexión durante restauración puede dejar la partida parcialmente escrita.

## Licencia y procedencia

GPL-3.0-or-later. Incluye `LICENSE`, y el texto se sirve en `dist/LICENSE.txt`. Ver [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md). Proyecto independiente; no es una versión oficial de Lesserkuma.
