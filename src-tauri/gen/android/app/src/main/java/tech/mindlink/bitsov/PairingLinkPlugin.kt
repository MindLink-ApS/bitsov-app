package tech.mindlink.bitsov

import android.app.Activity
import android.content.Intent
import android.content.Context
import java.security.MessageDigest
import android.webkit.WebView
import app.tauri.annotation.Command
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin

/** An in-memory, take-once inbox. Import and validation belong to the existing
 * pairing command, called only after the owner confirms in the webview. */
@TauriPlugin
class PairingLinkPlugin(private val activity: Activity) : Plugin(activity) {
    companion object {
        private const val PAIRING_PREFIX = "bitsov://pair/"
        // Bounded: a hostile app firing random links can only evict old receipts.
        private const val MAX_RECEIPTS = 32
    }
    // Only digests survive process death. Never persist bearer tickets. Keep
    // earlier receipts too: Android can redeliver the original launch intent.
    private val preferences = activity.getSharedPreferences("pairing_link_inbox", Context.MODE_PRIVATE)
    private var takenHashes: List<String> =
        (preferences.getString("taken_hashes_v2", "") ?: "").split(',').filter { it.length == 64 }.takeLast(MAX_RECEIPTS)
    private var pendingLink: String? = null
    private var pendingHash: String? = null

    override fun load(webView: WebView) {
        super.load(webView)
        receive(activity.intent)
    }

    override fun onNewIntent(intent: Intent) {
        receive(intent)
    }

    private fun receive(intent: Intent) {
        if (intent.action != Intent.ACTION_VIEW) return
        val link = intent.dataString ?: return
        // Do not retain the ticket in the Activity's launch Intent.
        intent.data = null
        val hash = MessageDigest.getInstance("SHA-256")
            .digest(link.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }
        if (hash in takenHashes) return
        pendingHash = hash
        // Preserve the exact URI, without URL decoding or accepting new formats.
        // An oversized intent still opens the screen with a validation error.
        pendingLink = if (link.length <= PAIRING_PREFIX.length + 16384) link else ""
    }

    @Command
    fun takePendingLink(invoke: Invoke) {
        activity.runOnUiThread {
            // Commit before handing the link to the renderer: a redelivered VIEW
            // after process death must not become a fresh confirmation prompt.
            if (pendingHash != null) {
                val receipts = (takenHashes - pendingHash!! + pendingHash!!).takeLast(MAX_RECEIPTS)
                if (!preferences.edit().remove("taken_hashes").putString("taken_hashes_v2", receipts.joinToString(",")).commit()) {
                    invoke.reject("Cannot record pairing link receipt")
                    return@runOnUiThread
                }
                takenHashes = receipts
            }
            val response = JSObject()
            response.put("link", pendingLink)
            pendingLink = null
            pendingHash = null
            invoke.resolve(response)
        }
    }
}
