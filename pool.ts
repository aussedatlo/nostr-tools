import { Relay, RelayEvent, relayInit } from './relay'
import { normalizeURL } from './utils'
import { Filter } from './filter'
import { Event } from './event'
import { SubscriptionOptions, Sub, Pub } from './relay'

export type SimplePool = {
  eoseSubTimeout: number
  getTimeout: number
  close(relays: string[]): void
  sub(relays: string[], filters: Filter[], opts?: SubscriptionOptions): Sub
  get(
    relays: string[],
    filter: Filter,
    opts?: SubscriptionOptions
  ): Promise<Event | null>
  list(
    relays: string[],
    filters: Filter[],
    opts?: SubscriptionOptions
  ): Promise<Event[]>
  seenOn(id: string): string[]
  publish(relays: string[], event: Event): Pub
}

export function simplePoolInit(options: { eoseSubTimeout?: number; getTimeout?: number } = {}): SimplePool {
  const _conn: { [url: string]: Relay } = {}
  const _seenOn: { [id: string]: Set<string> } = {} // a map of all events we've seen in each relay

  const eoseSubTimeout: number = options.eoseSubTimeout || 3400
  const getTimeout: number = options.getTimeout || 3400

  function close(relays: string[]): void {
    relays.forEach(url => {
      let relay = _conn[normalizeURL(url)]
      if (relay) relay.close()
    })
  }

  async function ensureRelay(url: string): Promise<Relay> {
    const nm = normalizeURL(url)
    const existing = _conn[nm]
    if (existing && existing.status === 1) return existing

    if (existing) {
      await existing.connect()
      return existing
    }

    const relay = relayInit(nm, {
      getTimeout: getTimeout * 0.9,
      listTimeout: getTimeout * 0.9
    })
    _conn[nm] = relay

    await relay.connect()

    return relay
  }

  function sub(relays: string[], filters: Filter[], opts?: SubscriptionOptions): Sub {
    let _knownIds: Set<string> = new Set()
    let modifiedOpts = { ...(opts || {}) }
    modifiedOpts.alreadyHaveEvent = (id, url) => {
      if (opts?.alreadyHaveEvent?.(id, url)) {
        return true
      }
      let set = _seenOn[id] || new Set()
      set.add(url)
      _seenOn[id] = set
      return _knownIds.has(id)
    }

    let subs: Sub[] = []
    let eventListeners: Set<(event: Event) => void> = new Set()
    let eoseListeners: Set<() => void> = new Set()
    let eosesMissing = relays.length

    let eoseSent = false
    let eoseTimeout = setTimeout(() => {
      eoseSent = true
      for (let cb of eoseListeners.values()) cb()
    }, eoseSubTimeout)

    relays.forEach(async relay => {
      let r
      try {
        r = await ensureRelay(relay)
      } catch (err) {
        handleEose()
        return
      }
      if (!r) return
      let s = r.sub(filters, modifiedOpts)
      s.on('event', (event: Event) => {
        _knownIds.add(event.id as string)
        for (let cb of eventListeners.values()) cb(event)
      })
      s.on('eose', () => {
        if (eoseSent) return
        handleEose()
      })
      subs.push(s)

      function handleEose() {
        eosesMissing--
        if (eosesMissing === 0) {
          clearTimeout(eoseTimeout)
          for (let cb of eoseListeners.values()) cb()
        }
      }
    })

    let greaterSub: Sub = {
      sub(filters, opts) {
        subs.forEach(sub => sub.sub(filters, opts))
        return greaterSub
      },
      unsub() {
        subs.forEach(sub => sub.unsub())
      },
      on(type, cb) {
        switch (type) {
          case 'event':
            eventListeners.add(cb)
            break
          case 'eose':
            eoseListeners.add(cb)
            break
        }
      },
      off(type, cb) {
        if (type === 'event') {
          eventListeners.delete(cb)
        } else if (type === 'eose') eoseListeners.delete(cb)
      }
    }

    return greaterSub
  }

  function get(
    relays: string[],
    filter: Filter,
    opts?: SubscriptionOptions
  ): Promise<Event | null> {
    return new Promise(resolve => {
      let s = sub(relays, [filter], opts)
      let timeout = setTimeout(() => {
        s.unsub()
        resolve(null)
      }, getTimeout)
      s.on('event', (event: Event) => {
        resolve(event)
        clearTimeout(timeout)
        s.unsub()
      })
    })
  }

  function list(
    relays: string[],
    filters: Filter[],
    opts?: SubscriptionOptions
  ): Promise<Event[]> {
    return new Promise(resolve => {
      let events: Event[] = []
      let s = sub(relays, filters, opts)

      s.on('event', (event: Event) => {
        events.push(event)
      })

      // we can rely on an eose being emitted here because pool.sub() will fake one
      s.on('eose', () => {
        s.unsub()
        resolve(events)
      })
    })
  }

  function publish(relays: string[], event: Event): Pub {
    const pubs: Pub[] = []
    relays.forEach(async relay => {
      let r
      try {
        r = await ensureRelay(relay)
        pubs.push(r.publish(event))
      } catch (_) { }
    })
    return {
      on(type, cb) {
        pubs.forEach((pub, i) => {
          pub.on(type, () => cb(relays[i]))
        })
      },
      off() {
        // do nothing here, FIXME
      }
    }
  }

  function seenOn(id: string): string[] {
    return Array.from(_seenOn[id]?.values?.() || [])
  }

  return { eoseSubTimeout, getTimeout, close, sub, get, list, publish, seenOn }
}
