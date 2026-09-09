// Unified fetch for the dsh REST layer.
//
// In the Tauri WebView the app origin (tauri://localhost / http://tauri.localhost)
// is cross-origin to the DSH Remote Server, so plain fetch is subject to CORS.
// tauri-plugin-http routes requests through the Rust HTTP client and bypasses
// CORS entirely; the `http:default` capability already allows https://** (see
// src-tauri/capabilities/default.json). In plain browsers we keep native fetch
// (same-origin deployments / dev proxy need no bypass).

import { isTauri } from '../../utils/tauri'

type FetchImpl = typeof globalThis.fetch

let cachedTauriFetch: FetchImpl | null = null
let loading: Promise<FetchImpl | null> | null = null

async function loadTauriFetch(): Promise<FetchImpl | null> {
  if (!isTauri()) return null
  if (cachedTauriFetch) return cachedTauriFetch
  if (loading === null) {
    loading = import('@tauri-apps/plugin-http')
      .then(mod => {
        cachedTauriFetch = mod.fetch as unknown as FetchImpl
        return cachedTauriFetch
      })
      .catch(() => null)
  }
  return loading
}

/** Resolve the fetch implementation: plugin-http under Tauri, native otherwise. */
export async function resolveFetch(): Promise<FetchImpl> {
  if (isTauri()) {
    const tauriFetch = await loadTauriFetch()
    if (tauriFetch !== null) return tauriFetch
  }
  return globalThis.fetch
}
