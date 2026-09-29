// Match both thread and turn IDs. Completion can precede the turn/start reply.
//
// Two clocks, because "too long" and "stuck" are different problems. A real
// piece of work — reading a long document, installing dependencies, waiting for
// somebody to answer an approval — can take a long time while plainly making
// progress, and cutting it off on a wall clock throws that work away for no
// reason. What is worth cutting off is a turn that has gone quiet: no output,
// no tool call, no question. So the idle clock is the one that usually fires,
// and it restarts on every sign of life; the ceiling only exists so a turn
// cannot run forever.
export function runTurn(client, { threadId, input, start, timeoutMs = 6 * 60 * 60_000, idleTimeoutMs = 15 * 60_000, signal, onTurn, relatedThreads }) {
  return new Promise((resolve, reject) => {
    let turnId;
    let settled = false;
    const early = new Map();
    const finish = (error, turn) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer); clearTimeout(idleTimer);
      client.off("notification", onNotification);
      client.off("notification", onActivity);
      client.off("serverRequest", onAwaitingInput);
      client.off("stopped", onStopped);
      signal?.removeEventListener("abort", onAbort);
      if (error) reject(error); else resolve(turn);
    };
    const interrupt = () => {
      if (turnId) client.request("turn/interrupt", { threadId, turnId }).catch(() => {});
    };
    const onAbort = () => { interrupt(); finish(new Error("Task cancelled")); };
    const onStopped = (error) => finish(error);
    const onNotification = (message) => {
      if (message.method !== "turn/completed" || message.params?.threadId !== threadId) return;
      const turn = message.params.turn;
      if (!turnId) { early.set(turn.id, turn); return; }
      if (turn.id === turnId) finish(null, turn);
    };
    // Any output, tool call or notification from this thread is a sign of life
    // and restarts the idle clock. A server request (a command/file approval or
    // a question) is different: it means the turn is now waiting for the person,
    // which can legitimately take far longer than the idle window. Restarting the
    // clock on its arrival would still cut the turn off 15 minutes later while it
    // waits, so instead the clock is *paused* while the request is outstanding
    // and re-armed by the next activity once the person answers and Codex resumes.
    // The wall-clock ceiling still applies, so a turn can never truly run forever.
    let idleTimer;
    const stall = () => { interrupt(); finish(new Error(`这一步已经 ${Math.round(idleTimeoutMs / 60_000)} 分钟没有任何动静，已经停下。已经写好的文件都还在任务目录里；可以直接再发一条继续。`)); };
    const restartIdle = () => { clearTimeout(idleTimer); idleTimer = setTimeout(stall, idleTimeoutMs); };
    // A subagent works on a thread of its own. Its output is this turn making
    // progress, so it feeds the same idle clock and pauses it the same way --
    // otherwise a long delegated step looks like a stall and the parent turn is
    // cut off while it is plainly working. Completion above stays strict: only
    // the parent thread's own turn/completed ends this turn.
    const alive = (id) => id === threadId || Boolean(relatedThreads?.has(id));
    const onActivity = (message) => { if (!settled && alive(message?.params?.threadId)) restartIdle(); };
    const onAwaitingInput = (message) => { if (!settled && alive(message?.params?.threadId)) clearTimeout(idleTimer); };
    const timer = setTimeout(() => { interrupt(); finish(new Error(`这个任务已经连续执行了 ${Math.round(timeoutMs / 3600_000)} 小时，为避免无限运行已经停下。已经写好的文件都还在任务目录里。`)); }, timeoutMs);
    restartIdle();
    if (signal?.aborted) { onAbort(); return; }
    signal?.addEventListener("abort", onAbort, { once: true });
    client.on("notification", onNotification);
    client.on("notification", onActivity);
    client.on("serverRequest", onAwaitingInput);
    client.on("stopped", onStopped);
    Promise.resolve().then(() => {
      if (settled) return null;
      // A review (Codex's /review) starts its turn with review/start instead;
      // it answers with the turn the same way, and ends the same way.
      return start ? start() : client.request("turn/start", { threadId, input });
    }).then((started) => {
      if (!started) return;
      turnId = started.turn.id;
      // Steering a running turn needs that turn's id, so it is reported the
      // moment it exists rather than staying private to this function.
      onTurn?.(turnId);
      if (settled) { interrupt(); return; }
      if (early.has(turnId)) finish(null, early.get(turnId));
      early.clear();
    }).catch((error) => finish(error));
  });
}
