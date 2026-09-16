// mic-watch — reports whether any process is using the microphone.
//
// Prints one line per state transition on stdout:
//     active     some process has the default input device open
//     inactive   nothing is using it
// The initial state is printed immediately. Exits when stdin closes, so the
// parent only has to keep the pipe open to keep the helper alive.
//
// `kAudioDevicePropertyDeviceIsRunningSomewhere` is the same signal macOS uses
// for the orange microphone indicator. A one-second poll is deliberate: the
// consumer debounces transitions for seconds anyway, so the poll is simpler
// and more robust than property listeners across device switches.

import CoreAudio
import Foundation

func defaultInputDevice() -> AudioDeviceID? {
    var device = AudioDeviceID(0)
    var size = UInt32(MemoryLayout<AudioDeviceID>.size)
    var address = AudioObjectPropertyAddress(
        mSelector: kAudioHardwarePropertyDefaultInputDevice,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain)
    let status = AudioObjectGetPropertyData(
        AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &device)
    guard status == noErr, device != 0 else { return nil }
    return device
}

func isRunningSomewhere(_ device: AudioDeviceID) -> Bool {
    var running: UInt32 = 0
    var size = UInt32(MemoryLayout<UInt32>.size)
    var address = AudioObjectPropertyAddress(
        mSelector: kAudioDevicePropertyDeviceIsRunningSomewhere,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain)
    let status = AudioObjectGetPropertyData(device, &address, 0, nil, &size, &running)
    return status == noErr && running != 0
}

// Exit when the parent goes away without killing us.
let stdinWatcher = Thread {
    var buffer = [UInt8](repeating: 0, count: 1)
    while true {
        if read(STDIN_FILENO, &buffer, 1) <= 0 { exit(0) }
    }
}
stdinWatcher.name = "mic-watch-stdin"
stdinWatcher.start()

signal(SIGPIPE, SIG_IGN)

var lastReported: Bool? = nil
while true {
    let active = defaultInputDevice().map(isRunningSomewhere) ?? false
    if active != lastReported {
        print(active ? "active" : "inactive")
        fflush(stdout)
        lastReported = active
    }
    Thread.sleep(forTimeInterval: 1.0)
}
