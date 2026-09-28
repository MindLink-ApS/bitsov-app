import CoreGraphics
import Foundation

// Select only this test app's titled window, never the whole desktop.
let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
let ownedPids = Set(CommandLine.arguments.dropFirst().compactMap(Int.init))
for window in windows {
    let name = window[kCGWindowName as String] as? String ?? ""
    let owner = window[kCGWindowOwnerName as String] as? String ?? ""
    let pid = window[kCGWindowOwnerPID as String] as? Int ?? -1
    let layer = window[kCGWindowLayer as String] as? Int ?? -1
    if ownedPids.contains(pid) && layer == 0 {
        FileHandle.standardError.write(Data("owned window: \(owner) / \(name) / \(pid)\n".utf8))
        print(window[kCGWindowNumber as String]!)
        exit(0)
    }
}
exit(1)
