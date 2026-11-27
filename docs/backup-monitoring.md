# Respaldos al NAS y alertas locales — 27 de noviembre de 2026

Estado actual: transferencia directa Ubuntu al NAS activa cada doce horas, cuota de 50 GiB comprobada y cinco respaldos verificados. La tarea Windows de transferencia al NAS está deshabilitada; su configuración se conserva como respaldo operativo. El monitor Windows consulta el estado del trabajo directo y no exige una copia reciente en la laptop. El aviso de prueba fue confirmado visualmente en el centro de notificaciones. Las secciones siguientes conservan el procedimiento previo basado en Windows como referencia; el flujo activo y sus límites están en nas-direct.md. No se cambió la API, el cifrado, las claves o los datos clínicos. Herramientas, pruebas y documentación incluidas en el checkpoint de monitor y transferencia NAS autorizado por el propietario.

## Flujo activo y horarios

- Ubuntu, 03:30 America/Mexico_City: cron de miguel ejecuta `timeout 50m node ops/backup-job.mjs CONFIG_PRIVADA`. Conserva el cifrado y la política de retención existentes. Se guardó la entrada cron anterior en una copia privada, fuera de Git.
- El trabajo registra inicio, éxito o fallo en `.config/kuvi-backup/last-run.json`, con permisos 0600. Un bloqueo evita ejecuciones simultáneas. La salida y el registro no contienen stderr bruto, SQL, credenciales ni datos clínicos.
- Windows, tarea existente `Kuvi-DatabaseBackup-Pull`: mantiene la copia del PC cada hora.
- Windows, `Kuvi-DatabaseBackup-NasPull`: recoge los archivos cifrados directamente del servidor a la carpeta SMB del NAS cada 12 horas, a las 03:38 y 15:38 America/Mexico_City. Se quitó el disparador de inicio de sesión; conserva StartWhenAvailable para recuperar una ejecución omitida.
- Windows, `Kuvi-DatabaseBackup-Watch`: comprueba por su cuenta el servidor y las dos copias cada hora, al minuto 45, y al iniciar sesión. No depende de que el trabajo de copia lo invoque. El registro de tareas utiliza privilegios limitados, sesión interactiva, recuperación de ejecuciones omitidas y rechazo de instancias superpuestas. La transferencia espera red; el monitor también puede ejecutarse sin red para avisar de la falta de conexión.

Este flujo depende del PC encendido y con sesión iniciada. El NAS es el destino persistente de las copias, pero no el ejecutor autónomo de su transferencia. Si el PC está apagado o sin sesión, no transfiere ni emite avisos; recupera ejecuciones al volver a estar disponible. Un observador siempre encendido, independiente del PC, sigue siendo un refuerzo pendiente.

La carpeta de recuperación operativa permanece en la Caja fuerte de UGREEN, separada de esta carpeta SMB. Las copias diarias `.dump.gpg` ya están cifradas antes de salir de Ubuntu. Sus archivos `.json` contienen tamaño, SHA-256, fecha y metadatos técnicos para verificarlas. No se transfieren claves privadas ni contraseñas a la carpeta de copias diarias.

## Integridad y retención

La misma herramienta `backup-pull.mjs` trabaja con una configuración adicional `nas-pull-config.json`, en el directorio privado del operador. Verifica tamaño y hash de cada archivo descargado, sincroniza bytes, publica el archivo y confirma la recepción al servidor. No sobrescribe copias con contenido distinto ni elimina copias del PC o del NAS. La política de borrado de Ubuntu sigue requiriendo una confirmación de alguna copia verificada fuera del servidor; no equivale a exigir dos destinos distintos. El monitor comprueba por separado que la copia más reciente está en ambos.

Las credenciales SMB se introducen en Windows/Explorador y no se guardan en argumentos de tareas, Git o configuración de Kuvi. Las tareas usan el acceso de red del mismo usuario. Si Windows pierde ese acceso después de reiniciar, hay que autenticar la carpeta nuevamente o configurar su credencial mediante Windows. Los permisos de la carpeta se administran en UGOS; esta revisión comprobó acceso e integridad, no auditó todas las ACL internas del NAS.

No se aplica borrado automático en el NAS. Hay que definir más adelante capacidad y retención propias, además de considerar otra ubicación física si el NAS comparte sitio con este PC.

## Condiciones del monitor

`backup-health.mjs` comprueba el inventario cifrado del servidor y expone únicamente metadatos técnicos del último respaldo y trabajo. `backup-observer.mjs`, ejecutado en Windows, consulta ese resultado por SSH y vuelve a calcular el SHA-256 de la copia más reciente en PC y NAS. La identidad de origen queda fijada en la configuración privada para detectar cambios inesperados.

Se detectan: servidor inaccesible; inventario vacío, inválido o de otro origen; trabajo fallido o atascado durante más de una hora; respaldo de más de 36 horas; tareas de transferencia fallidas o sin actualización durante más de tres horas en PC o quince horas en NAS; archivos ausentes, corruptos o destino inaccesible. Hay una gracia de dos horas para la aparición de una copia nueva en PC y catorce horas en NAS, ajustada al intervalo de doce horas solicitado para el MVP, pero la corrupción o una tarea fallida se informa inmediatamente. También se rechazan marcas de tiempo inválidas o adelantadas.

Los avisos se muestran en el centro de notificaciones de Windows con el título «Respaldos de Kuvi». Se emite el problema inicial, cambios de problema, repetición a las seis horas si persiste y recuperación. Windows puede suprimir banners según la configuración de notificaciones; no se alteraron las preferencias globales del usuario. El propietario confirmó la notificación de prueba mediante captura del centro de notificaciones.

Los archivos privados del PC son `monitor-config.json`, `nas-pull-config.json`, `last-nas-pull.json`, `backup-monitor-status.json` y `backup-monitor-events.jsonl` bajo `.kuvi-backup`. La ruta real del NAS y la configuración no se incorporan a Git. El registro contiene códigos técnicos y fechas, sin datos clínicos. La supervisión no sustituye las restauraciones periódicas.

## Operación y recuperación de tareas

Instalar los scripts de `ops/windows` y los módulos `backup-pull.mjs`, `backup-observer.mjs`, `backup-observer-core.mjs` en el directorio privado del operador. Escribir los scripts PowerShell en UTF-8 con BOM para Windows PowerShell 5.1. Usar la configuración de ejemplo del monitor, completando las rutas privadas, identidad comprobada de origen y ruta SMB. La configuración NAS deriva de la de recogida del PC, cambiando solo `localDirectory`.

`Register-KuviBackupTasks.ps1` registra las dos tareas nuevas si no existen; si existen, verifica su acción y privilegios y evita sobrescribirlas. `-VerifyOnly` no registra tareas. La tarea de copia del PC anterior se conserva. Los lanzadores utilizan Windows PowerShell 5.1 con `-WindowStyle Hidden`, necesario para la API de notificaciones utilizada. Para pruebas manuales sin abrir consola, invocarlos con `ProcessStartInfo.CreateNoWindow=true`.

Para una prueba visible de aviso, ejecutar `Invoke-KuviBackupWatch.ps1 -TestNotification`. El resultado «submitted» confirma aceptación de la API; la aceptación física requiere verlo en Windows. Para revisar operaciones reales, consultar los estados JSON privados y el resultado de las tareas programadas.

## Validación realizada y límites

- 15 pruebas sintéticas aprobadas del monitor (incluido el intervalo NAS de doce horas): pérdida de conexión, trabajo fallido o atascado, antigüedad, relojes inválidos, cambio de origen, gracia, integridad de bytes, nombres inválidos, errores del NAS y deduplicación/recuperación.
- Prueba de integración del trabajo con fallo deliberado de una herramienta en un directorio temporal: registró el fallo correctamente sin cambiar el estado real de producción.
- Respaldo real adicional generado mediante el nuevo trabajo; copia en PC y cinco copias en NAS verificadas. Una segunda recogida no duplicó archivos.
- Ambas tareas nuevas fueron ejecutadas mediante el Programador de tareas y terminaron con resultado 0. El monitor real informó PC y NAS correctos, sin errores ni copias pendientes.
- Notificación de prueba confirmada por captura del propietario.
- Pendiente observar la siguiente ejecución diaria de las 03:30 con el nuevo wrapper y una ejecución por horario de las dos tareas nuevas; las primeras pruebas fueron inicios explícitos desde el Programador. El horario anterior de respaldo y recogida ya estaba comprobado.
- No se desconectaron el NAS ni el servidor reales para simular averías; esos casos se comprobaron con datos y destinos sintéticos.

Cambio posterior: el propietario indicó que la laptop permanece apagada gran parte del día. Se confirmó conexión SMB desde Ubuntu al NAS y se preparó la transferencia directa, todavía sin activar ni introducir credenciales. Véase nas-direct.md para el estado real y los pasos pendientes. La ruta Windows conserva su intervalo de doce horas hasta completar esa migración.

Migración completada: el nuevo cron de Ubuntu transfiere/verifica a las 03:38 y 15:38, con copia temporal, flush y relectura del NAS. El informe de backup-health incluye el estado de la transferencia directa; el monitor acepta nasMode=server-direct y requirePcCopy=false. Las alertas de Windows continúan necesitando la laptop encendida, pero los respaldos del NAS ya no. Dieciocho pruebas del monitor y ocho de copia directa aprobadas; transferencia real y repetición verificadas. Pendiente primer disparo por horario del cron directo.
