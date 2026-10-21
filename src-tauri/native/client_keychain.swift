// App-client seeds stay in the local Data Protection Keychain. No UI, sync,
// access-group sharing, legacy-login fallback, or update/overwrite operation.
import Foundation
import Security
import LocalAuthentication

struct ClientKeychain {
    var copy: (CFDictionary, UnsafeMutablePointer<CFTypeRef?>?) -> OSStatus = SecItemCopyMatching
    var add: (CFDictionary, UnsafeMutablePointer<CFTypeRef?>?) -> OSStatus = SecItemAdd
    var delete: (CFDictionary) -> OSStatus = SecItemDelete

    func remove(_ account: String) -> OSStatus {
        var attributes = query(account)
        attributes.removeValue(forKey: kSecAttrAccessible)
        let context = LAContext()
        context.interactionNotAllowed = true
        defer { context.invalidate() }
        attributes[kSecUseAuthenticationContext] = context
        let status = delete(attributes as CFDictionary)
        return status == errSecItemNotFound ? errSecSuccess : status
    }

    func query(_ account: String) -> [CFString: Any] {
        [kSecClass: kSecClassGenericPassword,
         kSecAttrService: "tech.mindlink.bitsov.client-ed25519.v1",
         kSecAttrAccount: account,
         kSecAttrSynchronizable: false,
         kSecUseDataProtectionKeychain: true,
         kSecAttrAccessible: kSecAttrAccessibleWhenUnlockedThisDeviceOnly]
    }

    func read(_ account: String, _ output: UnsafeMutablePointer<UInt8>) -> OSStatus {
        var attributes = query(account)
        attributes[kSecReturnData] = true
        attributes[kSecMatchLimit] = kSecMatchLimitOne
        let context = LAContext()
        context.interactionNotAllowed = true
        defer { context.invalidate() }
        attributes[kSecUseAuthenticationContext] = context
        var result: CFTypeRef?
        let status = copy(attributes as CFDictionary, &result)
        guard status == errSecSuccess else { return status }
        guard var data = result as? Data else { return errSecDecode }
        defer { data.resetBytes(in: 0..<data.count) }
        guard data.count == 32 else { return errSecDecode }
        data.copyBytes(to: output, count: 32)
        return errSecSuccess
    }

    func insert(_ account: String, _ seed: UnsafePointer<UInt8>) -> OSStatus {
        var data = Data(bytes: seed, count: 32)
        defer { data.resetBytes(in: 0..<data.count) }
        var attributes = query(account)
        attributes[kSecValueData] = data
        return add(attributes as CFDictionary, nil)
    }
}

// Container UUIDs may change after an app update. Scope by the path relative to
// Application Support, including the app/profile identifier, never that UUID.
private func clientAccount(_ path: UnsafePointer<CChar>) throws -> String {
    let root = try FileManager.default.url(for: .applicationSupportDirectory,
        in: .userDomainMask, appropriateFor: nil, create: false).standardizedFileURL
    let directory = URL(fileURLWithPath: String(cString: path), isDirectory: true).standardizedFileURL
    let prefix = root.path + "/"
    guard directory.path.hasPrefix(prefix), directory.lastPathComponent == "app-client" else {
        throw NSError(domain: NSOSStatusErrorDomain, code: Int(errSecParam))
    }
    // Covers wrapped device blobs, pairing records and remote descriptors. These
    // are device-specific and must not be restored onto a different phone.
    var appDirectory = directory.deletingLastPathComponent()
    var values = URLResourceValues()
    values.isExcludedFromBackup = true
    try appDirectory.setResourceValues(values)
    return String(directory.path.dropFirst(prefix.count))
}

@_cdecl("bitsov_client_key_read")
public func bitsov_client_key_read(_ path: UnsafePointer<CChar>?, _ output: UnsafeMutablePointer<UInt8>?) -> Int32 {
    guard let path = path, let output = output else { return errSecParam }
    return autoreleasepool {
        do { return ClientKeychain().read(try clientAccount(path), output) }
        catch { return errSecParam }
    }
}

@_cdecl("bitsov_client_key_add")
public func bitsov_client_key_add(_ path: UnsafePointer<CChar>?, _ seed: UnsafePointer<UInt8>?) -> Int32 {
    guard let path = path, let seed = seed else { return errSecParam }
    return autoreleasepool {
        do { return ClientKeychain().insert(try clientAccount(path), seed) }
        catch { return errSecParam }
    }
}

// Only the Rust fresh-install guard calls this, before pairing can start.
// Exact service/account deletion; no seed lookup and no authentication UI.
@_cdecl("bitsov_client_key_delete")
public func bitsov_client_key_delete(_ path: UnsafePointer<CChar>?) -> Int32 {
    guard let path = path else { return errSecParam }
    return autoreleasepool {
        do { return ClientKeychain().remove(try clientAccount(path)) }
        catch { return errSecParam }
    }
}

// Called at iOS setup before any descriptor or pairing state can be written.
@_cdecl("bitsov_exclude_app_backup")
public func bitsov_exclude_app_backup(_ path: UnsafePointer<CChar>?) -> Int32 {
    guard let path = path else { return errSecParam }
    return autoreleasepool {
        do {
            var directory = URL(fileURLWithPath: String(cString: path), isDirectory: true)
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            var values = URLResourceValues()
            values.isExcludedFromBackup = true
            try directory.setResourceValues(values)
            return errSecSuccess
        } catch { return errSecParam }
    }
}
