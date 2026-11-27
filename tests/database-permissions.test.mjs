import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {randomBytes,randomUUID} from 'node:crypto';
import {Client} from 'pg';
import Fastify from 'fastify';
import jwt from '@fastify/jwt';
import {names,writeTables,readOnlyTables,allTables,identifier} from '../ops/database-policy.mjs';

const context=JSON.parse(await readFile(process.env.KUVI_PRIVILEGE_TEST_CONTEXT,'utf8'));
if(!/^kuvi_permissions_test_[a-f0-9]{32}$/.test(context.target)||
  [context.appUrl,context.backupUrl,context.migrationUrl].some(value=>decodeURIComponent(new URL(value).pathname.slice(1))!==context.target))throw Error('DISPOSABLE_PERMISSION_DATABASE_REQUIRED');
const {prisma}=await import('../dist/infrastructure/db/prisma.js');
const dbs={app:new Client({connectionString:context.appUrl}),backup:new Client({connectionString:context.backupUrl}),migration:new Client({connectionString:context.migrationUrl})};
test('least-privilege database isolation and real HTTP operations',async t=>{
  for(const client of Object.values(dbs))await client.connect();
  const app=Fastify({logger:false});
  await app.register(jwt,{secret:context.jwt});
  for(const [file,exported,prefix] of [
    ['auth/auth.routes','authRoutes','/auth'],['doctor/doctor.routes','doctorRoutes','/doctor'],
    ['sharing/sharing.routes','sharingRoutes','/sharing'],['appointments/appointments.routes','appointmentsRoutes','/appointments'],
    ['questionnaire/questionnaire.routes','questionnaireRoutes','/questionnaire'],['medical-history/medical-history.routes','medicalHistoryRoutes','/medical-history'],
    ['medications/medications.routes','medicationsRoutes','/medications'],['documents/documents.routes','documentsRoutes','/documents'],
  ])await app.register((await import(`../dist/modules/${file}.js`))[exported],{prefix});
  await app.ready();
  async function denied(client,sql) {
    await client.query('BEGIN');
    try{await assert.rejects(client.query(sql),error=>error.code==='42501'||error.code==='25006');}
    finally{await client.query('ROLLBACK');}
  }
  try {
    await t.test('runtime has no ownership, superuser or administrative capabilities',async()=>{
      const {rows:[role]}=await dbs.app.query(`SELECT rolname,rolsuper,rolcreatedb,rolcreaterole,rolbypassrls,rolreplication FROM pg_roles WHERE rolname=current_user`);
      assert.equal(role.rolname,names.app);
      for(const field of ['rolsuper','rolcreatedb','rolcreaterole','rolbypassrls','rolreplication'])assert.equal(role[field],false);
      const {rows:[own]}=await dbs.app.query(`SELECT count(*)::int AS n FROM pg_class WHERE relowner=(SELECT oid FROM pg_roles WHERE rolname=current_user) AND relnamespace='public'::regnamespace`);
      assert.equal(own.n,0);
      await denied(dbs.app,'CREATE TABLE public.permission_forbidden(id int)');
      await denied(dbs.app,'CREATE SCHEMA permission_forbidden');
      await denied(dbs.app,'TRUNCATE public."User"');
      await denied(dbs.app,'ALTER TABLE public."User" ADD COLUMN forbidden integer');
      await denied(dbs.app,'SET LOCAL ROLE kuvi_owner');
      await denied(dbs.app,"SELECT pg_read_file('/dev/null',0,0)");
      await denied(dbs.app,'SELECT * FROM public."_prisma_migrations" LIMIT 0');
    });
    await t.test('runtime CRUD matches the explicit table policy, with administrative tables read-only',async()=>{
      for(const table of [...writeTables,...readOnlyTables])await dbs.app.query(`SELECT * FROM public.${identifier(table)} LIMIT 0`);
      for(const table of writeTables) {
        await dbs.app.query(`INSERT INTO public.${identifier(table)} SELECT * FROM public.${identifier(table)} WHERE FALSE`);
        await dbs.app.query(`DELETE FROM public.${identifier(table)} WHERE FALSE`);
      }
      for(const table of readOnlyTables)await denied(dbs.app,`DELETE FROM public.${identifier(table)} WHERE FALSE`);
    });
    await t.test('backup can read the complete schema and cannot write or elevate even after disabling the read-only default',async()=>{
      for(const table of allTables)await dbs.backup.query(`SELECT * FROM public.${identifier(table)} LIMIT 0`);
      assert.equal((await dbs.backup.query('SHOW default_transaction_read_only')).rows[0].default_transaction_read_only,'on');
      await dbs.backup.query('SET default_transaction_read_only=off');
      await denied(dbs.backup,'DELETE FROM public."User" WHERE FALSE');
      await denied(dbs.backup,'CREATE TABLE public.backup_forbidden(id int)');
      await denied(dbs.backup,'SET LOCAL ROLE kuvi_owner');
      await dbs.backup.query('SET default_transaction_read_only=on');
    });
    await t.test('migration login creates as the NOLOGIN owner and future tables are backed up without automatic app access',async()=>{
      const {rows:[r]}=await dbs.migration.query('SELECT current_user,session_user');
      assert.equal(r.current_user,names.owner);assert.equal(r.session_user,names.migration);
      await dbs.migration.query('CREATE TABLE public."PermissionFutureProbe"(id text PRIMARY KEY)');
      try{
        await dbs.backup.query('SELECT * FROM public."PermissionFutureProbe" LIMIT 0');
        await denied(dbs.app,'SELECT * FROM public."PermissionFutureProbe" LIMIT 0');
      }finally{await dbs.migration.query('DROP TABLE public."PermissionFutureProbe"');}
    });
    let patient,doctor,patientToken,doctorToken;
    const password=randomBytes(24).toString('hex');
    const req=(token,method,url,payload)=>app.inject({method,url,payload,headers:token?{authorization:`Bearer ${token}`}:{}});
    await t.test('patient registration, persistent sessions, operator onboarding and doctor approval work with separate credentials',async()=>{
      const response=await req(null,'POST','/auth/register-patient',{username:'synthetic_'+randomBytes(6).toString('hex'),password,phone:'SYNTHETIC',sex:'H'});
      assert.equal(response.statusCode,201);
      patient=response.json().user;
      const login=await req(null,'POST','/auth/login',{username:patient.username,password});
      assert.equal(login.statusCode,200);patientToken=login.json().token;
      const refresh=await req(null,'POST','/auth/refresh',{refreshToken:login.json().refreshToken});
      assert.equal(refresh.statusCode,200);patientToken=refresh.json().token;
      const username='synthetic_doc_'+randomBytes(6).toString('hex');
      const onboard=spawnSync(process.execPath,['ops/db-command.mjs','doctor-onboard'],{
        input:JSON.stringify({action:'create',username,password,verificationReference:'synthetic-permission-test'}),
        env:{...process.env,KUVI_DATABASE_PROFILES:context.testProfiles,KUVI_OPERATOR_CONFIRM:'1'},encoding:'utf8',timeout:30000});
      assert.equal(onboard.status,0);
      doctor={id:JSON.parse(onboard.stdout).userId,username};
      const dl=await req(null,'POST','/auth/login',{username,password});
      assert.equal(dl.statusCode,200);doctorToken=dl.json().token;
      assert.equal((await req(doctorToken,'GET','/doctor/me')).statusCode,200);
    });
    await t.test('consent, questionnaire, history and doctor reads work without approval-table writes',async()=>{
      await dbs.migration.query(`INSERT INTO public."QuestionnaireQuestion"(id,"groupId","askGroup","questionText","answerType","updatedAt") VALUES ('synthetic-question',1,'synthetic','Synthetic question','text',now())`);
      assert.equal((await req(patientToken,'GET','/questionnaire/vegetative-functions')).statusCode,200);
      assert.equal((await req(patientToken,'POST','/questionnaire/answers',{answers:[{questionId:'synthetic-question',value:'Synthetic answer'}]})).statusCode,200);
      assert.equal((await req(patientToken,'POST','/medical-history/me',{noteType:'synthetic',noteText:'Synthetic history'})).statusCode,201);
      assert.equal((await req(patientToken,'POST','/sharing/doctor-grants',{doctorId:doctor.id,scopes:['summary','questionnaire','medical-history'],expiresAt:new Date(Date.now()+86400000).toISOString(),expectedVersion:0})).statusCode,200);
      for(const scope of ['summary','questionnaire','medical-history'])assert.equal((await req(doctorToken,'GET',`/doctor/patients/${patient.id}/${scope}`)).statusCode,200);
    });
    await t.test('assigned appointment, doctor confirmation, note and prescription lifecycle work through HTTP',async()=>{
      const id='synthetic-consultation';
      const op=async(token,action,asDoctor=false)=>{
        const response=await req(token,'POST',asDoctor?`/appointments/doctor/${patient.id}/operations`:'/appointments/me/operations',{operationId:randomUUID(),action});
        assert.equal(response.statusCode,200,`appointment ${action.type} HTTP status`);return response.json();
      };
      let row=await op(patientToken,{type:'save',id,expectedVersion:0,appointment:{doctorId:doctor.id,doctorName:'Synthetic doctor',specialty:'General',
        start:new Date(Date.now()-600000).toISOString(),end:new Date(Date.now()+1800000).toISOString(),timezone:'America/Mexico_City',location:'Synthetic',modality:'in_person',reminder24h:false,reminder1h:false}});
      row=await op(doctorToken,{type:'confirm',id,expectedVersion:row.version},true);
      row=await op(doctorToken,{type:'clinical_note',id,expectedVersion:row.version,noteId:'synthetic-note',text:'Synthetic doctor note'},true);
      row=await op(doctorToken,{type:'issue_prescription',id,expectedVersion:row.version,prescriptionId:'synthetic-rx',instructions:'Synthetic only',items:[{id:'synthetic-item',name:'Synthetic item',dose:'Test',route:'Test',frequency:'Test',duration:'Test'}]},true);
      await op(doctorToken,{type:'revoke_prescription',id,expectedVersion:row.version,prescriptionId:'synthetic-rx',reason:'Synthetic correction'},true);
      assert.equal((await req(patientToken,'GET',`/appointments/me/${id}`)).statusCode,200);
      assert.equal((await req(patientToken,'GET','/medications/me')).statusCode,200);
      assert.equal((await req(patientToken,'GET','/documents/me')).statusCode,200);
    });
  }finally{
    await app.close();await prisma.$disconnect();
    for(const client of Object.values(dbs))await client.end();
  }
});
