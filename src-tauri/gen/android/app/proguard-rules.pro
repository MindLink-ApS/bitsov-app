# Rust loads plugins by class name; Tauri discovers commands/callbacks and
# Jackson decodes @InvokeArg fields by reflection. Keep names, constructors,
# annotations and members, including permission/activity callbacks and future
# annotated plugins. Covers DeviceKeyPlugin (Keystore), PhoneRecoveryPlugin,
# LocalNetworkPlugin, PairingLinkPlugin and app.tauri.barcodescanner's plugin
# and ScanOptions. Do not relax these to keepnames/allowshrinking.
-keepattributes *Annotation*,Signature,InnerClasses,EnclosingMethod
-keep @app.tauri.annotation.TauriPlugin class * { *; }
-keep @app.tauri.annotation.InvokeArg class * { *; }
-keepclasseswithmembers,includedescriptorclasses class * {
    @app.tauri.annotation.Command <methods>;
}

# Tauri's JNI/JSON bridge (PluginManager, Invoke, JSObject, JSArray, Channel,
# built-in AppPlugin/PathPlugin and annotations). Retain members called from
# Rust even when Java/Kotlin has no visible caller. The generated
# proguard-tauri.pro and dependency consumer rules are also loaded by Gradle.
-keep class app.tauri.** { *; }

# Wry/Tauri generated app-package classes are constructed and called by JNI.
# Native methods alone are insufficient: Rust also calls Java methods such as
# getPluginManager, getId, loadUrlMainThread and evalScript by name.
-keep class tech.mindlink.bitsov.TauriActivity { *; }
-keep class tech.mindlink.bitsov.WryActivity { *; }
-keep class tech.mindlink.bitsov.Rust { *; }
-keep class tech.mindlink.bitsov.RustWebView { *; }
-keep class tech.mindlink.bitsov.RustWebViewClient { *; }
-keep class tech.mindlink.bitsov.RustWebChromeClient { *; }
-keep class tech.mindlink.bitsov.Ipc { *; }
-keepclasseswithmembers,includedescriptorclasses class * {
    native <methods>;
}
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}
