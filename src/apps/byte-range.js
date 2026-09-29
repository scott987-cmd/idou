// The one part of a file a request asks for with `Range: bytes=...`, for the
// places that serve a version's files. A video is fetched in pieces: Safari --
// and so the in-app browser on an iPhone -- asks for bytes=0-1 first and will
// not play a video that is only ever served whole.
//
// One range only; several, or anything malformed, is answered with the whole
// file, which a server may always do. A range that starts past the end cannot
// be served at all: "unsatisfiable", for a 416.
export function byteRange(header, size) {
  if (typeof header !== "string" || !Number.isSafeInteger(size) || size < 0) return null;
  const match = /^\s*bytes\s*=\s*(\d*)\s*-\s*(\d*)\s*$/i.exec(header);
  if (!match || (!match[1] && !match[2])) return null;
  let start, end;
  if (!match[1]) {
    // bytes=-N: the last N bytes.
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix === 0) return size === 0 ? "unsatisfiable" : null;
    start = Math.max(0, size - suffix); end = size - 1;
  } else {
    start = Number(match[1]);
    if (!Number.isSafeInteger(start)) return null;
    // Past the end is a range that exists and cannot be served; an end before
    // its start is not a range at all.
    if (start >= size) return "unsatisfiable";
    end = match[2] ? Number(match[2]) : size - 1;
    if (!Number.isSafeInteger(end) || end < start) return null;
    end = Math.min(end, size - 1);
  }
  return { start, end };
}
