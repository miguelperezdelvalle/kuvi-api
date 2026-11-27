# Aislamiento del servicio de Kuvi — 26 de noviembre de 2026

Estado: **aplicado y verificado el 26 de noviembre de 2026 (America/Mexico_City)**. El servicio activo usa `kuvi-api`, sin grupos suplementarios, ejecutando Node desde la copia propiedad de root. Se conserva debajo el historial de preparación y correcciones. No se han cambiado credenciales, sesiones o datos clínicos.

Actualización del primer intento: se crearon la cuenta y los artefactos, la candidata respondió correctamente y el servicio principal falló al consultar interfaces de red. La reversión restauró la unidad de miguel. Se reprodujo el error 97 de `uv_interface_addresses` en una unidad transitoria de usuario con las tres familias originales; al permitir también `AF_NETLINK`, la misma prueba pasó. La plantilla corregida incluye esta familia y un `ExecStartPre` que consulta las interfaces para cubrir el caso antes de tocar el servicio principal. No se han cambiado credenciales ni datos clínicos.

Comando histórico utilizado para reanudar la preparación revisada (ya completada; no volver a ejecutarlo sobre el servicio aislado):

```powershell
ssh -t kuvi-dev "sudo bash /home/miguel/kuvi-api/ops/install-service-isolation.sh --resume"
```

La reanudación comprueba cuenta y grupos, propietarios y permisos de la copia existente, enlaces internos, igualdad del entorno y contenido de los artefactos frente al origen. Reutiliza la copia sin borrar versiones o sobrescribir credenciales; conserva una nueva copia de la unidad anterior y vuelve a ejecutar las pruebas candidatas. Si la preparación no coincide, se detiene para revisión. El instalador conserva el rechazo de `--apply` cuando hay archivos existentes.

## Instalación inicial en un servidor todavía sin aislamiento

```powershell
ssh -t kuvi-dev "sudo bash /home/miguel/kuvi-api/ops/install-service-isolation.sh --apply"
```

Si sudo pide contraseña, se introduce únicamente en esa terminal. No se comparte en el chat. El SSH disponible para esta revisión permite administrar los archivos de miguel, pero `sudo -n` no está autorizado. No se utiliza su pertenencia a Docker para obtener acceso root.

## Cambios preparados

- Cuenta de sistema `kuvi-api`, sin inicio de sesión, directorio personal ni grupos suplementarios.
- Copia de `dist`, `node_modules` y `package.json` en un directorio de versión dentro de `/opt/kuvi-api/releases`, propiedad de root. Se rechazan enlaces que salgan de la copia. No se copian `.git`, `ops`, claves operativas o `.env` al directorio de ejecución.
- `/opt/kuvi-api/current` apunta a esa versión. El servicio ejecuta directamente `/usr/bin/node`, sin watcher ni npm.
- El entorno actual se conserva en `/etc/kuvi/backend.env`, root:root 600, dentro de un directorio 700. Lo carga systemd; la cuenta de ejecución no puede leer el archivo. El proceso recibe su propia conexión limitada a `kuvi_app` y su clave JWT; no se rotan sesiones ni secretos en este cambio.
- systemd oculta `/home`, protege el sistema de archivos contra escritura, elimina capacidades y acceso a dispositivos, impide elevación de privilegios, usa temporales privados y bloquea sockets de Docker/containerd. Se conservan las familias de sockets necesarias para HTTP, PostgreSQL y consulta de interfaces (`AF_NETLINK`).

## Pruebas y reversión

Antes del cambio se inicia una unidad candidata con el mismo aislamiento, ligada a loopback y a un puerto temporal. Comprueba `/db-health` (200) y `/users/me` sin autenticación (401). No modifica datos clínicos.

Se ejecutan comprobaciones como `kuvi-api`: deben fallar la lectura de los perfiles de administrador, migraciones, respaldo y restauración; la lectura de ambos archivos de entorno; la escritura del servidor compilado y la conexión al socket de Docker. La cuenta solo puede pertenecer a su grupo propio.

Solo entonces se reinicia el servicio principal y se repiten salud y acceso anónimo. Si falla después de sustituir la unidad, el instalador vuelve a instalar la unidad anterior y reinicia el servicio. La comprobación no sustituye una prueba funcional en el teléfono después de la aplicación.

Se guarda la unidad anterior en `/var/lib/kuvi-service-isolation/FECHA/previous.service`. Para una reversión manual, un administrador instala ese archivo como `/etc/systemd/system/kuvi-backend.service`, ejecuta `systemctl daemon-reload`, `systemctl restart kuvi-backend.service` y comprueba `/db-health`. No se borran automáticamente las cuentas o archivos de la instalación fallida: quedan para inspección. El instalador rechaza instalaciones ya existentes, cuentas previas o drop-ins para evitar sobrescribirlos.

Las futuras ediciones de código o de `.env` en `/home/miguel/kuvi-api` **no cambiarán la copia en ejecución**. Será necesario desplegar explícitamente una nueva versión y, si procede, actualizar el entorno protegido con privilegios administrativos. Las migraciones y los respaldos siguen ejecutándose desde las herramientas operativas de miguel con sus perfiles separados. El aislamiento no elimina los privilegios administrativos del operador.

## Validación realizada antes de solicitar el paso administrativo

- `npm test`: 52 pruebas aprobadas, incluida compilación y arranque del servidor compilado.
- `bash -n ops/install-service-isolation.sh`: correcto.
- `bash ops/install-service-isolation.sh --check`: correcto, sin cambios de servicio, cuentas o credenciales.
- `systemd-analyze verify ops/kuvi-backend.service`: correcto.
- `git diff --check`: correcto.

En el momento de la preparación, las pruebas del usuario Linux real, la instancia candidata y el reinicio estaban pendientes; véase el resultado de aplicación al final. Este bloque queda sin commit ni push.

## Corrección de comparación al reanudar

La comparación inicial omitía -l en rsync; sus avisos sobre enlaces de node_modules/.bin se interpretaban como diferencias. Se corrigió a -rlcn y se comprobó que los artefactos coinciden. Prueba temporal: enlaces iguales aceptados, cambios de contenido y destino de enlace detectados. No hubo cambio del servicio durante ese intento; después se completó --resume con sudo.

## Aplicación completada y verificación independiente

El operador ejecutó --resume con sudo y recibió el resultado satisfactorio de salud, rechazo de acceso anónimo y denegación de lectura de credenciales administrativas, acceso a Docker y escritura del código desplegado. La copia de reversión quedó en `/var/lib/kuvi-service-isolation/20261127T040705Z/previous.service` (fecha UTC; noche del 26 de noviembre en México).

En otra conexión SSH se confirmó: servicio activo, proceso node con usuario y grupo kuvi-api, UID 997/GID 973 sin grupos suplementarios, directorio /opt/kuvi-api/current, ProtectSystem=strict, ProtectHome=yes, NoNewPrivileges=yes y bloqueo de sockets Docker/containerd. El servidor compilado es root:root 0644. /health y /db-health devolvieron 200; /users/me sin credenciales devolvió 401. La auditoría PostgreSQL conserva kuvi_app sin superusuario, CREATEDB ni CREATEROLE. No fue necesario instalar una APK.

Aceptación funcional posterior completada: el usuario confirmó edición en Paciente con cero cambios pendientes y dio por válida la prueba de Doctor después de comprobar la persistencia de la edición solicitada en PostgreSQL. El hito técnico y funcional está cerrado; la documentación y las herramientas forman parte del checkpoint autorizado de estabilización. El procedimiento de despliegue de futuras versiones es trabajo posterior.
