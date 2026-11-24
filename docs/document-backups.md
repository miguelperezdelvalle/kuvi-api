# Respaldo cifrado de documentos

Implementado el 22 de noviembre de 2026. Las rutas requieren una cuenta de paciente activa y una sesión válida. Doctor no obtiene acceso mediante permisos clínicos existentes. El servidor no recibe claves de bóveda, frases, archivo de recuperación, nombres, títulos, tipos MIME ni fechas clínicas en claro. Guarda el sobre cifrado exacto y metadatos técnicos de almacenamiento. La autenticación criptográfica del contenido se comprueba en el dispositivo; el backend valida su estructura sin descifrarlo.

## Contrato

- GET /documents/me devuelve espacio, cuota, bóveda e inventario paginado de hasta 50 identificadores, hashes SHA-256, tamaños y fechas de subida. cursor permite continuar por identificador.
- POST /documents/me/:id recibe los bytes UTF-8 de un sobre kuvi-document v1, con Content-Type application/json. Se rechazan campos adicionales y se comprueban cuenta, documento, versión, Base64 y tamaños. Un reintento idéntico devuelve la misma confirmación sin duplicar cuota. Una copia distinta con el mismo identificador produce 409 y conserva la anterior.
- GET /documents/me/:id devuelve exactamente los bytes guardados, con ETag y Cache-Control: no-store. Otro propietario obtiene 404.
- DELETE /documents/me/:id exige If-Match con el hash actual, entre comillas o sin ellas. La app elimina únicamente copias locales; esta ruta de borrado remoto no tiene todavía una pantalla de gestión.

## Límites y persistencia

Máximo de 10 MiB para el contenido cifrado del documento y 4096 bytes para los metadatos cifrados. El cuerpo completo está limitado a 14 MiB antes de analizar JSON. Las cuotas contabilizan los bytes reales del sobre UTF-8, incluida la expansión Base64. DOCUMENT_BACKUP_QUOTA_BYTES vale 262144000 por defecto y DOCUMENT_BACKUP_MAX_FILES vale 100. Se validan sus valores al iniciar.

Se admiten hasta cuatro cargas simultáneas por instancia, dos por cuenta; se autentica antes de procesar el cuerpo y los excesos devuelven 429. La lectura de solicitudes tiene un plazo de 120 segundos. DocumentBackup almacena bytes, tamaño y hash en PostgreSQL, con clave compuesta de cuenta y documento y restricciones de tamaño y hash. DocumentBackupVault conserva una bóveda por cuenta, incluso al vaciar el respaldo, para evitar cambiar de clave silenciosamente.

Las escrituras y los borrados toman un bloqueo de transacción por cuenta antes de comprobar cuotas. El tamaño y la cantidad se comprueban y guardan dentro de la misma transacción. No se actualizan sobres existentes. Las respuestas y errores no devuelven contenido rechazado ni identificadores privados innecesarios. Los cuerpos de solicitud y respuesta ya están excluidos de los registros estructurados del servicio.

## Recuperación

Paciente valida la copia local antes de enviarla y descarga de nuevo la copia guardada antes de marcarla confirmada. Al restaurar, comprueba tamaño, hash, cuenta, bóveda, autenticación del cifrado, metadatos y contenido, y confirma el almacenamiento local antes de publicar el índice. Conserva copias locales válidas que difieran y permite reparar una copia local corrupta desde un respaldo válido. Las operaciones no envían el archivo de recuperación ni sus seis palabras.

Los archivos y metadatos permanecen opacos para el servidor. Este sí conoce identificadores técnicos, tamaños, cantidad y momentos de las operaciones. El cifrado no garantiza disponibilidad ni permite detectar por sí solo la omisión de documentos por un servidor comprometido. Se mantiene la necesidad de respaldar la propia base del servidor como operación independiente. La autorización criptográfica de otros dispositivos y Doctor sigue pendiente.

## Validación y operación

npm run test:documents crea un esquema temporal, aplica migraciones, usa usuarios y documentos sintéticos y elimina el esquema al terminar. Sus nueve pruebas incluyen autenticación, límites, aislamiento, reintentos, cuotas concurrentes, ausencia de nombres en claro, borrado y paginación. La suite general y TypeScript también se validaron. Nunca se deben ejecutar las pruebas de escritura contra datos reales.

La migración 20261122000000_document_backups añade dos tablas y no transforma expedientes existentes. Se probó en un checkout aislado antes de desplegar. Revertir el código no exige borrar las tablas ni los archivos cifrados. Ante un fallo de despliegue se deben conservar las copias y resolver la causa sin resetear la base.
