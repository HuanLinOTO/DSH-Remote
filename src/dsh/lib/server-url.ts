// DSH Remote server URL helpers — ported from apps/android/src/lib/server-url.ts (no PairLink QR flow on web v1).

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '10.0.2.2'])

/** Private-network IPv4 ranges reachable only on a LAN/VPN (RFC1918, link-local, CGNAT). */
function isPrivateHostname(hostname: string): boolean {
  if (LOCAL_HOSTS.has(hostname)) return true
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname)
  if (match === null) return false
  const [a, b] = [Number(match[1]), Number(match[2])]
  return (
    a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254) ||
    (a === 100 && b >= 64 && b <= 127)
  )
}

export function normalizeServerUrl(input: string): string {
  const value = input.trim().replace(/\/+$/, '')
  if (value.length === 0) throw new Error('Enter the DSH Remote server address.')

  const withScheme = /^[a-z][a-z\d+.-]*:\/\//i.test(value) ? value : `https://${value}`
  let url: URL
  try {
    url = new URL(withScheme)
  } catch {
    throw new Error('The server address is not a valid URL.')
  }

  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isPrivateHostname(url.hostname))) {
    throw new Error('Only HTTPS (or HTTP on a private network) is supported.')
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('The server address must not contain credentials, query, or fragment.')
  }
  return url.toString().replace(/\/$/, '')
}

export function websocketUrl(baseUrl: string): string {
  const url = new URL(normalizeServerUrl(baseUrl))
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  url.pathname = '/ws/v1/connect'
  return url.toString()
}
