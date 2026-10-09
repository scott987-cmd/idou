// Whether a published site is up, after any sequence of what its owner, an
// administrator and the content checks do to it (site-registry.js), against a
// model of three facts: what the owner last wanted (up after a publish or a
// republish, down after 取消发布), whether an administrator holds it, and
// whether it waits for review or was turned down. It is up only when its owner
// wants it up and nothing else holds it down.
//
// Five rounds of review before .270 each found another pair of these that
// disagreed -- a hold and a check again, 取消发布 on a held site that waits --
// one combination at a time. This walks thousands of sequences instead, the
// same ones every run (a seeded generator), and prints the one that fails.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SiteRegistry } from "../src/control-plane/site-registry.js";
import { appHash, appManifest } from "../src/apps/manifest.js";

const OWNER = "ou_owner", TENANT = "t1";
const pack = (n) => {
  const bytes = Buffer.from(`<!doctype html><p>第 ${n} 版</p>`);
  return { manifest: { schemaVersion: 1, runtime: "static", network: "none", entry: "index.html", files: [{ path: "index.html", bytes: bytes.length, sha256: appHash(bytes) }] },
    blobs: [{ path: "index.html", base64: bytes.toString("base64") }] };
};
const versionOf = (n) => appManifest(pack(n).manifest).digest;
// mulberry32: small, seeded, the same sequence every run.
const generator = (seed) => () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };

// What each step does to the model, and to the registry. A step the registry
// refuses (publishing over a hold, bringing back one that waits) changes neither.
// `kept`: the versions the site keeps, the one up first (docs/sites-phase0.md §0.6).
const published = (m, n) => [n, ...m.kept.filter((old) => old !== n)].slice(0, 3);
const wentBack = (m) => [m.kept[1], m.kept[0], ...m.kept.slice(2)];
const STEPS = {
  publish: { run: (sites, id, n) => sites.publish({ siteId: id, ownerId: OWNER, tenantId: TENANT, name: "看板", share: { scope: "invited" }, ...pack(n) }),
    model: (m, n) => m.held ? null : { ...m, wantsUp: true, review: null, kept: published(m, n) } },
  publishWaiting: { run: (sites, id, n) => sites.publish({ siteId: id, ownerId: OWNER, tenantId: TENANT, name: "看板", share: { scope: "invited" }, ...pack(n), review: { checkId: `c${n}`, reason: "发现 1 处手机号" } }),
    model: (m, n) => m.held ? null : { ...m, wantsUp: true, review: "pending", checkId: `c${n}`, kept: published(m, n) } },
  // Going back is publishing a kept version again: up, checked like one.
  goBack: { run: (sites, id) => sites.revert(id, { ownerId: OWNER, version: sites.get(id)?.history?.[1] }),
    model: (m) => m.held || m.kept.length < 2 ? null : { ...m, wantsUp: true, review: null, kept: wentBack(m) } },
  goBackWaiting: { run: (sites, id, n) => sites.revert(id, { ownerId: OWNER, version: sites.get(id)?.history?.[1], review: { checkId: `c${n}`, reason: "发现 1 处手机号" } }),
    model: (m, n) => m.held || m.kept.length < 2 ? null : { ...m, wantsUp: true, review: "pending", checkId: `c${n}`, kept: wentBack(m) } },
  withdraw: { run: (sites, id) => sites.withdraw(id, { ownerId: OWNER }), model: (m) => ({ ...m, wantsUp: false }) },
  republish: { run: (sites, id) => sites.republish(id, { ownerId: OWNER }), model: (m) => m.held || m.review ? null : { ...m, wantsUp: true } },
  republishWaiting: { run: (sites, id, n) => sites.republish(id, { ownerId: OWNER, review: { checkId: `c${n}`, reason: "公开网站都要管理员审核" } }),
    model: (m, n) => m.held || m.review ? null : { ...m, wantsUp: true, review: "pending", checkId: `c${n}` } },
  hold: { run: (sites, id) => sites.hold(id, { by: { userId: "ou_admin" }, reason: "核实中" }), model: (m) => ({ ...m, held: true }) },
  release: { run: (sites, id) => sites.release(id), model: (m) => ({ ...m, held: false }) },
  // A site turned down stays turned down: a check again does not make it wait again.
  checkAgain: { run: (sites, id, n) => sites.awaitReview(id, { checkId: `c${n}`, reason: "补查发现 1 处手机号" }), model: (m, n) => m.review === "rejected" ? m : { ...m, review: "pending", checkId: `c${n}` } },
  approve: { run: (sites, id, n, m) => sites.approve(id, { by: { userId: "ou_admin" }, checkId: m.checkId ?? "none" }), model: (m) => m.review === "pending" ? { ...m, review: null, checkId: null } : m },
  reject: { run: (sites, id) => sites.reject(id, { by: { userId: "ou_admin" }, reason: "删掉手机号" }), model: (m) => m.review === "pending" ? { ...m, review: "rejected" } : null },
  shareChecked: { run: (sites, id) => sites.setShare(id, { scope: "tenant" }, { ownerId: OWNER, review: null }), model: (m) => m.held ? null : { ...m, review: null, checkId: null } },
  shareWaiting: { run: (sites, id, n) => sites.setShare(id, { scope: "anyone" }, { ownerId: OWNER, anonymousAllowed: true, review: { checkId: `c${n}`, reason: "发现 1 处手机号" } }),
    model: (m, n) => m.held ? null : { ...m, review: "pending", checkId: `c${n}` } },
  shareUnchecked: { run: (sites, id) => sites.setShare(id, { scope: "invited" }, { ownerId: OWNER }), model: (m) => m.held ? null : m },
};
const NAMES = Object.keys(STEPS);

test("a site is up exactly when its owner wants it up and nothing holds it down, after any sequence of what anyone does to it", { timeout: 120_000 }, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "idou-site-states-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sites = await SiteRegistry.open(root);
  let checked = 0;
  for (const seed of [270, 20261003]) {
    const random = generator(seed);
    for (let run = 0; run < 800; run += 1) {
      const first = await sites.publish({ ownerId: OWNER, tenantId: TENANT, name: "看板", share: { scope: "invited" }, ...pack(0) });
      const id = first.id;
      let model = { wantsUp: true, held: false, review: null, checkId: null, kept: [0] };
      const done = ["publish"];
      for (let step = 1; step <= 16; step += 1) {
        const name = NAMES[Math.floor(random() * NAMES.length)];
        const expected = STEPS[name].model(model, step);
        let refused = false;
        try { await STEPS[name].run(sites, id, step, model); } catch { refused = true; }
        done.push(refused ? `${name}(拒绝)` : name);
        if (expected === null) assert.ok(refused, `the registry should have refused ${name}: ${done.join(" → ")}`);
        else { assert.ok(!refused, `the registry refused ${name}: ${done.join(" → ")}`); model = expected; }
        const site = sites.list().find((row) => row.id === id);
        const up = model.wantsUp && !model.held && !model.review;
        assert.equal(site.offline, !up, `after ${done.join(" → ")}: ${up ? "should be up" : "should be down"} (model ${JSON.stringify(model)})`);
        assert.equal(Boolean(site.held), model.held, `held, after ${done.join(" → ")}`);
        assert.equal(site.review?.state ?? null, model.review, `review, after ${done.join(" → ")}`);
        // The copies a build before .270 reads, read the way .269 does: its
        // release returns a site to the hold's copy and looks at nothing else, so
        // that copy is down while a review is open (sixth review before .270);
        // its approval returns it to the review's copy, the owner's wish.
        const raw = sites.get(id);
        assert.deepEqual(raw.history, model.kept.map(versionOf), `versions kept, after ${done.join(" → ")}`);
        assert.equal(raw.version, versionOf(model.kept[0]), `version up, after ${done.join(" → ")}`);
        if (raw.held) assert.equal(raw.held.wasOffline === true, !model.wantsUp || model.review !== null, `held's copy, after ${done.join(" → ")}`);
        if (raw.review?.state) assert.equal(raw.review.wasOffline === true, !model.wantsUp, `review's copy, after ${done.join(" → ")}`);
        checked += 1;
      }
      await sites.erase(id, { ownerId: OWNER }).catch(async () => { await sites.release(id); await sites.erase(id, { ownerId: OWNER }); });
    }
  }
  assert.equal(checked, 2 * 800 * 16);
});
