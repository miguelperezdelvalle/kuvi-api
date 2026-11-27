# Roles y conexiones de PostgreSQL — Kuvi

Implementado el 25 de noviembre de 2026, PostgreSQL 16.15. El propietario confirmó que solo conoce a Kuvi utilizando esta base. Se conservó la cuenta administrativa original, sin cambiar su contraseña ni deshabilitarla. La aplicación ya conecta mediante kuvi_app y la comprobación del servicio confirmó una conexión real de su pool con ese rol, sin superusuario ni propiedad de objetos.

## Matriz operativa

| Rol | Uso | Facultades |
|---|---|---|
| kuvi_app | API Paciente y Doctor | SELECT en 26 tablas; INSERT/UPDATE/DELETE en las 23 tablas de datos habilitadas. Sin DDL, TRUNCATE, propiedad, creación de bases/roles, réplica ni bypass de RLS. |
| kuvi_owner | Propietario de la base, public y las 27 tablas | NOLOGIN; se utiliza mediante el rol de migración. No es superusuario y no puede crear bases ni roles. |
| kuvi_migrator | Migraciones, banco de preguntas y comandos de operador | LOGIN sin superusuario, CREATEDB ni CREATEROLE; al conectar adopta kuvi_owner mediante una membresía SET explícita. |
| kuvi_backup | Exportación completa | SELECT en todas las tablas, incluida _prisma_migrations; lectura de secuencias si las hubiera. Sin escrituras, DDL ni elevación. default_transaction_read_only=on es una protección adicional, no el fundamento de sus permisos. |
| kuvi_restore_operator | Restauraciones y bases de pruebas aisladas | LOGIN sin superusuario ni CREATEROLE. CREATEDB es necesario para crear destinos nuevos. Usa postgres como base de mantenimiento y no tiene CONNECT a la base activa de Kuvi. |
| kuvi_restore_owner | Propietario de restauraciones y pruebas | NOLOGIN sin privilegios administrativos; el operador puede asumirlo únicamente para trabajar con sus destinos. No pertenece a kuvi_owner. |

DoctorApproval, DoctorApprovalEvent y QuestionnaireQuestion son de solo lectura para la API. _prisma_migrations no es accesible para la cuenta de aplicación. Las nuevas tablas creadas por kuvi_owner reciben lectura para el respaldo, pero no acceso automático de la app: la política debe actualizarse explícitamente cuando cambie el modelo.

La separación es por finalidad y familia de tablas. No introduce RLS ni minimización por columna; la autorización entre pacientes/médicos continúa en la aplicación. Las aprobaciones médicas siguen siendo una operación de Kuvi y no hay un endpoint público para otorgarlas.

## Archivos de credenciales

La única conexión de base incluida en /home/miguel/kuvi-api/.env es DATABASE_URL con kuvi_app. Los valores de JWT, puertos y demás configuración se conservaron. Las sesiones de las apps no se invalidaron como parte de este cambio.

Los archivos privados están en /home/miguel/.config/kuvi-database, directorio 0700, archivos 0600:

- app.env, backup.env, migration.env y restore.env: una conexión distinta por finalidad.
- profiles.json: rutas de perfiles y nombres de propietarios, sin contraseñas.
- admin.env: credencial administrativa previa reservada para recuperación y provisión.
- application.before-permissions.env: copia protegida del entorno anterior.
- backup-config.before-permissions.json y backup-core.before-permissions.mjs: referencia de reversión de la operación anterior.

Se generaron contraseñas aleatorias de 256 bits. La provisión utiliza verificadores SCRAM-SHA-256, para evitar incluir contraseñas legibles en las sentencias DDL de creación de roles. No se imprimieron contraseñas, URL privadas ni verificadores. Los archivos privados permanecen fuera de Git y no se copiaron a Windows.

El respaldo carga backup.env y exige kuvi_backup. La restauración carga restore.env solo cuando se solicita verificar una restauración. La operación normal de respaldo no carga esa conexión privilegiada. La clave privada de cifrado del respaldo sigue únicamente en el PC.

## Comandos de uso habitual

```sh
cd /home/miguel/kuvi-api
npm run db:permissions:audit
npm run db:migrate:status
npm run db:migrate:deploy
npm run test:db-permissions
npm run test:backups
```

prisma:migrate ahora utiliza migrate deploy mediante la credencial de migración. No ejecuta migrate dev en la base activa. migrate deploy verifica después el esquema conocido y aplica los permisos de tablas dentro de una transacción. Ante tablas o funciones sin clasificar, exige revisar la política en lugar de conceder acceso indiscriminado.

seed y doctor:onboard también pasan por el perfil de operador/migración. El alta médica conserva el requisito KUVI_OPERATOR_CONFIRM=1 y entrada JSON por stdin. No se crearon, aprobaron o revocaron médicos reales para verificar esta entrega. El comando captura la salida de herramientas y devuelve resultados y códigos limitados, sin volcar datos de conexión o entrada.

## Pruebas aisladas

Los comandos test:sessions, test:clinical-access, test:appointments, test:medications, test:physicians y test:documents crean primero una base nueva con prefijo kuvi_integration_test_UUID. No crean sus esquemas de prueba en la base activa. Se ejecutan con el propietario de ese destino mediante una cuenta sin superusuario y eliminan la base al terminar.

La suite de directorio ejecuta sus dos archivos secuencialmente, para respetar el límite de conexiones operativas. Las pruebas siguen comprobando las mismas funciones de directorio y citas. Las pruebas de permisos tienen otro prefijo, kuvi_permissions_test_UUID, y crean fixtures exclusivamente sintéticas.

Resultados:

| Comprobación | Resultado |
|---|---|
| TypeScript | Sin errores |
| Suite general | 52 aprobadas |
| Matriz de permisos y HTTP con kuvi_app | 8 aprobadas |
| Sesiones | 14 aprobadas |
| Acceso clínico | 19 aprobadas |
| Citas | 13 aprobadas |
| Medicamentos | 12 aprobadas |
| Directorio y citas | 30 aprobadas; incluye de nuevo las pruebas de citas |
| Documentos | 9 aprobadas |
| Respaldo: unitarias | 6 aprobadas |
| Respaldo: fallos operativos | 4 escenarios aprobados |

La matriz verificó lectura/DML de la app, rechazo de DDL, TRUNCATE, propiedad, acceso a archivos del servidor y SET ROLE al propietario. También probó que el respaldo no pueda escribir aun desactivando su valor predeterminado de solo lectura. Validó nuevas tablas de migración con acceso de respaldo y sin acceso automático de la app.

El flujo HTTP con la cuenta limitada cubrió registro de paciente, login, renovación, alta médica de operador por conexión separada, aprobación, consentimiento, cuestionario, historia, consulta de Doctor, cita asignada, confirmación, nota clínica, emisión y revocación de receta, y consultas de medicamentos y documentos. Todos los usuarios y datos de estas pruebas fueron sintéticos y temporales.

Se generó una copia real con kuvi_backup, se transfirió y verificó en Windows y se restauró con kuvi_restore_operator, sin superusuario ni creación de roles. Coincidieron las 27 tablas, 13 migraciones y tamaño/hash de los sobres de documentos. No se descifraron los documentos de pacientes. Se eliminaron la base y los archivos legibles temporales; el propietario NOLOGIN de restauración es ahora un rol permanente reutilizable.

El cron de las 03:30 del 25 de noviembre ejecutó correctamente el respaldo con la nueva credencial y la retención devolvió cero archivos eliminados. La tarea horaria de Windows lo recogió a las 03:32, resultado 0, con hash y tamaño verificados. Esta es la primera aceptación de la ejecución diaria por horario.

## Transición y reversión

Se prepararon roles, conexiones y pruebas antes de cambiar el entorno del servicio. La política solo cambió propiedad y permisos, no datos clínicos. La cuenta administrativa original siguió operativa durante la preparación. database-cutover.mjs comprobó la cuenta nueva y la política de reinicio de systemd antes de sustituir .env de forma atómica.

El servicio es del usuario miguel, con Restart=always y KillMode=control-group. Se envió SIGTERM únicamente a su supervisor, del mismo propietario, para que systemd lo arrancara leyendo el nuevo EnvironmentFile. No se usó sudo ni se cambió la unidad de systemd. Se verificaron la nueva identidad en el entorno del supervisor y /db-health. Si falla la comprobación durante la transición, el programa restaura la conexión administrativa y vuelve a comprobar salud.

La reversión conservada no es una invitación a volver a usar el administrador de forma habitual. Si se necesita, reemplazar únicamente DATABASE_URL desde la referencia privada, conservar el resto del entorno y reiniciar controladamente el servicio. No hace falta retirar los roles nuevos o revertir la propiedad para que el administrador original vuelva a operar.

## Límites y pasos siguientes

- Aislamiento Linux completado el 26 de noviembre de 2026: el servicio usa kuvi-api, sin grupo Docker ni lectura de perfiles operativos; ejecuta una copia compilada propiedad de root con sandbox de systemd. Véase service-isolation.md. La transición inicial descrita arriba corresponde al 25 de noviembre y su script database-cutover.mjs es histórico: ya no sirve para reiniciar o inspeccionar el entorno de este servicio con otro propietario. Los cambios del código o .env de miguel requieren ahora despliegue administrativo explícito.
- La cuenta administrativa anterior se conserva para recuperación; no fue eliminada ni se rotó su contraseña. Los despliegues nuevos deben usar los perfiles limitados y reservar esa cuenta para tareas justificadas.
- La custodia externa de la recuperación de la clave operativa, un destino permanente de copias y las alertas independientes siguen pendientes.
- No se cambió código Flutter, no se requiere una nueva APK y no se hicieron acciones clínicas reales para probar el cambio. La comprobación física de las apps puede repetirse cuando el propietario vuelva.
- Los cambios de copias operativas y permisos todavía no se han incluido en commit o push.

Referencias: [GRANT de PostgreSQL 16](https://www.postgresql.org/docs/16/sql-grant.html), [membresía de roles](https://www.postgresql.org/docs/16/role-membership.html), [privilegios predeterminados](https://www.postgresql.org/docs/16/sql-alterdefaultprivileges.html).
