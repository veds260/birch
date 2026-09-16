// One pass over the video at one frame a second: where the faces are, what the frame
// is of, any text on screen, and where the eye goes. JSON lines, one per sample.
import AVFoundation
import Vision
import Foundation

let args = CommandLine.arguments
guard args.count >= 3 else { FileHandle.standardError.write("usage: scenevision <in.mp4> <out.jsonl> [step]\n".data(using: .utf8)!); exit(2) }
let inURL = URL(fileURLWithPath: args[1])
let outPath = args[2]
let step: Double = args.count > 3 ? (Double(args[3]) ?? 1.0) : 1.0

let asset = AVURLAsset(url: inURL)
guard asset.tracks(withMediaType: .video).first != nil else { exit(3) }
let dur: Double = CMTimeGetSeconds(asset.duration)
let gen = AVAssetImageGenerator(asset: asset)
gen.appliesPreferredTrackTransform = true
gen.requestedTimeToleranceBefore = .zero
gen.requestedTimeToleranceAfter = CMTime(seconds: 0.2, preferredTimescale: 600)
gen.maximumSize = CGSize(width: 640, height: 640)

FileManager.default.createFile(atPath: outPath, contents: nil)
let fh = FileHandle(forWritingAtPath: outPath)!

func r3(_ v: Double) -> Double { return (v * 1000.0).rounded() / 1000.0 }
func box(_ b: CGRect) -> [Double] {
    // Vision uses a bottom-left origin; flip to top-left fractions
    return [r3(Double(b.minX)), r3(1.0 - Double(b.maxY)), r3(Double(b.maxX)), r3(1.0 - Double(b.minY))]
}

var t: Double = 0.0
var n = 0
while t < dur {
    let cm = CMTime(seconds: t, preferredTimescale: 600)
    if let cg = try? gen.copyCGImage(at: cm, actualTime: nil) {
        let handler = VNImageRequestHandler(cgImage: cg, orientation: .up, options: [:])
        let faces = VNDetectFaceRectanglesRequest()
        let sal = VNGenerateAttentionBasedSaliencyImageRequest()
        let cls = VNClassifyImageRequest()
        let txt = VNRecognizeTextRequest()
        txt.recognitionLevel = .fast
        txt.usesLanguageCorrection = false
        try? handler.perform([faces, sal, cls, txt])

        var rec: [String: Any] = ["t": (t * 100.0).rounded() / 100.0]
        var faceList: [[Double]] = []
        for f in (faces.results ?? []) { faceList.append(box(f.boundingBox)) }
        rec["faces"] = faceList
        if let s = sal.results?.first, let first = s.salientObjects?.first {
            rec["look"] = box(first.boundingBox)
        }
        var tagList: [[Any]] = []
        for c in (cls.results ?? []) {
            let conf: Double = Double(c.confidence)
            if conf > 0.35 && tagList.count < 5 { tagList.append([c.identifier, (conf * 100.0).rounded() / 100.0]) }
        }
        rec["tags"] = tagList
        var words: [String] = []
        for o in (txt.results ?? []) { if let s = o.topCandidates(1).first?.string { words.append(s) } }
        if !words.isEmpty { rec["text"] = words.prefix(12).joined(separator: " ") }
        if let data = try? JSONSerialization.data(withJSONObject: rec), let line = String(data: data, encoding: .utf8) {
            fh.write((line + "\n").data(using: .utf8)!)
        }
        n += 1
        if n % 20 == 0 { FileHandle.standardError.write("vision \(n)\n".data(using: .utf8)!) }
    }
    t += step
}
fh.closeFile()
print("{\"frames\": \(n), \"duration\": \(dur)}")
