import test from 'node:test'
import assert from 'node:assert/strict'
import { generateKeypair } from '../src/crypto/keystore.ts'
import { fingerprintFromSpki } from '../src/crypto/fingerprint.ts'
import { rotateRegistry, revokeRegistry, publicKeyPem } from '../src/crypto/keyLifecycle.ts'
import { loadPreferences, savePreferences } from '../src/store/preferences.ts'

const url = 'https://registry.test'
const old = await generateKeypair()
const replacement = await generateKeypair('pending-rotation', true)
const fp = await fingerprintFromSpki(old.publicKeySpki)
const next = await fingerprintFromSpki(replacement.publicKeySpki)
function reply(body, status = 200) { return new Response(JSON.stringify(body), { status }) }
function mockFetch(t, fn) { const saved = globalThis.fetch; globalThis.fetch = fn; t.after(() => { globalThis.fetch = saved }) }
async function verifies(key, nonce, signature) {
  const publicKey = await crypto.subtle.importKey('spki', key.publicKeySpki, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify'])
  return crypto.subtle.verify('RSASSA-PKCS1-v1_5', publicKey, Buffer.from(signature, 'base64'), new TextEncoder().encode(nonce))
}

test('rotation proves ownership of both keys and checks the returned replacement fingerprint', async t => {
  const calls = []
  mockFetch(t, async (requestUrl, init) => {
    calls.push(requestUrl)
    if (requestUrl.includes('/key/')) return reply({ detail: 'missing' }, 404)
    if (requestUrl.endsWith('/rotate/challenge')) return reply({ nonce: 'rotation-nonce' })
    const body = JSON.parse(init.body)
    assert.equal(body.old_fingerprint, fp)
    assert.equal(body.new_public_key, publicKeyPem(replacement))
    assert.ok(await verifies(old, body.nonce, body.old_signature))
    assert.ok(await verifies(replacement, body.nonce, body.new_signature))
    return reply({ new_fingerprint: next })
  })
  await rotateRegistry(url, fp, old.privateKey, replacement)
  assert.equal(calls.length, 3)
  assert.equal(old.privateKey.extractable, false)
  assert.equal(replacement.privateKey.extractable, true)
})

test('rotation resumes after a lost response without rotating to a different key', async t => {
  let calls = 0
  mockFetch(t, async () => { calls++; return reply({ fingerprint: next, public_key: publicKeyPem(replacement) }) })
  await rotateRegistry(url, fp, old.privateKey, replacement)
  assert.equal(calls, 1)
})

test('rotation refuses a mismatched key or an unreachable registry', async t => {
  mockFetch(t, async () => reply({ fingerprint: next, public_key: publicKeyPem(old) }))
  await assert.rejects(rotateRegistry(url, fp, old.privateKey, replacement), /different replacement key/)
  globalThis.fetch = async () => { throw new Error('offline') }
  await assert.rejects(rotateRegistry(url, fp, old.privateKey, replacement), /offline/)
})

test('revocation signs the registry challenge and requires confirmation', async t => {
  mockFetch(t, async (requestUrl, init) => {
    if (requestUrl.includes('/key/')) return reply({ fingerprint: fp })
    if (requestUrl.endsWith('/challenge')) return reply({ nonce: 'revoke-nonce' })
    const body = JSON.parse(init.body)
    assert.equal(body.fingerprint, fp)
    assert.ok(await verifies(old, body.nonce, body.signature))
    return reply({ revoked: true })
  })
  await revokeRegistry(url, fp, old.privateKey)
  globalThis.fetch = async requestUrl => requestUrl.includes('/key/') ? reply({}) : requestUrl.endsWith('/challenge') ? reply({ nonce: 'nonce' }) : reply({ revoked: false })
  await assert.rejects(revokeRegistry(url, fp, old.privateKey), /did not confirm/)
})

test('revocation retry accepts an already removed registration but propagates other errors', async t => {
  mockFetch(t, async () => reply({}, 404))
  await revokeRegistry(url, fp, old.privateKey)
  globalThis.fetch = async () => reply({ detail: 'unavailable' }, 503)
  await assert.rejects(revokeRegistry(url, fp, old.privateKey), /unavailable/)
})

test('removed registries do not reappear from the original identity metadata', () => {
  const data = new Map()
  globalThis.localStorage = { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value) }
  const initial = { url, handle: '@user@registry.test' }
  assert.equal(loadPreferences(fp, initial).registries.length, 1)
  const preferences = { brokerUrls: [], channels: [], activeChannel: '', registries: [], selectedRegistry: '' }
  savePreferences(fp, preferences)
  assert.deepEqual(loadPreferences(fp, initial), preferences)
})

test('rotate all groups matching handles across registries and keeps different handles separate', async () => {
  const { rotationGroups } = await import('../src/crypto/rotation.ts')
  const identities = [
    {fingerprint:'one',handle:'@wiz@reg1.test',registryUrl:'https://reg1.test'},
    {fingerprint:'two',handle:'@wiz2@reg1.test',registryUrl:'https://reg1.test'},
    {fingerprint:'three',handle:'@wiz@reg2.test',registryUrl:'https://reg2.test'},
  ]
  const groups=rotationGroups(identities,identities[0],'all')
  assert.deepEqual(groups.map(group=>[group.name,group.registrations.length]),[['wiz',2],['wiz2',1]])
  assert.equal(rotationGroups(identities,identities[0],'registration')[0].registrations.length,1)
})

test('per-registration rotation splits a shared key without discarding its other registration or settings', async () => {
  const { rotatedPreferences } = await import('../src/crypto/rotation.ts')
  const prefs={brokerUrls:['wss://one.test'],brokerAccess:{'wss://one.test':{read:true,publish:false}},channels:['general'],activeChannel:'general',registries:[{url:'https://one.test',handle:'@wiz@one.test'},{url:'https://two.test',handle:'@wiz@two.test'}],selectedRegistry:'https://one.test'}
  const journal={oldFingerprint:'old',preferences:prefs,completed:[],sources:[{fingerprint:'old',preferences:prefs}],jobs:[{oldFingerprint:'old',url:'https://one.test',handle:'@wiz@one.test',replacementFingerprint:'new'}]}
  const result=rotatedPreferences(journal)
  assert.deepEqual(result.get('old').registries,[prefs.registries[1]])
  assert.deepEqual(result.get('new').registries,[prefs.registries[0]])
  assert.equal(result.get('old').selectedRegistry,'https://two.test')
  assert.deepEqual(result.get('new').brokerAccess,prefs.brokerAccess)
  assert.equal(prefs.registries.length,2,'finalization mutated the recovery snapshot')
  assert.deepEqual([...rotatedPreferences(journal)],[...result],'retrying finalization changes the outcome')
})

test('generated backup matches the retained non-exportable key and is not stored automatically', async () => {
  const { generateBackupKeypair }=await import('../src/crypto/keystore.ts')
  const { record,pem }=await generateBackupKeypair('backup-test')
  const imported=await(await import('../src/crypto/keystore.ts')).importKeypair(pem)
  assert.equal(await fingerprintFromSpki(record.publicKeySpki),await fingerprintFromSpki(imported.publicKeySpki))
  assert.equal(record.privateKey.extractable,false)
  await assert.rejects(crypto.subtle.exportKey('pkcs8',record.privateKey))
})

test('rotation cannot mistake another handle on an imported key for a completed operation', async t => {
  mockFetch(t,async()=>reply({fingerprint:next,public_key:publicKeyPem(replacement),user_tag:'someone-else'}))
  await assert.rejects(rotateRegistry(url,fp,old.privateKey,replacement,'expected-handle'),/different handle/)
})

test('each handle/registry identity has an independent record even when fingerprints match',async()=>{
 const {identityRecordId}=await import('../src/crypto/keystore.ts')
 const first={fingerprint:'same-key',handle:'@wiz@one.test',registryUrl:'https://one.test'}
 const second={fingerprint:'same-key',handle:'@wiz@two.test',registryUrl:'https://two.test'}
 assert.notEqual(identityRecordId(first),identityRecordId(second))
 assert.equal(identityRecordId(first),identityRecordId({...first,fingerprint:'rotated-key'}),'rotation should replace only that identity record')
})

test('forgetting one local identity leaves the other identity configuration intact',async()=>{
 const {withoutLocalIdentity}=await import('../src/store/localIdentityDeletion.ts')
 const preferences={brokerUrls:['wss://relay.test'],channels:['general'],activeChannel:'general',registries:[{url:'https://one.test',handle:'@wiz@one.test'},{url:'https://two.test',handle:'@wiz@two.test'}],selectedRegistry:'https://one.test'}
 const updated=withoutLocalIdentity(preferences,'https://one.test')
 assert.deepEqual(updated.registries,[preferences.registries[1]])
 assert.equal(updated.selectedRegistry,'https://two.test')
 assert.deepEqual(updated.brokerUrls,preferences.brokerUrls)
 assert.equal(preferences.registries.length,2)
})
