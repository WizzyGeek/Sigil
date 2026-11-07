import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeUrl } from '../src/config.ts'
import { loadPreferences, savePreferences } from '../src/store/preferences.ts'
import { BrokerClient } from '../src/api/broker.ts'
import { requestChallenge, requestStake, register, isHandleAvailable, RegistryError } from '../src/api/registry.ts'
import { importKeypair, generateKeypair } from '../src/crypto/keystore.ts'
import { hashEmail, fingerprintFromSpki } from '../src/crypto/fingerprint.ts'
import { signFrame, canonicalJsonString } from '../src/crypto/jwt.ts'
import { createRegistryKeyring, verifyStake } from '../src/crypto/registryTrust.ts'
import { buildUnt, buildCommand, verifyUnt, verifyUntFrame } from '../src/crypto/unt.ts'

const storage = new Map()
globalThis.localStorage = { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) }

test('connection URLs preserve custom paths and reject unsupported protocols', () => {
  assert.equal(normalizeUrl(' https://registry.test/api/// ', 'registry'), 'https://registry.test/api')
  assert.equal(normalizeUrl('wss://broker.test/custom?token=abc', 'broker'), 'wss://broker.test/custom?token=abc')
  for (const url of ['', 'localhost:8000', 'javascript:alert(1)', 'https://user:pass@registry.test', 'https://registry.test/#x', 'http://registry.test']) assert.equal(normalizeUrl(url, 'registry'), null)
  assert.equal(normalizeUrl('http://localhost:8000/', 'registry'), 'http://localhost:8000')
  globalThis.window = { location: { href: 'https://client.test/' } }
  assert.equal(normalizeUrl('/ws', 'broker'), 'wss://client.test/ws')
})

test('no environment suggestions means no invented broker or channels', () => {
  storage.clear()
  const prefs = loadPreferences('first')
  assert.deepEqual(prefs.channels, [])
  assert.equal(prefs.activeChannel, '')
  assert.deepEqual(prefs.brokerUrls, [])
  assert.deepEqual(prefs.registries, [])
})

test('connection choices and different registry handles survive reload per identity', () => {
  storage.clear()
  const initial = { url: 'https://registry-a.test', handle: '@alice@a' }
  const prefs = loadPreferences('alice', initial)
  prefs.brokerUrls = ['wss://broker.test/ws', 'wss://other-broker.test/ws']
  prefs.channels = ['test-channel']
  prefs.activeChannel = 'test-channel'
  prefs.registries.push({ url: 'https://registry-b.test', handle: '@different@b' })
  prefs.selectedRegistry = 'https://registry-b.test'
  savePreferences('alice', prefs)
  assert.deepEqual(loadPreferences('alice', initial), prefs)
  assert.deepEqual(loadPreferences('bob').registries, [])
  storage.set('sigil:preferences:broken', '{bad-json')
  assert.doesNotThrow(() => loadPreferences('broken'))
  storage.set('sigil:preferences:broken', JSON.stringify({ channels: [null, 3, 'one', 'one'], registries: [null, {}], activeChannel: 'missing' }))
  assert.deepEqual(loadPreferences('broken').channels, ['one'])
  assert.equal(loadPreferences('broken').activeChannel, 'one')
})

test('challenge, registration, and stake requests target the explicit registry', async () => {
  const calls = []
  globalThis.fetch = async (url, options) => { calls.push([url, options]); return Response.json({}) }
  await requestChallenge('fp', 'https://custom.test/api')
  await register({ user_tag: 'alice', recovery_email_hash: 'hash' }, 'https://custom.test/api')
  await requestStake({ fingerprint: 'fp', nonce: 'n', signature: 's' }, 'https://other.test')
  assert.deepEqual(calls.map(call => call[0]), ['https://custom.test/api/challenge', 'https://custom.test/api/register', 'https://other.test/stake'])
  assert.equal(JSON.parse(calls[1][1].body).recovery_email_hash, 'hash')
  assert.ok(calls.every(call => call[1].redirect === 'error'))
  await assert.rejects(requestChallenge('fp', 'http://public.test'), /HTTPS registry URL/)
  globalThis.fetch = async () => Response.json({ detail: 'Handle taken' }, { status: 409 })
  await assert.rejects(register({}, 'https://custom.test'), error => error instanceof RegistryError && error.status === 409 && error.message === 'Handle taken')
})

test('only a 404 means a handle is available; server failures are errors', async () => {
  globalThis.fetch = async () => new Response('', { status: 404 })
  assert.equal(await isHandleAvailable('https://r.test', 'alice'), true)
  globalThis.fetch = async () => new Response('', { status: 200 })
  assert.equal(await isHandleAvailable('https://r.test', 'alice'), false)
  globalThis.fetch = async () => new Response('', { status: 500 })
  await assert.rejects(isHandleAvailable('https://r.test', 'alice'), /Could not check/)
})

test('broker rejects disconnected sends and closes without scheduling reconnections', t => {
  const sockets = []
  class FakeSocket {
    static OPEN = 1
    readyState = 0
    sent = []
    constructor(url) { this.url = url; sockets.push(this) }
    close() { this.readyState = 3; this.onclose?.() }
    send(value) { this.sent.push(value) }
  }
  t.mock.method(globalThis, 'setTimeout', () => 1)
  globalThis.WebSocket = FakeSocket
  const statuses = []
  const broker = new BrokerClient('wss://chosen.test/ws', () => {}, status => statuses.push(status))
  assert.equal(sockets[0].url, 'wss://chosen.test/ws')
  assert.throws(() => broker.send([{}, 'sig']), /draft has been kept/)
  sockets[0].readyState = 1
  sockets[0].onopen()
  broker.send([{ type: 'note' }, 'sig'])
  assert.equal(sockets[0].sent.length, 1)
  assert.throws(() => broker.send([{ type: 'note', content: 'x'.repeat(262144) }, 'sig']), /Frame exceeds/)
  broker.close()
  assert.equal(setTimeout.mock.callCount(), 0)
  assert.deepEqual(statuses, [true])
})

test('imported PEM stays non-extractable and signed notes preserve replies and display names', async () => {
  const algorithm = { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }
  const author = await crypto.subtle.generateKey(algorithm, true, ['sign', 'verify'])
  const privateDer = await crypto.subtle.exportKey('pkcs8', author.privateKey)
  const pem = `-----BEGIN PRIVATE KEY-----\n${Buffer.from(privateDer).toString('base64')}\n-----END PRIVATE KEY-----`
  const record = await importKeypair(pem)
  assert.equal(record.privateKey.extractable, false)
  await assert.rejects(crypto.subtle.exportKey('pkcs8', record.privateKey))
  assert.equal(await fingerprintFromSpki(record.publicKeySpki), await fingerprintFromSpki(await crypto.subtle.exportKey('spki', author.publicKey)))
  const registry = await crypto.subtle.generateKey(algorithm, true, ['sign', 'verify'])
  const claims = { iss: 'registry.test', iat: Math.floor(Date.now() / 1000), public_key: `-----BEGIN PUBLIC KEY-----\n${Buffer.from(record.publicKeySpki).toString('base64')}\n-----END PUBLIC KEY-----`, user_tag: 'alice', display_name: 'Alice Example' }
  const stake = await signFrame(claims, registry.privateKey)
  const frame = await buildUnt('A reply', 'chosen-channel', stake, record.privateKey, 'parent-jti')
  const keys = createRegistryKeyring([['https://registry.test', registry.publicKey]])
  const note = await verifyUnt(frame, keys)
  assert.equal(note.replyTo, 'parent-jti')
  assert.equal(note.displayName, 'Alice Example')
  assert.equal(note.channel, 'chosen-channel')
  assert.equal(note.authorFp, 'sha256:' + await fingerprintFromSpki(record.publicKeySpki))
  assert.equal(note.stakeIssuedAt, claims.iat)
  frame[0].reply_to = 'tampered'
  await assert.rejects(verifyUnt(frame, keys), /signature invalid/)
  assert.equal(await hashEmail(' ALICE@example.com '), await hashEmail('alice@example.com'))
})

test('each registry issuer can only be verified by its own configured key', async t => {
  const algorithm = { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }
  const [registryA, registryB, author] = await Promise.all(Array.from({ length: 3 }, () => crypto.subtle.generateKey(algorithm, true, ['sign', 'verify'])))
  const keys = createRegistryKeyring([
    ['https://registry-a.test/api', registryA.publicKey],
    ['https://registry-b.test', registryB.publicKey],
  ])
  const publicKey = await crypto.subtle.exportKey('spki', author.publicKey)
  const claims = { iat: Math.floor(Date.now() / 1000), public_key: `-----BEGIN PUBLIC KEY-----\n${Buffer.from(publicKey).toString('base64')}\n-----END PUBLIC KEY-----`, user_tag: '@alice', display_name: null }
  const stakeFor = (issuer, signer) => signFrame({ ...claims, iss: issuer }, signer.privateKey)
  const noteFor = async (issuer, signer) => buildUnt('A signed note', 'general', await stakeFor(issuer, signer), author.privateKey)

  await t.test('valid A and B notes select their respective keys', async () => {
    assert.equal((await verifyUnt(await noteFor('registry-a.test', registryA), keys)).registry, 'registry-a.test')
    assert.equal((await verifyUnt(await noteFor('registry-b.test', registryB), keys)).registry, 'registry-b.test')
  })
  await t.test('B cannot impersonate A, and A cannot impersonate B', async () => {
    await assert.rejects(verifyUnt(await noteFor('registry-a.test', registryB), keys), /signature invalid/)
    await assert.rejects(verifyUnt(await noteFor('registry-b.test', registryA), keys), /signature invalid/)
  })
  await t.test('unknown and missing issuers are rejected even with a trusted signature', async () => {
    await assert.rejects(verifyUnt(await noteFor('unknown.test', registryA), keys), /Unknown registry issuer/)
    const missingIssuer = await signFrame(claims, registryA.privateKey)
    await assert.rejects(verifyStake(missingIssuer, keys), /Invalid stake frame/)
  })
  await t.test('a stake response must belong to the provider being contacted', async () => {
    const providerA = createRegistryKeyring([['https://registry-a.test', registryA.publicKey]])
    await assert.rejects(verifyStake(await stakeFor('registry-b.test', registryB), providerA), /Unknown registry issuer/)
  })
  await t.test('history requests and relay envelopes enforce the same issuer binding', async () => {
    for (const type of ['request_notes', 'note_relay']) {
      const valid = await buildCommand(type, 'general', await stakeFor('registry-a.test', registryA), author.privateKey)
      assert.equal((await verifyUntFrame(valid, keys)).inner.iss, 'registry-a.test')
      const impersonation = await buildCommand(type, 'general', await stakeFor('registry-a.test', registryB), author.privateKey)
      await assert.rejects(verifyUntFrame(impersonation, keys), /signature invalid/)
    }
  })
  await t.test('author signatures and timestamp binding remain enforced', async () => {
    const frame = await noteFor('registry-a.test', registryA)
    const wrongAuthor = await signFrame(frame[0], registryB.privateKey)
    await assert.rejects(verifyUnt(wrongAuthor, keys), /signature invalid/)
    const swappedTimestamp = await signFrame({ ...frame[0], stake_iat: claims.iat + 1 }, author.privateKey)
    await assert.rejects(verifyUnt(swappedTimestamp, keys), /stake_iat mismatch/)
  })
  await t.test('authority mapping preserves ports and rejects ambiguous registry URLs', () => {
    const local = createRegistryKeyring([['http://localhost:8000/api', registryA.publicKey], ['http://localhost:9000', registryB.publicKey]])
    assert.equal(local.get('localhost:8000'), registryA.publicKey)
    assert.equal(local.get('localhost:9000'), registryB.publicKey)
    assert.throws(() => createRegistryKeyring([['https://registry-a.test/api', registryA.publicKey], ['https://registry-a.test/other', registryB.publicKey]]), /Multiple configured registry URLs/)
  })
})


test('canonical signing preserves HTML, Unicode, separators and prototype-named fields', () => {
  const value = JSON.parse('{"z":1,"__proto__":{"signed":true},"content":"<b>& café 😀"}')
  assert.equal(canonicalJsonString(value), '{"__proto__":{"signed":true},"content":"<b>& café 😀","z":1}')
  assert.equal(canonicalJsonString({ text: 'one\u2028two\u2029three' }), '{"text":"one\\u2028two\\u2029three"}')
})


test('registry requests time out rather than leaving client actions pending', async t => {
  t.mock.method(globalThis, 'setTimeout', callback => { queueMicrotask(callback); return 1 })
  globalThis.fetch = (_url, init) => new Promise((_resolve, reject) => {
    const aborted = () => reject(new DOMException('Aborted', 'AbortError'))
    if (init.signal.aborted) aborted()
    else init.signal.addEventListener('abort', aborted, { once: true })
  })
  await assert.rejects(requestChallenge('fp', 'https://registry.test'), /Registry request timed out/)
})


test('new key generation is non-extractable and does not require or overwrite IndexedDB', async () => {
  const record = await generateKeypair('pending-test')
  assert.equal(record.id, 'pending-test')
  assert.equal(record.privateKey.extractable, false)
  assert.equal(record.privateKey.algorithm.modulusLength, 4096)
  assert.ok(record.publicKeySpki.byteLength > 0)
})

test('note metadata displays exact stake age rather than a categorical score or note age', async()=>{
 const {formatDuration,freshnessLabel,issuedAtLabel}=await import('../src/components/noteMetadata.ts')
 assert.equal(formatDuration(0,true),'0s')
 assert.equal(formatDuration(12),'12 seconds')
 assert.equal(formatDuration(130,true),'2m 10s')
 assert.equal(formatDuration(90061),'1 day 1 hour 1 minute 1 second')
 assert.equal(freshnessLabel({issuedAt:1700000130,stakeIssuedAt:1700000000}),'2 minutes 10 seconds')
 assert.equal(freshnessLabel({issuedAt:100,stakeIssuedAt:105}),'Stake issued 5 seconds after note')
 assert.equal(freshnessLabel({issuedAt:100}),'Unavailable')
 assert.equal(issuedAtLabel(Number.NaN),'Unavailable')
})
