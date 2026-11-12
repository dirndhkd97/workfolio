import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { stripTypeScriptTypes } from 'node:module';
const directory = mkdtempSync(join(tmpdir(),'workfolio-images-'));
const root = new URL('../',import.meta.url);
const compile = (path,name,rewrite = value => value) => writeFileSync(join(directory,name),rewrite(stripTypeScriptTypes(readFileSync(new URL(path,root),'utf8'))));
compile('src/lib/community/domain.ts','domain.mjs');
compile('functions/_lib/community-images.ts','images.mjs',value=>value
  .replace(/import \{ getCommunityIdentity[^\n]+community-auth';/, "const getCommunityIdentity = async request => ({'owner-session':'owner','visitor-session':'visitor'})[request.headers.get('x-test-session')] || null;")
  .replace("'../../src/lib/community/domain'","'./domain.mjs'"));
for (const [path,name] of [['functions/api/community-images/index.ts','upload.mjs'],['functions/api/community-images/[id].ts','image.mjs']]) compile(path,name,value=>value.replace("'../../_lib/community-images'","'./images.mjs'"));
const {onRequest:upload} = await import(pathToFileURL(join(directory,'upload.mjs')).href);
const {onRequest:imageRoute} = await import(pathToFileURL(join(directory,'image.mjs')).href);
const {inspectImage,IMAGE_BYTES,cleanupImages,readPostImages} = await import(pathToFileURL(join(directory,'images.mjs')).href);
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=','base64');
let db,env,objects,background;
function adapter(connection) {
  function prepare(sql,bindings=[]) {return {
    bind(...args){return prepare(sql,args)},
    async first(){return connection.prepare(sql).get(...bindings)||null},
    async all(){return {results:connection.prepare(sql).all(...bindings)}},
    async run(){return {meta:{changes:Number(connection.prepare(sql).run(...bindings).changes)}}},
  }};
  return {prepare};
}
beforeEach(()=>{
  db?.close();db = new DatabaseSync(':memory:');
  db.exec(readFileSync(new URL('migrations/0006_community_board.sql',root),'utf8'));
  db.exec(readFileSync(new URL('migrations/0012_community_post_images.sql',root),'utf8'));
  objects=new Map();background=[];
  env={DB:adapter(db),COMMUNITY_IMAGES:{
    async put(key,bytes,options){objects.set(key,{bytes:Uint8Array.from(bytes),options});return {key}},
    async get(key){const item=objects.get(key);return item ? {body:item.bytes,httpEtag:`"${key}"`} : null},
    async delete(key){objects.delete(key)},
  }};
});
after(()=>{db?.close();rmSync(directory,{recursive:true,force:true})});
async function uploadRequest(bytes=png,user='owner',extra={}) {
  const response = await upload({env,waitUntil:task=>background.push(task),request:new Request('https://board.example/api/community-images',{method:'POST',headers:{origin:'https://board.example','content-type':'image/png',...(user?{'x-test-session':`${user}-session`}:{}),...extra},body:bytes})});
  await Promise.all(background.splice(0));return response;
}
async function route(id,method='GET',user=null,extra={}) {
  const response = await imageRoute({env,params:{id},waitUntil:task=>background.push(task),request:new Request(`https://board.example/api/community-images/${id}`,{method,headers:{...(user?{'x-test-session':`${user}-session`}:{}),...(method==='DELETE'?{origin:'https://board.example','content-type':'application/json'}:{}),...extra}})});
  await Promise.all(background.splice(0));return response;
}
async function createUpload(){const response=await uploadRequest();assert.equal(response.status,201);return (await response.json()).image}
function attach(imageId){db.prepare('INSERT INTO community_posts VALUES (?,?,?,?,?,?,?)').run('post','owner','title','body','category','nickname',Date.now());db.prepare("UPDATE community_post_images SET post_id='post',status='attached' WHERE id=?").run(imageId)}

test('raster upload accepts actual PNG bytes and exposes only id, own URL and dimensions',async()=>{
  const image=await createUpload();assert.deepEqual(Object.keys(image).sort(),['height','id','url','width']);
  assert.equal(image.width,1);assert.equal(image.height,1);assert.equal(image.url,`/api/community-images/${image.id}`);
  assert.equal(objects.size,1);assert.equal([...objects.values()][0].options.httpMetadata.contentType,'image/png');
  assert.equal(db.prepare('SELECT status FROM community_post_images').get().status,'pending');
  assert.deepEqual(await readPostImages(env.DB,'post'),[]);
});
test('upload requires session, same-origin request, supported real bytes and bounded actual stream',async()=>{
  assert.equal((await uploadRequest(png,null)).status,401);
  assert.equal((await uploadRequest(png,'owner',{origin:'https://evil.example'})).status,403);
  assert.equal((await uploadRequest(png,'owner',{'sec-fetch-site':'cross-site'})).status,403);
  assert.equal((await uploadRequest(png,'owner',{'content-type':'image/svg+xml'})).status,415);
  assert.equal((await uploadRequest(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'),'owner')).status,415);
  assert.equal((await uploadRequest(png,'owner',{'content-type':'image/jpeg'})).status,415);
  assert.equal((await uploadRequest(Buffer.alloc(IMAGE_BYTES+1),'owner')).status,413);
  const huge=Buffer.from(png);huge.writeUInt32BE(12001,16);
  assert.equal((await uploadRequest(huge,'owner')).status,413);
  assert.equal(objects.size,0);assert.equal(db.prepare('SELECT COUNT(*) n FROM community_post_images').get().n,0);
});
test('pending images are owner-only and no-store, attached images become public with revalidation and HEAD support',async()=>{
  const image=await createUpload();
  assert.equal((await route(image.id)).status,404);assert.equal((await route(image.id,'GET','visitor')).status,404);
  const own=await route(image.id,'GET','owner');assert.equal(own.status,200);assert.equal(own.headers.get('cache-control'),'private, no-store');assert.equal(own.headers.get('vary'),'Cookie');
  assert.equal(own.headers.get('content-type'),'image/png');assert.equal(own.headers.get('x-content-type-options'),'nosniff');assert.match(own.headers.get('content-security-policy'),/sandbox/);
  assert.deepEqual(Buffer.from(await own.arrayBuffer()),png);
  attach(image.id);
  const publicResponse=await route(image.id);assert.equal(publicResponse.status,200);assert.equal(publicResponse.headers.get('cache-control'),'public, max-age=0, must-revalidate');
  assert.deepEqual(await readPostImages(env.DB,'post'),[image]);
  const head=await route(image.id,'HEAD');assert.equal(head.status,200);assert.equal((await head.arrayBuffer()).byteLength,0);
  assert.equal((await route(image.id,'GET',null,{'if-none-match':publicResponse.headers.get('etag')})).status,304);
  assert.equal((await route(image.id,'DELETE','owner')).status,404,'attached images must be removed by deleting their post');
  db.prepare("DELETE FROM community_posts WHERE id='post'").run();
  assert.equal((await route(image.id,'GET',null,{'if-none-match':publicResponse.headers.get('etag')})).status,404,'deleted post must be checked before ETag');
});
test('only the pending owner may discard an upload; discarded and expired images are inaccessible',async()=>{
  const image=await createUpload();
  assert.equal((await route(image.id,'DELETE',null)).status,401);assert.equal((await route(image.id,'DELETE','visitor')).status,404);
  assert.equal((await route(image.id,'DELETE','owner',{origin:'https://evil.example'})).status,403);
  assert.equal((await route(image.id,'DELETE','owner')).status,200);
  assert.equal(objects.size,0);assert.equal((await route(image.id,'GET','owner')).status,404);
  const expired=await createUpload();db.prepare('UPDATE community_post_images SET expires_at=? WHERE id=?').run(Date.now()-1,expired.id);
  assert.equal((await route(expired.id,'GET','owner')).status,404);await cleanupImages(env);assert.equal(objects.size,0);
  assert.equal((await route('../private-key','GET','owner')).status,404);
});
test('upload quota is atomic, account-scoped and resets after an hour; pending uploads are capped',async()=>{
  db.prepare('INSERT INTO community_image_upload_limits VALUES (?,?,?)').run('owner',Date.now(),29);
  await createUpload();const blocked=await uploadRequest();assert.equal(blocked.status,429);assert.equal(blocked.headers.get('retry-after'),'3600');
  assert.equal((await uploadRequest(png,'visitor')).status,201);
  db.prepare('UPDATE community_image_upload_limits SET window_started_at=? WHERE owner_id=?').run(Date.now()-3600001,'owner');
  await createUpload();assert.equal(db.prepare('SELECT attempts FROM community_image_upload_limits WHERE owner_id=?').get('owner').attempts,1);
  const now=Date.now();
  for(let i=0;i<18;i++){const id=crypto.randomUUID();db.prepare("INSERT INTO community_post_images (id,owner_id,object_key,status,content_type,byte_size,width,height,created_at,expires_at) VALUES (?,?,?,'pending','image/png',1,1,1,?,?)").run(id,'owner',id,now,now+86400000)}
  assert.equal((await uploadRequest()).status,429);
});
test('storage failures are private and leave an inaccessible tombstone for retryable cleanup',async()=>{
  env.COMMUNITY_IMAGES.put=async()=>{throw new Error('private storage secret')};
  const response=await uploadRequest();assert.equal(response.status,503);assert.doesNotMatch(await response.text(),/private storage secret/);
  assert.equal(db.prepare('SELECT status FROM community_post_images').get().status,'deleted');
  await cleanupImages(env);assert.equal(db.prepare('SELECT COUNT(*) n FROM community_post_images').get().n,0);
  env.COMMUNITY_IMAGES=undefined;assert.equal((await uploadRequest()).status,503);
});
test('image routes reject unsupported methods and truncated raster containers',async()=>{
  const image=await createUpload();assert.equal((await route(image.id,'POST','owner')).status,405);
  const response=await upload({env,request:new Request('https://board.example/api/community-images'),waitUntil:()=>{}});assert.equal(response.status,405);
  for(const bytes of [png.subarray(0,24),Buffer.concat([png,Buffer.from('<script>')])]) assert.throws(()=>inspectImage(bytes,'image/png'));
  const jpeg=Buffer.from([255,216,255,192,0,11,8,0,2,0,3,1,1,17,0,255,218,0,2,0,255,217]);
  assert.throws(()=>inspectImage(jpeg,'image/jpeg'));// too short to be an image
  const padded=Buffer.concat([jpeg.subarray(0,-2),Buffer.from([0,0,0,0]),jpeg.subarray(-2)]);
  assert.deepEqual(inspectImage(padded,'image/jpeg'),{width:3,height:2});
  const webp=Buffer.alloc(30);webp.write('RIFF',0);webp.writeUInt32LE(22,4);webp.write('WEBPVP8 ',8);webp.writeUInt32LE(10,16);webp[23]=157;webp[24]=1;webp[25]=42;webp.writeUInt16LE(3,26);webp.writeUInt16LE(2,28);
  assert.deepEqual(inspectImage(webp,'image/webp'),{width:3,height:2});
  webp.writeUInt32LE(500,4);assert.throws(()=>inspectImage(webp,'image/webp'));
});


test('cleanup cannot delete an object claimed by a post after its initial candidate lookup',async()=>{
  const image=await createUpload();db.prepare('UPDATE community_post_images SET expires_at=? WHERE id=?').run(Date.now()-1,image.id);
  const original=env.DB.prepare;
  let interleaved=false;
  env.DB.prepare=(sql)=>{
    if(sql.includes("UPDATE community_post_images SET status = 'deleted' WHERE id")&&!interleaved){interleaved=true;attach(image.id)}
    return original(sql);
  };
  await cleanupImages(env);assert.equal(interleaved,true);assert.equal(objects.size,1);
  assert.equal(db.prepare('SELECT status FROM community_post_images WHERE id=?').get(image.id).status,'attached');
  assert.equal((await route(image.id)).status,200);
});
