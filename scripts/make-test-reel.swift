// Writes a 6-second 1080x1920 H.264 test video for reel test runs, using only macOS frameworks.
//   swift scripts/make-test-reel.swift ~/Feedpilot/media/feedpilot-test-reel.mp4
import AVFoundation
import CoreGraphics
import CoreText
import Foundation

let output = URL(fileURLWithPath: (CommandLine.arguments[1] as NSString).expandingTildeInPath)
try? FileManager.default.removeItem(at: output)

let width = 1080, height = 1920, fps: Int32 = 30, seconds = 6
let writer = try AVAssetWriter(outputURL: output, fileType: .mp4)
let input = AVAssetWriterInput(mediaType: .video, outputSettings: [
  AVVideoCodecKey: AVVideoCodecType.h264, AVVideoWidthKey: width, AVVideoHeightKey: height,
])
let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: [
  kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32ARGB,
  kCVPixelBufferWidthKey as String: width,
  kCVPixelBufferHeightKey as String: height,
])
writer.add(input)
writer.startWriting()
writer.startSession(atSourceTime: .zero)

let colorSpace = CGColorSpaceCreateDeviceRGB()
let font = CTFontCreateWithName("Helvetica-Bold" as CFString, 110, nil)
let label = NSAttributedString(string: "Feedpilot reel test", attributes: [
  NSAttributedString.Key(kCTFontAttributeName as String): font,
  NSAttributedString.Key(kCTForegroundColorAttributeName as String): CGColor(red: 1, green: 1, blue: 1, alpha: 1),
])
let line = CTLineCreateWithAttributedString(label)
let textWidth = CTLineGetBoundsWithOptions(line, []).width
let frames = Int(fps) * seconds

for frame in 0..<frames {
  while !input.isReadyForMoreMediaData { usleep(1000) }
  var pixelBuffer: CVPixelBuffer?
  CVPixelBufferPoolCreatePixelBuffer(nil, adaptor.pixelBufferPool!, &pixelBuffer)
  guard let buffer = pixelBuffer else { fatalError("could not get a pixel buffer") }
  CVPixelBufferLockBaseAddress(buffer, [])
  let context = CGContext(
    data: CVPixelBufferGetBaseAddress(buffer), width: width, height: height, bitsPerComponent: 8,
    bytesPerRow: CVPixelBufferGetBytesPerRow(buffer), space: colorSpace,
    bitmapInfo: CGImageAlphaInfo.noneSkipFirst.rawValue)!
  let t = Double(frame) / Double(frames)
  let top = CGColor(red: 0.37 + 0.3 * t, green: 0.15, blue: 0.8 - 0.4 * t, alpha: 1)
  let bottom = CGColor(red: 1.0, green: 0.42 + 0.3 * t, blue: 0.42, alpha: 1)
  let gradient = CGGradient(colorsSpace: colorSpace, colors: [top, bottom] as CFArray, locations: [0, 1])!
  context.drawLinearGradient(gradient, start: CGPoint(x: 0, y: height), end: .zero, options: [])
  context.textPosition = CGPoint(x: (CGFloat(width) - textWidth) / 2, y: CGFloat(height) / 2 + CGFloat(sin(t * .pi * 2) * 200))
  CTLineDraw(line, context)
  CVPixelBufferUnlockBaseAddress(buffer, [])
  adaptor.append(buffer, withPresentationTime: CMTime(value: CMTimeValue(frame), timescale: fps))
}

input.markAsFinished()
let finished = DispatchSemaphore(value: 0)
writer.finishWriting { finished.signal() }
finished.wait()
print(writer.status == .completed ? "wrote \(output.path)" : "failed: \(String(describing: writer.error))")
