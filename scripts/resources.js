// Optional local Docker resource collector. Run in a separate terminal during a study.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, open } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
const exec=promisify(execFile);
const services=process.argv.slice(2);
if(!services.length || services.some(name=>!['mysql','cockroach','cockroach2','cockroach3'].includes(name)))throw new Error('Usage: npm run resources -- mysql cockroach [cockroach2 cockroach3]');
const seconds=Number(process.env.RESOURCE_SECONDS || 600),interval=Number(process.env.RESOURCE_INTERVAL_SECONDS || 1);
if(!Number.isFinite(seconds)||seconds<1||seconds>86400||!Number.isFinite(interval)||interval<1||interval>60)throw new Error('Resource duration must be 1–86400 seconds, interval 1–60 seconds');
const composeArgs=process.env.RESOURCE_CLUSTER==='true' ? ['compose','-f','docker-compose.yml','-f','docker-compose.cluster.yml'] : ['compose'];
const {stdout}=await exec('docker',[...composeArgs,'ps','--quiet',...services]);
const containers=stdout.trim().split(/\s+/).filter(Boolean);if(!containers.length)throw new Error('No running database containers found');
const output=resolve(import.meta.dirname,'../results');await mkdir(output,{recursive:true});const filename=resolve(output,`resources-${Date.now()}.jsonl`),file=await open(filename,'wx');
const deadline=Date.now()+seconds*1000;
try{while(Date.now()<deadline){const started=Date.now();const {stdout}=await exec('docker',['stats','--no-stream','--format','{{json .}}',...containers],{timeout:30000});for(const line of stdout.trim().split('\n').filter(Boolean))await file.write(JSON.stringify({timestamp:new Date().toISOString(),sampling_elapsed_ms:Date.now()-started,...JSON.parse(line)})+'\n');await pause(Math.max(0,interval*1000-(Date.now()-started)));}}finally{await file.close();}
console.log(`Docker CPU/memory/network/block-I/O samples saved: ${filename}`);
