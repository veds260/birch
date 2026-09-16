// Who is moving their mouth. Samples the video a few times a second, finds every
// face with its lip landmarks, and writes how open each mouth is. The editor lines
// that up with the audio to tell the speaker from the people around them.
import AVFoundation
import Vision
import Foundation

let args = CommandLine.arguments
guard args.count >= 3 else { FileHandle.standardError.write("usage: talkers <in.mp4> <out.jsonl> [fps]\n".data(using: .utf8)!); exit(2) }
let asset = AVURLAsset(url: URL(fileURLWithPath: args[1]))
let outPath = args[2]
let fps: Double = args.count > 3 ? (Double(args[3]) ?? 5.0) : 5.0
guard asset.tracks(withMediaType: .video).first != nil else { exit(3) }
let dur = CMTimeGetSeconds(asset.duration)

let reader = try! AVAssetReader(asset: asset)
let track = asset.tracks(withMediaType: .video).first!
let out = AVAssetReaderTrackOutput(track: track, outputSettings: [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA])
out.alwaysCopiesSampleData = false
reader.add(out)
reader.startReading()

// the file's own rotation, so boxes come out in the frame people see
let tf = track.preferredTransform
var orient: CGImagePropertyOrientation = .up
if tf.b == 1.0 && tf.c == -1.0 { orient = .right }
else if tf.b == -1.0 && tf.c == 1.0 { orient = .left }
else if tf.a == -1.0 && tf.d == -1.0 { orient = .down }

FileManager.default.createFile(atPath: outPath, contents: nil)
let fh = FileHandle(forWritingAtPath: outPath)!
func r3(_ v: Double) -> Double { return (v * 1000.0).rounded() / 1000.0 }

var next = 0.0, n = 0
while let sb = out.copyNextSampleBuffer() {
    let t = CMTimeGetSeconds(CMSampleBufferGetPresentationTimeStamp(sb))
    if t + 0.001 < next { continue }
    next = t + 1.0 / fps
    guard let px = CMSampleBufferGetImageBuffer(sb) else { continue }
    let req = VNDetectFaceLandmarksRequest()
    let h = VNImageRequestHandler(cvPixelBuffer: px, orientation: orient, options: [:])
    try? h.perform([req])
    var faces: [[Double]] = []
    for f in (req.results ?? []) {
        let b = f.boundingBox
        var open = -1.0
        if let lips = f.landmarks?.innerLips, lips.pointCount > 2 {
            let ys = lips.normalizedPoints.map { Double($0.y) }
            open = (ys.max()! - ys.min()!)
        }
        faces.append([r3(Double(b.minX)), r3(1.0 - Double(b.maxY)), r3(Double(b.maxX)), r3(1.0 - Double(b.minY)), r3(open)])
    }
    let line = "{\"t\":\(r3(t)),\"f\":\(faces)}\n"
    fh.write(line.data(using: .utf8)!)
    n += 1
    if n % 25 == 0 { FileHandle.standardError.write("talkers \(Int(t))\n".data(using: .utf8)!) }
}
fh.closeFile()
print("{\"frames\": \(n), \"duration\": \(dur)}")
