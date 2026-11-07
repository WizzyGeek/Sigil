import test from 'node:test'
import assert from 'node:assert/strict'
import { BrokerPool } from '../src/api/brokerPool.ts'
import { mergeNotes } from '../src/store/feed.ts'
import { loadPreferences, savePreferences } from '../src/store/preferences.ts'

const storage=new Map()
globalThis.localStorage={getItem:key=>storage.get(key)??null,setItem:(key,value)=>storage.set(key,value)}

function fakeSockets(t) {
 const sockets=[]
 class Socket {
  static OPEN=1
  readyState=0
  sent=[]
  constructor(url){this.url=url;sockets.push(this)}
  send(data){if(this.readyState!==1)throw new Error('closed');this.sent.push(JSON.parse(data))}
  close(){this.readyState=3;this.onclose?.()}
  open(){this.readyState=1;this.onopen?.()}
  receive(frame){this.onmessage?.({data:JSON.stringify(frame)})}
 }
 const previous=globalThis.WebSocket
 globalThis.WebSocket=Socket
 t.after(()=>{globalThis.WebSocket=previous})
 return sockets
}

test('connections are independent, inbound frames never bridge, and history replies stay on the source broker',t=>{
 const sockets=fakeSockets(t), received=[],states=[]
 const pool=new BrokerPool({onFrame:(url,frame)=>received.push({url,frame}),onChange:state=>states.push(state),onError:assert.fail})
 t.after(()=>pool.close())
 pool.updateUrls(['wss://one.test/ws','wss://two.test/ws'])
 sockets.forEach(socket=>socket.open())
 assert.deepEqual(states.at(-1),{'wss://one.test/ws':true,'wss://two.test/ws':true})
 const learned=[{type:'note',jti:'learned'},'sig']
 sockets[0].receive(learned)
 assert.deepEqual(received,[{url:'wss://one.test/ws',frame:learned}])
 assert.equal(sockets[1].sent.length,0,'a received note was bridged without a history request')
 const reply=[{type:'note_relay',request_jti:'request-on-two'},'sig']
 pool.sendTo('wss://two.test/ws',reply)
 assert.deepEqual(sockets[1].sent,[reply])
 assert.equal(sockets[0].sent.length,0)
 const authored=[{type:'note',jti:'authored-once'},'sig']
 assert.equal(pool.publish(authored).sent,2)
 assert.deepEqual(sockets[0].sent,[authored])
 assert.deepEqual(sockets[1].sent,[reply,authored])
 pool.updateUrls(['wss://two.test/ws'])
 assert.equal(sockets[0].readyState,3)
 assert.equal(sockets[1].readyState,1,'removing one broker disconnected another')
 assert.equal(pool.publish([{type:'note',jti:'still-online'},'sig']).sent,1)
 pool.close()
 pool.updateUrls(['wss://two.test/ws'])
 assert.equal(sockets.length,3,'pool cannot reopen after lifecycle cleanup')
})

test('sending fails without losing a draft when all connections are unavailable',t=>{
 const sockets=fakeSockets(t)
 const pool=new BrokerPool({onFrame:()=>{},onChange:()=>{},onError:assert.fail})
 t.after(()=>pool.close())
 pool.updateUrls(['wss://one.test/ws','wss://two.test/ws'])
 assert.throws(()=>pool.publish([{},'sig']),/draft has been kept/)
 sockets[0].open();sockets[1].open()
 sockets[0].readyState=3 // A close race after the connection-status snapshot.
 const result=pool.publish([{type:'note'},'sig'])
 assert.equal(result.sent,1)
 assert.deepEqual(result.failed,['wss://one.test/ws'])
})

test('a merged timeline deduplicates globally by JTI and sorts by signed iat with stable ties',()=>{
 const note=(jti,issuedAt,body=jti)=>({jti,issuedAt,body})
 const fromOne=[note('late',30),note('same-second-b',20)]
 const fromTwo=[note('early',10),note('late',30,'duplicate'),note('same-second-a',20)]
 const merged=mergeNotes(fromOne,fromTwo)
 assert.deepEqual(merged.map(note=>note.jti),['early','same-second-a','same-second-b','late'])
 assert.equal(merged.at(-1).body,'late','a duplicate replaced an already accepted JTI')
 assert.deepEqual(mergeNotes(merged,[note('middle',15)]).map(note=>note.jti),['early','middle','same-second-a','same-second-b','late'])
})

test('legacy single-broker preferences migrate and multiple brokers survive reload without duplicates',()=>{
 storage.clear()
 storage.set('sigil:preferences:legacy',JSON.stringify({brokerUrl:'wss://ONE.test:443/ws'}))
 assert.deepEqual(loadPreferences('legacy').brokerUrls,['wss://one.test/ws'])
 const preferences=loadPreferences('new')
 preferences.brokerUrls=['wss://one.test/ws','wss://TWO.test:443/ws','wss://one.test/ws','not a URL']
 savePreferences('new',preferences)
 const reloaded=loadPreferences('new')
 assert.deepEqual(reloaded.brokerUrls,['wss://one.test/ws','wss://two.test/ws'])
 reloaded.brokerUrls=[]
 savePreferences('new',reloaded)
 assert.deepEqual(loadPreferences('new').brokerUrls,[],'explicit disconnect restored a deployment default')
})
