import UIKit

// Fixed destinations only; open's completion avoids canOpenURL/query permissions.
@_cdecl("bitsov_phone_recovery_open")
func bitsovPhoneRecoveryOpen(_ tailscale: Bool, _ context: UInt,
    _ complete: @escaping @convention(c) (UInt, Bool) -> Void) {
    DispatchQueue.main.async {
        let url = tailscale ? URL(string: "tailscale://")! : URL(string: UIApplication.openSettingsURLString)!
        UIApplication.shared.open(url, options: [:]) { opened in
            if tailscale && !opened {
                UIApplication.shared.open(URL(string: "https://apps.apple.com/app/id1470499037")!, options: [:]) {
                    complete(context, $0)
                }
            } else { complete(context, opened) }
        }
    }
}
