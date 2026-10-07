import { readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
for (const directory of ['src','scripts','public','test']) {
  for (const file of await readdir(resolve(import.meta.dirname,'..',directory))) {
    if (!file.endsWith('.js')) continue;
    const result=spawnSync(process.execPath,['--check',resolve(import.meta.dirname,'..',directory,file)],{stdio:'inherit'});
    if (result.status !== 0) process.exit(result.status || 1);
  }
}
console.log('JavaScript syntax checks passed.');
