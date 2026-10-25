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
