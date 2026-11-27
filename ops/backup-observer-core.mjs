// No dependencies: shared by the Windows observer and synthetic tests.
export const backupName=/^kuvi-db-\d{8}T\d{6}Z-[a-f0-9]{8}\.dump\.gpg$/;
export function validLatest(value){
 return Boolean(value&&backupName.test(value.filename||'')&&/^[a-f0-9]{64}$/.test(value.sha256||'')&&/^[a-f0-9]{64}$/.test(value.sourceIdentity||'')&&Number.isSafeInteger(value.bytes)&&value.bytes>0&&value.bytes<=20*1024**3&&Number.isFinite(Date.parse(value.createdAt)));
}
export function directNasStatus(report,now=Date.now()){
 const nas=report?.nas;
 if(!nas||!['succeeded','running','failed'].includes(nas.state))return {nasCopy:'unavailable',nasPullStatus:null};
 const running=nas.state==='running',runningAge=now-Date.parse(nas.startedAt);
 const latest=running?nas.lastSuccessLatest:nas.latest;
 const matches=validLatest(latest)&&validLatest(report.latest)&&latest.filename===report.latest.filename&&latest.sha256===report.latest.sha256&&latest.bytes===report.latest.bytes&&latest.sourceIdentity===report.latest.sourceIdentity;
 return {nasCopy:matches?'ok':'missing',nasPullStatus:{ok:nas.state==='succeeded'||(running&&Number.isFinite(runningAge)&&runningAge>=-300000&&runningAge<=3600000),at:running?(nas.lastSuccessAt??nas.startedAt):nas.finishedAt}};
}
export function evaluateBackupHealth({now=Date.now(),report,sourceIdentity,pullStatus,nasPullStatus,pcCopy,nasCopy,requireNas=true,requirePcCopy=true,maxBackupAgeHours=36,maxPullAgeHours=3,copyGraceHours=2,maxNasPullAgeHours=maxPullAgeHours,nasCopyGraceHours=copyGraceHours}){
 const codes=[],pending=[];const hour=3600000;
 const age=value=>{const t=Date.parse(value);return Number.isFinite(t)?now-t:NaN;};
 const add=code=>{if(!codes.includes(code))codes.push(code);};
 const reportValid=report?.ok===true&&report.format==='kuvi-backup-health'&&report.version===1;
 if(!reportValid)add('SERVER_CHECK_FAILED');
 if(reportValid){
  const reportAge=age(report.checkedAt);
  if(!Number.isFinite(reportAge)||reportAge < -300000||reportAge>15*60000)add('SERVER_CLOCK_OR_REPORT_INVALID');
  const latest=report.latest;
  if(!validLatest(latest))add('BACKUP_MISSING_OR_INVALID');
  else{
   if(latest.sourceIdentity!==sourceIdentity)add('BACKUP_SOURCE_CHANGED');
   const backupAge=age(latest.createdAt);
   if(backupAge < -300000)add('BACKUP_CLOCK_INVALID');
   if(backupAge>maxBackupAgeHours*hour)add('SERVER_BACKUP_STALE');
   for(const [prefix,copy,required] of [['PC',pcCopy,requirePcCopy],['NAS',nasCopy,requireNas]]){
    if(!required)continue;
    if(copy==='ok')continue;
    const grace=prefix==='NAS'?nasCopyGraceHours:copyGraceHours;
    if(copy==='missing'&&backupAge>=0&&backupAge<=grace*hour)pending.push(prefix+'_COPY_PENDING');
    else add(prefix+(copy==='corrupt'?'_COPY_CORRUPT':copy==='missing'?'_COPY_MISSING':'_UNAVAILABLE'));
   }
  }
  const job=report.job;
  if(!job)add('SERVER_JOB_STATUS_MISSING');
  else if(!['running','succeeded','failed'].includes(job.state)||!Number.isFinite(age(job.startedAt))||age(job.startedAt)<-300000)add('SERVER_JOB_STATUS_INVALID');
  else if(job.state==='failed')add('SERVER_BACKUP_JOB_FAILED');
  else if(job.state==='running'&&age(job.startedAt)>hour)add('SERVER_BACKUP_JOB_STALLED');
  else if(job.state==='succeeded'&&(!Number.isFinite(age(job.finishedAt))||age(job.finishedAt)<-300000))add('SERVER_JOB_STATUS_INVALID');
 }
 const pullAge=age(pullStatus?.at);
 if(requirePcCopy){
  if(!pullStatus||!Number.isFinite(pullAge)||pullAge < -300000)add('PC_PULL_STATUS_INVALID');
  else{if(pullStatus.ok!==true)add('PC_PULL_FAILED');if(pullAge>maxPullAgeHours*hour)add('PC_PULL_STALE');}
 }
 if(requireNas){
  const nasAge=age(nasPullStatus?.at);
  if(!nasPullStatus||!Number.isFinite(nasAge)||nasAge < -300000)add('NAS_PULL_STATUS_INVALID');
  else{if(nasPullStatus.ok!==true)add('NAS_PULL_FAILED');if(nasAge>maxNasPullAgeHours*hour)add('NAS_PULL_STALE');}
 }
 return {ok:codes.length===0,codes,pending,checkedAt:new Date(now).toISOString(),latestCreatedAt:validLatest(report?.latest)?report.latest.createdAt:null};
}
export function notificationDecision(previous,current,now=Date.now(),repeatHours=6){
 const priorCodes=Array.isArray(previous?.lastNotifiedCodes)?previous.lastNotifiedCodes:Array.isArray(previous?.codes)?previous.codes:[];
 const changed=JSON.stringify([...priorCodes].sort())!==JSON.stringify([...current.codes].sort());
 const elapsed=now-Date.parse(previous?.lastNotifiedAt);
 if(!current.ok&&(changed||!previous||!Number.isFinite(elapsed)||elapsed>=repeatHours*3600000))return 'problem';
 if(current.ok&&previous?.ok===false)return 'recovered';
 return null;
}
