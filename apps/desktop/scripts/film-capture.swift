// Records one window by its title, wherever it is and whatever covers it, to an HEVC file at the window's native pixels: only that window's pixels
// reach the film, so the person can go on using the computer. q on stdin finishes the file.
// film-capture <title> <file> <width> <height> <fps>
import AppKit
import AVFoundation
import CoreMedia
import Foundation
import ScreenCaptureKit

// ScreenCaptureKit needs a process with a connection to the window server.
_ = NSApplication.shared
let args = CommandLine.arguments
let mbps = args.count > 6 ? Int(args[6]) ?? 240 : 240
guard args.count >= 6, let width = Int(args[3]), let height = Int(args[4]), let fps = Int32(args[5]) else { fatalError("usage: film-capture <title> <file> <width> <height> <fps> [mbps]") }
let url = URL(fileURLWithPath: args[2])
try? FileManager.default.removeItem(at: url)

final class Recorder: NSObject, SCStreamOutput, @unchecked Sendable {
  let writer: AVAssetWriter
  let input: AVAssetWriterInput
  var started = false
  init(_ url: URL, _ width: Int, _ height: Int) throws {
    writer = try AVAssetWriter(outputURL: url, fileType: .mp4)
    input = AVAssetWriterInput(mediaType: .video, outputSettings: [AVVideoCodecKey: AVVideoCodecType.hevc, AVVideoWidthKey: width, AVVideoHeightKey: height, AVVideoCompressionPropertiesKey: [AVVideoAverageBitRateKey: mbps * 1_000_000]])
    input.expectsMediaDataInRealTime = true
    writer.add(input)
  }
  func stream(_ stream: SCStream, didOutputSampleBuffer sample: CMSampleBuffer, of type: SCStreamOutputType) {
    guard type == .screen, sample.isValid,
      let info = CMSampleBufferGetSampleAttachmentsArray(sample, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
      let raw = info.first?[.status] as? Int, SCFrameStatus(rawValue: raw) == .complete else { return }
    if !started {
      started = true
      writer.startWriting()
      writer.startSession(atSourceTime: sample.presentationTimeStamp)
      print("first-frame")
      fflush(stdout)
    }
    if input.isReadyForMoreMediaData { input.append(sample) }
  }
}

Task {
  do {
    var found: SCWindow?
    for _ in 0..<50 where found == nil {
      let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
      found = content.windows.first { $0.title == args[1] }
      if found == nil { try await Task.sleep(nanoseconds: 100_000_000) }
    }
    guard let window = found else { fatalError("no window titled \(args[1])") }
    let config = SCStreamConfiguration()
    config.width = width
    config.height = height
    config.minimumFrameInterval = CMTime(value: 1, timescale: fps)
    config.showsCursor = false
    config.queueDepth = 8
    config.pixelFormat = kCVPixelFormatType_32BGRA
    let recorder = try Recorder(url, width, height)
    let stream = SCStream(filter: SCContentFilter(desktopIndependentWindow: window), configuration: config, delegate: nil)
    try stream.addStreamOutput(recorder, type: .screen, sampleHandlerQueue: DispatchQueue(label: "film.capture"))
    try await stream.startCapture()
    while let line = readLine(strippingNewline: true), line != "q" {}
    try await stream.stopCapture()
    recorder.input.markAsFinished()
    await recorder.writer.finishWriting()
    exit(recorder.writer.status == .completed ? 0 : 1)
  } catch {
    fputs("film-capture: \(error)\n", stderr)
    exit(1)
  }
}
dispatchMain()
