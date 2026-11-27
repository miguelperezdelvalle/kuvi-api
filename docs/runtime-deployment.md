# Despliegue de versiones del backend

Estado: primera activación administrativa completada y comprobada por SSH independiente. La versión activa es 20261127T050954Z-1bcff545d1e1, correspondiente al commit 1bcff545d1e171f92d0076d4e49eaca639ee09d0. Las pruebas de reversión descritas aquí son simuladas; no se ha forzado una caída en producción ni ejecutado todavía la reversión administrativa explícita.

## Preparar como operador

El repositorio debe tener confirmados sus cambios de archivos rastreados. Los archivos sin seguimiento no se incluyen en el paquete; las herramientas no hacen commit, fetch, merge ni push automáticamente.

```bash
cd /home/miguel/kuvi-api
node ops/prepare-release.mjs
```

Se construye un snapshot de `git archive HEAD` en una carpeta privada bajo `/home/miguel/.local/share/kuvi-deploy/ID`. Allí se ejecutan `npm ci --ignore-scripts`, generación de Prisma, compilación y las pruebas generales y de respaldos. Se usa un entorno sintético para generar y probar el código; no se copia `.env` al snapshot ni se ejecuta npm con root. Los registros de preparación permanecen privados.

La lectura del historial de migraciones utiliza el perfil de respaldo de solo lectura. Deben coincidir exactamente nombres y SHA-256 de todas las migraciones aplicadas con los archivos del commit. Migraciones pendientes, editadas, desconocidas o incompletas impiden la preparación. Los cambios de esquema requieren un procedimiento separado y compatibilidad explícita con el código anterior; esta herramienta no ejecuta migraciones ni restaura bases.

El runtime contiene únicamente `dist`, `node_modules` y `package.json`. Su manifiesto externo registra commit, versión de Node, pruebas completadas, firma del historial de migraciones e inventario criptográfico del runtime, incluidos los enlaces internos. No contiene credenciales ni datos clínicos.

## Comprobar y activar

```bash
python3 ops/deploy-runtime.py --check ID
sudo python3 ops/deploy-runtime.py --apply ID
```

Desde Windows puede ejecutarse el segundo comando con `ssh -t kuvi-dev` y la ruta absoluta del script. El identificador es el que imprime la preparación; no se acepta una ruta arbitraria. La sesión del asistente no tiene sudo sin contraseña: el paso administrativo se ejecuta en la terminal del operador, sin compartirla en el chat.

El preflight confirma que el servicio sigue aislado, sin drop-ins ni cambios de unidad que requieran revisión, que la versión actual está íntegra y pertenece a root, que el paquete mantiene su contenido y que el historial de migraciones no cambió. El modo `--check` no reinicia ni sustituye el servicio.

La activación:

1. Toma el mismo bloqueo exclusivo que el instalador de aislamiento.
2. Copia el runtime a una carpeta nueva en `/opt/kuvi-api/releases/ID`, propiedad de root. Verifica nuevamente el inventario; rechaza enlaces que salgan de la carpeta, archivos especiales y archivos `.env`.
3. Arranca una candidata con la unidad protegida actual, pero con directorio de la versión nueva y puerto temporal en loopback. Comprueba consulta de interfaces, `/db-health` (200) y rechazo anónimo en `/users/me` (401). Retira la candidata antes del cambio principal.
4. Vuelve a comprobar el historial de migraciones, sustituye atómicamente `/opt/kuvi-api/current`, reinicia el servicio y repite salud y rechazo de acceso anónimo.
5. Si falla la sustitución, el reinicio o la comprobación posterior, vuelve a apuntar a la versión anterior, la reinicia y comprueba su salud. Si esa recuperación también falla, informa que hace falta intervención administrativa; nunca eleva el rol SQL ni sustituye credenciales.

La activación implica un reinicio breve; no es un despliegue sin interrupción. No modifica la unidad principal, `/etc/kuvi/backend.env`, las cuentas Linux, las claves JWT, los datos o las tareas de respaldo. Tampoco incorpora automáticamente cambios de `.env` del repositorio: actualizar el entorno protegido requiere revisión administrativa por separado.

## Reversión explícita

Después de una activación correcta:

```bash
sudo python3 /home/miguel/kuvi-api/ops/deploy-runtime.py --rollback
```

La reversión usa exclusivamente la versión anterior registrada en `/var/lib/kuvi-deployments/last-success.json`, privado y propiedad de root. Comprueba que sigue activa la versión registrada, que la anterior mantiene su inventario y que la base conserva el mismo historial de migraciones. Después prueba esa versión como candidata y realiza la misma activación con recuperación automática ante fallo. No equivale a revertir migraciones ni borra datos.

Se conservan versiones y eventos de despliegue, incluidos los intentos fallidos. No hay limpieza automática ni sobrescritura de una versión existente. Ante un fallo de candidata, se inspecciona el resultado y se prepara otro identificador antes de repetir; no se borra una carpeta de versión para forzar la reanudación.

## Validación de esta entrega

- 10 pruebas con archivos sintéticos temporales: copia con enlaces internos, alteración de contenido y enlaces, enlaces externos, exclusión de entorno, activación correcta, recuperación ante fallo de reinicio, salud o sustitución, y notificación de recuperación fallida.
- Preparación real del commit `1bcff545d1e171f92d0076d4e49eaca639ee09d0`: 52 pruebas generales y 6 de respaldos aprobadas desde el snapshot con dependencias instaladas según el lockfile.
- Paquete `20261127T050954Z-1bcff545d1e1`: manifiesto, inventario y migraciones coincidentes; preflight completo aprobado sin cambiar el servicio. Los identificadores usan UTC; las fechas de comunicación del proyecto usan America/Mexico_City.
- Primera activación administrativa completada: el operador recibió ok=true, dbHealth=true, runtimeUser=kuvi-api y previousRelease=20261127T035112Z. Verificación independiente: enlace actual correcto, proceso Node como kuvi-api, sandbox conservado, /health y /db-health 200, /users/me anónimo 401, inventario de 16.394 entradas idéntico al manifiesto y firma de migraciones coincidente. No quedó la unidad candidata.
- Aceptación funcional posterior completada: el usuario editó una cita en Paciente y confirmó cero cambios pendientes. Quedan cerradas la primera activación y su aceptación funcional. Herramientas, pruebas y documentación incluidas en el checkpoint de despliegue autorizado por el propietario.

La preparación comprueba la integridad y la trazabilidad dentro del servidor; no constituye una firma independiente del autor del código. El operador sigue siendo responsable de revisar el commit que autoriza desplegar.
