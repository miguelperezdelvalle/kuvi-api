# Copias operativas de PostgreSQL — Kuvi

Estado al 25 de noviembre de 2026: respaldo cifrado diario activo en Ubuntu y recogida automática en el PC del propietario. Primera copia real transferida, comprobada y restaurada en una base aislada. El destino provisional fue elegido expresamente por el propietario. La base activa y los expedientes no fueron modificados para probar la recuperación. No se imprimieron datos clínicos ni credenciales.

## Qué se copia y qué permanece cifrado

Se exporta la base completa, con estructura, datos, restricciones, índices y migraciones, mediante pg_dump en formato custom. El dump se transmite directamente a GnuPG: no se escribe una exportación sin cifrar en el servidor durante el respaldo. Solo se publica el archivo final después de que ambas herramientas terminen correctamente, se vacíe el archivo y se publique su manifiesto técnico con SHA-256, tamaño, fecha y versión.

El respaldo operativo contiene los datos que PostgreSQL ya almacena: cuentas, hashes de contraseñas, sesiones, permisos, datos clínicos y sobres de documentos. El cifrado propio de los documentos permanece intacto: la clave operativa de respaldo no permite abrir los documentos del paciente. No se copian claves de documentos, frases de recuperación, archivos privados de GnuPG o SSH, ni el archivo .env. El código se conserva en Git. Después de una pérdida total habrá que configurar de nuevo las credenciales de infraestructura y del servicio.

El servidor tiene PostgreSQL 16.15 en un contenedor, pero el host ofrecía herramientas 18.6. Se copiaron pg_dump y pg_restore 16.15 desde la imagen que ya ejecuta la base a /home/miguel/.local/lib/kuvi-pg16. Antes de exportar, el programa comprueba que la versión mayor del cliente coincide con la base. Una actualización de PostgreSQL requiere actualizar estas herramientas y repetir la restauración de prueba.

Referencias: [pg_dump 16](https://www.postgresql.org/docs/16/app-pgdump.html), [pg_restore 16](https://www.postgresql.org/docs/16/app-pgrestore.html), [cifrado de clave pública de GnuPG](https://www.gnupg.org/documentation/manuals/gnupg/Operational-GPG-Commands.html). La exportación lógica es una base inicial para este piloto: no incorpora archivo continuo de WAL ni recuperación a cualquier instante.

## Horarios y retención

- Ubuntu: cron del usuario miguel, diariamente a las 03:30, America/Mexico_City. Se conserva cualquier entrada anterior ajena al bloque marcado de Kuvi. No necesita sesión SSH abierta ni linger del gestor de servicios del usuario.
- Windows: tarea Kuvi-DatabaseBackup-Pull, con el usuario propietario y privilegio limitado. Se ejecuta al iniciar sesión y cada hora, con red disponible, inicio diferido si se perdió una ejecución y sin ejecuciones simultáneas.
- El PC debe estar encendido, con sesión iniciada y conexión por Tailscale. No es un destino permanente disponible las 24 horas. Si está apagado o sin conexión, las copias siguen acumulándose en Ubuntu y se recogen después.
- Servidor: se mantienen como mínimo las siete copias más recientes. Solo se eliminan copias de más de 14 días que tengan confirmación previa de copia fuera del servidor. El recibo se emite después de comprobar hash, tamaño y vaciado en el PC. Los archivos sin recibo, las copias recientes y cualquier archivo de otro formato se conservan.
- PC: no hay borrado automático. Esta decisión conserva el historial mientras se elige un destino permanente y se define su capacidad y retención. El recibo acredita una comprobación anterior, no prueba que nadie haya borrado después la copia del PC.
- El objetivo inicial es una exportación diaria, con pérdida potencial de hasta 24 horas antes de una avería del servidor. La copia externa puede ser más antigua si el PC está apagado. No equivale a una garantía de recuperación continua o de disponibilidad.

Los tres archivos antiguos encontrados en /home/miguel/kuvi-backups se conservaron intactos, sin inspeccionar ni publicar su contenido. La nueva rutina utiliza otra carpeta y no los incluye en la limpieza.

## Rutas y comandos

Servidor:

- Programa: /home/miguel/kuvi-api/ops/backup.mjs y backup-core.mjs.
- Configuración privada: /home/miguel/.config/kuvi-backup/config.json, modo 0600.
- Clave pública: /home/miguel/.config/kuvi-backup/public-keyring, modo 0700. La operación rechaza una bóveda GnuPG que contenga claves privadas.
- Copias: /home/miguel/kuvi-postgres-backups, modo 0700; archivos y manifiestos 0600.
- Registro del cron: /home/miguel/.config/kuvi-backup/daily.log. Solo fecha y estados técnicos; los errores de las herramientas no se vuelcan para evitar exponer SQL o conexión.

```sh
cd /home/miguel/kuvi-api
node ops/backup.mjs run /home/miguel/.config/kuvi-backup/config.json
node ops/backup.mjs list /home/miguel/.config/kuvi-backup/config.json
node ops/backup.mjs prune /home/miguel/.config/kuvi-backup/config.json
node --test tests/backup.test.mjs
node tests/backup-failures.integration.mjs /home/miguel/.config/kuvi-backup/config.json
```

Windows:

- Copias cifradas: C:\Users\migue\Documents\KuviBackups.
- Programa, configuración y estado: C:\Users\migue\.kuvi-backup.
- Último resultado: last-pull.json. La tarea de Windows también conserva su último código de salida.
- La carpeta de copias y la de operación restringen su acceso al usuario y SYSTEM.

```powershell
& "$env:USERPROFILE\.kuvi-backup\Invoke-KuviBackupPull.ps1"
Get-ScheduledTaskInfo -TaskName 'Kuvi-DatabaseBackup-Pull'
```

El receptor compara el archivo existente antes de aceptarlo y no sustituye una copia distinta. Una transferencia incompleta utiliza un nombre temporal y solo se publica tras comprobar su hash y tamaño. No se borra ningún archivo local para recoger copias nuevas.

## Custodia de la clave operativa

La clave privada RSA-3072 se generó en este PC, con vencimiento de dos años. Está protegida por una contraseña aleatoria de 256 bits, guardada mediante DPAPI para este usuario de Windows. No se transmitió a Ubuntu. La copia exportada operator-secret-protected.asc, dentro de KuviBackups\Recovery, también está protegida por esa contraseña. La pública se importó al servidor y su huella está fijada en la configuración.

Por ahora, la operación de descifrado depende de conservar este perfil de Windows. Antes de cambiar o reinstalar Windows, hay que custodiar una copia portable de la clave y su contraseña fuera del PC. Se preparó Export-KuviBackupRecovery.ps1 para que el propietario las exporte a una carpeta externa elegida sin imprimir la contraseña. Todavía no se ha realizado esa custodia física externa. No confundir esta contraseña operativa con el archivo y las seis palabras de recuperación del paciente.

```powershell
# Ejecutar solo después de elegir una carpeta externa existente y protegida.
& "$env:USERPROFILE\.kuvi-backup\Export-KuviBackupRecovery.ps1" -Destination 'RUTA_ABSOLUTA_DEL_DESTINO'
```

Este comando produce la clave protegida y un archivo separado con su contraseña. El destino debe proteger ambos materiales; no deben compartirse por chat. No se ha programado ni ejecutado esta exportación hacia un destino desconocido.

## Restauración y comprobación

La prueba no sobreescribe una base existente. Primero se comprueba el SHA-256 del archivo cifrado en Windows, se descifra con la clave privada local a una carpeta temporal restringida y se espera la terminación correcta de GnuPG antes de usar el resultado. Esto evita ejecutar una exportación que no haya pasado la comprobación criptográfica. La exportación temporal contiene la base operativa legible, pero los documentos mantienen su cifrado propio.

El archivo se copia por SSH a la carpeta privada restore-check y se compara su hash de nuevo. verify-restore genera un nombre kuvi_restore_check_UUID y utiliza el propietario permanente NOLOGIN kuvi_restore_owner, sin privilegios administrativos. Revoca el acceso público y ejecuta pg_restore con ese rol, transacción única y salida inmediata ante un error. No acepta un nombre de base de destino proporcionado por el operador, ni utiliza --clean o --create. El origen del archivo debe ser la copia propia comprobada: una exportación SQL es código ejecutable y no debe usarse una de procedencia desconocida.

La comprobación exige tablas y migraciones aplicadas y revisa por páginas que el contenido cifrado de cada DocumentBackup tenga el tamaño y SHA-256 almacenados. Nunca solicita claves del paciente ni descifra sus documentos. Al terminar, elimina la base temporal y el archivo de prueba del servidor; el propietario NOLOGIN se conserva para las siguientes comprobaciones; la exportación temporal local también se elimina. La copia cifrada original permanece en ambos equipos.

```sh
node ops/backup.mjs verify-restore /home/miguel/.config/kuvi-backup/config.json restore-check-UUID.dump SHA256_DEL_ARCHIVO_DESCIFRADO
```

Ante un desastre real, restaurar primero en una instancia aislada y comprobarla antes de cambiar la conexión de la aplicación. La copia no recupera cambios posteriores a su fecha. Antes de abrir el servicio, invalidar las sesiones y enlaces compartidos restaurados y revisar las autorizaciones de pacientes y médicos: volver a una copia antigua también puede volver al estado anterior de una revocación. No se automatizó ningún cambio de sesiones, permisos, citas o prescripciones en la base activa.

## Validación y límites pendientes

- Seis pruebas unitarias: formatos y límites, credenciales por entorno, directorios privados y enlaces, verificación de inventario y recibos, retención y rechazo de destinos de restauración inseguros.
- Cuatro escenarios de fallo: cliente de otra versión, exportación que falla, archivo que supera el límite y trabajo simultáneo bloqueado. No publican copias incompletas. Se corrigió que un segundo cierre EBADF impidiera retirar un temporal cifrado tras un error de stream.
- Prueba sintética completa: copia cifrada, transferencia y recibo, descifrado solo en Windows y restauración en otra base; coincidieron datos, hashes de las filas sembradas, documentos cifrados, 27 tablas y 13 migraciones. Las bases desechables se retiraron.
- Primera copia real: transferida con hash y tamaño correctos; autenticada en Windows, restaurada y comprobada en una base aislada con 27 tablas y 13 migraciones e integridad de todos los sobres de documentos. La base activa permaneció en su sitio.
- Tarea real de Windows ejecutada y recogida repetida sin duplicar archivos. La ejecución por horario se confirmó a las 03:30 del 25 de noviembre con la cuenta de solo lectura; Windows recogió la copia a las 03:32.

La recuperación operativa se exportó a una carpeta privada del PC y se compararon exactamente la clave y la contraseña con sus originales protegidos, sin imprimir valores. El propietario confirmó que la trasladó a la Caja fuerte de su NAS UGREEN. La transferencia y custodia en el NAS se aceptan por confirmación del propietario; no se verificaron automáticamente allí. La prueba adicional de descifrado con llavero nuevo quedó pendiente por rechazo de revisión automática. El 27 de noviembre se activó la transferencia horaria de los respaldos cifrados a una carpeta SMB del NAS y un monitor separado de las tareas de copia, con avisos de Windows confirmados por el propietario. Ambos requieren el PC encendido y su sesión iniciada: no constituyen supervisión siempre disponible. Queda pendiente independizar esa ejecución del PC. Véase backup-monitoring.md. La separación de permisos se aplicó después de este bloque: la aplicación usa kuvi_app sin superusuario, el respaldo usa kuvi_backup de solo lectura y la restauración kuvi_restore_operator con CREATEDB, sin CREATEROLE. Las credenciales están en perfiles distintos fuera del entorno del servicio. La comprobación aislada no crea roles; utiliza kuvi_restore_owner, permanente y NOLOGIN. Véase database-permissions.md.

Los scripts, pruebas y documentación no contienen configuraciones reales, claves, .env ni copias de la base. Los artefactos privados están fuera de Git. El bloque inicial de respaldos y permisos está publicado en el commit 1bcff54; la custodia confirmada en el NAS se documenta en el checkpoint posterior de despliegue.

Actualización del 27 de noviembre: el cron de las 03:30 usa ahora ops/backup-job.mjs, que conserva la exportación y retención existentes y escribe el estado de ejecución privado. Los comandos directos de backup.mjs siguen disponibles, pero no actualizan ese estado de trabajo programado. NAS y monitor local están documentados en backup-monitoring.md. El bloque está incluido en el checkpoint de monitor y transferencia directa NAS autorizado por el propietario.

Estado posterior del 27 de noviembre: la transferencia principal al NAS pasó a ser directa desde Ubuntu cada doce horas (03:38 y 15:38), mediante montaje SMB 3.1.1 cifrado y usuario estándar. Cinco respaldos verificados y cuota de 50 GiB visible. La laptop mantiene una copia adicional y sus notificaciones locales, pero ya no transporta los respaldos al NAS. Véase nas-direct.md; falta confirmar el primer disparo por horario del nuevo cron.
