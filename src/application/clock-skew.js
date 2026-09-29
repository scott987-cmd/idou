// How far this machine's clock may be from the control plane's.
//
// The server sets every short-lived credential's expiry by its own clock --
// "the session's end, or five minutes from now, whichever is sooner" -- and
// the desktop checks that bound by this one. Since the control plane moved off
// this machine (2026-09-22) the two clocks differ by some hundreds of
// milliseconds even with both synchronised, and a check with no allowance
// refused a freshly issued credential whenever the reply arrived faster than
// the server's lead: media generation failed with 媒体授权响应无效 while the
// session had more than five minutes left. The sign-in client has allowed this
// much from the start; the credential checks now allow the same.
//
// Only a bound read off this machine's clock gets the allowance. A bound the
// server gave in the same terms -- a child credential may not outlive its
// session -- is still checked exactly.
export const CLOCK_SKEW_MS = 60_000;
