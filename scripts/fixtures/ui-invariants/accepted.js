// Findings of the UI rules that are known and accepted, each with the reason.
// An entry here is a decision, not a way to make the suite pass: it names the
// finding exactly and says why the application is right as it is.
//
// kind   the rule (「被遮挡」, 「英文」, ...)
// where  a regular expression the finding's element must match
// detail optional regular expression for the finding's detail
// why    the reason it is accepted
export const ACCEPTED = [];

export function acceptedFinding(row) {
  return ACCEPTED.some((entry) => entry.kind === row.kind && entry.where.test(row.where) && (!entry.detail || entry.detail.test(row.detail ?? "")));
}
