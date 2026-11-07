import test from 'node:test'
import assert from 'node:assert/strict'
import { publicEndpoint } from '../src/discovery/advertiser.ts'
import { discoverEndpoints } from '../src/api/registry.ts'

test('discovery advertising excludes broker connection tokens and credentials',()=>{
 assert.equal(publicEndpoint('wss://broker.test/ws?token=secret','broker'),null)
 assert.equal(publicEndpoint('wss://user:pass@broker.test/ws','broker'),null)
 assert.equal(publicEndpoint('wss://BROKER.test:443','broker'),'wss://broker.test/')
 assert.equal(publicEndpoint('http://public.test','registry'),null)
 assert.equal(publicEndpoint('http://localhost:8000/','registry'),null)
 assert.equal(publicEndpoint('ws://192.168.1.10/ws','broker'),null)
 assert.equal(publicEndpoint('ws://[::1]/ws','broker'),null)
 assert.equal(publicEndpoint('wss://broker.test/ws','broker'),'wss://broker.test/ws')
})

test('suggestions query only the supplied source registry and retain abort support',async t=>{
 const old=globalThis.fetch
 t.after(()=>{globalThis.fetch=old})
 const calls=[]
 globalThis.fetch=async(url,options)=>{calls.push({url,options});return new Response(JSON.stringify({entries:[{kind:'broker',url:'wss://relay.test/ws'}]}),{status:200})}
 const result=await discoverEndpoints('https://active.test/api','broker','relay')
 const request=new URL(calls[0].url)
 assert.equal(request.origin,'https://active.test')
 assert.equal(request.pathname,'/api/discovery')
 assert.equal(request.searchParams.get('kind'),'broker')
 assert.equal(request.searchParams.get('query'),'relay')
 assert.equal(calls[0].options.redirect,'error')
 assert.ok(calls[0].options.signal instanceof AbortSignal)
 assert.equal(result.entries[0].url,'wss://relay.test/ws')
})
