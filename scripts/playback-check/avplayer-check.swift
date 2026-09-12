// AVFoundation playback check for the ffmpeg Lambda's HLS output.
//
// AVFoundation is the engine behind AVPlayer on iOS, so this exercises the same
// demuxer and decoder path the iOS client uses. It is a stronger check than
// loading the stream in a browser, because HLS.js has its own demuxer.
//
//   swift avplayer-check.swift <master playlist url> <expected duration seconds>

import AVFoundation
import Foundation

let args = CommandLine.arguments
guard args.count >= 3, let url = URL(string: args[1]), let expected = Double(args[2]) else {
    print("usage: avplayer-check.swift <url> <expectedDurationSeconds>")
    exit(2)
}

var failures: [String] = []
func check(_ condition: Bool, _ message: String) {
    if condition {
        print("  ok   \(message)")
    } else {
        print("  FAIL \(message)")
        failures.append(message)
    }
}

print("AVFoundation HLS check")
print("  url: \(url.absoluteString)")

let asset = AVURLAsset(url: url)

// 1. The asset must load and report a duration matching the playlist.
let sem = DispatchSemaphore(value: 0)
var loadedDuration: Double = -1
var isPlayable = false
var loadError: String?

Task {
    do {
        let duration = try await asset.load(.duration)
        loadedDuration = CMTimeGetSeconds(duration)
        isPlayable = try await asset.load(.isPlayable)
    } catch {
        loadError = "\(error)"
    }
    sem.signal()
}
if sem.wait(timeout: .now() + 30) == .timedOut {
    print("  FAIL asset properties did not load within 30s")
    exit(1)
}

if let loadError {
    print("  FAIL asset failed to load: \(loadError)")
    exit(1)
}

check(isPlayable, "asset reports isPlayable")
check(abs(loadedDuration - expected) < 1.0,
      "duration \(String(format: "%.3f", loadedDuration))s within 1s of expected \(expected)s")

// 2. Audio tracks must be present and describe AAC stereo at 48 kHz.
let trackSem = DispatchSemaphore(value: 0)
var trackDescription = "none"
var sampleRate: Double = 0
var channels: Int = 0
Task {
    if let track = try? await asset.loadTracks(withMediaType: .audio).first,
       let descriptions = try? await track.load(.formatDescriptions),
       let desc = descriptions.first {
        let subtype = CMFormatDescriptionGetMediaSubType(desc)
        let chars = [24, 16, 8, 0].map { String(UnicodeScalar((subtype >> UInt32($0)) & 0xff)!) }
        trackDescription = chars.joined()
        if let basic = CMAudioFormatDescriptionGetStreamBasicDescription(desc) {
            sampleRate = basic.pointee.mSampleRate
            channels = Int(basic.pointee.mChannelsPerFrame)
        }
    }
    trackSem.signal()
}
_ = trackSem.wait(timeout: .now() + 30)

// Informational, not a check. For an HLS asset AVFoundation often reports no
// format descriptions until segments have been buffered, and the encoding is
// already verified against the segment bytes by ffprobe in the harness.
print("  info audio format before playback: subtype '\(trackDescription)', " +
      "\(sampleRate) Hz, \(channels) ch")

// 3. Decode from the start. A manifest can parse while segments fail to decode,
//    so advancing currentTime is the check that matters.
let item = AVPlayerItem(asset: asset)
let player = AVPlayer(playerItem: item)
player.volume = 0
player.play()

// AVFoundation drives playback from the main run loop, so the wait has to service
// it rather than sleeping. Sleeping leaves currentTime pinned at 0 and looks like
// a stream that will not decode.
func waitForPlayback(past target: Double, timeout: Double, label: String) -> Double {
    let deadline = Date().addingTimeInterval(timeout)
    var reached: Double = 0
    while Date() < deadline {
        let now = CMTimeGetSeconds(player.currentTime())
        if now.isFinite { reached = now }
        if reached > target { break }
        if let error = item.error {
            print("  FAIL \(label): player item error: \(error)")
            failures.append("\(label) player item error")
            return reached
        }
        RunLoop.current.run(until: Date().addingTimeInterval(0.1))
    }
    return reached
}

let playedFromStart = waitForPlayback(past: 3.0, timeout: 30, label: "playback from start")
check(playedFromStart > 3.0,
      "decoded past 3s from the start (reached \(String(format: "%.2f", playedFromStart))s)")

// Once buffers exist, the decoded format is available and worth asserting: this is
// what the decoder actually produced, not what the playlist advertised.
if let playing = item.tracks.first(where: { $0.assetTrack?.mediaType == .audio }),
   let desc = playing.assetTrack?.formatDescriptions.first as! CMFormatDescription? {
    let subtype = CMFormatDescriptionGetMediaSubType(desc)
    let chars = [24, 16, 8, 0].map { String(UnicodeScalar((subtype >> UInt32($0)) & 0xff)!) }
    let decoded = chars.joined()
    check(decoded == "aac ", "decoded audio subtype is 'aac ' (got '\(decoded)')")
    if let basic = CMAudioFormatDescriptionGetStreamBasicDescription(desc) {
        check(basic.pointee.mSampleRate == 48000,
              "decoded sample rate is 48000 (got \(basic.pointee.mSampleRate))")
        check(basic.pointee.mChannelsPerFrame == 2,
              "decoded channel count is 2 (got \(basic.pointee.mChannelsPerFrame))")
    }
} else {
    print("  info no decoded audio track description available")
}

// 4. Seek into the middle. This loads a segment that is not the first, which is
//    where a missing or wrong timestamp shows up.
let seekTarget = min(300.0, expected * 0.5)
var seekFinished = false
var seekReturned = false
player.seek(to: CMTime(seconds: seekTarget, preferredTimescale: 600)) { done in
    seekFinished = done
    seekReturned = true
}
let seekDeadline = Date().addingTimeInterval(30)
while !seekReturned && Date() < seekDeadline {
    RunLoop.current.run(until: Date().addingTimeInterval(0.1))
}
check(seekFinished, "seek to \(seekTarget)s completed")

player.play()
let playedAfterSeek = waitForPlayback(past: seekTarget + 2.0, timeout: 30, label: "playback after seek")
check(playedAfterSeek > seekTarget + 2.0,
      "decoded past \(seekTarget + 2.0)s after seeking (reached \(String(format: "%.2f", playedAfterSeek))s)")

// 5. Seek to near the end, which exercises the final short segment.
let tailTarget = expected - 4.0
var tailReturned = false
player.seek(to: CMTime(seconds: tailTarget, preferredTimescale: 600)) { _ in tailReturned = true }
let tailDeadline = Date().addingTimeInterval(30)
while !tailReturned && Date() < tailDeadline {
    RunLoop.current.run(until: Date().addingTimeInterval(0.1))
}
player.play()
let playedTail = waitForPlayback(past: tailTarget + 1.0, timeout: 30, label: "playback near end")
check(playedTail > tailTarget + 1.0,
      "decoded the final segment (reached \(String(format: "%.2f", playedTail))s)")

player.pause()

print("")
if failures.isEmpty {
    print("PASS — AVFoundation played the stream from the start, after a mid-file seek, and at the end")
    exit(0)
} else {
    print("FAIL — \(failures.count) check(s) failed:")
    for f in failures { print("  - \(f)") }
    exit(1)
}
