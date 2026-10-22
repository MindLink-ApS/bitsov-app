package tech.mindlink.bitsov

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.provider.Settings
import app.tauri.annotation.Command
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.Plugin

/** No URL, package or intent arguments can come from the webview. */
@TauriPlugin
class PhoneRecoveryPlugin(private val activity: Activity) : Plugin(activity) {
    private fun launch(intent: Intent): Boolean = try {
        activity.startActivity(intent)
        true
    } catch (_: Exception) { false }

    @Command
    fun openAppSettings(invoke: Invoke) {
        activity.runOnUiThread {
            if (launch(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                    Uri.parse("package:" + activity.packageName)))) invoke.resolve()
            else invoke.reject("Could not open Settings")
        }
    }

    @Command
    fun openTailscale(invoke: Invoke) {
        activity.runOnUiThread {
            val app = activity.packageManager.getLaunchIntentForPackage("com.tailscale.ipn")
            val opened = (app != null && launch(app)) ||
                launch(Intent(Intent.ACTION_VIEW, Uri.parse("market://details?id=com.tailscale.ipn"))) ||
                launch(Intent(Intent.ACTION_VIEW, Uri.parse("https://play.google.com/store/apps/details?id=com.tailscale.ipn")))
            if (opened) invoke.resolve() else invoke.reject("Could not open Tailscale")
        }
    }
}
