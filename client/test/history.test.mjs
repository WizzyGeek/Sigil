import test from 'node:test'
import assert from 'node:assert/strict'
import { PeerHistory, beforeCursor, cursorFor, peerFingerprint } from '../src/history/peerHistory.ts'
import { createRegistryKeyring } from '../src/crypto/registryTrust.ts'
import { signFrame } from '../src/crypto/jwt.ts'

const algorithm = { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }
const fixture = (async () => {
 const registry = await crypto.subtle.generateKey(algorithm, true, ['sign', 'verify'])
 const authors = await Promise.all(Array.from({ length: 3 }, () => crypto.subtle.generateKey(algorithm, true, ['sign', 'verify'])))
 const pems = await Promise.all(authors.map(async pair => `-----BEGIN PUBLIC KEY-----\n${Buffer.from(await crypto.subtle.exportKey('spki', pair.publicKey)).toString('base64')}\n-----END PUBLIC KEY-----`))
 const fingerprints = await Promise.all(pems.map(peerFingerprint))
 const stake = (index, iat = Math.floor(Date.now()/1000)) => signFrame({ iss: 'registry.test', iat, public_key: pems[index], user_tag: `@user${index}`, display_name: null }, registry.privateKey)
 const notes = async (count, prefix, index = 0, iat = Math.floor(Date.now()/1000)-86400) => {
  const proof = await stake(index, iat)
  return Promise.all(Array.from({ length: count }, async (_, n) => {
   const jti = `${prefix}-${String(n).padStart(4,'0')}`
   const raw = await signFrame({ jti, iat, type: 'note', channel: 'general', content: jti, stake: proof, stake_iat: iat }, authors[index].privateKey)
   return { jti, channel: 'general', issuedAt: iat, raw: JSON.stringify(raw) }
  }))
 }
 return { registry, authors, pems, fingerprints, stake, notes, keys: createRegistryKeyring([['https://registry.test',registry.publicKey]]) }
})()

async function until(predicate, message = 'condition', timeout = 4000) {
 const start=Date.now()
 while (!predicate()) { if (Date.now()-start > timeout) throw new Error(`Timed out: ${message}`); await new Promise(resolve=>setTimeout(resolve,5)) }
}
async function world(t, initial, indices = initial.map((_,n)=>n), extra = {}) {
 const f=await fixture, clients=[], requests=new Map(), sent=[], errors=[]
 for (let n=0;n<initial.length;n++) {
  const index=indices[n], store=new Map(initial[n].map(note=>[note.jti,note])), statuses=[]
  const client={ store,statuses,engine:null }
  client.engine=new PeerHistory({
   fingerprint:f.fingerprints[index], privateKey:f.authors[index].privateKey, keys:f.keys,
   getStake:()=>f.stake(index), timeoutMs:200,
   readPage:async(channel,till,before,limit)=>{
    const matching=[...store.values()].filter(note=>note.channel===channel && note.issuedAt<till && (!before || beforeCursor(cursorFor(note),before))).sort((a,b)=>b.issuedAt-a.issuedAt || (a.jti>b.jti?-1:1))
    return { notes:matching.slice(0,limit),more:matching.length>limit }
   },
   save:async note=>{if(store.has(note.jti))return false;store.set(note.jti,note);return true},
   onNote:()=>{}, onStatus:(_channel,status)=>statuses.push(status), onError:error=>errors.push(error),
   ...extra,
   ...(extra.clientOptions?.(n) ?? {}),
   send:frame=>{
    sent.push({from:n,frame})
    if (extra.drop?.(frame,n)) return
    if (frame[0].type==='request_notes') {
     requests.set(frame[0].jti,n)
     for(let peer=0;peer<clients.length;peer++)if(peer!==n) queueMicrotask(()=>{void clients[peer].engine.handle(frame).catch(error=>errors.push(error))})
    } else {
     const target=requests.get(frame[0].request_jti)
     if(target!==undefined)queueMicrotask(()=>{void clients[target].engine.handle(frame).catch(error=>errors.push(error))})
    }
   },
  })
  clients.push(client)
 }
 t.after(()=>clients.forEach(client=>client.engine.dispose()))
 return { ...f,clients,sent,errors }
}

test('a sole old peer deterministically supplies all pages, including same-second notes older than five minutes',async t=>{
 const f=await fixture, history=await f.notes(83,'history')
 const w=await world(t,[history,[]])
 await w.clients[1].engine.start('general')
 await until(()=>w.clients[1].store.size===83,'all 83 history notes')
 await until(()=>w.clients[1].statuses.at(-1)?.phase==='synced','completed history sync')
 assert.deepEqual([...w.clients[1].store.keys()].sort(),history.map(note=>note.jti).sort())
 assert.ok(w.sent.filter(item=>item.frame[0].type==='request_notes').length>=4)
 assert.deepEqual(w.errors,[])
})

test('each peer is paginated independently and overlapping replies are saved once',async t=>{
 const f=await fixture, a=await f.notes(42,'a'),b=await f.notes(37,'b',1)
 const w=await world(t,[a,[...a.slice(0,10),...b],[]])
 await w.clients[2].engine.start('general')
 await until(()=>w.clients[2].store.size===79,'both peers complete')
 await until(()=>w.clients[2].statuses.at(-1)?.phase==='synced','peer completion')
 assert.equal(w.clients[2].statuses.at(-1).peers,2)
 assert.equal(w.clients[2].statuses.at(-1).received,79)
 assert.deepEqual(w.errors,[])
})

test('history is available between separate sessions sharing the same identity',async t=>{
 const f=await fixture, history=await f.notes(57,'same-identity')
 const w=await world(t,[history,[]],[0,0])
 await w.clients[1].engine.start('general')
 await until(()=>w.clients[1].store.size===57,'same-key peer history')
 assert.deepEqual(w.errors,[])
})

test('current-second notes are included and relay frames honor byte budgets',async t=>{
 const f=await fixture, history=await f.notes(14,'current',0,Math.floor(Date.now()/1000))
 const w=await world(t,[history,[]],undefined,{maxFrameBytes:6500})
 await w.clients[1].engine.start('general')
 await until(()=>w.clients[1].store.size===14,'byte-limited pages')
 const relays=w.sent.filter(item=>item.frame[0].type==='note_relay')
 assert.ok(relays.length>1)
 for(const {frame} of relays)assert.ok(new TextEncoder().encode(JSON.stringify(frame)).length<=6500)
 assert.deepEqual(w.errors,[])
})

test('no peers triggers bounded retries with fresh JTIs and disposal cancels timers',async t=>{
 const w=await world(t,[[]],undefined,{timeoutMs:10})
 await w.clients[0].engine.start('general')
 await until(()=>w.clients[0].statuses.at(-1)?.phase==='no-peers','no-peer state')
 const ids=w.sent.map(item=>item.frame[0].jti)
 assert.equal(ids.length,3)
 assert.equal(new Set(ids).size,3)
 w.clients[0].engine.dispose()
 await new Promise(resolve=>setTimeout(resolve,30))
 assert.equal(w.sent.length,3)
})

test('unsolicited, wrongly addressed, wrong-channel, and invalid pages cannot poison a valid pending request',async t=>{
 const w=await world(t,[[]]), proof=await w.stake(1)
 await w.clients[0].engine.start('general')
 const requestId=w.sent[0].frame[0].jti
 const note=(await w.notes(1,'untrusted',1))[0]
 const reply=async patch=>signFrame({jti:crypto.randomUUID(),iat:Math.floor(Date.now()/1000),type:'note_relay',channel:'general',stake:proof,stake_iat:proof[0].iat,to:w.fingerprints[0],request_jti:requestId,peer_id:'peer',relays:[JSON.parse(note.raw)],has_more:false,next_cursor:null,...patch},w.authors[1].privateKey)
 for(const patch of [{request_jti:'unsolicited'},{to:'sha256:wrong'},{channel:'other'}])await w.clients[0].engine.handle(await reply(patch))
 await assert.rejects(w.clients[0].engine.handle(await reply({has_more:true,next_cursor:{iat:note.issuedAt,jti:'wrong'}})),/continuation cursor/)
 const tampered=JSON.parse(note.raw);tampered[0].content='tampered'
 await w.clients[0].engine.handle(await reply({relays:[tampered],peer_id:'corrupt-peer'}))
 assert.equal(w.clients[0].store.size,0)
 await w.clients[0].engine.handle(await reply({}))
 assert.equal(w.clients[0].store.size,1)
})

test('a lost continuation retries its cursor with a fresh JTI and finishes without duplicates',async t=>{
 const f=await fixture, history=await f.notes(63,'retry')
 let replies=0,dropped=false
 const w=await world(t,[history,[]],undefined,{timeoutMs:60,drop:(frame,from)=>{if(from===0 && frame[0].type==='note_relay' && ++replies===2){dropped=true;return true}return false}})
 await w.clients[1].engine.start('general')
 await until(()=>w.clients[1].store.size===63,'retry recovering a lost page')
 assert.equal(dropped,true)
 assert.equal(w.clients[1].statuses.at(-1).received,63)
 const requests=w.sent.filter(item=>item.from===1&&item.frame[0].type==='request_notes').map(item=>item.frame[0])
 assert.equal(new Set(requests.map(frame=>frame.jti)).size,requests.length)
 assert.ok(requests.some((frame,index)=>index>0 && frame.before?.jti===requests[index-1].before?.jti))
 assert.deepEqual(w.errors,[])
})


test('temporary storage failure does not acknowledge or lose a history page',async t=>{
 const f=await fixture, history=await f.notes(9,'storage-retry')
 let fail=true
 const received=new Map()
 const w=await world(t,[history,[]],undefined,{timeoutMs:60,save:async note=>{
  if(fail){fail=false;throw new Error('Temporary storage failure')}
  if(received.has(note.jti))return false
  received.set(note.jti,note);return true
 }})
 await w.clients[1].engine.start('general')
 await until(()=>received.size===9,'retry after storage failure')
 await until(()=>w.clients[1].statuses.at(-1)?.phase==='synced','completion after persistence recovered')
 assert.equal(w.clients[1].statuses.at(-1).received,9)
 assert.ok(w.errors.some(error=>/Temporary storage failure/.test(error.message)))
})


test('untrusted originals are skipped without losing trusted history on subsequent pages',async t=>{
 const f=await fixture, known=await f.notes(35,'aaa-known'), unknown=await f.notes(35,'zzz-unknown')
 for(const note of unknown){
  const original=JSON.parse(note.raw)
  const proof=await signFrame({...original[0].stake[0],iss:'other.test'},f.registry.privateKey)
  note.raw=JSON.stringify(await signFrame({...original[0],stake:proof},f.authors[0].privateKey))
 }
 const wider=createRegistryKeyring([['https://registry.test',f.registry.publicKey],['https://other.test',f.registry.publicKey]])
 const w=await world(t,[[...known,...unknown],[]],undefined,{clientOptions:n=>n===0?{keys:wider}:{}})
 await w.clients[1].engine.start('general')
 await until(()=>w.clients[1].store.size===35,'trusted notes after an untrusted first page')
 await until(()=>w.clients[1].statuses.at(-1)?.phase==='synced','mixed-registry completion')
 assert.equal(w.clients[1].statuses.at(-1).skipped,35)
 assert.deepEqual([...w.clients[1].store.keys()].sort(),known.map(note=>note.jti).sort())
 assert.deepEqual(w.errors,[])
})
