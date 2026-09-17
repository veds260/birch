// Writes a black-and-white mask video where white is the person, using the
// segmentation built into macOS. ffmpeg then uses it to slide text behind them.
import AVFoundation
import Vision
import CoreImage
import Foundation

let args = CommandLine.arguments
guard args.count >= 3 else {
    FileHandle.standardError.write("usage: personmask <in.mp4> <out.mov> [quality]\n".data(using: .utf8)!)
    exit(2)
}
let inURL = URL(fileURLWithPath: args[1])
let outURL = URL(fileURLWithPath: args[2])
let qual = args.count > 3 ? args[3] : "balanced"
try? FileManager.default.removeItem(at: outURL)

let asset = AVURLAsset(url: inURL)
guard let track = asset.tracks(withMediaType: .video).first else { exit(3) }
// the file's own rotation, so the matte matches the picture people see
let tf = track.preferredTransform
var orient: CGImagePropertyOrientation = .up
if tf.b == 1.0 && tf.c == -1.0 { orient = .right }
else if tf.b == -1.0 && tf.c == 1.0 { orient = .left }
else if tf.a == -1.0 && tf.d == -1.0 { orient = .down }
let size = track.naturalSize.applying(track.preferredTransform)
let W = abs(Int(size.width)), H = abs(Int(size.height))
let fps = track.nominalFrameRate > 0 ? track.nominalFrameRate : 30

let reader = try AVAssetReader(asset: asset)
let output = AVAssetReaderTrackOutput(track: track, outputSettings: [
    kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA])
output.alwaysCopiesSampleData = false
reader.add(output)

let writer = try AVAssetWriter(outputURL: outURL, fileType: .mov)
let input = AVAssetWriterInput(mediaType: .video, outputSettings: [
    AVVideoCodecKey: AVVideoCodecType.h264,
    AVVideoWidthKey: W, AVVideoHeightKey: H,
    AVVideoCompressionPropertiesKey: [AVVideoAverageBitRateKey: W * H * 4]])
input.expectsMediaDataInRealTime = false
let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input,
    sourcePixelBufferAttributes: [
        kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
        kCVPixelBufferWidthKey as String: W, kCVPixelBufferHeightKey as String: H])
writer.add(input)

let request = VNGeneratePersonSegmentationRequest()
request.qualityLevel = qual == "fast" ? .fast : (qual == "accurate" ? .accurate : .balanced)
request.outputPixelFormat = kCVPixelFormatType_OneComponent8
let ci = CIContext()

writer.startWriting()
writer.startSession(atSourceTime: .zero)
reader.startReading()

var n = 0
let queue = DispatchQueue(label: "mask")
let done = DispatchSemaphore(value: 0)

input.requestMediaDataWhenReady(on: queue) {
    while input.isReadyForMoreMediaData {
        guard reader.status == .reading,
              let sample = output.copyNextSampleBuffer(),
              let pixels = CMSampleBufferGetImageBuffer(sample) else {
            input.markAsFinished()
            writer.finishWriting { done.signal() }
            return
        }
        let time = CMSampleBufferGetPresentationTimeStamp(sample)
        let handler = VNImageRequestHandler(cvPixelBuffer: pixels, orientation: orient, options: [:])
        var out: CVPixelBuffer?
        CVPixelBufferCreate(nil, W, H, kCVPixelFormatType_32BGRA, nil, &out)
        if let buf = out {
            do {
                try handler.perform([request])
                if let mask = (request.results?.first)?.pixelBuffer {
                    // the mask comes back smaller than the frame, so stretch it
                    var img = CIImage(cvPixelBuffer: mask)
                    let sx = CGFloat(W) / img.extent.width
                    let sy = CGFloat(H) / img.extent.height
                    img = img.transformed(by: CGAffineTransform(scaleX: sx, y: sy))
                    ci.render(img, to: buf)
                } else {
                    ci.render(CIImage(color: .black).cropped(to: CGRect(x: 0, y: 0, width: W, height: H)), to: buf)
                }
            } catch {
                ci.render(CIImage(color: .black).cropped(to: CGRect(x: 0, y: 0, width: W, height: H)), to: buf)
            }
            adaptor.append(buf, withPresentationTime: time)
            n += 1
            if n % 60 == 0 {
                FileHandle.standardError.write("mask progress \(n)\n".data(using: .utf8)!)
            }
        }
    }
}
done.wait()
print("{\"frames\": \(n), \"width\": \(W), \"height\": \(H), \"fps\": \(fps)}")
