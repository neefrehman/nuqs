import {
  useCallback,
  useEffect,
  useInsertionEffect,
  useRef,
  useState
} from 'react'
import { useAdapter } from './adapters/internal.context'
import { debug } from './debug'
import type { Nullable, Options } from './defs'
import type { Parser } from './parsers'
import { emitter, type CrossHookSyncPayload } from './sync'
import {
  FLUSH_RATE_LIMIT_MS,
  enqueueQueryStringUpdate,
  scheduleFlushToURL
} from './update-queue'
import { safeParse } from './utils'

type KeyMapValue<Type> = Parser<Type> &
  Options & {
    defaultValue?: Type
  }

export type UseQueryStatesKeysMap<Map = any> = {
  [Key in keyof Map]: KeyMapValue<Map[Key]>
}

export interface UseQueryStatesOptions extends Options {}

export type Values<T extends UseQueryStatesKeysMap> = {
  [K in keyof T]: T[K]['defaultValue'] extends NonNullable<
    ReturnType<T[K]['parse']>
  >
    ? NonNullable<ReturnType<T[K]['parse']>>
    : ReturnType<T[K]['parse']> | null
}

type UpdaterFn<T extends UseQueryStatesKeysMap> = (
  old: Values<T>
) => Partial<Nullable<Values<T>>>

export type SetValues<T extends UseQueryStatesKeysMap> = (
  values: Partial<Nullable<Values<T>>> | UpdaterFn<T> | null,
  options?: Options
) => Promise<URLSearchParams>

export type UseQueryStatesReturn<T extends UseQueryStatesKeysMap> = [
  Values<T>,
  SetValues<T>
]

/**
 * Synchronise multiple query string arguments to React state in Next.js
 *
 * @param keys - An object describing the keys to synchronise and how to
 *               serialise and parse them.
 *               Use `parseAs(String|Integer|Float|...)` for quick shorthands.
 * @param options - Optional history mode, shallow routing and scroll restoration options.
 */
export function useQueryStates<KeyMap extends UseQueryStatesKeysMap>(
  keyMap: KeyMap,
  {
    history = 'replace',
    scroll = false,
    shallow = true,
    throttleMs = FLUSH_RATE_LIMIT_MS,
    clearOnDefault = false,
    startTransition
  }: Partial<UseQueryStatesOptions> = {}
): UseQueryStatesReturn<KeyMap> {
  type V = Values<KeyMap>
  const keys = Object.keys(keyMap).join(',')
  const {
    searchParams: initialSearchParams,
    updateUrl,
    rateLimitFactor = 1
  } = useAdapter()
  const queryRef = useRef<Record<string, string | null>>({})
  // Initialise the queryRef with the initial values
  if (Object.keys(queryRef.current).length !== Object.keys(keyMap).length) {
    queryRef.current = Object.fromEntries(initialSearchParams?.entries() ?? [])
  }

  const [internalState, setInternalState] = useState<V>(() => {
    const source = initialSearchParams ?? new URLSearchParams()
    return parseMap(keyMap, source)
  })

  const stateRef = useRef(internalState)
  debug(
    '[nuq+ `%s`] render - state: %O, iSP: %s',
    keys,
    internalState,
    initialSearchParams
  )

  useEffect(() => {
    const state = parseMap(
      keyMap,
      initialSearchParams,
      queryRef.current,
      stateRef.current
    )
    setInternalState(state)
  }, [
    Object.keys(keyMap)
      .map(key => initialSearchParams?.get(key))
      .join('&')
  ])

  // Sync all hooks together & with external URL changes
  useInsertionEffect(() => {
    function updateInternalState(state: V) {
      debug('[nuq+ `%s`] updateInternalState %O', keys, state)
      stateRef.current = state
      setInternalState(state)
    }
    const handlers = Object.keys(keyMap).reduce(
      (handlers, key) => {
        handlers[key as keyof V] = ({ state, query }: CrossHookSyncPayload) => {
          const { defaultValue } = keyMap[key]!
          // Note: cannot mutate in-place, the object ref must change
          // for the subsequent setState to pick it up.
          stateRef.current = {
            ...stateRef.current,
            [key as keyof V]: state ?? defaultValue ?? null
          }
          queryRef.current[key] = query
          debug(
            '[nuq+ `%s`] Cross-hook key sync %s: %O (default: %O). Resolved: %O',
            keys,
            key,
            state,
            defaultValue,
            stateRef.current
          )
          updateInternalState(stateRef.current)
        }
        return handlers
      },
      {} as Record<keyof V, (payload: CrossHookSyncPayload) => void>
    )
    for (const key of Object.keys(keyMap)) {
      debug('[nuq+ `%s`] Subscribing to sync for `%s`', keys, key)
      emitter.on(key, handlers[key]!)
    }
    return () => {
      for (const key of Object.keys(keyMap)) {
        debug('[nuq+ `%s`] Unsubscribing to sync for `%s`', keys, key)
        emitter.off(key, handlers[key])
      }
    }
  }, [keyMap])

  const update = useCallback<SetValues<KeyMap>>(
    (stateUpdater, callOptions = {}) => {
      const newState: Partial<Nullable<KeyMap>> =
        typeof stateUpdater === 'function'
          ? stateUpdater(stateRef.current)
          : stateUpdater === null
            ? (Object.fromEntries(
                Object.keys(keyMap).map(key => [key, null])
              ) as Nullable<KeyMap>)
            : stateUpdater
      debug('[nuq+ `%s`] setState: %O', keys, newState)
      for (let [key, value] of Object.entries(newState)) {
        const parser = keyMap[key]
        if (!parser) {
          continue
        }
        if (
          (callOptions.clearOnDefault ??
            parser.clearOnDefault ??
            clearOnDefault) &&
          value !== null &&
          parser.defaultValue !== undefined &&
          (parser.eq ?? ((a, b) => a === b))(value, parser.defaultValue)
        ) {
          value = null
        }

        queryRef.current[key] = enqueueQueryStringUpdate(
          key,
          value,
          parser.serialize ?? String,
          {
            // Call-level options take precedence over individual parser options
            // which take precedence over global options
            history: callOptions.history ?? parser.history ?? history,
            shallow: callOptions.shallow ?? parser.shallow ?? shallow,
            scroll: callOptions.scroll ?? parser.scroll ?? scroll,
            throttleMs:
              callOptions.throttleMs ?? parser.throttleMs ?? throttleMs,
            startTransition:
              callOptions.startTransition ??
              parser.startTransition ??
              startTransition
          }
        )
        emitter.emit(key, {
          state: value,
          query: queryRef.current[key] ?? null
        })
      }
      return scheduleFlushToURL(updateUrl, rateLimitFactor)
    },
    [
      keyMap,
      history,
      shallow,
      scroll,
      throttleMs,
      startTransition,
      updateUrl,
      rateLimitFactor
    ]
  )
  return [internalState, update]
}

// --

function parseMap<KeyMap extends UseQueryStatesKeysMap>(
  keyMap: KeyMap,
  searchParams: URLSearchParams,
  cachedQuery?: Record<string, string | null>,
  cachedState?: Values<KeyMap>
) {
  return Object.keys(keyMap).reduce((obj, key) => {
    const { defaultValue, parse } = keyMap[key]!
    const query = searchParams?.get(key) ?? null
    if (cachedQuery && cachedState && cachedQuery[key] === query) {
      obj[key as keyof KeyMap] = cachedState[key] ?? defaultValue ?? null
      return obj
    }
    const value = query === null ? null : safeParse(parse, query, key)
    obj[key as keyof KeyMap] = value ?? defaultValue ?? null
    if (cachedQuery) {
      cachedQuery[key] = query
    }
    return obj
  }, {} as Values<KeyMap>)
}
