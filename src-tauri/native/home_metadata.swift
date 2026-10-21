// iOS public node trust metadata. No passwords, prompts, synchronization,
// access-group sharing, or fallback out of the Data Protection Keychain.
import Foundation
import Security
import LocalAuthentication

struct HomeMetadata {
    var copy: (CFDictionary, UnsafeMutablePointer<CFTypeRef?>?) -> OSStatus = SecItemCopyMatching
    var add: (CFDictionary, UnsafeMutablePointer<CFTypeRef?>?) -> OSStatus = SecItemAdd
    var update: (CFDictionary, CFDictionary) -> OSStatus = SecItemUpdate

    static func valid(_ service: String) -> Bool {
        let profile = "tech.mindlink.bitsov.remotetest."
        let name = service.hasPrefix(profile) ? String(service.dropFirst(profile.count)) : service
        let fields = name.split(separator: ".", omittingEmptySubsequences: false)
        return fields.count == 4 && fields[0] == "bitsov" && fields[1] == "node"
            && fields[2].utf8.count == 64
            && fields[2].utf8.allSatisfy { (48...57).contains($0) || (97...102).contains($0) }
            && ["box-transport", "unlock-binding"].contains(String(fields[3]))
    }

    private func query(_ service: String, _ context: LAContext) -> [CFString: Any] {
        [kSecClass: kSecClassGenericPassword, kSecAttrService: service,
         kSecAttrAccount: "BitSov", kSecAttrSynchronizable: false,
         kSecUseDataProtectionKeychain: true, kSecUseAuthenticationContext: context]
    }

    func store(_ service: String, _ data: Data) -> OSStatus {
        guard Self.valid(service), (1...16384).contains(data.count) else { return errSecParam }
        let context = LAContext()
        context.interactionNotAllowed = true
        defer { context.invalidate() }
        let base = query(service, context)
        var attributes = base
        attributes[kSecAttrAccessible] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        attributes[kSecValueData] = data
        let status = add(attributes as CFDictionary, nil)
        guard status == errSecDuplicateItem else { return status }
        return update(base as CFDictionary,
            [kSecValueData: data, kSecAttrAccessible: kSecAttrAccessibleWhenUnlockedThisDeviceOnly] as CFDictionary)
    }

    func read(_ service: String, _ data: inout Data) -> OSStatus {
        guard Self.valid(service) else { return errSecParam }
        let context = LAContext()
        context.interactionNotAllowed = true
        defer { context.invalidate() }
        var attributes = query(service, context)
        attributes[kSecReturnData] = true
        attributes[kSecMatchLimit] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = copy(attributes as CFDictionary, &result)
        guard status == errSecSuccess else { return status }
        guard let bytes = result as? Data, (1...16384).contains(bytes.count) else { return errSecDecode }
        data = bytes
        return errSecSuccess
    }
}

@_cdecl("bitsov_home_store")
public func bitsov_home_store(_ service: UnsafePointer<CChar>?, _ bytes: UnsafePointer<UInt8>?,
                              _ count: Int, _ secret: Int32) -> Int32 {
    guard let service = service, let bytes = bytes, secret == 0,
          (1...16384).contains(count) else { return errSecParam }
    return autoreleasepool {
        HomeMetadata().store(String(cString: service), Data(bytes: bytes, count: count))
    }
}

@_cdecl("bitsov_home_read")
public func bitsov_home_read(_ service: UnsafePointer<CChar>?, _ output: UnsafeMutablePointer<UInt8>?,
                             _ capacity: Int, _ length: UnsafeMutablePointer<Int>?) -> Int32 {
    guard let service = service, let output = output, let length = length,
          (1...16384).contains(capacity) else { return errSecParam }
    length.pointee = 0
    return autoreleasepool {
        var data = Data()
        let status = HomeMetadata().read(String(cString: service), &data)
        guard status == errSecSuccess else { return status }
        guard data.count <= capacity else { return errSecBufferTooSmall }
        data.copyBytes(to: output, count: data.count)
        length.pointee = data.count
        return errSecSuccess
    }
}
