// A QR code for a site's link (docs/sites-phase1.md §1.4), made here: a link
// sent to a service to be drawn is a link given away. Byte mode (UTF-8),
// error correction level M (about 15% of the code can be lost and it still
// reads), versions 1 to 10 -- up to 213 bytes, more than a site's link needs.
// Written from ISO/IEC 18004; checked against macOS's own reader
// (scripts/check-qr-codes.swift), and the matrices it made are pinned in
// test/qr-code.test.js.

// Level M, versions 1..10: error correction codewords per block, and the
// blocks as [count, data codewords each].
const BLOCKS = [null,
  [10, [[1, 16]]], [16, [[1, 28]]], [26, [[1, 44]]], [18, [[2, 32]]], [24, [[2, 43]]],
  [16, [[4, 27]]], [18, [[4, 31]]], [22, [[2, 38], [2, 39]]], [22, [[3, 36], [2, 37]]], [26, [[4, 43], [1, 44]]]];
const ALIGNMENT = [null, [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];
const REMAINDER_BITS = [null, 0, 7, 7, 7, 7, 7, 0, 0, 0, 0];
const LEVEL_M = 0b00;

// GF(256) with the QR polynomial x^8 + x^4 + x^3 + x^2 + 1.
const EXP = new Uint8Array(512), LOG = new Uint8Array(256);
for (let i = 0, x = 1; i < 255; i += 1) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11d; }
for (let i = 255; i < 512; i += 1) EXP[i] = EXP[i - 255];
const multiply = (a, b) => (a && b ? EXP[LOG[a] + LOG[b]] : 0);

function generator(degree) {
  let poly = [1];
  for (let i = 0; i < degree; i += 1) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j += 1) { next[j] ^= poly[j]; next[j + 1] ^= multiply(poly[j], EXP[i]); }
    poly = next;
  }
  return poly;
}
function errorCorrection(data, degree) {
  const gen = generator(degree), out = [...data, ...new Array(degree).fill(0)];
  for (let i = 0; i < data.length; i += 1) {
    const factor = out[i];
    if (factor) for (let j = 0; j < gen.length; j += 1) out[i + j] ^= multiply(gen[j], factor);
  }
  return out.slice(data.length);
}

const capacity = (version) => BLOCKS[version][1].reduce((sum, [count, size]) => sum + count * size, 0);

function codewords(bytes, version) {
  const bits = [];
  const put = (value, length) => { for (let i = length - 1; i >= 0; i -= 1) bits.push((value >>> i) & 1); };
  put(0b0100, 4);
  put(bytes.length, version < 10 ? 8 : 16);
  for (const byte of bytes) put(byte, 8);
  const room = capacity(version) * 8;
  put(0, Math.min(4, room - bits.length));
  while (bits.length % 8) bits.push(0);
  const data = [];
  for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((byte, bit) => (byte << 1) | bit, 0));
  for (let pad = 0; data.length < capacity(version); pad += 1) data.push(pad % 2 ? 0x11 : 0xec);
  // Split into blocks, each with its own error correction, then interleave.
  const [degree, layout] = BLOCKS[version];
  const blocks = [];
  let at = 0;
  for (const [count, size] of layout) for (let n = 0; n < count; n += 1) { const chunk = data.slice(at, at + size); at += size; blocks.push({ data: chunk, ec: errorCorrection(chunk, degree) }); }
  const out = [];
  const longest = Math.max(...blocks.map((block) => block.data.length));
  for (let i = 0; i < longest; i += 1) for (const block of blocks) if (i < block.data.length) out.push(block.data[i]);
  for (let i = 0; i < degree; i += 1) for (const block of blocks) out.push(block.ec[i]);
  return out;
}

// BCH codes for the format (15,5) and version (18,6) information.
function bch(value, poly, length) {
  const degree = Math.floor(Math.log2(poly));
  let rest = value << degree;
  while (rest >= 1 << degree) rest ^= poly << (Math.floor(Math.log2(rest)) - degree);
  return (value << degree) | rest;
}

const MASKS = [
  (r, c) => (r + c) % 2 === 0, (r) => r % 2 === 0, (_r, c) => c % 3 === 0, (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0, (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0, (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

function base(version) {
  const size = 17 + version * 4;
  const dark = Array.from({ length: size }, () => new Array(size).fill(false));
  const fixed = Array.from({ length: size }, () => new Array(size).fill(false));
  const set = (r, c, value) => { if (r >= 0 && c >= 0 && r < size && c < size) { dark[r][c] = value; fixed[r][c] = true; } };
  const finder = (top, left) => {
    for (let r = -1; r <= 7; r += 1) for (let c = -1; c <= 7; c += 1) {
      const ring = Math.max(Math.abs(r - 3), Math.abs(c - 3));
      set(top + r, left + c, r >= 0 && r <= 6 && c >= 0 && c <= 6 && ring !== 2);
    }
  };
  finder(0, 0); finder(0, size - 7); finder(size - 7, 0);
  for (let i = 8; i < size - 8; i += 1) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
  // Every alignment pattern but the three where the finders are; those on a
  // timing line are drawn over it.
  const places = ALIGNMENT[version], last = places.length - 1;
  places.forEach((r, i) => places.forEach((c, j) => {
    if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) return;
    for (let dr = -2; dr <= 2; dr += 1) for (let dc = -2; dc <= 2; dc += 1) set(r + dr, c + dc, Math.max(Math.abs(dr), Math.abs(dc)) !== 1);
  }));
  // The format information's places, written once the mask is chosen, and the dark module.
  for (let i = 0; i < 9; i += 1) { if (!fixed[8][i]) set(8, i, false); if (!fixed[i][8]) set(i, 8, false); }
  for (let i = 0; i < 8; i += 1) { set(8, size - 1 - i, false); set(size - 1 - i, 8, false); }
  set(size - 8, 8, true);
  if (version >= 7) {
    const info = bch(version, 0x1f25, 18);
    for (let i = 0; i < 18; i += 1) {
      const bit = ((info >>> i) & 1) === 1, a = Math.floor(i / 3), b = (i % 3) + size - 11;
      set(a, b, bit); set(b, a, bit);
    }
  }
  return { size, dark, fixed };
}

function place(matrix, data, version) {
  const { size, dark, fixed } = matrix;
  const bits = [];
  for (const byte of data) for (let i = 7; i >= 0; i -= 1) bits.push((byte >>> i) & 1);
  for (let i = 0; i < REMAINDER_BITS[version]; i += 1) bits.push(0);
  let index = 0, upward = true;
  for (let right = size - 1; right > 0; right -= 2) {
    if (right === 6) right = 5;
    for (let step = 0; step < size; step += 1) {
      const r = upward ? size - 1 - step : step;
      for (const c of [right, right - 1]) if (!fixed[r][c]) dark[r][c] = bits[index++] === 1;
    }
    upward = !upward;
  }
}

function formatBits(mask) { return bch((LEVEL_M << 3) | mask, 0x537, 15) ^ 0x5412; }
// Bit 0 is the least significant. One copy around the top-left finder, one
// split between the other two; the dark module beside the second.
function writeFormat(dark, size, mask) {
  const bits = formatBits(mask), bit = (i) => ((bits >>> i) & 1) === 1;
  for (let i = 0; i <= 5; i += 1) dark[i][8] = bit(i);
  dark[7][8] = bit(6); dark[8][8] = bit(7); dark[8][7] = bit(8);
  for (let i = 9; i < 15; i += 1) dark[8][14 - i] = bit(i);
  for (let i = 0; i < 8; i += 1) dark[8][size - 1 - i] = bit(i);
  for (let i = 8; i < 15; i += 1) dark[size - 15 + i][8] = bit(i);
  dark[size - 8][8] = true;
}

function penalty(dark, size) {
  let score = 0;
  // Runs of five or more of one colour, in rows and columns.
  for (let pass = 0; pass < 2; pass += 1) for (let a = 0; a < size; a += 1) {
    let run = 1;
    for (let b = 1; b < size; b += 1) {
      const here = pass ? dark[b][a] : dark[a][b], before = pass ? dark[b - 1][a] : dark[a][b - 1];
      if (here === before) { run += 1; if (b === size - 1 && run >= 5) score += run - 2; }
      else { if (run >= 5) score += run - 2; run = 1; }
    }
  }
  // 2x2 blocks of one colour.
  for (let r = 0; r < size - 1; r += 1) for (let c = 0; c < size - 1; c += 1) {
    const v = dark[r][c];
    if (v === dark[r][c + 1] && v === dark[r + 1][c] && v === dark[r + 1][c + 1]) score += 3;
  }
  // Patterns that look like a finder: 1011101 with four light on a side.
  const looks = (line) => {
    let found = 0;
    for (let i = 0; i + 11 <= line.length; i += 1) {
      const window = line.slice(i, i + 11).map((v) => (v ? 1 : 0)).join("");
      if (window === "10111010000" || window === "00001011101") found += 1;
    }
    return found;
  };
  for (let a = 0; a < size; a += 1) score += 40 * (looks(dark[a]) + looks(dark.map((row) => row[a])));
  // How far from half dark.
  const darkCount = dark.reduce((sum, row) => sum + row.filter(Boolean).length, 0);
  score += Math.floor(Math.abs((darkCount * 100) / (size * size) - 50) / 5) * 10;
  return score;
}

// The modules, true for dark, for `text`; and the version and mask used.
// `mask`: one of the eight, instead of the one that reads best (for checking each).
export function qrMatrix(text, { mask: only = null } = {}) {
  const bytes = new TextEncoder().encode(String(text));
  const version = BLOCKS.findIndex((row, v) => row && capacity(v) * 8 >= 4 + (v < 10 ? 8 : 16) + bytes.length * 8);
  if (version < 1) throw new Error("这段文字太长，放不进二维码");
  const data = codewords(bytes, version);
  let best = null;
  for (let mask = 0; mask < 8; mask += 1) {
    if (only !== null && mask !== only) continue;
    const matrix = base(version);
    place(matrix, data, version);
    for (let r = 0; r < matrix.size; r += 1) for (let c = 0; c < matrix.size; c += 1) if (!matrix.fixed[r][c] && MASKS[mask](r, c)) matrix.dark[r][c] = !matrix.dark[r][c];
    writeFormat(matrix.dark, matrix.size, mask);
    const score = penalty(matrix.dark, matrix.size);
    if (!best || score < best.score) best = { score, mask, modules: matrix.dark };
  }
  return { version, mask: best.mask, size: best.modules.length, modules: best.modules };
}

// An SVG of it, with the four-module quiet zone around it that readers need.
export function qrSvg(text, { scale = 8, dark = "#111", light = "#fff" } = {}) {
  const { size, modules } = qrMatrix(text);
  const edge = size + 8;
  let path = "";
  for (let r = 0; r < size; r += 1) for (let c = 0; c < size; c += 1) if (modules[r][c]) path += `M${c + 4} ${r + 4}h1v1h-1z`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${edge} ${edge}" width="${edge * scale}" height="${edge * scale}" shape-rendering="crispEdges">`
    + `<rect width="${edge}" height="${edge}" fill="${light}"/><path d="${path}" fill="${dark}"/></svg>`;
}
