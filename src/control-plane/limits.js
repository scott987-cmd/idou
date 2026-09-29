// Limits that hold for the whole server and for each person's share of it.
//
// The pilot bounded everything per process with one number -- a hundred
// signed-in sessions, four Feishu reads at a time, thirty sign-ins a minute --
// which was the whole server for one person and a hard ceiling for a hundred.
// Each of those numbers is now what one person gets, and the server's own
// limit is its capacity (server-config.js loadCapacity): one busy person still
// cannot take everything, and a hundred thousand people are not refused
// because the hundred-and-first signed in.
//
// Checking costs the same however many people there are: nothing here walks
// every entry to answer one request.

// Entries in the order they expire, so pruning takes from the front only what
// has expired. An entry whose expiry moved later is put back by the caller's
// `still(entry)` answering with its new time.
export class ExpiryQueue {
  #items = [];
  get size() { return this.#items.length; }
  add(expiresAt, key, value) {
    const items = this.#items;
    items.push({ expiresAt, key, value });
    for (let at = items.length - 1; at > 0;) {
      const up = (at - 1) >> 1;
      if (items[up].expiresAt <= items[at].expiresAt) break;
      [items[up], items[at]] = [items[at], items[up]]; at = up;
    }
  }
  // The earliest entry, removed, if it has expired by `now`.
  due(now) {
    const items = this.#items;
    if (!items.length || items[0].expiresAt > now) return null;
    const first = items[0], last = items.pop();
    if (items.length) {
      items[0] = last;
      for (let at = 0; ;) {
        const left = at * 2 + 1, right = left + 1;
        let least = at;
        if (left < items.length && items[left].expiresAt < items[least].expiresAt) least = left;
        if (right < items.length && items[right].expiresAt < items[least].expiresAt) least = right;
        if (least === at) break;
        [items[least], items[at]] = [items[at], items[least]]; at = least;
      }
    }
    return first;
  }
}

const whole = (value, name) => {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`Invalid limit ${name}`);
  return value;
};

// What is held right now: overall, and by each person.
export class Shares {
  #held = new Map();
  constructor({ max, perPerson, name = "shares" }) {
    this.max = whole(max, name); this.perPerson = whole(perPerson, name); this.total = 0;
    if (this.perPerson > this.max) throw new Error(`Invalid limit ${name}: a person's share exceeds the whole`);
  }
  held(person) { return this.#held.get(person) ?? 0; }
  // Which limit one more would break: "server", "person", or null if it fits.
  refusal(person, count = 1) {
    return this.total + count > this.max ? "server" : this.held(person) + count > this.perPerson ? "person" : null;
  }
  take(person, count = 1) { this.#held.set(person, this.held(person) + count); this.total += count; }
  give(person, count = 1) {
    const left = this.held(person) - count;
    if (left > 0) this.#held.set(person, left); else this.#held.delete(person);
    this.total = Math.max(0, this.total - count);
  }
  get people() { return this.#held.size; }
}

// Events in the last `windowMs`: overall, counted in ten slices of the window
// so a check is constant work however busy the server is (the window slides a
// tenth at a time), and for each person exactly, from their own few recent
// times.
export class Rates {
  #slices; #sliceMs; #people = new Map();
  constructor({ windowMs, max, perPerson, now = Date.now, name = "rates" }) {
    this.windowMs = whole(windowMs, name); this.max = whole(max, name); this.perPerson = whole(perPerson, name); this.now = now;
    if (this.perPerson > this.max) throw new Error(`Invalid limit ${name}: a person's share exceeds the whole`);
    this.#sliceMs = Math.max(1, Math.ceil(windowMs / 10));
    this.#slices = new Map();
  }
  #recent(person, at) {
    const times = this.#people.get(person);
    if (!times) return [];
    const kept = times.filter((time) => time > at - this.windowMs);
    if (kept.length) this.#people.set(person, kept); else this.#people.delete(person);
    return kept;
  }
  #total(at) {
    const current = Math.floor(at / this.#sliceMs);
    let total = 0;
    for (const [slice, count] of this.#slices) {
      if (slice <= current - 10) this.#slices.delete(slice); else total += count;
    }
    return total;
  }
  refusal(person, count = 1) {
    const at = this.now();
    return this.#total(at) + count > this.max ? "server" : this.#recent(person, at).length + count > this.perPerson ? "person" : null;
  }
  hit(person, count = 1) {
    const at = this.now(), slice = Math.floor(at / this.#sliceMs);
    this.#slices.set(slice, (this.#slices.get(slice) ?? 0) + count);
    const times = this.#recent(person, at);
    for (let index = 0; index < count; index += 1) times.push(at);
    this.#people.set(person, times);
  }
  // When the oldest of a person's events leaves the window: how long to wait
  // for a slot, for a caller that would rather wait than be refused.
  nextFor(person) {
    const times = this.#recent(person, this.now());
    return times.length ? times[0] + this.windowMs - this.now() : 0;
  }
  // People tracked; those with nothing in the window are dropped as they are
  // looked at, and by this.
  sweep() { const at = this.now(); for (const person of [...this.#people.keys()]) this.#recent(person, at); return this.#people.size; }
}

// "tenant\nuser": whose share something counts against.
export const personOf = (who) => `${who.tenantId}\n${who.userId}`;

// A Map that also counts its entries by person (`personOf(value)`), however
// they are removed: for state deleted from many places, where a count kept by
// hand beside it would drift.
export class CountedMap extends Map {
  #byPerson = new Map();
  #person;
  constructor(person) { super(); this.#person = person; }
  set(key, value) {
    const previous = super.get(key);
    if (previous !== undefined) this.#bump(this.#person(previous), -1);
    this.#bump(this.#person(value), 1);
    return super.set(key, value);
  }
  delete(key) {
    const value = super.get(key);
    if (value === undefined || !super.delete(key)) return false;
    this.#bump(this.#person(value), -1);
    return true;
  }
  clear() { super.clear(); this.#byPerson.clear(); }
  held(person) { return this.#byPerson.get(person) ?? 0; }
  #bump(person, by) {
    const next = (this.#byPerson.get(person) ?? 0) + by;
    if (next > 0) this.#byPerson.set(person, next); else this.#byPerson.delete(person);
  }
}
