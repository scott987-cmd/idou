// Length-prefixed JSON over a private pipe; never HTTP, shell text or log output.
export async function* readFrames(stream, limit) {
  let header = Buffer.alloc(4), offset = 0, size = null, used = 0, chunks = [];
  for await (const chunk of stream) {
    let cursor = 0;
    while (cursor < chunk.length) {
      if (size === null) {
        const n = Math.min(4 - offset, chunk.length - cursor); chunk.copy(header, offset, cursor, cursor + n); offset += n; cursor += n;
        if (offset < 4) continue;
        size = header.readUInt32BE(); if (!size || size > limit()) throw new Error("Runtime frame limit");
      }
      const n = Math.min(size - used, chunk.length - cursor); chunks.push(chunk.subarray(cursor, cursor + n)); used += n; cursor += n;
      if (used === size) {
        const value = JSON.parse(Buffer.concat(chunks, size).toString("utf8"));
        header = Buffer.alloc(4); offset = 0; size = null; used = 0; chunks = [];
        yield value;
      }
    }
  }
  if (offset || size !== null) throw new Error("Truncated runtime frame");
}
export function writeFrame(stream, value) {
  const bytes = Buffer.from(JSON.stringify(value)), header = Buffer.alloc(4); header.writeUInt32BE(bytes.length);
  return new Promise((resolve, reject) => { stream.write(Buffer.concat([header, bytes]), error => error ? reject(error) : resolve()); });
}
