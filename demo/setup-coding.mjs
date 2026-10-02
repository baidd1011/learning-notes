import {mkdir,copyFile} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const destination=new URL('./.runtime/coding-deps/',import.meta.url);await mkdir(destination,{recursive:true});
for(const [source,target]of [['coding-package.json','package.json'],['coding-package-lock.json','package-lock.json']])await copyFile(new URL(source,import.meta.url),new URL(target,destination));
const npm=process.platform==='win32'?'npm.cmd':'npm';
const child=process.platform==='win32'
 ? spawn(process.env.ComSpec??'cmd.exe',['/d','/s','/c','npm ci --ignore-scripts --no-audit --no-fund'],{cwd:fileURLToPath(destination),stdio:'inherit',windowsHide:true})
 : spawn(npm,['ci','--ignore-scripts','--no-audit','--no-fund'],{cwd:fileURLToPath(destination),stdio:'inherit'});
child.on('exit',code=>process.exitCode=code??1);
