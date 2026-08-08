// Reads text and positions out of an image using Apple's Vision framework.
//
// Why Swift in a TypeScript project: Vision ships with macOS and is very good at
// clean synthetic text like CAD labels. No install, no API key, no per-page cost.
// Tesseract would need a Homebrew package and performs worse on small type.
//
//   swift tools/ocr.swift <image.png> [tiles]
//
// Prints TSV: text <TAB> centreX <TAB> centreY <TAB> confidence
// Coordinates are pixels from the TOP-LEFT of the image.

import Foundation
import Vision
import AppKit

let args = CommandLine.arguments
guard args.count > 1 else {
    FileHandle.standardError.write("usage: ocr.swift <image.png> [tiles]\n".data(using: .utf8)!)
    exit(2)
}
let path = args[1]
let tiles = args.count > 2 ? (Int(args[2]) ?? 5) : 5

guard let img = NSImage(contentsOfFile: path),
      let full = img.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
    FileHandle.standardError.write("cannot load \(path)\n".data(using: .utf8)!)
    exit(1)
}

// Vision downscales large images internally, which destroys 6pt room labels. So we
// hand it overlapping tiles at full resolution instead. The overlap stops labels
// that straddle a tile boundary from being cut in half; duplicates are removed
// afterwards by rounding the position into a coarse grid.
let W = full.width, H = full.height
let tw = W / tiles, th = H / tiles
let overlap = 100
var seen = Set<String>()
var out = ""

for ty in 0..<tiles {
    for tx in 0..<tiles {
        let x = max(0, tx * tw - overlap)
        let y = max(0, ty * th - overlap)
        let w = min(W - x, tw + overlap * 2)
        let h = min(H - y, th + overlap * 2)
        guard w > 0, h > 0,
              let tile = full.cropping(to: CGRect(x: x, y: y, width: w, height: h)) else { continue }

        let req = VNRecognizeTextRequest()
        req.recognitionLevel = .accurate
        // Off: these are room codes, not prose. Autocorrect turns "1-077R" into words.
        req.usesLanguageCorrection = false
        req.recognitionLanguages = ["en-US"]

        try? VNImageRequestHandler(cgImage: tile, options: [:]).perform([req])

        for obs in (req.results ?? []) {
            guard let best = obs.topCandidates(1).first else { continue }
            let b = obs.boundingBox                       // normalised, origin bottom-left
            let px = x + Int(b.midX * CGFloat(w))
            let py = y + Int((1 - b.midY) * CGFloat(h))   // flip to top-left origin
            let key = "\(best.string)|\(px / 12)|\(py / 12)"
            if seen.contains(key) { continue }
            seen.insert(key)
            out += "\(best.string)\t\(px)\t\(py)\t\(String(format: "%.2f", best.confidence))\n"
        }
    }
}

FileHandle.standardOutput.write(out.data(using: .utf8)!)
