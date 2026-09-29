// Keep the same lock order used by publication/reception (cloud lane, then local
// Wiki). Reversing these two awaits can deadlock when a publisher is selecting
// local reads while renewal is queued.
export function runWikiRenewalCheckpoint({ cloudWork, wiki, publication, reception, isCurrent }, operation) {
  return cloudWork.run(() => wiki.withSynthesisCheckpoint(async () => {
    isCurrent(); const result = await operation();
    // Login success is independent of Wiki policy. Each component stops only
    // its own active work if the successor policy cannot be verified.
    await publication.refreshSession(); await reception.refreshSession();
    return result;
  }));
}
