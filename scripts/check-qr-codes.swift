// Reads back the QR codes src/application/qr-code.js makes, with macOS's own
// reader (CoreImage), so the encoder is checked by something that did not
// write it. A development check, not part of npm run check (that needs macOS):
//
//   node scripts/check-qr-codes.mjs > /tmp/qr.json && swift scripts/check-qr-codes.swift /tmp/qr.json
//
// Input: a JSON array of { text, size, modules: ["0101…", …] }. Prints one
// line per code and exits 1 if any did not read back exactly.
import Foundation
import CoreImage

struct Code: Decodable { let text: String; let size: Int; let modules: [String] }

let path = CommandLine.arguments[1]
let codes = try JSONDecoder().decode([Code].self, from: Data(contentsOf: URL(fileURLWithPath: path)))
let detector = CIDetector(ofType: CIDetectorTypeQRCode, context: nil, options: [CIDetectorAccuracy: CIDetectorAccuracyHigh])!
var failed = 0
for code in codes {
  let scale = 8, quiet = 4, edge = (code.size + quiet * 2) * scale
  var pixels = [UInt8](repeating: 255, count: edge * edge)
  for (r, row) in code.modules.enumerated() {
    for (c, bit) in row.enumerated() where bit == "1" {
      for y in 0..<scale { for x in 0..<scale { pixels[((r + quiet) * scale + y) * edge + (c + quiet) * scale + x] = 0 } }
    }
  }
  let provider = CGDataProvider(data: Data(pixels) as CFData)!
  let image = CGImage(width: edge, height: edge, bitsPerComponent: 8, bitsPerPixel: 8, bytesPerRow: edge,
                      space: CGColorSpaceCreateDeviceGray(), bitmapInfo: CGBitmapInfo(rawValue: 0), provider: provider,
                      decode: nil, shouldInterpolate: false, intent: .defaultIntent)!
  let read = (detector.features(in: CIImage(cgImage: image)).first as? CIQRCodeFeature)?.messageString
  let ok = read == code.text
  if !ok { failed += 1 }
  print("\(ok ? "ok" : "FAILED") size \(code.size): \(read ?? "(nothing read)")")
}
exit(failed == 0 ? 0 : 1)
