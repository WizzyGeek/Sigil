/** Registry HTTP API client. Every call uses the user's chosen registry. */
import { config, normalizeUrl } from '../config'
import type { StakeFrame } from '../types/protocol'

export class RegistryError extends Error {
  constructor(message: string, public status: number) { super(message) }
}

async function response<T>(registryUrl: string, path: string, init: RequestInit, consume: (response: Response) => Promise<T>, signal?: AbortSignal): Promise<T> {
  const base = normalizeUrl(registryUrl, 'registry')
  if (!base) throw new Error('Use an HTTPS registry URL (HTTP is allowed only for local loopback development).')
  const controller = new AbortController()
  let timedOut = false
  const abort = () => controller.abort()
  if (signal?.aborted) abort()
  else signal?.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(() => { timedOut = true; abort() }, config.registryTimeoutMs)
  try {
    return await consume(await fetch(`${base}${path}`, { ...init, signal: controller.signal, redirect: 'error' }))
  } catch (error) {
    if (timedOut) throw new Error(`Registry request timed out after ${config.registryTimeoutMs / 1000} seconds. Check the registry connection and retry.`)
    throw error
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', abort)
  }
}

async function request<T>(registryUrl: string, path: string, body?: unknown): Promise<T> {
  return response(registryUrl, path, body === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }, async res => {
    if (!res.ok) {
      const error = await res.json().catch(() => ({})) as { detail?: unknown }
      throw new RegistryError(typeof error.detail === 'string' ? error.detail : `Registry request failed (${res.status})`, res.status)
    }
    return res.json() as Promise<T>
  })
}

export async function fetchRegistryPublicKey(registryUrl: string): Promise<string> {
  return (await request<{ public_key: string }>(registryUrl, '/registry/public-key')).public_key
}

export function requestChallenge(fingerprint: string, registryUrl: string): Promise<{ nonce: string; expires_at: string }> {
  return request(registryUrl, '/challenge', { fingerprint })
}

export function register(payload: {
  public_key: string
  user_tag: string
  display_name?: string
  nonce: string
  signature: string
  recovery_email_hash?: string
}, registryUrl: string): Promise<{ fingerprint: string; handle: string }> {
  return request(registryUrl, '/register', payload)
}

export function requestStake(payload: { fingerprint: string; nonce: string; signature: string }, registryUrl: string): Promise<{ stake: StakeFrame }> {
  return request(registryUrl, '/stake', payload)
}

export function lookupKey(fingerprint: string, registryUrl: string): Promise<{ fingerprint: string; public_key: string; user_tag: string; display_name: string | null }> {
  return request(registryUrl, `/key/${encodeURIComponent(fingerprint)}`)
}

export async function isHandleAvailable(registryUrl: string, handle: string, signal?: AbortSignal): Promise<boolean> {
  return response(registryUrl, `/handle/${encodeURIComponent(handle)}`, {}, async res => {
    if (res.ok) return false
    if (res.status === 404) return true
    throw new Error('Could not check handle availability. Try again.')
  }, signal)
}
