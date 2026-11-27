import { createHmac, createHash, pbkdf2Sync, randomBytes } from 'node:crypto';

export const names = Object.freeze({owner:'kuvi_owner', app:'kuvi_app', backup:'kuvi_backup',
  migration:'kuvi_migrator', restore:'kuvi_restore_operator', restoreOwner:'kuvi_restore_owner'});
export const readOnlyTables = Object.freeze(['DoctorApproval','DoctorApprovalEvent','QuestionnaireQuestion']);
export const writeTables = Object.freeze(['Appointment','AppointmentClinicalNote','AppointmentEvent',
  'AppointmentOperation','AuthRefreshToken','AuthSession','DocumentBackup','DocumentBackupVault',
  'MedicalHistoryNote','Medication','MedicationIntake','MedicationOperation','MedicationStockMovement',
  'MedicationTreatment','PatientDoctorGrant','PatientDoctorGrantEvent','PatientProfile','Physician',
  'PhysicianSource','Prescription','QuestionnaireAnswer','SharedAccess','User']);
export const allTables = Object.freeze([...readOnlyTables,...writeTables,'_prisma_migrations']);
export function identifier(value) {
  if(typeof value!=='string'||!value.length||value.length>63||value.includes('\0')) throw Error('INVALID_SQL_IDENTIFIER');
  return '"'+value.replaceAll('"','""')+'"';
}
export function literal(value) {
  if(typeof value!=='string'||value.includes('\0')) throw Error('INVALID_SQL_LITERAL');
  return "'"+value.replaceAll("'","''")+"'";
}
// PostgreSQL accepts a SCRAM verifier directly. Random passwords and verifiers
// stay in private configuration/memory; plaintext passwords never enter DDL.
export function scramVerifier(password) {
  const salt=randomBytes(16), iterations=16384;
  const salted=pbkdf2Sync(password,salt,iterations,32,'sha256');
  const client=createHmac('sha256',salted).update('Client Key').digest();
  const stored=createHash('sha256').update(client).digest('base64');
  const server=createHmac('sha256',salted).update('Server Key').digest('base64');
  salted.fill(0);client.fill(0);
  return `SCRAM-SHA-256$${iterations}:${salt.toString('base64')}$${stored}:${server}`;
}
export function connectionFor(original, role, password, database) {
  const url=new URL(original);
  url.username=role;url.password=password;
  if(database) url.pathname='/'+database;
  return url.toString();
}

export async function assertKnownSchema(client,schema='public') {
  const {rows}=await client.query(`SELECT c.relname AS name,c.relkind FROM pg_class c
    JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relkind IN ('r','p','v','m','S','f')`,[schema]);
  if(rows.some(row=>!['r','p'].includes(row.relkind)||!allTables.includes(row.name))||
      allTables.some(name=>!rows.some(row=>row.name===name))) throw Error('UNCLASSIFIED_DATABASE_OBJECTS');
  const {rows:[functions]}=await client.query(`SELECT count(*)::int AS count FROM pg_proc p
    JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname=$1`,[schema]);
  if(functions.count!==0) throw Error('DATABASE_FUNCTION_REVIEW_REQUIRED');
}

export async function grantTablePolicy(client,schema='public') {
  const s=identifier(schema);
  for(const role of [names.app,names.backup]) {
    await client.query(`REVOKE ALL ON ALL TABLES IN SCHEMA ${s} FROM ${identifier(role)}`);
    await client.query(`REVOKE ALL ON ALL SEQUENCES IN SCHEMA ${s} FROM ${identifier(role)}`);
  }
  await client.query(`REVOKE ALL ON ALL TABLES IN SCHEMA ${s} FROM PUBLIC`);
  await client.query(`GRANT SELECT ON ALL TABLES IN SCHEMA ${s} TO ${identifier(names.backup)}`);
  await client.query(`GRANT SELECT ON ALL SEQUENCES IN SCHEMA ${s} TO ${identifier(names.backup)}`);
  for(const table of [...writeTables,...readOnlyTables]) {
    await client.query(`GRANT SELECT ON ${s}.${identifier(table)} TO ${identifier(names.app)}`);
  }
  for(const table of writeTables) {
    await client.query(`GRANT INSERT, UPDATE, DELETE ON ${s}.${identifier(table)} TO ${identifier(names.app)}`);
  }
  await client.query(`ALTER DEFAULT PRIVILEGES FOR ROLE ${identifier(names.owner)} IN SCHEMA ${s}
    GRANT SELECT ON TABLES TO ${identifier(names.backup)}`);
  await client.query(`ALTER DEFAULT PRIVILEGES FOR ROLE ${identifier(names.owner)} IN SCHEMA ${s}
    GRANT SELECT ON SEQUENCES TO ${identifier(names.backup)}`);
  await client.query(`ALTER DEFAULT PRIVILEGES FOR ROLE ${identifier(names.owner)}
    REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC`);
}

export async function applyDatabasePolicy(client,{transferOwnership=true}={}) {
  await assertKnownSchema(client);
  const {rows:[context]}=await client.query('SELECT current_database() AS database');
  const database=identifier(context.database);
  await client.query('BEGIN');
  try {
    await client.query("SET LOCAL lock_timeout='5s'");
    if(transferOwnership) {
      await client.query(`ALTER DATABASE ${database} OWNER TO ${identifier(names.owner)}`);
      await client.query(`ALTER SCHEMA public OWNER TO ${identifier(names.owner)}`);
      for(const table of allTables) await client.query(`ALTER TABLE public.${identifier(table)} OWNER TO ${identifier(names.owner)}`);
    }
    await client.query(`REVOKE ALL ON DATABASE ${database} FROM PUBLIC`);
    await client.query(`REVOKE ALL ON SCHEMA public FROM PUBLIC`);
    for(const role of [names.app,names.backup,names.migration]) {
      await client.query(`GRANT CONNECT ON DATABASE ${database} TO ${identifier(role)}`);
    }
    for(const role of [names.app,names.backup]) {
      await client.query(`GRANT USAGE ON SCHEMA public TO ${identifier(role)}`);
    }
    await grantTablePolicy(client);
    await client.query('COMMIT');
  } catch(error) {await client.query('ROLLBACK');throw error;}
}
