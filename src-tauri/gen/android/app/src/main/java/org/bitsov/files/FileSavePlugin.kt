package org.bitsov.files

import android.app.Activity
import android.content.ContentValues
import android.os.Build
import android.provider.MediaStore
import android.util.Base64
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin

@InvokeArg
class SaveArgs {
    var name: String = ""
    var mime: String = ""
    var data: String = ""
}

/**
 * Saves one received file into the shared Downloads collection (MediaStore,
 * Android 10+). The new entry is pending until its bytes are written; a name
 * that is taken gets a new one from the system, so nothing is replaced. No
 * storage permission is requested. The Rust side has already checked the
 * size, decoded the data and cleaned the name and type.
 */
@TauriPlugin
class FileSavePlugin(private val activity: Activity) : Plugin(activity) {
    @Command
    fun saveToDownloads(invoke: Invoke) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
            invoke.reject("unsupported")
            return
        }
        val args = invoke.parseArgs(SaveArgs::class.java)
        val bytes = try {
            Base64.decode(args.data, Base64.NO_WRAP)
        } catch (_: IllegalArgumentException) {
            invoke.reject("corrupt")
            return
        }
        val resolver = activity.contentResolver
        val values = ContentValues().apply {
            put(MediaStore.Downloads.DISPLAY_NAME, args.name)
            put(MediaStore.Downloads.MIME_TYPE, args.mime)
            put(MediaStore.Downloads.IS_PENDING, 1)
        }
        val uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
        if (uri == null) {
            invoke.reject("failed")
            return
        }
        try {
            val out = resolver.openOutputStream(uri, "w") ?: throw IllegalStateException("no stream")
            out.use { it.write(bytes) }
            resolver.update(uri, ContentValues().apply { put(MediaStore.Downloads.IS_PENDING, 0) }, null, null)
        } catch (_: Exception) {
            // Never leave a half-written entry behind.
            resolver.delete(uri, null, null)
            invoke.reject("failed")
            return
        }
        // The name the system actually used (it may differ when the name was taken).
        var saved = args.name
        resolver.query(uri, arrayOf(MediaStore.Downloads.DISPLAY_NAME), null, null, null)?.use { cursor ->
            if (cursor.moveToFirst()) saved = cursor.getString(0) ?: saved
        }
        val ret = JSObject()
        ret.put("name", saved)
        invoke.resolve(ret)
    }
}
