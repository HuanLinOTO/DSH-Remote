// useModels — dsh-backed model catalog (replaces the OpenCode providers REST).
// The catalog comes from `session.models` on the connected Host and is cached
// in the dsh session store.

import { useSyncExternalStore, useCallback } from 'react'
import type { ModelInfo } from '../api'
import { useDshStore } from '../dsh/chat/sessionStore'
import { sessionModelsToModelInfos } from '../dsh/chat/uiAdapters'

interface ModelsState {
  models: ModelInfo[]
  isLoading: boolean
  error: Error | null
}

type Listener = () => void

let snapshot: ModelsState = { models: [], isLoading: false, error: null }
const listeners = new Set<Listener>()

function notify(): void {
  const state = useDshStore.getState()
  const next: ModelsState = {
    models: sessionModelsToModelInfos(state.sessionModels),
    isLoading: state.connection.phase === 'connected' && state.sessionModels === undefined,
    error: null,
  }
  if (next.models === snapshot.models && next.isLoading === snapshot.isLoading) return
  snapshot = next
  for (const fn of listeners) fn()
}

// Keep the external-store snapshot in sync with the dsh store.
useDshStore.subscribe(notify)

/** Force-refresh the model catalog for the currently open session. */
export function refreshModels(_serverId?: string): Promise<void> {
  const state = useDshStore.getState()
  const sessionId = state.sessions.find(session => session.running)?.sessionId
    ?? state.sessions.find(session => !session.blank)?.sessionId
  if (sessionId === undefined) return Promise.resolve()
  return state.requireClient().sessionModels(sessionId)
    .then(models => {
      useDshStore.setState({ sessionModels: models })
    })
    .catch(() => undefined)
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

interface UseModelsResult {
  models: ModelInfo[]
  isLoading: boolean
  error: Error | null
  refetch: () => Promise<void>
}

export function useModels(_serverId?: string): UseModelsResult {
  const state = useSyncExternalStore(subscribe, () => snapshot, () => snapshot)
  const refetch = useCallback(() => refreshModels(), [])
  return {
    models: state.models,
    isLoading: state.isLoading,
    error: state.error,
    refetch,
  }
}
