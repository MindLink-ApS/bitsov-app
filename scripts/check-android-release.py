#!/usr/bin/env python3
"""Cheap release-config guard, not an R8 interpreter or APK runtime test.

CI passes --generated after its Android cargo check. No SDK, Gradle or keys
are needed to inspect the rules emitted by the locked Tauri dependency.
"""
import argparse
from pathlib import Path
import re
import sys
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[1]
APP = ROOT / "src-tauri/gen/android/app"


def compact(text):
    return re.sub(r"\s+", "", re.sub(r"#.*", "", text))


def check(generated):
    rules = compact((APP / "proguard-rules.pro").read_text())
    required = [
        "-keepattributes *Annotation*,Signature,InnerClasses,EnclosingMethod",
        "-keep @app.tauri.annotation.TauriPlugin class * { *; }",
        "-keep @app.tauri.annotation.InvokeArg class * { *; }",
        "-keepclasseswithmembers,includedescriptorclasses class * { @app.tauri.annotation.Command <methods>; }",
        "-keepclasseswithmembers,includedescriptorclasses class * { native <methods>; }",
        "-keepclassmembers class * { @android.webkit.JavascriptInterface <methods>; }",
        "-keep class app.tauri.** { *; }",
    ]
    # Wry constructs/calls these by JNI class and method name. Native-method
    # rules alone do not protect Java methods called FROM Rust.
    for name in ["TauriActivity", "WryActivity", "Rust", "RustWebView",
                 "RustWebViewClient", "RustWebChromeClient", "Ipc"]:
        required.append(f"-keep class tech.mindlink.bitsov.{name} {{ *; }}")
    for rule in required:
        if compact(rule) not in rules:
            raise ValueError(f"missing app rule: {rule}")

    gradle = re.sub(r"//[^\n]*", "", (APP / "build.gradle.kts").read_text())
    bundled = 'implementation("com.google.mlkit:barcode-scanning:17.3.0")'
    if compact(bundled) not in compact(gradle):
        raise ValueError("review bundled barcode model dependency")
    excluded_api = 'exclude(group = "com.google.android.gms", module = "play-services-mlkit-barcode-scanning")'
    if compact(excluded_api) in compact(gradle):
        raise ValueError("bundled ML Kit also needs the play-services barcode API classes")
    release = gradle.split('getByName("release") {', 1)[1].split("\n    }", 1)[0]
    for setting in ["isMinifyEnabled = true", "isShrinkResources = true",
                    "isDebuggable = false", "isJniDebuggable = false",
                    'getDefaultProguardFile("proguard-android-optimize.txt")',
                    '"proguard-rules.pro"', '"proguard-tauri.pro"']:
        if compact(setting) not in compact(release):
            raise ValueError(f"missing release setting: {setting}")
    if "signingConfig" in release:
        raise ValueError("review release signing before adding credentials/configuration")

    android = "{http://schemas.android.com/apk/res/android}"
    main = APP / "src/main"
    app = ET.parse(main / "AndroidManifest.xml").getroot().find("application")
    if app.get(android + "usesCleartextTraffic") != "false":
        raise ValueError("release manifest must deny cleartext")
    config = app.get(android + "networkSecurityConfig")
    if config != "@xml/network_security_config":
        raise ValueError("review changed network security resource")
    network = ET.parse(main / "res/xml/network_security_config.xml").getroot()
    if network.find("base-config").get("cleartextTrafficPermitted") != "false":
        raise ValueError("release base-config must deny cleartext")
    if any(node.get("cleartextTrafficPermitted") == "true" for node in network.iter()):
        raise ValueError("release cleartext exceptions require a documented review")

    if generated:
        emitted = compact((APP / "proguard-tauri.pro").read_text())
        activity = "-keep class tech.mindlink.bitsov.TauriActivity { public app.tauri.plugin.PluginManager getPluginManager(); }"
        if compact(activity) not in emitted:
            raise ValueError(f"missing generated rule: {activity}")
        # Since Tauri 2.12, plugin rules are consumer rules, not in the app's
        # generated .pro. Read the dependency selected by generated Gradle
        # settings, without executing Gradle or assuming a Cargo cache path.
        settings = (APP.parent / "tauri.settings.gradle").read_text()
        library = re.search(r'''project\(':tauri-android'\)\.projectDir = new File\("([^"]+)"\)''', settings)
        if library is None:
            raise ValueError("missing generated Tauri Android dependency")
        consumer = compact((Path(library[1]) / "consumer-rules.pro").read_text())
        arg = "-keep @app.tauri.annotation.InvokeArg public class * { *; }"
        if compact(arg) not in consumer:
            raise ValueError(f"missing Tauri consumer rule: {arg}")
        plugin = re.search(r"-keep@app\.tauri\.annotation\.TauriPluginpublicclass\*\{([^}]+)\}", consumer)
        for member in ["public <init>(...);", "@app.tauri.annotation.Command public <methods>;",
                       "@app.tauri.annotation.PermissionCallback <methods>;",
                       "@app.tauri.annotation.ActivityCallback <methods>;"]:
            if plugin is None or compact(member) not in plugin[1]:
                raise ValueError(f"missing generated plugin member rule: {member}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--generated", action="store_true", help="also require cargo-generated Tauri rules")
    args = parser.parse_args()
    try:
        check(args.generated)
    except (ValueError, OSError, IndexError, AttributeError) as error:
        sys.exit(f"Android release guard FAILED: {error}")
    print("Android release guard passed" + (" (including generated Tauri rules)" if args.generated else ""))
