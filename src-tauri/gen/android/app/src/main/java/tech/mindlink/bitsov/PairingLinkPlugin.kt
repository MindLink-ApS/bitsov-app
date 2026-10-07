package tech.mindlink.bitsov

import android.app.Activity
import android.content.Intent
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
    private var pendingLink: String? = null

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
        // Preserve the exact URI, without URL decoding or accepting new formats.
        // An oversized intent still opens the screen with a validation error.
        pendingLink = if (link.length <= 16397) link else ""
    }

    @Command
    fun takePendingLink(invoke: Invoke) {
        activity.runOnUiThread {
            val response = JSObject()
            response.put("link", pendingLink)
            pendingLink = null
            invoke.resolve(response)
        }
    }
}
