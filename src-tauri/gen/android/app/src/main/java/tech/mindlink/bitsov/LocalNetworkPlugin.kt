package tech.mindlink.bitsov

import android.app.Activity
import android.os.Build
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleOwner
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.Permission
import app.tauri.annotation.PermissionCallback
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.PermissionState
import app.tauri.plugin.Plugin
import java.net.InetAddress
import java.net.NetworkInterface
import org.json.JSONArray

@InvokeArg
class LanRequest {
    var addresses: Array<String> = emptyArray()
    var mdns: Boolean = false
}

internal fun sameSubnet(address: ByteArray, local: ByteArray, prefix: Int): Boolean {
    if (address.size != local.size || prefix <= 0 || prefix > address.size * 8) return false
    return address.indices.all { index ->
        val bits = (prefix - index * 8).coerceIn(0, 8)
        val mask = (0xff shl (8 - bits)) and 0xff
        (address[index].toInt() and mask) == (local[index].toInt() and mask)
    }
}

internal fun requiresLanPermission(address: InetAddress, subnets: List<Pair<ByteArray, Int>>): Boolean {
    if (address.isLoopbackAddress) return false
    val bytes = address.address
    return address.isSiteLocalAddress || address.isLinkLocalAddress || address.isMulticastAddress ||
        (bytes.size == 16 && (bytes[0].toInt() and 0xfe) == 0xfc) ||
        subnets.any { (local, prefix) -> sameSubnet(bytes, local, prefix) }
}

/** Only Rust's LAN dial path calls this. Never prompt from intent delivery. */
@TauriPlugin(permissions = [Permission(strings = ["android.permission.ACCESS_LOCAL_NETWORK"], alias = "lan")])
class LocalNetworkPlugin(private val activity: Activity) : Plugin(activity) {
    private var requested = false
    private data class Pending(val invoke: Invoke, val local: List<Boolean>)
    private val pending = mutableListOf<Pending>()

    private fun granted() = Build.VERSION.SDK_INT < 37 || getPermissionState("lan") == PermissionState.GRANTED

    private fun reply(request: Pending) {
        val grant = granted()
        request.invoke.resolve(JSObject().put("granted", grant)
            .put("allowed", JSONArray(request.local.map { grant || !it })))
    }

    @Command
    fun ensurePermission(invoke: Invoke) {
        activity.runOnUiThread {
            val args = invoke.parseArgs(LanRequest::class.java)
            if (granted()) {
                reply(Pending(invoke, args.addresses.map { false }))
                return@runOnUiThread
            }
            // Include directly connected global IPv6 subnets, not just RFC1918
            // and ULA. Public/VPN alternatives remain usable after LAN denial.
            val subnets = try { NetworkInterface.getNetworkInterfaces()?.toList().orEmpty()
                .filter { it.isUp && !it.isLoopback }
                .flatMap { it.interfaceAddresses }
                .map { it.address.address to it.networkPrefixLength.toInt() }
            } catch (_: Exception) {
                invoke.reject("Cannot check local network access")
                return@runOnUiThread
            }
            val request = Pending(invoke, args.addresses.map { requiresLanPermission(InetAddress.getByName(it), subnets) })
            if (granted() || (!args.mdns && request.local.none { it })) {
                reply(request)
            } else if (pending.isNotEmpty()) {
                pending.add(request)
            } else if (requested || (activity as? LifecycleOwner)?.lifecycle?.currentState?.isAtLeast(Lifecycle.State.RESUMED) != true) {
                // No repeated prompts from retries or background launches.
                // Foreground/Settings recovery rechecks the actual OS grant.
                reply(request)
            } else {
                requested = true
                pending.add(request)
                requestPermissionForAlias("lan", invoke, "permissionResult")
            }
        }
    }

    @PermissionCallback
    fun permissionResult(invoke: Invoke) {
        val waiting = pending.toList()
        pending.clear()
        waiting.forEach { reply(it) }
    }
}
