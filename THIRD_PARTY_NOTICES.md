# Procedencia y referencias

La implementación JavaScript de este proyecto fue escrita para FlashGBX Pocket. El protocolo y comportamiento de cartuchos se estudiaron en:

- **FlashGBX / Lesserkuma**, GPL-3.0: https://github.com/Lesserkuma/FlashGBX, commit `e4467d79635d868f780d099112e55c65118dec58`. Referencias: `LK_Device.py`, `hw_GBFlash.py`, `hw_GBxCartRW.py`, `Mapper.py`. El texto de licencia incluido procede de este repositorio.
- **FlashGBX LK Firmware / Lesserkuma**, GPL-3.0: https://github.com/Lesserkuma/FlashGBX_LK_Firmware, commit `c04c4b285dc0c6b200a1030451970c1bffed6a1d`. Referencias: comandos L15, tamaños, endianidad, ACKs y variables de `LK.h`, implementación en `LK.c`, ejemplo `example.py` y plantilla `LK_device.h`.
- **Linux CH341 driver**, https://github.com/torvalds/linux/blob/master/drivers/usb/serial/ch341.c. Referencia del protocolo de registros: reloj de 48 MHz, divisor y bit de paquetes cortos según versión. Se usan constantes para tres velocidades exactas; no se incorpora el driver C ni su algoritmo general.
- **usb-serial-for-android / mik3y**, https://github.com/mik3y/usb-serial-for-android/blob/master/usbSerialForAndroid/src/main/java/com/hoho/android/usbserial/driver/Ch34xSerialDriver.java. Referencia adicional de configuración CH340.
- **Chrome WebUSB**: https://developer.chrome.com/docs/capabilities/usb
- **Chrome Web Serial**: https://developer.chrome.com/docs/capabilities/serial
- **Google Web Serial polyfill**: https://github.com/google/web-serial-polyfill. Consultado para establecer que implementa CDC ACM; no se distribuye ni se usa como controlador CH340.

El ejemplo visual y los datos de demostración son originales y ficticios. No se distribuyen ROMs comerciales. Las constantes de logo de cabecera en las pruebas y el parser se usan para reconocer el formato GB.

- Decodificación de logos GB/GBC y GBA: formatos y algoritmo de referencia en `RomFileDMG.py` y `RomFileAGB.py` de [FlashGBX](https://github.com/Lesserkuma/FlashGBX), GPL-3.0; Huffman GBA basado en la referencia de Winter1760 citada allí. Se renderizan los bytes del cartucho, sin una imagen de logo prefijada. Las pruebas incluyen los bytes estándar de cabecera GBA documentados en [ezgba](https://github.com/langest/ezgba/blob/master/src/tools/gba.py).

- `dist/config/db_DMG.json`: base de datos GB/GBC de [FlashGBX/config/db_DMG.json](https://github.com/Lesserkuma/FlashGBX/blob/master/FlashGBX/config/db_DMG.json), distribuida con FlashGBX (GPL-3.0). Copia de `master` descargada el 2026-10-27; 3.130 entradas; SHA-256 del archivo: `5583b8972dbafc1b9b75493df4134f44fce247c8e512b2db3a8d4cacf65f8ea8`. Se consulta localmente por SHA-1 de los primeros 384 bytes para obtener nombre y código de producto. No se utiliza para cambiar comandos, voltajes ni algoritmos de escritura.

## Motor original en WebAssembly

- `dist/engine/flashgbx.zip` contiene las fuentes y recursos originales de **FlashGBX 5.1**, GPL-3.0-or-later, snapshot `Lesserkuma-FlashGBX-e4467d7` (commit `e4467d79635d868f780d099112e55c65118dec58`). Incluye su archivo LICENSE. SHA-256 del paquete: `11d66ea5516c603eb6085790fdcc22ba2fce13003b9bd097d57806fbd149039b`. Código y perfiles: https://github.com/Lesserkuma/FlashGBX. El adaptador de navegador se distribuye por separado en `dist/engine/adapter.py`; las fuentes originales no se parchean.
- `dist/vendor/pyodide/`: **Pyodide 314.0.7**, MPL-2.0; licencia incluida en `LICENSE`. Código y versiones: https://github.com/pyodide/pyodide/tree/314.0.7. Runtime obtenido del paquete NPM oficial `pyodide@314.0.7`.
- Dependencias Pyodide incluidas: Pillow 12.2.0, python-dateutil 2.9.0.post0, six 1.17.0 y packaging 26.1. Los wheels mantienen sus licencias en los directorios `*.dist-info/licenses` o sus archivos equivalentes. Los SHA-256 se verificaron contra `pyodide-lock.json` antes de incorporarlos. Se cargan desde el mismo origen de la aplicación, sin descargar paquetes desde terceros durante una sesión de usuario.
