// What the Agent is told when a confirmation does not come back as "yes".
//
// A confirmation can end three ways besides being accepted, and they are not
// the same thing to report. Telling the Agent "the user cancelled" after a
// five-minute timeout made it tell the person they had declined something they
// never saw an answer to.
//
// A timeout is also not an invitation to ask again. The earlier wording ("the
// user can be asked to start it again when ready") read to the Agent as leave to
// re-issue at once, and in a live run it put the same card up a second time for
// a person who was away. It now says plainly who decides when to try again.
export function declined(choice, cancelled) {
  if (choice?.reason === "timeout") return new Error("确认等了 5 分钟没有回应，已作废，没有执行任何操作。不要自己重新发起：告诉用户确认已超时，等用户明确说准备好了再发起。");
  if (choice?.reason === "withdrawn") return new Error("确认在回应之前已作废（发起的请求已经结束或窗口已关闭），没有执行任何操作。");
  return new Error(cancelled);
}
