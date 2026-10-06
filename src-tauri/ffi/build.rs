fn main() {
    let target_os = std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    let mobile_feature = std::env::var_os("CARGO_FEATURE_MOBILE").is_some();
    if target_os == "macos" && !mobile_feature {
        build_device_key_swift();
    }
}

/// Compile the Swift bridges into a static library and link their frameworks
/// and runtime into consumers of this crate.
fn build_device_key_swift() {
    use std::path::PathBuf;
    use std::process::Command;

    const SOURCE: &str = "../native/device_key.swift";
    println!("cargo:rerun-if-changed={SOURCE}");
    println!("cargo:rerun-if-env-changed=MACOSX_DEPLOYMENT_TARGET");
    println!("cargo:rerun-if-env-changed=DEVELOPER_DIR");
    println!("cargo:rerun-if-env-changed=SDKROOT");

    let out_dir = PathBuf::from(std::env::var("OUT_DIR").expect("OUT_DIR"));
    let arch = match std::env::var("CARGO_CFG_TARGET_ARCH").as_deref() {
        Ok("aarch64") => "arm64",
        Ok("x86_64") => "x86_64",
        other => panic!("device key bridge: unsupported macOS arch {other:?}"),
    };
    // Matches the parent app's tauri.conf.json `bundle.macOS.minimumSystemVersion`.
    let min_os = std::env::var("MACOSX_DEPLOYMENT_TARGET").unwrap_or_else(|_| "11.0".into());
    let target = format!("{arch}-apple-macosx{min_os}");

    let xcrun = |args: &[&str]| -> String {
        let out = Command::new("xcrun")
            .args(args)
            .output()
            .unwrap_or_else(|e| panic!("device key bridge: xcrun {args:?}: {e}"));
        assert!(
            out.status.success(),
            "device key bridge: xcrun {args:?} failed: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        String::from_utf8(out.stdout)
            .expect("xcrun output is UTF-8")
            .trim()
            .to_string()
    };
    let sdk = xcrun(&["--sdk", "macosx", "--show-sdk-path"]);
    let swiftc = PathBuf::from(xcrun(&["--sdk", "macosx", "-f", "swiftc"]));
    let toolchain_lib = swiftc
        .parent()
        .and_then(|bin| bin.parent())
        .expect("swiftc path has a toolchain root")
        .join("lib/swift/macosx");

    let lib = out_dir.join("libbitsov_device_key.a");
    let status = Command::new(&swiftc)
        .args([
            "-emit-library",
            "-static",
            "-parse-as-library",
            "-module-name",
            "BitsovDeviceKey",
            "-O",
            "-swift-version",
            "5",
            "-target",
            &target,
            "-sdk",
            &sdk,
            "-module-cache-path",
        ])
        .arg(out_dir.join("swift-module-cache"))
        .arg(SOURCE)
        .arg("-o")
        .arg(&lib)
        .status()
        .unwrap_or_else(|e| panic!("device key bridge: running swiftc: {e}"));
    assert!(
        status.success(),
        "device key bridge: swiftc failed on {SOURCE}"
    );

    println!("cargo:rustc-link-search=native={}", out_dir.display());
    println!("cargo:rustc-link-lib=static=bitsov_device_key");
    for framework in ["CryptoKit", "LocalAuthentication", "Security", "Foundation"] {
        println!("cargo:rustc-link-lib=framework={framework}");
    }
    println!("cargo:rustc-link-search=native={sdk}/usr/lib/swift");
    println!("cargo:rustc-link-search=native={}", toolchain_lib.display());
    println!("cargo:rustc-link-arg=-Wl,-rpath,/usr/lib/swift");
}
