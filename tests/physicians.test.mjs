import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import jwt from '@fastify/jwt';
import { prisma } from '../dist/infrastructure/db/prisma.js';
import { profileUrl, parseSearch, parseProfile, fetchPublic, BraveDiscovery } from '../dist/modules/physicians/providers.js';
import { PhysicianDirectory, configuredDiscovery } from '../dist/modules/physicians/physicians.service.js';
import { SerperDiscovery } from '../dist/modules/physicians/serper.js';
import { physicianMetrics } from '../dist/modules/physicians/physicians.metrics.js';
import { physiciansRoutes } from '../dist/modules/physicians/physicians.routes.js';
import { applyAppointmentOperation } from '../dist/modules/appointments/appointments.service.js';

if (!process.env.APPOINTMENT_TEST_SCHEMA?.startsWith('kuvi_appts_test_') ||
 new URL(process.env.DATABASE_URL).searchParams.get('schema') !== process.env.APPOINTMENT_TEST_SCHEMA)
 throw Error('Isolated schema required');
const url = 'https://www.doctoralia.com.mx/perfil/arturo-delgado-pesero';
const photo='https://s3.us-east-1.amazonaws.com/doctoralia.com.mx/doctor/abc/abc_220_square.jpg';
const fixture = `<link rel="canonical" href="${url}">
<script type="application/ld+json">{"@type":"Physician","name":"Dr. Arturo Delgado Pesero","url":"${url}"}</script>
<div data-test-id="doctor-specializations"><a title="Nefrólogo">Nefrólogo</a><a title="Internista">Internista</a></div>
<section data-id="doctor-address-item"><span data-test-id="address-info-name">Consultorio 711</span><div class="profile-address-card__location"><span data-test-id="address-info-street">Montevideo 303</span>, Ciudad de México</div></section>
<section data-id="doctor-address-item"><span data-test-id="address-info-name">En línea</span></section>`;

test('provider parsing and network boundaries', async t => {
 await t.test('photo comes only from verified profile, supports protocol-relative CDN, excludes logos and unsafe URLs',()=>{
  const withImage=fixture+`<meta property="og:image" content="${photo.replace('https:','')}">`;
  assert.equal(parseProfile(withImage,url).photoUrl,photo);
  assert.equal(parseProfile(withImage,url).photoSourceUrl,url);
  assert.equal(parseProfile(fixture,url).photoUrl,null);
  for(const bad of ['http://127.0.0.1/photo.jpg','https://evil.test/avatar.jpg',
    'https://s3.us-east-1.amazonaws.com/other/logo.jpg','https://user@s3.us-east-1.amazonaws.com/doctoralia.com.mx/doctor/abc/a.jpg']) {
   const p=parseProfile(fixture+`<meta property="og:image" content="${bad}">`,url);
   assert.equal(p.photoUrl,null); assert.equal(p.photoSourceUrl,null);
  }
  assert.throws(()=>parseProfile(withImage,url+'-wrong'),{code:'UNVERIFIED_PROFILE'});
  const structured=fixture.replace('"@type":"Physician"',`"@type":"Physician","image":{"contentUrl":"${photo}"}`);
  assert.equal(parseProfile(structured,url).photoUrl,photo);
 });
 await t.test('Serper selection and request filtering, locale and deduplication', async () => {
  assert.equal(configuredDiscovery({}),undefined);
  assert.equal(configuredDiscovery({SERPER_API_KEY:' ',BRAVE_SEARCH_API_KEY:'x'}).name,'web_search');
  assert.equal(configuredDiscovery({SERPER_API_KEY:'x',BRAVE_SEARCH_API_KEY:'y'}).name,'serper');
  const p=new SerperDiscovery('test-secret',async (endpoint,options)=>{
   assert.equal(endpoint,'https://google.serper.dev/search'); assert.equal(options.method,'POST');
   assert.equal(options.redirect,'manual'); assert.equal(options.headers['X-API-KEY'],'test-secret');
   const body=JSON.parse(options.body); assert.equal(body.gl,'mx'); assert.equal(body.hl,'es');
   assert.equal(body.q.includes('site:doctoralia.com.mx'),true); assert.equal(body.q.includes('Arturo'),true);
   assert.equal(options.headers.authorization,undefined);
   return Response.json({organic:[{title:'Arturo',link:url},{title:'duplicate',link:url+'?tracking=1'},
    {title:'listing',link:'https://www.doctoralia.com.mx/nefrologo/texcoco/san-pedro3'}, {title:'bad',link:'https://evil.test/perfil/arturo'},null,{title:'bad',link:5}]});
  });
  const rows=await p.search({query:'Arturo Delgado',city:'CDMX',specialty:'Nefrólogo'});
  assert.equal(rows.length,1); assert.equal(rows[0].profileUrl,url);
 });
 await t.test('Serper failures do not follow redirects or expose keys', async () => {
  for (const response of [new Response('',{status:302,headers:{location:'https://evil.test'}}),
    new Response('',{status:429}), Response.json({message:'error'}),
    new Response('x'.repeat(1024*1024+1),{headers:{'content-type':'application/json'}})]) {
   let calls=0;
   const p=new SerperDiscovery('test-secret',async()=>{calls++;return response;});
   await assert.rejects(p.search({query:'Arturo',city:'',specialty:''}),e=>!e.message.includes('test-secret'));
   assert.equal(calls,1);
  }
  assert.deepEqual(await new SerperDiscovery('x',async()=>Response.json({organic:[]})).search({query:'Arturo',city:'',specialty:''}),[]);
 });
 await t.test('recognizes empty results without accepting blocked HTML', () => {
  assert.deepEqual(parseSearch('<div data-test-id="search-listing-container"></div><h1>No hemos encontrado ningún Arturo Delgado</h1>'), []);
  assert.throws(() => parseSearch('<h1>Captcha</h1>'), { code: 'UNREADABLE_PROVIDER_SEARCH' });
 });
 await t.test('extracts verified identity and separates offices, rejects mismatched canonical', () => {
  const p = parseProfile(fixture, url);
  assert.deepEqual(p.specialties, ['Nefrólogo', 'Internista']); assert.equal(p.offices.length, 1);
  assert.equal(p.offices[0].address, 'Montevideo 303, Ciudad de México');
  assert.throws(() => parseProfile(fixture, url + '-other'), { code: 'UNVERIFIED_PROFILE' });
  for (const u of ['http://www.doctoralia.com.mx/perfil/a','https://evil.test/perfil/a','https://www.doctoralia.com.mx@evil.test/perfil/a','https://www.doctoralia.com.mx:444/perfil/a','https://www.doctoralia.com.mx/tratamientos-servicios/a/b']) assert.equal(profileUrl(u), null);
 });
 await t.test('deduplicates search cards and excludes clinics', () => {
  const card = `<div data-test-id="result-item" data-test-entity-type="doctor" data-doctor-name="Arturo" data-doctor-url="${url}"></div>`;
  assert.equal(parseSearch(`<div data-test-id="search-list">${card}${card}${card.replace('type="doctor"','type="clinic"')}</div>`).length, 1);
 });
 await t.test('blocks unsafe redirect before fetching, limits size, no credentials sent', async () => {
  let calls = 0;
  await assert.rejects(fetchPublic(url, async (_url, options) => {
   calls++; assert.equal(options.redirect, 'manual'); assert.deepEqual(options.headers, { Accept: 'text/html' });
   return new Response('', { status: 302, headers: { location: 'http://127.0.0.1/private' } });
  }), { code: 'UNSAFE_PROVIDER_REDIRECT' }); assert.equal(calls, 1);
  await assert.rejects(fetchPublic(url, async () => new Response('x'.repeat(3*1024*1024+1), { headers: { 'content-type':'text/html' } })), { code: 'PROVIDER_RESPONSE_TOO_LARGE' });
  await assert.rejects(fetchPublic('https://evil.test', async () => { throw Error('Must not fetch'); }), { code: 'INVALID_PROVIDER_URL' });
 });
 await t.test('optional web discovery restricts output to public profiles and confines API key', async () => {
  const provider = new BraveDiscovery('test-key', async (u, options) => {
   const parsed = new URL(u); assert.equal(parsed.host, 'api.search.brave.com');
   assert.match(parsed.searchParams.get('q'), /site:doctoralia.com.mx/);
   assert.equal(options.headers['X-Subscription-Token'], 'test-key');
   return Response.json({ web: { results: [{ title: 'Arturo', url }, { title:'Wrong', url:'https://evil.test/perfil/a' }] } });
  });
  assert.equal((await provider.search({ query:'Arturo Delgado', city:'CDMX', specialty:'Nefrólogo' })).length, 1);
 });
});

test('directory persistence, appointment identity and aggregate metrics', async t => {
 const profile = parseProfile(fixture, url); let fetches = 0;
 const provider = { name:'doctoralia_public', search:async () => [], profile:async () => { fetches++; return profile; } };
 const directory = new PhysicianDirectory(provider, null);
 const patient = await prisma.user.create({ data: { username: randomUUID(), passwordHash:'test-only' } });
 const other = await prisma.user.create({ data: { username: randomUUID(), passwordHash:'test-only' } });
 const stranger = await prisma.user.create({ data: { username: randomUUID(), passwordHash:'test-only', role:'doctor' } });
 let physician;
 const apply = (actor, action, operationId = randomUUID()) => applyAppointmentOperation(actor, actor.id, { action, operationId });
 const save = (id, overrides = {}, expectedVersion = 0) => ({ type:'save', id, expectedVersion, appointment: {
  doctorId:null, directoryDoctorId:physician, doctorName:'Nombre corregido por paciente', specialty:'Nefrología',
  start:new Date(Date.now()-86400000).toISOString(), end:new Date(Date.now()-86300000).toISOString(),
  timezone:'America/Mexico_City', location:'Dirección corregida', modality:'in_person', reminder24h:true, reminder1h:true, ...overrides } });
 const app = Fastify(); await app.register(jwt, { secret:'physicians-isolated-test' });
 await app.register(physiciansRoutes, { prefix:'/physicians', directory }); await app.ready();
 const req = (actor, path, body, method = 'POST') => app.inject({ method, url:`/physicians/${path}`, payload:body,
  headers:actor ? { authorization:`Bearer ${app.jwt.sign({ sub:actor.id })}` } : {} });
 try {
  await t.test('concurrent imports persist one physician and use cache', async () => {
   const [a,b] = await Promise.all([directory.profile(url), directory.profile(url)]);
   physician = a.value.directoryDoctorId; assert.equal(physician, b.value.directoryDoctorId);
   assert.equal(await prisma.physicianSource.count({ where:{ profileUrl:url } }),1);
   const before = fetches; await directory.profile(url); assert.equal(fetches,before);
   const row = await prisma.physician.findUnique({ where:{id:physician} }); assert.equal(row.affiliationStatus,'external');
  });
  await t.test('local directory finds Arturo even when upstream name search is empty or down', async () => {
   const result = await directory.search({query:'Arturo Delgado',city:'CDMX',specialty:'Nefrólogo'});
   assert.equal(result.value[0].directoryDoctorId,physician); assert.ok(result.warnings.includes('web_search_not_configured'));
   const failing = new PhysicianDirectory({...provider,search:async()=>{throw Error('offline');}}, null);
   assert.equal((await failing.search({query:'Arturo Delgado',city:'',specialty:''})).value[0].directoryDoctorId,physician);
  });
  await t.test('legacy cached profiles refresh photo once; photo persists in cache/search and disappears on verified refresh',async()=>{
   await prisma.physician.update({where:{id:physician},data:{photoCheckedAt:null}});
   let calls=0;
   let current={...profile,photoUrl:photo,photoSourceUrl:url};
   const d=new PhysicianDirectory({...provider,profile:async()=>{calls++;return current;}},null);
   const a=await d.profile(url); assert.equal(a.value.photoUrl,photo); assert.equal(calls,1);
   const b=await d.profile(url); assert.equal(b.value.photoUrl,photo); assert.equal(b.value.photoSourceUrl,url); assert.equal(calls,1);
   assert.equal((await d.search({query:'Arturo Delgado',city:'',specialty:''})).value[0].photoUrl,photo);
   current={...profile,photoUrl:null,photoSourceUrl:null};
   await prisma.physicianSource.updateMany({where:{physicianId:physician},data:{fetchedAt:new Date(0)}});
   assert.equal((await d.profile(url)).value.photoUrl,null);
   assert.equal((await d.profile(url)).value.photoUrl,null); assert.equal(calls,2);
  });
  await t.test('search auth, body validation and rate limiting; metrics have no public endpoint', async () => {
   assert.equal((await req(null,'search',{query:'Arturo'})).statusCode,401);
   assert.equal((await req(patient,'search',{query:'a'})).statusCode,400);
   assert.equal((await req(patient,'profile',{url:'http://127.0.0.1'})).statusCode,400);
   assert.equal((await req(patient,'search',{query:'Arturo'})).statusCode,200);
   assert.equal((await req(patient,'metrics',undefined,'GET')).statusCode,404);
   for(let i=0;i<20;i++) await req(stranger,'search',{query:'Arturo'});
   assert.equal((await req(stranger,'search',{query:'Arturo'})).statusCode,429);
  });
  await t.test('discovery runs only for insufficient matches and preserves results during failure',async()=>{
   let calls=0;
   const discovery={name:'serper',search:async()=>{calls++;return [{...profile,name:'Otro Médico'}];}};
   const d=new PhysicianDirectory(provider,discovery);
   await d.search({query:'Arturo Delgado',city:'Ciudad de México',specialty:'Nefrólogo'});
   assert.equal(calls,0);
   await d.search({query:'Nombre Ausente',city:'',specialty:''}); assert.equal(calls,1);
   // A namesake or wrong specialty must not suppress fallback.
   await d.search({query:'Arturo Delgado',city:'',specialty:'Cardiólogo'}); assert.equal(calls,2);
   const failing=new PhysicianDirectory(provider,{name:'serper',search:async()=>{throw Error('quota');}});
   const r=await failing.search({query:'Arturo Delgado',city:'',specialty:'Cardiólogo'});
   assert.ok(r.warnings.includes('serper_unavailable')); assert.ok(r.value.some(v=>v.directoryDoctorId===physician));
  });
  await t.test('idempotent retries, edits, archive and cancellation do not inflate completed counts', async () => {
   const action = save('one'), op = randomUUID();
   await Promise.all([apply(patient,action,op), apply(patient,action,op)]);
   await apply(patient,save('one',{location:'Consultorio actualizado'},1));
   await apply(patient,{type:'status',id:'one',expectedVersion:2,status:'completed',reason:'Asistí'});
   await apply(patient,{type:'archive',id:'one',expectedVersion:3,archived:true});
   await apply(patient,save('two')); await apply(patient,{type:'status',id:'two',expectedVersion:1,status:'completed',reason:'Asistí'});
   await apply(other,save('three')); await apply(other,{type:'status',id:'three',expectedVersion:1,status:'completed',reason:'Asistí'});
   await apply(other,save('cancel')); await apply(other,{type:'status',id:'cancel',expectedVersion:1,status:'cancelled',reason:'Cancelé'});
   await apply(other,save('future',{start:new Date(Date.now()+86400000).toISOString(),end:new Date(Date.now()+86500000).toISOString()}));
   const rows = await physicianMetrics(new Date(Date.now()-90*86400000));
   const m=rows.find(r=>r.id===physician);
   assert.equal(m.registeredAppointments,5); assert.equal(m.distinctPatients,2);
   assert.equal(m.completedAppointments,3); assert.equal(m.recentCompletedAppointments,3);
   assert.equal(m.recentDistinctPatients,2); assert.equal(m.returningPatients,1); assert.equal(m.cancelledAppointments,1);
   assert.equal('userId' in m,false); assert.equal('patientNotes' in m,false);
   const short = (await physicianMetrics(new Date(Date.now()-3600000))).find(r=>r.id===physician);
   assert.equal(short.recentCompletedAppointments,0);
  });
  await t.test('legacy client omission preserves association and verified refresh never overwrites appointment text', async () => {
   const a=save('legacy'); delete a.appointment.directoryDoctorId;
   await apply(patient,a); const retry=randomUUID(); const legacyOp=save('old-client-retry'); delete legacyOp.appointment.directoryDoctorId;
   await apply(patient,legacyOp,retry); await apply(patient,legacyOp,retry);
   const update=save('future',{},1); delete update.appointment.directoryDoctorId;
   await apply(other,update);
   assert.equal((await prisma.appointment.findUnique({where:{userId_id:{userId:other.id,id:'future'}}})).directoryDoctorId,physician);
   await prisma.physicianSource.updateMany({where:{physicianId:physician},data:{fetchedAt:new Date(0)}});
   await directory.profile(url);
   const row=await prisma.appointment.findUnique({where:{userId_id:{userId:patient.id,id:'two'}}});
   assert.equal(row.doctorName,'Nombre corregido por paciente'); assert.equal(row.location,'Dirección corregida');
   await assert.rejects(apply(other,save('future',{directoryDoctorId:null},2)),{code:'DIRECTORY_DOCTOR_CHANGE_REQUIRES_NEW_APPOINTMENT'});
   await assert.rejects(apply(patient,save('bad',{directoryDoctorId:'missing'})),{code:'INVALID_DIRECTORY_DOCTOR'});
  });
 } finally { await app.close(); await prisma.$disconnect(); }
});
