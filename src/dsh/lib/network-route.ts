// Transport routing preference — ported from apps/android network-route helpers.
// Web adaptation: navigator.onLine replaces NetInfo; the browser cannot detect a
// LAN-capable route, so "unknown" semantics apply (LAN stays enabled; ICE falls
// back to P2P → TURN → Relay when no local route exists).

export type NetworkRoute = 'local' | 'remote' | 'unknown'

export type PreferredTransport = 'lan' | 'p2p' | 'turn' | 'relay'

/** Keep LAN first on unknown networks: ICE validates candidates and falls back naturally. */
export function automaticPreferredTransports(route: NetworkRoute): PreferredTransport[] {
  if (route === 'remote') return ['p2p', 'turn', 'relay']
  return ['lan', 'p2p', 'turn', 'relay']
}

export async function resolveAutomaticPreferredTransports(): Promise<PreferredTransport[]> {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return ['relay']
  }
  return automaticPreferredTransports('unknown')
}

export function initialProbeTransports(preferredTransports: readonly PreferredTransport[]): PreferredTransport[] {
  return [...preferredTransports]
}
