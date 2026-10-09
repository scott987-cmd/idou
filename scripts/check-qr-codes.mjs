// The codes scripts/check-qr-codes.swift reads back: a site's links as they
// are shared, and one long enough for every version the encoder makes.
import { qrMatrix } from "../src/application/qr-code.js";

const texts = [
  "https://sites.example/s/6f0d2c1e-0000-4000-8000-0000000000ee/?from=qr",
  `https://sites.example/s/${encodeURIComponent("销售周报")}/?from=qr`,
  "HELLO",
  "i豆 文档网站",
  ...[20, 30, 50, 70, 90, 110, 130, 160, 190, 210].map((length) => `https://example.test/${"x".repeat(Math.max(1, length - 21))}`),
];
const shape = (text, options) => {
  const { size, modules, version } = qrMatrix(text, options);
  return { text, size, version, modules: modules.map((row) => row.map((dark) => (dark ? "1" : "0")).join("")) };
};
// And every mask, on a code with version information and alignment patterns on the timing lines.
const codes = [...texts.map((text) => shape(text)), ...[0, 1, 2, 3, 4, 5, 6, 7].map((mask) => shape(texts[0].padEnd(130, "y"), { mask }))];
process.stdout.write(JSON.stringify(codes));
