import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { runtimeBinding } from "../apps/runtime-grant.js";
import { ExpiryQueue } from "./limits.js";

const digest = (value) => createHash("sha256").update(value).digest("hex");
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

// With a shared store (several replicas, docs/scaling-plan.md): where the
// records live in it (state-store.js); how long a replica remembers that a
// token was not there, so a client retrying with a dead one does not cost a
// query each time; how long it remembers a revocation, so a read already on its
// way cannot bring the revoked record back; and how a write the store could
// not take is tried again -- less and less often, and no longer than a session
// can live.
const STORED = "session";
const MISS_MS = 1000;
const GONE_MS = 30_000;
const REMEMBERED = 100_000;
const RETRY_MS = [1000, 3000, 10_000, 30_000, 60_000];
const LONGEST_MS = 15 * 60_000;

function frozen(value) {
  if (value && typeof value === "object") { for (const inner of Object.values(value)) frozen(inner); Object.freeze(value); }
  return value;
}
// What the coding agent's turn credential is for (issueForModelTurn): the
// model gateway, and nothing else. Its own audience, so every route that serves
// the desktop's own session -- and checks for that session's audience --
// refuses it without having to remember that it exists.
export const MODEL_TURN = "model-turn";

// A record read back from the shared store. Another replica of this deployment
// sealed it (authenticated encryption bound to its slot), so this checks only
// that it is a session at all. A turn credential written before it had its own
// audience carried its root's; it is read as what it is.
function revive(value) {
  if (!value || typeof value !== "object" || ![value.id, value.familyId, value.tenantId, value.userId, value.audience].every((field) => typeof field === "string" && field)
    || !Number.isSafeInteger(value.expiresAt) || !Array.isArray(value.scopes) || (value.parentKey !== undefined && typeof value.parentKey !== "string")) return null;
  return frozen(value.parentKey && value.audience === "codex-model-gateway" ? { ...value, audience: MODEL_TURN } : value);
}

// Short-lived agent tokens. OAuth identity verification and device-key
// redemption happen in FeishuLoginService; tokens themselves remain scoped bearer
// credentials, not per-request hardware/device attestation.
//
// One process keeps them in memory, as it always has. Given a shared store
// (`state`, state-store.js), several replicas share them:
//   - every record issued here is written to the store, sealed, under the
//     token's digest -- never the token. A token that another replica may be
//     the first to receive is handed out once that write has been tried
//     (`persisted()`). If the store is away the token still works here, and is
//     written when the store is back.
//   - a replica receiving a token it does not hold reads it from the store at
//     the request's entry (`ensure()`); verify() stays local and synchronous.
//     What goes with a signed-in session -- its Feishu access and renewal
//     grants (§2.4) -- is read with it, by the loaders those services add.
//     A session whose grants could not all be read (one signed in before they
//     were kept, a write that failed) is taken only where the session alone is
//     enough -- the model gateway, `verify(token, { shared: true })`; every
//     other service answers as for a session it does not know, and the desktop
//     signs back in with its stored credential, as it does after a restart.
//   - a revocation is taken out of the store in one statement for the whole
//     family, and the store's notification drops it from every other replica.
//     A replica that was cut off from notifications checks what it holds
//     once it hears again.
// With a route key, every token a person holds begins with the same eight
// characters (see #mint), so nginx can send one person to one replica.
export class SessionRegistry extends EventEmitter {
  #byParent = new Map();
  #byFamily = new Map();
  #expiry = new ExpiryQueue();
  #tails = new Map();
  #firsts = new Map();
  #busy = new Map();
  #writing = new Set();
  #loaded = new Set();
  #loaders = [];
  #loading = new Map();
  #missed = new Map();
  #gone = new Map();
  #sleepers = new Set();
  #epoch = 0;
  #checking = null;
  #checkAgain = false;

  constructor({ now = Date.now, state = null, routeKey = null, log = () => {} } = {}) {
    super();
    if (routeKey !== null && (!Buffer.isBuffer(routeKey) || routeKey.length < 32)) throw new Error("A route key is at least 32 bytes");
    if (state !== null && (typeof state.put !== "function" || typeof state.present !== "function")) throw new Error("Invalid session store");
    this.now = now;
    this.sessions = new Map();
    this.state = state;
    this.routeKey = routeKey;
    this.log = log;
    this.closed = false;
    if (state) {
      this.onChange = (change) => this.#changed(change);
      state.on("change", this.onChange);
      // A replica that only serves requests never issues, and issuing is where
      // pruning happens; what it read from the store is pruned on a timer.
      this.pruner = setInterval(() => this.prune(), 30_000);
      this.pruner.unref?.();
    }
  }

  issue({ tenantId, userId, deviceId, ttlMs = 15 * 60_000, authProvider = "development", appId = null, displayName = null, deviceProof = null, cliIdentityChecks = false, cliBridge = false, cliDocumentWrites = false, cliMessageWrites = false, cliDriveWrites = false, cliDestructiveWrites = false }) {
    if (![tenantId, userId, deviceId].every((id) => typeof id === "string" && id.length > 0)) {
      throw new Error("Session identity is required");
    }
    if (!Number.isInteger(ttlMs) || ttlMs < 1 || ttlMs > 15 * 60_000) throw new Error("Invalid session lifetime");
    // A Feishu session names its application. Which shape that id has is the
    // deployment's (provider-definition.js), checked where the id is configured;
    // the registry only insists that there is one and that it is a plain token.
    if (!["development", "feishu"].includes(authProvider) || (authProvider === "feishu" && (typeof appId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(appId) || deviceProof !== "ed25519-login"))) throw new Error("Verified login metadata is required");
    if (typeof cliIdentityChecks !== "boolean" || cliIdentityChecks && authProvider !== "feishu") throw new Error("Feishu identity checks require verified login");
    if (typeof cliBridge !== "boolean" || cliBridge && authProvider !== "feishu") throw new Error("Feishu CLI bridge requires verified login");
    for (const [name, value] of [["document", cliDocumentWrites], ["message", cliMessageWrites], ["drive", cliDriveWrites], ["destructive", cliDestructiveWrites]]) {
      if (typeof value !== "boolean" || value && (!cliBridge || authProvider !== "feishu")) throw new Error(`Feishu CLI ${name} writes require the verified bridge`);
    }
    this.prune();
    const id = randomUUID();
    const session = Object.freeze({ id, familyId: id, tenantId, userId, deviceId,
      authProvider, appId, displayName, deviceProof, ...(cliIdentityChecks ? { cliIdentityChecks: true } : {}), ...(cliBridge ? { cliBridge: true } : {}), ...(cliDocumentWrites ? { cliDocumentWrites: true } : {}), ...(cliMessageWrites ? { cliMessageWrites: true } : {}), ...(cliDriveWrites ? { cliDriveWrites: true } : {}), ...(cliDestructiveWrites ? { cliDestructiveWrites: true } : {}),
      audience: "codex-model-gateway", scopes: Object.freeze(["models:responses"]), expiresAt: this.now() + ttlMs });
    return this.#keep(session);
  }

  issueForSkills(parentToken) {
    const parent = this.verify(parentToken);
    if (!parent || parent.authProvider !== "feishu" || parent.parentKey || parent.audience !== "codex-model-gateway") throw new Error("Verified Feishu parent session required");
    const parentKey = digest(parentToken);
    // One bounded derivative per parent; never broaden the model token's scopes.
    for (const [key, value] of this.#children(parentKey)) if (value.audience === "skill-center") this.remove(key);
    return this.#keep(Object.freeze({ ...parent, id: randomUUID(), parentKey, audience: "skill-center", scopes: Object.freeze(["skills:read"]), expiresAt: Math.min(parent.expiresAt, this.now() + 5 * 60_000) }));
  }

  // The credential the desktop writes into the agent's lease file. The coding
  // agent can read that file — its `workspace-write` sandbox allows reads
  // everywhere — so it must not be the root token. This child reaches the model
  // gateway and nothing else: being a child it cannot mint media/Drive/MCP/skill
  // tokens (every issueFor* above refuses a token that has a parentKey), and
  // its audience is its own (MODEL_TURN). Until 2026-09-27 it carried its
  // root's audience, and the routes that check for the desktop's session took
  // it: an agent could publish, share or erase sites, and create or delete
  // schedules, with none of the cards the desktop shows for those. The desktop
  // keeps the root token in memory. It lives exactly as long as its root; a
  // rotation issues a fresh one.
  issueForModelTurn(parentToken) {
    const parent = this.verify(parentToken);
    if (!parent || parent.parentKey || parent.audience !== "codex-model-gateway") throw new Error("Root session required");
    const parentKey = digest(parentToken);
    this.prune();
    // One turn credential per root; replacing it revokes the previous one --
    // including one issued before turn credentials had their own audience.
    for (const [key, value] of this.#children(parentKey)) if (value.audience === MODEL_TURN || value.audience === "codex-model-gateway") this.remove(key);
    return this.#keep(Object.freeze({ ...parent, id: randomUUID(), parentKey, audience: MODEL_TURN, expiresAt: parent.expiresAt }));
  }

  // The credential a scheduled task's sandbox reaches the model with. It carries
  // the same audience-and-scope pair as the desktop's own turn credential but is
  // deliberately NOT that credential, for two reasons the gateway makes plain:
  // it rate-limits per session id, so a runaway scheduled task sharing the
  // desktop's token would push the person's own conversation into 429; and
  // issueForModelTurn revokes the previous turn credential each time it is
  // called, so minting one for a sandbox would sign the desktop out of its own
  // model access mid-sentence.
  //
  // Bounded rather than revoking, unlike issueForModelTurn: two scheduled tasks
  // may run at once, and a revoking issuer would have the second silently take
  // the first one's credential away. (Bounded per replica: the leases a parent
  // holds are counted where they were issued, which is one replica as long as
  // one person's requests go to one.)
  //
  // Like every other derivative here it refuses a token that already has a
  // parentKey, so a sandbox credential cannot mint anything further -- it is a
  // leaf, which is the whole point of handing it to a container.
  // Deliberately not requiring a Feishu login, unlike issueForSkills and
  // issueForMcp: those reach enterprise resources, while this one reaches only
  // the model -- exactly what issueForModelTurn reaches, which does not require
  // one either. Matching the credential this most resembles, rather than a tier
  // it has nothing in common with, is also what lets a development server run a
  // scheduled task at all.
  issueForSandboxRun(parentToken) {
    const parent = this.verify(parentToken);
    if (!parent || parent.parentKey || parent.audience !== "codex-model-gateway") throw new Error("Root session required");
    this.prune(); const parentKey = digest(parentToken);
    if (this.#children(parentKey).filter(([, value]) => value.audience === "sandbox-run").length >= 4) throw new Error("Sandbox run lease limit");
    // Capped at the parent, and the parent itself can never be issued for more
    // than 15 minutes (`issue` refuses a longer ttlMs). A longer ceiling here
    // would read as though a sandbox could hold model access for half an hour;
    // it cannot. A task outliving one window continues on a rotated session, not
    // on a longer-lived child.
    return this.#keep(Object.freeze({ ...parent, id: randomUUID(), parentKey, audience: "sandbox-run",
      scopes: Object.freeze(["models:responses"]), expiresAt: parent.expiresAt }));
  }

  // Internal rotation. Existing parents/children retain their original expiry.
  rotate(parentToken, ttlMs) {
    const parent = this.verify(parentToken);
    if (!parent || parent.authProvider !== "feishu" || parent.parentKey || parent.audience !== "codex-model-gateway") throw new Error("Verified parent required");
    if (!Number.isInteger(ttlMs) || ttlMs < 1 || ttlMs > 900000) throw new Error("Invalid session lifetime");
    this.prune();
    return this.#keep(Object.freeze({ ...parent, id: randomUUID(), expiresAt: this.now() + ttlMs }));
  }

  issueForMcp(parentToken, { connectionId, policyDigest, tools }) {
    const parent = this.verify(parentToken);
    if (!parent || parent.authProvider !== "feishu" || parent.parentKey || parent.audience !== "codex-model-gateway") throw new Error("Verified Feishu parent session required");
    if (!/^[a-z][a-z0-9_-]{0,39}$/.test(connectionId) || !/^[a-f0-9]{64}$/.test(policyDigest) || !Array.isArray(tools) || !tools.length || tools.length > 32 || tools.some((tool) => typeof tool !== "string" || !/^[A-Za-z0-9_.-]{1,100}$/.test(tool)) || new Set(tools).size !== tools.length) throw new Error("Invalid MCP scope");
    this.prune(); const parentKey = digest(parentToken);
    if (this.#children(parentKey).filter(([, value]) => value.audience === "mcp-broker").length >= 6) throw new Error("MCP lease limit");
    return this.#keep(Object.freeze({ ...parent, id: randomUUID(), parentKey, audience: "mcp-broker", scopes: Object.freeze(["mcp:tools"]), connectionId, policyDigest,
      tools: Object.freeze([...tools].sort()), expiresAt: Math.min(parent.expiresAt, this.now() + 5 * 60_000) }));
  }

  // `shared`: the caller needs nothing but the session, so one read from the
  // shared store will do (see the class comment).
  verify(token, { shared = false } = {}) {
    if (typeof token !== "string" || !TOKEN.test(token)) return null;
    const key = digest(token);
    const session = this.sessions.get(key);
    const parent = session?.parentKey ? this.sessions.get(session.parentKey) : null;
    if (!session || session.expiresAt <= this.now() || (session.parentKey && (!parent || parent.expiresAt <= this.now()))) {
      // Here only. Expired is expired everywhere; a parent missing before its
      // time was revoked, and a revocation takes the whole family out of the
      // shared store at once.
      this.#drop(key);
      return null;
    }
    return shared || !this.#loaded.has(key) ? session : null;
  }

  issueForMedia(parentToken, kind) {
    const parent = this.verify(parentToken);
    if (!parent || parent.parentKey || parent.audience !== "codex-model-gateway") throw new Error("Parent session required");
    if (!["image", "video", "speech"].includes(kind)) throw new Error("Invalid media kind");
    const parentKey = digest(parentToken);
    this.prune();
    // Reuse an audience slot only by revoking the old lease; never revoke skill/MCP leases.
    for (const [key, value] of this.#children(parentKey)) if (value.audience === "media-service" && value.kind === kind) this.remove(key);
    return this.#keep(Object.freeze({ ...parent, id: randomUUID(), parentKey, audience: "media-service", kind,
      scopes: Object.freeze(["media:generate", "media:read", "media:cancel"]), expiresAt: Math.min(parent.expiresAt, this.now() + 300000) }));
  }

  issueForDrive(parentToken) {
    const parent = this.verify(parentToken);
    if (!parent || parent.parentKey || parent.audience !== "codex-model-gateway") throw new Error("Parent session required");
    const parentKey = digest(parentToken);
    this.prune();
    for (const [key, value] of this.#children(parentKey)) if (value.audience === "drive-budget") this.remove(key);
    return this.#keep(Object.freeze({ ...parent, id: randomUUID(), parentKey, audience: "drive-budget", scopes: Object.freeze(["drive:reserve"]), expiresAt: Math.min(parent.expiresAt, this.now() + 300000) }));
  }

  issueForApps(parentToken) {
    const parent = this.verify(parentToken); if (!parent || parent.parentKey || parent.audience !== "codex-model-gateway") throw new Error("Parent session required");
    const parentKey = digest(parentToken); this.prune();
    for (const [key, value] of this.#children(parentKey)) if (value.audience === "app-catalog") this.remove(key);
    return this.#keep(Object.freeze({ ...parent, id: randomUUID(), parentKey, audience: "app-catalog", scopes: Object.freeze(["apps:candidates"]), expiresAt: Math.min(parent.expiresAt, this.now() + 300000) }));
  }

  issueForAppReview(parentToken) {
    const parent = this.verify(parentToken); if (!parent || parent.parentKey || parent.audience !== "codex-model-gateway") throw new Error("Parent session required");
    const parentKey = digest(parentToken); this.prune();
    for (const [key, value] of this.#children(parentKey)) if (value.audience === "app-review") this.remove(key);
    return this.#keep(Object.freeze({ ...parent, id: randomUUID(), parentKey, audience: "app-review", scopes: Object.freeze(["apps:review"]), expiresAt: Math.min(parent.expiresAt, this.now() + 300000) }));
  }

  issueForAppRuntime(parentToken, input) {
    const parent = this.verify(parentToken); if (!parent || parent.parentKey || parent.audience !== "codex-model-gateway") throw new Error("Parent session required");
    const binding = Object.freeze(runtimeBinding(input)), parentKey = digest(parentToken); this.prune();
    for (const [key, value] of this.#children(parentKey)) if (value.audience === "app-runtime") this.remove(key);
    return this.#keep(Object.freeze({ ...parent, id: randomUUID(), parentKey, audience: "app-runtime", scopes: Object.freeze(["apps:runtime"]), runtimeBinding: binding, expiresAt: Math.min(parent.expiresAt, this.now() + 300000) }));
  }

  issueForAppRuntimeOperator(parentToken) {
    const parent = this.verify(parentToken); if (!parent || parent.parentKey || parent.audience !== "codex-model-gateway") throw new Error("Parent session required");
    const parentKey = digest(parentToken); this.prune();
    for (const [key, value] of this.#children(parentKey)) if (value.audience === "app-runtime-operator") this.remove(key);
    return this.#keep(Object.freeze({ ...parent, id: randomUUID(), parentKey, audience: "app-runtime-operator", scopes: Object.freeze(["apps:runtime-options"]), expiresAt: Math.min(parent.expiresAt, this.now() + 300000) }));
  }

  issueForWiki(parentToken) {
    const parent = this.verify(parentToken); if (!parent || parent.parentKey || parent.audience !== "codex-model-gateway") throw new Error("Parent session required");
    const parentKey = digest(parentToken); this.prune();
    for (const [key, value] of this.#children(parentKey)) if (value.audience === "wiki-coordinator") this.remove(key);
    return this.#keep(Object.freeze({ ...parent, id: randomUUID(), parentKey, audience: "wiki-coordinator", scopes: Object.freeze(["wiki:coordinate"]), expiresAt: Math.min(parent.expiresAt, this.now() + 300000) }));
  }

  // Revokes one record, here and in the shared store.
  remove(key) {
    this.#drop(key);
    if (this.state) void this.#shared([key], () => this.state.delete(STORED, key));
  }

  // Revoking a root revokes its family: every rotation of that login and every
  // child of any of them. Revoking a child revokes it alone. Resolves to
  // whether the shared store took the revocation at the first try (true
  // without a store); if it did not, it goes on trying in the background.
  revoke(token) {
    const key = digest(token), session = this.sessions.get(key), dropped = [key];
    if (session && !session.parentKey) {
      for (const member of [...(this.#byFamily.get(session.familyId) ?? [])]) { dropped.push(member); this.#drop(member); }
    } else {
      this.#drop(key);
      for (const [child] of this.#children(key)) { dropped.push(child); this.#drop(child); }
    }
    if (!this.state) return Promise.resolve(true);
    // A token this replica never held is looked up in the store for its family.
    return this.#shared(dropped, async () => {
      const taken = await this.state.take(STORED, key);
      const known = session ?? revive(taken?.value);
      if (known && !known.parentKey) await this.state.deleteChildren(STORED, known.familyId);
    });
  }

  prune() {
    const now = this.now();
    for (let entry; (entry = this.#expiry.due(now));) if (this.sessions.get(entry.key) === entry.value) this.#drop(entry.key);
    for (const remembered of [this.#missed, this.#gone]) {
      for (const [key, until] of remembered) { if (until > now) break; remembered.delete(key); }
    }
  }

  // What a signed-in session needs besides itself before every service may
  // take it, read from the store when the session is: `loader(root)` answers
  // whether the root session has its part now (its Feishu access, its renewal).
  addLoader(loader) {
    if (typeof loader !== "function") throw new Error("Invalid session loader");
    this.#loaders.push(loader);
  }

  // A request may reach a replica that did not issue its token. Its entry point
  // awaits this before anything verifies it: a token this replica does not
  // hold is read from the shared store, together with the root it hangs from.
  async ensure(token) {
    if (!this.state || this.closed || typeof token !== "string" || !TOKEN.test(token)) return;
    const key = digest(token);
    if (this.sessions.has(key) || (this.#missed.get(key) ?? 0) > this.now()) return;
    let loading = this.#loading.get(key);
    if (!loading) {
      loading = this.#load(key).finally(() => this.#loading.delete(key));
      this.#loading.set(key, loading);
    }
    await loading;
  }

  // Resolves once these tokens' writes to the shared store have been tried,
  // to whether they all took. A token another replica may be the first to
  // receive -- a login's, a rotation's -- is handed out only after this: the
  // client's next request goes wherever nginx sends it, possibly ahead of a
  // write still on its way.
  async persisted(...tokens) {
    if (!this.state) return true;
    const keys = tokens.filter((token) => typeof token === "string").map(digest);
    return (await Promise.all(keys.map((key) => this.#firsts.get(key) ?? true))).every(Boolean);
  }

  // What is still on its way to the shared store, awaited before it closes.
  // After close(), nothing more is retried.
  async flush() { await Promise.all([...this.#writing]); }

  close() {
    this.closed = true;
    clearInterval(this.pruner);
    if (this.onChange) this.state.off("change", this.onChange);
    for (const wake of [...this.#sleepers]) wake();
  }

  // A new token. With a route key, its first 6 bytes -- its first 8
  // characters -- are a keyed hash of the person, the same for every token they
  // hold, so nginx can send all of one person's requests to one replica
  // (docs/scaling-plan.md). Without the key the code names nobody. The other 26
  // bytes are random. Without a route key all 32 are, as before. Either way it
  // is 43 characters of base64url, the shape every client checks for.
  #mint({ tenantId, userId }) {
    if (!this.routeKey) return randomBytes(32).toString("base64url");
    const route = createHmac("sha256", this.routeKey).update(`${tenantId}\n${userId}`).digest().subarray(0, 6);
    return Buffer.concat([route, randomBytes(26)]).toString("base64url");
  }

  #keep(session) {
    const token = this.#mint(session), key = digest(token);
    this.#add(key, session);
    if (this.state) {
      // `parent` is the family, so revoking a login takes every rotation and
      // child out in one statement; `owner` is the person. Written while the
      // session is still here: once it is revoked or expired, there is nothing
      // to share.
      const first = this.#shared([key], () => this.state.put(STORED, key, session, { ttlMs: Math.max(1, session.expiresAt - this.now()),
        parent: session.familyId, owner: `${session.tenantId}\n${session.userId}` }), () => this.sessions.get(key) === session);
      this.#firsts.set(key, first);
      void first.then(() => { if (this.#firsts.get(key) === first) this.#firsts.delete(key); });
    }
    return { token, ...session };
  }

  #add(key, session) {
    this.sessions.set(key, session);
    const into = (index, name) => { let keys = index.get(name); if (!keys) index.set(name, keys = new Set()); keys.add(key); };
    into(this.#byFamily, session.familyId);
    if (session.parentKey) into(this.#byParent, session.parentKey);
    this.#expiry.add(session.expiresAt, key, session);
  }

  // Gone from this replica. Whatever holds state for the session hears
  // "revoked" and lets go of it.
  #drop(key) {
    const session = this.sessions.get(key);
    if (!session) return;
    this.sessions.delete(key);
    this.#loaded.delete(key);
    const out = (index, name) => { const keys = index.get(name); if (keys) { keys.delete(key); if (!keys.size) index.delete(name); } };
    out(this.#byFamily, session.familyId);
    if (session.parentKey) out(this.#byParent, session.parentKey);
    this.emit("revoked", session.id);
  }

  #children(parentKey) {
    const keys = this.#byParent.get(parentKey), found = [];
    for (const key of keys ?? []) { const value = this.sessions.get(key); if (value) found.push([key, value]); }
    return found;
  }

  // One write to the shared store. Writes touching the same token take turns
  // -- each attempt waits for the one before it -- so an issue cannot land
  // after its own revocation. One that fails is tried again, less and less
  // often, while `wanted()` holds and no longer than a session can live; an
  // issue's is wanted while the session is still here, so a retry never
  // brings back what was revoked in the meantime. The returned promise settles
  // with the first attempt, to whether it took; never rejects.
  #shared(keys, operation, wanted = () => true) {
    const attempt = () => {
      const turn = Promise.all(keys.map((key) => this.#tails.get(key))).then(async () => {
        if (!wanted()) return true;
        try { await operation(); return true; } catch (error) { return error; }
      });
      for (const key of keys) this.#tails.set(key, turn);
      void turn.then(() => { for (const key of keys) if (this.#tails.get(key) === turn) this.#tails.delete(key); });
      return turn;
    };
    for (const key of keys) this.#busy.set(key, (this.#busy.get(key) ?? 0) + 1);
    const first = attempt(), until = this.now() + LONGEST_MS;
    const writing = (async () => {
      let outcome = await first;
      for (let tries = 0; outcome !== true && !this.closed && this.now() < until && wanted(); tries += 1) {
        await this.#sleep(RETRY_MS[Math.min(tries, RETRY_MS.length - 1)]);
        if (this.closed || !wanted()) break;
        outcome = await attempt();
      }
      if (outcome !== true && wanted()) this.log({ component: "sessions", event: "session-change-not-shared", message: String(outcome?.message ?? outcome).slice(0, 200) });
    })().finally(() => {
      this.#writing.delete(writing);
      for (const key of keys) { const left = this.#busy.get(key) - 1; if (left > 0) this.#busy.set(key, left); else this.#busy.delete(key); }
    });
    this.#writing.add(writing);
    return first.then((outcome) => outcome === true);
  }

  async #load(key) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const epoch = this.#epoch;
      let session, parent = null;
      try {
        session = revive((await this.state.get(STORED, key))?.value);
        if (session?.parentKey && !this.sessions.has(session.parentKey)) parent = revive((await this.state.get(STORED, session.parentKey))?.value);
      } catch (error) {
        // The store failed, not the token: nothing is remembered, and the
        // request is answered as an unknown token would be.
        this.log({ component: "sessions", event: "session-store-unreadable", message: String(error?.message ?? error).slice(0, 200) });
        return;
      }
      const revoked = () => !session || this.#gone.has(key) || (session.parentKey && (this.#gone.has(session.parentKey) || (!parent && !this.sessions.has(session.parentKey))));
      // Notifications were cut off while this was read: read it again.
      if (epoch !== this.#epoch) continue;
      // Revoked while it was being read, or hanging from a root that is gone.
      if (revoked()) break;
      // A root read now has what goes with it read too; one already here is as
      // complete as it was.
      const complete = session.parentKey && !parent ? !this.#loaded.has(session.parentKey) : await this.#restore(parent ?? session);
      if (epoch !== this.#epoch) continue;
      if (revoked()) break;
      if (parent) { this.#add(session.parentKey, parent); if (!complete) this.#loaded.add(session.parentKey); }
      this.#add(key, session); if (!complete) this.#loaded.add(key);
      return;
    }
    this.#remember(this.#missed, key, MISS_MS);
  }

  async #restore(root) {
    if (root.authProvider !== "feishu" || !this.#loaders.length) return true;
    try { return (await Promise.all(this.#loaders.map((loader) => loader(root)))).every((found) => found === true); } catch (error) {
      this.log({ component: "sessions", event: "session-state-unreadable", message: String(error?.message ?? error).slice(0, 200) });
      return false;
    }
  }

  #changed({ namespace, key, op, local }) {
    if (op === "reset") { this.#epoch += 1; this.#missed.clear(); void this.#revalidate(); return; }
    if (local || namespace !== STORED) return;
    if (op === "put") this.#missed.delete(key);
    else if (op === "delete") { this.#remember(this.#gone, key, GONE_MS); this.#drop(key); }
  }

  // After the store's notifications were cut off, a revocation may have gone
  // unheard: every token held here is checked against the store once it is
  // reachable again, and those it no longer has are dropped. Until then this
  // replica goes on with what it holds. A session lives at most 15 minutes, and
  // refusing everybody whenever the database restarts would be the larger harm.
  #revalidate() {
    if (this.#checking) { this.#checkAgain = true; return this.#checking; }
    this.#checking = (async () => {
      for (let attempt = 0; !this.closed; attempt += 1) {
        this.#checkAgain = false;
        try {
          const keys = [...this.sessions.keys()];
          for (let at = 0; at < keys.length; at += 1000) {
            const batch = keys.slice(at, at + 1000), alive = new Set(await this.state.present(STORED, batch));
            // Not what is still on its way to the store.
            for (const key of batch) if (!alive.has(key) && !this.#busy.has(key)) this.#drop(key);
          }
          if (!this.#checkAgain) return;
        } catch (error) {
          this.log({ component: "sessions", event: "session-recheck-failed", message: String(error?.message ?? error).slice(0, 200) });
          await this.#sleep(RETRY_MS[Math.min(attempt, RETRY_MS.length - 1)]);
        }
      }
    })().finally(() => { this.#checking = null; });
    return this.#checking;
  }

  #remember(map, key, ms) {
    map.delete(key); map.set(key, this.now() + ms);
    if (map.size > REMEMBERED) for (const oldest of map.keys()) { map.delete(oldest); if (map.size <= REMEMBERED) break; }
  }

  // A wait that close() cuts short.
  #sleep(ms) {
    return new Promise((resolve) => {
      const wake = () => { clearTimeout(timer); this.#sleepers.delete(wake); resolve(); };
      const timer = setTimeout(wake, ms);
      timer.unref?.();
      this.#sleepers.add(wake);
    });
  }
}
