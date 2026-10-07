import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const packScript=fileURLToPath(new URL('./pack-plugin.mjs',import.meta.url));
const verifyScript=fileURLToPath(new URL('./verify-plugin.py',import.meta.url));
function fixture(t,changes={}) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'compositor-pack-'));
  t.after(()=>{
    const relative=path.relative(path.resolve(os.tmpdir()),path.resolve(root));
    assert.ok(relative.startsWith('compositor-pack-') && !relative.includes(path.sep));
    fs.rmSync(root,{recursive:true,force:true});
  });
  fs.mkdirSync(path.join(root,'dist'));
  fs.writeFileSync(path.join(root,'dist/index.html'),'<html>test</html>');
  fs.writeFileSync(path.join(root,'logo.svg'),'<svg xmlns="http://www.w3.org/2000/svg"/>');
  fs.writeFileSync(path.join(root,'plugin.json'),JSON.stringify({packid:'plugin-a',uuid:'plugin-a',version:'1.0.0',entry:'dist/index.html',devUrl:'http://localhost:5191',quickDev:true,...changes}));
  return root;
}
function pack(root,args=[]) {return spawnSync(process.execPath,[packScript,...args],{cwd:root,encoding:'utf8'});}
function inspectZip(file) {
  const result=spawnSync('python',['-c','import json,sys,zipfile; z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None; print(json.dumps({"manifest":json.loads(z.read("plugin.json")),"names":z.namelist()}))',file],{encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);return JSON.parse(result.stdout);
}
test('release package removes dev flags and exports a verifiable flat bundle',t=>{
  const root=fixture(t);const result=pack(root,['--version','1.2.0']);assert.equal(result.status,0,result.stderr);
  const zipped=inspectZip(path.join(root,'dist-pack/plugin-a-1.2.0.oplg'));
  assert.equal(zipped.manifest.devUrl,undefined);
  assert.equal(zipped.manifest.quickDev,undefined);
  assert.equal(zipped.manifest.version,'1.2.0');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root,'dist-pack/plugin.json'),'utf8')),zipped.manifest);
  assert.ok(fs.existsSync(path.join(root,'dist-pack/SHA256SUMS')));
  assert.ok(fs.existsSync(path.join(root,'dist-pack/logo.svg')));
  const verified=spawnSync('python',[verifyScript,path.join(root,'dist-pack')],{encoding:'utf8'});
  assert.equal(verified.status,0,verified.stderr);
  fs.appendFileSync(path.join(root,'dist-pack/plugin-a-1.2.0.oplg'),'tampered');
  assert.notEqual(spawnSync('python',[verifyScript,path.join(root,'dist-pack')],{encoding:'utf8'}).status,0);
});
test('missing entry and path-like versions cannot produce a release package',t=>{
  const root=fixture(t,{entry:''});
  assert.notEqual(pack(root).status,0);
  const other=fixture(t);
  assert.notEqual(pack(other,['--version','../../outside']).status,0);
});
