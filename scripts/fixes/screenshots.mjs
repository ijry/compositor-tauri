import fs from 'node:fs/promises';
import {launch,pageFor} from '../audit/harness.mjs';
await fs.mkdir('docs/fixes/screenshots',{recursive:true});const b=await launch();
try{for(const [name,prepare]of [['workspace',null],['curves','Curves'],['raw','raw'],['filter','filterVignette']]){const p=await pageFor(b);if(prepare==='raw')await p.evaluate(()=>{auditHost.openPath='/audit/input.dng';return A.E.commands.run('openRaw');});else if(prepare==='Curves')await p.evaluate(()=>A.E.commands.run('addAdjustment','Curves'));else if(prepare)await p.evaluate(kind=>A.E.commands.run('openFilter',kind),prepare);await p.waitForTimeout(400);await p.screenshot({path:'docs/fixes/screenshots/'+name+'.png'});await p.close();}}finally{await b.close();}
