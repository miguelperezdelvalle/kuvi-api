# Transferencia directa de Ubuntu al NAS — preparada

Estado: **activo y verificado**. Montaje CIFS real con SMB 3.1.1 cifrado, cinco respaldos y cinco manifiestos comprobados desde Ubuntu, segunda recogida sin duplicados y cron directo a las 03:38 y 15:38 America/Mexico_City. La capacidad visible del recurso confirma 50 GiB. La tarea Windows de transferencia al NAS quedó deshabilitada. No se expusieron contraseñas ni se modificó la API.

Como ajuste inmediato solicitado para el MVP, la transferencia existente desde Windows pasó a cada 12 horas, a las 03:38 y 15:38 America/Mexico_City. Se quitó su disparo al iniciar sesión; StartWhenAvailable conserva la recuperación de ejecuciones omitidas. El monitor mantiene su frecuencia horaria y conserva los umbrales del PC. Para el NAS se configuraron 15 horas de antigüedad máxima de transferencia y 14 horas de gracia de una copia nueva. Fallos y corrupción siguen siendo errores inmediatos. Quince pruebas del monitor aprobadas, incluido el nuevo intervalo; la tarea real fue inspeccionada con repetición PT12H y un único disparador temporal.

## Preparación necesaria en UGREEN

Crear un usuario estándar dedicado, por ejemplo `kuvi_backup`, y una carpeta **compartida** `KuviBackups`, con lectura/escritura para ese usuario y acceso limitado a ella. El recurso `personal_folder` depende de la identidad que entra y no garantiza el mismo directorio al utilizar una cuenta distinta. Las copias ya existentes en la carpeta personal se conservan; esta preparación no las mueve ni borra.

La cuenta de transferencia no debe acceder a la Caja fuerte ni a la recuperación operativa. Los archivos transferidos siguen cifrados mediante GPG antes de salir de Ubuntu. Se añade cifrado de transporte SMB 3.1.1 y no se copia la clave privada de los respaldos al servidor o a la carpeta compartida.

## Primer paso administrativo, tras crear usuario y recurso

Ejecutar desde la terminal habitual, sustituyendo IP, recurso y usuario si son distintos de los valores acordados:

```powershell
ssh -t kuvi-dev "sudo bash /home/miguel/kuvi-api/ops/setup-nas-direct.sh IP_DEL_NAS KuviBackups kuvi_backup"
```

Sudo pide la contraseña Ubuntu; el script pide después la contraseña del **usuario NAS** dos veces, sin eco. No se comparten en el chat. Si hace falta, instala `cifs-utils`. Crea un montaje automático de systemd bajo `/mnt/kuvi-nas` y una credencial root:root 0600 en un directorio 0700 `/etc/kuvi-nas`, sin incluir la contraseña en argumentos, Git o registros.

El montaje exige SMB 3.1.1 con `seal`, usa cache=none para comprobar la lectura desde el NAS y restringe acceso a miguel mediante uid/gid y modos 0700/0600. Es noexec, nosuid y nodev. No se modifica el servicio de la API. El acceso se monta bajo demanda; si el NAS no responde, no se permite escribir una copia silenciosamente en el directorio local subyacente.

El instalador rechaza rutas o archivos preexistentes para evitar reemplazar una preparación que necesita revisión. Si el primer montaje o copia falla, se conserva la configuración para inspeccionarla; no se debe volver a ejecutar el bootstrap sin revisar ese estado.

## Copia y comprobación

`nas-push.mjs` se ejecuta como miguel, utiliza los archivos cifrados existentes y el mismo bloqueo exclusivo de respaldo/retención. Comprueba el tipo de montaje, origen y opciones de protección antes de escribir. `nas-copy-core.mjs` publica las copias mediante archivos temporales, fuerza escritura, vuelve a leer y comparar SHA-256 y tamaño, conserva los manifiestos y solo después registra una confirmación que puede utilizar la retención de Ubuntu.

No sobrescribe deliberadamente archivos con contenido distinto, no sigue enlaces simbólicos de destino y no elimina copias existentes. Los archivos temporales creados por una copia fallida se limpian. El estado privado de la ejecución queda en `.config/kuvi-backup/last-nas-push.json`. La carpeta de destino prevista es `/mnt/kuvi-nas/database`, dentro del recurso nuevo.

## Activación y verificación completadas

El propietario creó la cuenta y el recurso compartido kuvi_backup, con cuota de 50 GiB, y ejecutó el instalador con sudo. La autenticación SMB funcionó; la copia inicial fue rechazada porque findmnt seleccionaba autofs en vez del CIFS montado en la misma ruta. Se corrigió el filtro a --types cifs y se añadió una prueba de regresión que distingue ambas capas y rechaza orígenes u opciones de protección distintos. No hizo falta volver a introducir la contraseña.

La primera copia directa publicó cinco respaldos y sus manifiestos. La segunda verificó cinco y copió cero. Se comprobaron ausencia de temporales, cuota visible de 50 GiB y salud de PostgreSQL (200). Se guardó el cron anterior y se añadió un bloque separado de transferencia directa cada doce horas, con timeout de cuarenta minutos. El respaldo de la base sigue siendo diario a las 03:30; verificar/transferir cada doce horas no genera una exportación nueva en cada transferencia.

El monitor recibe ahora el estado técnico de nas-push a través de backup-health.mjs, compara el manifiesto de la última copia comprobada con el respaldo más reciente y aplica los umbrales NAS de quince horas para transferencia y catorce de gracia de una copia nueva. La relectura del NAS la hace el trabajo directo cada doce horas; el observador de Windows consulta ese resultado y no vuelve a leer todos los bytes del NAS cada hora. La copia de la laptop se conserva como adicional, pero ya no es obligatoria para declarar saludable el destino principal. La antigua tarea Windows al NAS está deshabilitada; su configuración y los archivos previos se conservan.

Se adaptó Register-KuviBackupTasks.ps1 al modo server-direct para no recrear o reactivar accidentalmente la transferencia Windows. La verificación de las tareas y el monitor real terminaron correctamente. Falta observar el primer disparo del nuevo cron por horario; las dos comprobaciones directas fueron ejecuciones explícitas.

La transferencia directa elimina la dependencia de la laptop para guardar copias en el NAS. Las notificaciones configuradas siguen siendo locales en Windows y no se emiten con la laptop apagada. El aviso siempre disponible requiere un canal y ejecutor independientes, pendiente de definir.

Validación realizada: sintaxis de Bash y Node y ocho pruebas sintéticas (copia/lectura/confirmación, repetición sin duplicados, preservación de conflictos, limpieza de interrupciones, corrupción antes de publicar, rechazo de enlaces, manifiesto distinto y rechazo de un destino no permitido). El caso de copia inicial y repetida se cubre en una misma prueba. La octava prueba cubre autofs/CIFS y la ausencia de cifrado o un origen distinto. También se probaron el montaje y las dos copias reales descritas arriba. El monitor tiene dieciocho pruebas aprobadas, incluidas independencia del PC y fallos del modo directo. Bloque incluido en el checkpoint de monitor y transferencia NAS autorizado por el propietario.


## Cambio posterior de contraseña NAS

Si el propietario cambia en UGREEN la contraseña del usuario kuvi_backup, actualizar su credencial en Ubuntu desde la terminal habitual:

```powershell
ssh -t kuvi-dev "sudo python3 /home/miguel/kuvi-api/ops/update-nas-credentials.py"
```

Pide la nueva contraseña NAS dos veces sin eco y exige una terminal interactiva. No se introduce en el chat ni en argumentos. Valida que el archivo privado root contiene la cuenta esperada, toma el bloqueo de respaldos, detiene montaje y automontaje sin forzarlos, sustituye el archivo de credencial atómicamente con permisos 0600, conecta de nuevo y verifica los respaldos mediante el trabajador interior bajo el bloqueo existente. Conserva la programación y los archivos de respaldo.

Si hay una copia en curso, se detiene antes de pedir o sustituir la contraseña y se repite después. Si la contraseña se guarda pero falla la conexión nueva, informa explícitamente el fallo y registra un estado NAS fallido para el monitor. Puede repetirse el mismo comando para corregirla; no se vuelve a ejecutar el bootstrap inicial. Una sesión SMB que ya estaba conectada no basta para validar una contraseña modificada.

Cinco pruebas sintéticas aprobaron sustitución privada atómica, conservación de cuenta/dominio, contraseñas con signo igual, rechazo de entradas inválidas y preservación de enlaces. El propietario ejecutó el cambio administrativo y recibió credentialsUpdated=true y freshMountVerified=true, con cinco respaldos verificados y cero copias nuevas. La comprobación independiente validó el montaje cifrado, el estado NAS correcto, el cron de doce horas y la salud DB 200; el monitor Windows también informó estado correcto. La nueva contraseña quedó actualizada y comprobada. No se almacenaron valores de contraseña en este documento o Git.
