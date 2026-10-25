// Device-local secrets require owner presence. Legacy reads are migration only.
import Foundation
import Security
import LocalAuthentication
import CryptoKit

// An application identifier grants a private Keychain group. Inspect the
// running task, rather than trusting an Info.plist or probing a protected item.
func clientHasDataProtectionEntitlement(_ read: (String) -> Any?) -> Bool {
    guard let identity = read("com.apple.application-identifier") as? String else { return false }
    return !identity.isEmpty && identity.contains(".") && !identity.contains("*")
}

@_cdecl("bitsov_client_data_protection_available")
public func bitsov_client_data_protection_available() -> Int32 {
    #if os(macOS)
    var code: SecCode?
    var staticCode: SecStaticCode?
    var information: CFDictionary?
    guard SecCodeCopySelf(SecCSFlags(rawValue: 0), &code) == errSecSuccess, let code = code,
        SecCodeCopyStaticCode(code, SecCSFlags(rawValue: 0), &staticCode) == errSecSuccess, let staticCode = staticCode,
        SecCodeCopySigningInformation(staticCode, SecCSFlags(rawValue: kSecCSSigningInformation), &information) == errSecSuccess,
        let info = information as? [CFString: Any], let flags = info[kSecCodeInfoFlags] as? UInt32,
        flags & 0x2 == 0 /* kSecCodeSignatureAdhoc */, let task = SecTaskCreateFromSelf(nil) else { return 0 }
    return clientHasDataProtectionEntitlement { name in
        SecTaskCopyValueForEntitlement(task, name as CFString, nil)
    } ? 1 : 0
    #else
    return 1
    #endif
}

@_cdecl("bitsov_auth_context_create")
public func bitsov_auth_context_create(_ reason: UnsafePointer<CChar>?, _ setupFinish: Int32) -> UnsafeMutableRawPointer? {
    guard let reason = reason, let text = String(validatingUTF8: reason), !text.isEmpty else { return nil }
    let context = setupFinish == 1 ? setupReadContext() : LAContext()
    context.localizedReason = text
    return Unmanaged.passRetained(context).toOpaque()
}

@_cdecl("bitsov_auth_context_release")
public func bitsov_auth_context_release(_ handle: UnsafeMutableRawPointer?) {
    guard let handle = handle else { return }
    let context = Unmanaged<LAContext>.fromOpaque(handle).takeRetainedValue()
    invalidateUnlessSetupContext(context)
}

func clientAccessControlFlags() -> SecAccessControlCreateFlags { [.userPresence] }

func makeClientAccessControl(_ error: UnsafeMutablePointer<Unmanaged<CFError>?>) -> SecAccessControl? {
    SecAccessControlCreateWithFlags(nil, kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
        clientAccessControlFlags(), error)
}

private let clientKeychainLock = NSLock()

struct ClientKeychain {
    var copy: (CFDictionary, UnsafeMutablePointer<CFTypeRef?>?) -> OSStatus = SecItemCopyMatching
    var add: (CFDictionary, UnsafeMutablePointer<CFTypeRef?>?) -> OSStatus = SecItemAdd
    var delete: (CFDictionary) -> OSStatus = SecItemDelete
    var service = "tech.mindlink.bitsov.client-ed25519.v2"
    var legacyService: String? = "tech.mindlink.bitsov.client-ed25519.v1"
    var size = 32...32
    var publicMetadata: Data? = nil

    func query(_ account: String, service: String? = nil) -> [CFString: Any] {
        [kSecClass: kSecClassGenericPassword,
         kSecAttrService: service ?? self.service,
         kSecAttrAccount: account,
         kSecAttrSynchronizable: false,
         kSecUseDataProtectionKeychain: true]
    }

    private func removeItem(_ account: String, service: String) -> OSStatus {
        var attributes = query(account, service: service)
        let context = LAContext()
        context.interactionNotAllowed = true
        attributes[kSecUseAuthenticationUI] = kSecUseAuthenticationUIFail
        defer { context.invalidate() }
        attributes[kSecUseAuthenticationContext] = context
        let status = delete(attributes as CFDictionary)
        return status == errSecItemNotFound ? errSecSuccess : status
    }

    func remove(_ account: String) -> OSStatus {
        clientKeychainLock.lock()
        defer { clientKeychainLock.unlock() }
        let status = removeItem(account, service: service)
        guard status == errSecSuccess else { return status }
        return legacyService.map { removeItem(account, service: $0) } ?? errSecSuccess
    }

    private func readItem(_ account: String, service: String, context: LAContext) -> (OSStatus, Data?) {
        var attributes = query(account, service: service)
        attributes[kSecReturnData] = true
        attributes[kSecMatchLimit] = kSecMatchLimitOne
        attributes[kSecUseAuthenticationContext] = context
        var result: CFTypeRef?
        let status = copy(attributes as CFDictionary, &result)
        guard status == errSecSuccess else { return (status, nil) }
        guard var data = result as? Data else { return (errSecDecode, nil) }
        guard size.contains(data.count) else {
            data.resetBytes(in: 0..<data.count)
            return (errSecDecode, nil)
        }
        return (errSecSuccess, data)
    }

    func readData(_ account: String, context supplied: LAContext? = nil) -> (OSStatus, Data?) {
        let context = supplied ?? LAContext()
        if supplied == nil { context.localizedReason = "Access your BitSov device identity" }
        defer { if supplied == nil { context.invalidate() } }
        clientKeychainLock.lock()
        defer { clientKeychainLock.unlock() }
        let (status, saved) = readItem(account, service: service, context: context)
        if status == errSecSuccess {
            // Also finishes cleanup after a crash between publication and deletion.
            if let legacy = legacyService {
                let (oldStatus, old) = readItem(account, service: legacy, context: context)
                if oldStatus == errSecSuccess {
                    guard old == saved else { return (errSecDecode, nil) }
                    let cleanup = removeItem(account, service: legacy)
                    guard cleanup == errSecSuccess else { return (cleanup, nil) }
                } else if oldStatus != errSecItemNotFound { return (oldStatus, nil) }
            }
            return (status, saved)
        }
        // Cancellation, denial, lock, and missing entitlement are authoritative.
        guard status == errSecItemNotFound, let legacy = legacyService else { return (status, nil) }
        let (oldStatus, old) = readItem(account, service: legacy, context: context)
        guard oldStatus == errSecSuccess, var data = old else { return (oldStatus, nil) }
        defer { data.resetBytes(in: 0..<data.count) }
        let stored = insertData(account, data)
        guard stored == errSecSuccess else { return (migrationError(stored), nil) }
        let (verifiedStatus, verified) = readItem(account, service: service, context: context)
        guard verifiedStatus == errSecSuccess else { return (migrationError(verifiedStatus), nil) }
        guard verified == data else { return (errSecDecode, nil) }
        let cleanup = removeItem(account, service: legacy)
        guard cleanup == errSecSuccess else { return (cleanup, nil) }
        return (errSecSuccess, verified)
    }

    private func migrationError(_ status: OSStatus) -> OSStatus {
        // A disappearing destination must not look like a fresh installation.
        status == errSecItemNotFound ? errSecInternalComponent : status
    }

    func read(_ account: String, _ output: UnsafeMutablePointer<UInt8>) -> OSStatus {
        let (status, result) = readData(account)
        guard status == errSecSuccess, var data = result else { return status }
        defer { data.resetBytes(in: 0..<data.count) }
        guard data.count == 32 else { return errSecDecode }
        data.copyBytes(to: output, count: 32)
        return errSecSuccess
    }

    func insertData(_ account: String, _ data: Data) -> OSStatus {
        guard size.contains(data.count) else { return errSecParam }
        var error: Unmanaged<CFError>?
        guard let access = makeClientAccessControl(&error) else {
            error?.release()
            return errSecAuthFailed
        }
        var attributes = query(account)
        // Accessibility is embedded in SecAccessControl; specifying both is invalid.
        attributes[kSecAttrAccessControl] = access
        attributes[kSecValueData] = data
        if let metadata = publicMetadata { attributes[kSecAttrGeneric] = metadata }
        return add(attributes as CFDictionary, nil)
    }

    func metadata(_ account: String) -> (OSStatus, Data?) {
        var attributes = query(account)
        attributes[kSecReturnAttributes] = true
        attributes[kSecUseAuthenticationUI] = kSecUseAuthenticationUIFail
        attributes[kSecMatchLimit] = kSecMatchLimitOne
        let context = LAContext()
        context.interactionNotAllowed = true
        defer { context.invalidate() }
        attributes[kSecUseAuthenticationContext] = context
        var result: CFTypeRef?
        let status = copy(attributes as CFDictionary, &result)
        guard status == errSecSuccess else { return (status, nil) }
        guard let values = result as? [CFString: Any] else { return (errSecDecode, nil) }
        guard let publicKey = values[kSecAttrGeneric] as? Data else { return (errSecSuccess, nil) }
        guard publicKey.count == 65, publicKey.first == 4 else { return (errSecDecode, nil) }
        return (errSecSuccess, publicKey)
    }

    func insert(_ account: String, _ seed: UnsafePointer<UInt8>) -> OSStatus {
        var data = Data(bytes: seed, count: 32)
        defer { data.resetBytes(in: 0..<data.count) }
        return insertData(account, data)
    }
}

// Container UUIDs may change after an app update. Scope by the path relative to
// Application Support, including the app/profile identifier, never that UUID.
func clientAccount(_ path: UnsafePointer<CChar>) throws -> String {
    let root = try FileManager.default.url(for: .applicationSupportDirectory,
        in: .userDomainMask, appropriateFor: nil, create: false).standardizedFileURL
    let directory = URL(fileURLWithPath: String(cString: path), isDirectory: true).standardizedFileURL
    let prefix = root.path + "/"
    guard directory.path.hasPrefix(prefix), directory.lastPathComponent == "app-client" else {
        throw NSError(domain: NSOSStatusErrorDomain, code: Int(errSecParam))
    }
    // Covers wrapped device blobs, pairing records and remote descriptors. These
    // are device-specific and must not be restored onto a different phone.
    #if os(iOS)
    var appDirectory = directory.deletingLastPathComponent()
    var values = URLResourceValues()
    values.isExcludedFromBackup = true
    try appDirectory.setResourceValues(values)
    #endif
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
        do { return removeClientProfile(try clientAccount(path)) }
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

#if os(iOS)
import UIKit

// Setup runs on the main thread. Initial activation is not a return from the
// background, but a background launch must retry on its first foreground.
@_cdecl("bitsov_app_is_backgrounded")
public func bitsov_app_is_backgrounded() -> Int32 {
    guard Thread.isMainThread else { return 0 }
    return UIApplication.shared.applicationState == .background ? 1 : 0
}
#endif

func deviceBlobStore() -> ClientKeychain {
    ClientKeychain(service: "tech.mindlink.bitsov.device-key.v1", legacyService: nil, size: 1...4096)
}

@_cdecl("bitsov_device_blob_read")
public func bitsov_device_blob_read(_ path: UnsafePointer<CChar>?, _ output: UnsafeMutablePointer<UInt8>?,
    _ capacity: Int, _ length: UnsafeMutablePointer<Int>?, _ handle: UnsafeMutableRawPointer?) -> Int32 {
    guard let path = path, let output = output, let length = length, let handle = handle, capacity >= 0 else { return errSecParam }
    length.pointee = 0
    return autoreleasepool {
        do {
            let (status, result) = deviceBlobStore().readData(try clientAccount(path),
                context: Unmanaged<LAContext>.fromOpaque(handle).takeUnretainedValue())
            guard status == errSecSuccess, var data = result else { return status }
            defer { data.resetBytes(in: 0..<data.count) }
            guard data.count <= capacity else { return errSecBufferTooSmall }
            data.copyBytes(to: output, count: data.count)
            length.pointee = data.count
            return errSecSuccess
        } catch { return errSecParam }
    }
}

@_cdecl("bitsov_device_blob_add")
public func bitsov_device_blob_add(_ path: UnsafePointer<CChar>?, _ bytes: UnsafePointer<UInt8>?, _ count: Int) -> Int32 {
    guard let path = path, let bytes = bytes, (1...4096).contains(count) else { return errSecParam }
    return autoreleasepool {
        var data = Data(bytes: bytes, count: count)
        defer { data.resetBytes(in: 0..<data.count) }
        do {
            var store = deviceBlobStore()
            var publicKey = [UInt8](repeating: 0, count: 65)
            let status = bitsov_dk_public(bytes, count, &publicKey)
            guard status == 0 else { return errSecDecode }
            store.publicMetadata = Data(publicKey)
            return store.insertData(try clientAccount(path), data)
        }
        catch { return errSecParam }
    }
}

@_cdecl("bitsov_device_blob_delete")
public func bitsov_device_blob_delete(_ path: UnsafePointer<CChar>?) -> Int32 {
    guard let path = path else { return errSecParam }
    return autoreleasepool {
        do { return deviceBlobStore().remove(try clientAccount(path)) }
        catch { return errSecParam }
    }
}

func removeClientProfile(_ account: String, seed: ClientKeychain = ClientKeychain(),
    blob: ClientKeychain = deviceBlobStore()) -> OSStatus {
    let status = blob.remove(account)
    guard status == errSecSuccess else { return status }
    return seed.remove(account)
}

// The context is owned by the blocking Rust signing operation. It is the same
// context used for all protected reads (including migration readback).
@_cdecl("bitsov_device_blob_sign")
public func bitsov_device_blob_sign(_ blob: UnsafePointer<UInt8>?, _ count: Int,
    _ expected: UnsafePointer<UInt8>?, _ msg: UnsafePointer<UInt8>?, _ msgLen: Int,
    _ reason: UnsafePointer<CChar>?, _ outSig: UnsafeMutablePointer<UInt8>?,
    _ sigCap: Int, _ outSigLen: UnsafeMutablePointer<Int>?, _ handle: UnsafeMutableRawPointer?, _ setup: Int32) -> Int32 {
    guard let blob = blob, let expected = expected, let handle = handle, (1...4096).contains(count) else { return -5 }
    let context = Unmanaged<LAContext>.fromOpaque(handle).takeUnretainedValue()
    return autoreleasepool {
        guard let key = try? SecureEnclave.P256.Signing.PrivateKey(
            dataRepresentation: Data(bytes: blob, count: count), authenticationContext: context),
            key.publicKey.x963Representation == Data(bytes: expected, count: 65) else { return -3 }
        if setup == 0 || setup == 1 {
            return bitsov_dk_sign_setup(blob, count, msg, msgLen, reason, setup, outSig, sigCap, outSigLen, handle)
        }
        guard setup == -1 else { return -5 }
        return signMessage(blob, count, msg, msgLen, reason, outSig, sigCap, outSigLen, context)
    }
}

// Non-secret attributes only. A status poll must never request kSecReturnData.
@_cdecl("bitsov_device_blob_metadata")
public func bitsov_device_blob_metadata(_ path: UnsafePointer<CChar>?, _ output: UnsafeMutablePointer<UInt8>?,
    _ length: UnsafeMutablePointer<Int>?) -> Int32 {
    guard let path = path, let output = output, let length = length else { return errSecParam }
    length.pointee = 0
    return autoreleasepool {
        do {
            let (status, publicKey) = deviceBlobStore().metadata(try clientAccount(path))
            guard status == errSecSuccess else { return status }
            if let publicKey = publicKey {
                publicKey.copyBytes(to: output, count: 65)
                length.pointee = 65
            }
            return errSecSuccess
        } catch { return errSecParam }
    }
}
