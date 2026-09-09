// Unified Harness business client facade (plan D4).
// rc.2 Hosts expose the native ApiProxy tunnel; alpha Hosts expose the Typert
// Remote Gateway. Both implementations satisfy the same call surface, so the
// store layer programs against the union type.

import { HarnessAlphaClient } from '../vendor/client-core'
import { RemoteApiProxy } from './api-proxy'

export type HarnessClient = RemoteApiProxy | HarnessAlphaClient

export function isAlphaClient(client: HarnessClient): client is HarnessAlphaClient {
  return client instanceof HarnessAlphaClient
}

export function isApiProxyClient(client: HarnessClient): client is RemoteApiProxy {
  return client instanceof RemoteApiProxy
}
