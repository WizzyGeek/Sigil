import test from 'node:test'
import assert from 'node:assert/strict'
import { PeerNoteRequests, validNoteJti } from '../src/history/peerNoteRequests.ts'
import { buildCommand, verifyUnt } from '../src/crypto/unt.ts'
import { signFrame } from '../src/crypto/jwt.ts'
import { createRegistryKeyring } from '../src/crypto/registryTrust.ts'
import { peerFingerprint } from '../src/history/peerHistory.ts'

const fixture=(async()=>{
 const algorithm={name:'RSASSA-PKCS1-v1_5',modulusLength:2048,publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'}
 const registry=await crypto.subtle.generateKey(algorithm,true,['sign','verify']),authors=await Promise.all([0,1].map(()=>crypto.subtle.generateKey(algorithm,true,['sign','verify'])))
 const pems=await Promise.all(authors.map(async pair=>`-----BEGIN PUBLIC KEY-----\n${Buffer.from(await crypto.subtle.exportKey('spki',pair.publicKey)).toString('base64')}\n-----END PUBLIC KEY-----`)),fps=await Promise.all(pems.map(peerFingerprint)),keys=createRegistryKeyring([['https://registry.test',registry.publicKey]])
 const stakes=await Promise.all(pems.map((public_key,i)=>signFrame({iss:'registry.test',iat:1,public_key,user_tag:`@user${i}`,display_name:null},registry.privateKey)))
 const original=await signFrame({jti:'old-original',iat:2,type:'note',channel:'general',content:'an old parent',stake:stakes[1],stake_iat:1},authors[1].privateKey)
 return {authors,keys,stakes,fps,original}
})()
async function setup(t,overrides={}){
 const f=await fixture,sent=[],saved=[],received=[],errors=[]
 const make=(i,extra={})=>new PeerNoteRequests({fingerprint:f.fps[i],privateKey:f.authors[i].privateKey,keys:f.keys,getStake:async()=>f.stakes[i],send:frame=>sent.push({from:i,frame}),readNote:async()=>undefined,save:async note=>{saved.push(note);return true},onNote:note=>received.push(note),onError:error=>errors.push(error),timeoutMs:1000,...extra})
 const requester=make(0,overrides),responder=make(1,{readNote:async jti=>jti===f.original[0].jti?await verifyUnt(f.original,f.keys):undefined})
 t.after(()=>{requester.dispose();responder.dispose()})
 async function untilSent(n){for(let i=0;i<200&&sent.length<n;i++)await new Promise(r=>setTimeout(r,2));assert.ok(sent.length>=n)}
 return {...f,sent,saved,received,errors,requester,responder,untilSent}
}
test('direct lookup sends one request and one original, accepts old notes without a history scan, and coalesces concurrent requests',async t=>{
 const w=await setup(t),first=w.requester.request('general','old-original'),same=w.requester.request('general','old-original')
 assert.equal(first,same);await w.untilSent(1)
 assert.equal(w.sent[0].frame[0].type,'request_note');assert.equal(w.sent[0].frame[0].note_jti,'old-original');assert.equal(w.sent[0].frame[0].before,undefined)
 await w.responder.handle(w.sent[0].frame);await w.untilSent(2)
 assert.equal(w.sent[1].frame[0].relays.length,1)
 await w.requester.handle(w.sent[1].frame);assert.equal(await first,true);assert.equal(w.saved.length,1);assert.equal(w.received.length,1);assert.deepEqual(w.errors,[])
 await w.requester.handle(w.sent[1].frame);assert.equal(w.saved.length,1)
})
test('wrong request, recipient, target, channel, batch, tampered and untrusted originals cannot satisfy a lookup',async t=>{
 const w=await setup(t),pending=w.requester.request('general','old-original');await w.untilSent(1)
 const request=w.sent[0].frame[0],tampered=structuredClone(w.original);tampered[0].content='forged'
 const unknown=structuredClone(w.original);unknown[0].stake[0].iss='untrusted.test'
 async function reply(patch){return buildCommand('note_relay','general',w.stakes[1],w.authors[1].privateKey,{to:w.fps[0],request_jti:request.jti,note_jti:'old-original',relays:[w.original],...patch})}
 for(const patch of [{request_jti:'unsolicited'},{to:'wrong'},{note_jti:'different'},{channel:'elsewhere'},{relays:[w.original,w.original]}])await w.requester.handle(await reply(patch))
 for(const raw of [tampered,unknown])await assert.rejects(w.requester.handle(await reply({relays:[raw]})))
 const wrong=await signFrame({...w.original[0],jti:'other-note'},w.authors[1].privateKey);await w.requester.handle(await reply({relays:[wrong]}))
 assert.equal(w.saved.length,0)
 await w.requester.handle(await reply({}));assert.equal(await pending,true);assert.equal(w.saved.length,1)
})
test('responders use exact primary-key lookup, enforce channel, suppress duplicate requests, and stay silent for missing notes',async t=>{
 const w=await setup(t),make=(channel,note_jti)=>buildCommand('request_note',channel,w.stakes[0],w.authors[0].privateKey,{note_jti})
 for(const frame of [await make('other','old-original'),await make('general','missing'),await make('general','')])await w.responder.handle(frame)
 assert.equal(w.sent.length,0)
 const request=await make('general','old-original');await w.responder.handle(request);await w.responder.handle(request);assert.equal(w.sent.length,1)
})
test('timeouts do not retry; dispose cancels pending work; invalid selectors and the pending limit send nothing extra',async t=>{
 const w=await setup(t,{timeoutMs:25}),lookups=[]
 assert.equal(validNoteJti('😀'.repeat(65)),false)
 assert.equal(await w.requester.request('general',''),false)
 for(let n=0;n<64;n++)lookups.push(w.requester.request('general','note-'+n))
 assert.equal(await w.requester.request('general','overflow'),false)
 await Promise.all(lookups);const count=w.sent.length;assert.ok(count<=64)
 await new Promise(r=>setTimeout(r,35));assert.equal(w.sent.length,count)
 const pending=w.requester.request('general','pending');w.requester.dispose();assert.equal(await pending,false)
})
test('late replies and failed persistence are not acknowledged as successful lookups',async t=>{
 const w=await setup(t,{timeoutMs:30,save:async()=>{throw new Error('disk full')}}),pending=w.requester.request('general','old-original');await w.untilSent(1)
 await w.responder.handle(w.sent[0].frame);await assert.rejects(w.requester.handle(w.sent[1].frame),/disk full/);assert.equal(w.received.length,0)
 assert.equal(await pending,false);await w.requester.handle(w.sent[1].frame);assert.equal(w.received.length,0)
})
