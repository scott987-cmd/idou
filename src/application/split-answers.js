// One answer the model sent in pieces, shown as one.
//
// The gateway joins the pieces on the way in (control-plane/message-coalesce.js),
// but a record written before that held -- or by a provider that splits in a way
// it does not recognise -- keeps them as separate assistant messages. Shown as
// they are, the conversation folds every piece but the last away as "steps":
// measured on 2026-09-21, a 23-piece answer showed only its closing sentence, and
// three answers out of 32 in a knowledge-base evaluation showed no answer at
// all by default.
//
// What tells a piece from a step is the record itself. Messages and the Agent's
// steps share one sequence, so two assistant messages with a tool call, a
// command or a change between them are two moments of the turn -- the first is
// a step and stays one -- while two with nothing between them are one stream of
// text cut apart. Only those are joined, and only for showing: the record is
// never rewritten, and a message that carries a write or answers a request for
// an edit proposal is left exactly as it is, because what is applied is read
// back from the stored message by its id.
const plain = (message) => message?.role === "assistant" && !message.documentEdit && !message.sheetEdit && !message.baseEdit;

export function joinSplitAnswers(messages = [], activity = []) {
  const steps = (activity ?? []).map((entry) => entry?.seq).filter(Number.isFinite);
  const stepBetween = (from, to) => steps.some((seq) => seq > from && seq < to);
  const shown = [];
  let asked = null;
  for (const message of messages ?? []) {
    if (message?.role === "user" && !message.steered) asked = message;
    const last = shown.at(-1);
    const joinable = plain(last) && plain(message) && (last.agent ?? null) === (message.agent ?? null)
      && Number.isFinite(last.seq) && Number.isFinite(message.seq) && asked?.context?.intent !== "propose-edit"
      && !stepBetween(last.lastSeq ?? last.seq, message.seq);
    if (!joinable) { shown.push(message); continue; }
    shown[shown.length - 1] = { ...last, text: `${last.text ?? ""}${message.text ?? ""}`, lastSeq: message.seq,
      pieces: [...(last.pieces ?? [last.id]), message.id] };
  }
  return shown;
}
