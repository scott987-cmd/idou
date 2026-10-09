// What the administration console's 服务状态 page shows of this deployment:
// what it is configured to do, which models exist and whether they answer,
// what the server's own checks last found, who may use which model, which
// release is running (docs/admin-console.md). The page itself is
// admin-ui/pages-system.js; this is the data, read from whatever owns each
// part at the moment somebody asks, so there is no second copy to drift.
//
// **It never shows what anybody said.** No prompt, no answer, no cell of
// anybody's table: this file has no way to reach them.
export function systemState({ deployment = {}, models = [], health = null, visibility = null, checks = null, release = null } = {}) {
  return {
    release,
    deployment: {
      // What this deployment lets happen, in the words the settings use.
      sitesOrigin: deployment.sitesOrigin ?? null,
      anonymous: deployment.anonymous === true,
      allowlist: deployment.allowlist ?? null,
      unattended: deployment.unattended === true,
      sandboxMode: deployment.sandboxMode ?? null,
    },
    models: models.map((model) => ({
      id: model.id,
      provider: model.provider ?? null,
      // Whether it can answer right now, as model-health.js has been finding
      // out from real requests -- not a ping this page invented.
      usable: health ? health.usable(model.id) : null,
      isDefault: model.isDefault === true,
    })),
    // What the server's own checks last said (health-monitor.js).
    checks: checks ? { level: checks.level, checks: checks.checks.map((check) => ({ name: check.name, label: check.label, level: check.level, summary: check.summary, at: check.at })) } : null,
    // The policy as written. The ids are in it: a rule you cannot see the
    // target of is a rule you cannot check.
    visibility: visibility?.enabled
      ? { enabled: true, defaultVisible: visibility.defaultVisible,
        rules: visibility.rules.map((rule) => ({ kind: rule.kind, id: rule.id, models: [...rule.models] })) }
      : { enabled: false },
  };
}
