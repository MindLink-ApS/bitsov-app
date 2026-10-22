use std::{collections::BTreeSet, fs, path::PathBuf};

fn project_file(path: &str) -> String {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    fs::read_to_string(root.join(path)).unwrap_or_else(|error| panic!("{path}: {error}"))
}

const PLUGIN: &str = "gen/android/app/src/main/java/tech/mindlink/bitsov/DeviceKeyPlugin.kt";
const APPLE_HOME_KEYCHAIN_CFG: &str =
    "#[cfg(any(target_os = \"ios\", all(target_os = \"macos\", desktop, not(feature = \"mobile\"))))]";

/// The brace-balanced block after the first `{` following each `marker`.
fn blocks_after<'a>(source: &'a str, marker: &str) -> Vec<&'a str> {
    source
        .match_indices(marker)
        .map(|(start, _)| {
            let open = start
                + source[start..]
                    .find('{')
                    .unwrap_or_else(|| panic!("no block after {marker}"));
            let mut depth = 0;
            for (offset, char) in source[open..].char_indices() {
                match char {
                    '{' => depth += 1,
                    '}' => {
                        depth -= 1;
                        if depth == 0 {
                            return &source[open..=open + offset];
                        }
                    }
                    _ => {}
                }
            }
            panic!("unbalanced block after {marker}")
        })
        .collect()
}

fn block_after<'a>(source: &'a str, marker: &str) -> &'a str {
    let blocks = blocks_after(source, marker);
    assert_eq!(blocks.len(), 1, "expected exactly one {marker}");
    blocks[0]
}

fn kotlin_fn<'a>(source: &'a str, name: &str) -> &'a str {
    block_after(source, &format!("fun {name}("))
}

/// Drop formatting whitespace, keeping one space only between two word characters.
fn normalized(code: &str) -> String {
    let word = |char: char| char.is_alphanumeric() || char == '_';
    let mut out = String::new();
    let mut spaced = false;
    for char in code.chars() {
        if char.is_whitespace() {
            spaced = true;
            continue;
        }
        if spaced && out.chars().last().is_some_and(word) && word(char) {
            out.push(' ');
        }
        spaced = false;
        out.push(char);
    }
    out
}

#[test]
fn android_device_keys_are_hardware_backed_p256_and_biometric_per_signature() {
    let source =
        project_file("gen/android/app/src/main/java/tech/mindlink/bitsov/DeviceKeyPlugin.kt");

    for required in [
        "AndroidKeyStore",
        "ECGenParameterSpec(\"secp256r1\")",
        "setUserAuthenticationRequired(true)",
        "setUserAuthenticationParameters(",
        "KeyProperties.AUTH_BIOMETRIC_STRONG",
        "setInvalidatedByBiometricEnrollment(true)",
        "setIsStrongBoxBacked(true)",
        "SECURITY_LEVEL_STRONGBOX",
        "SECURITY_LEVEL_TRUSTED_ENVIRONMENT",
        "isInsideSecureHardware",
        "BiometricPrompt.CryptoObject",
        "SHA256withECDSA",
    ] {
        assert!(
            source.contains(required),
            "missing Android key invariant: {required}"
        );
    }
    assert!(
        !source.contains(".encoded"),
        "the Android private key must never be exported"
    );
}

#[test]
fn android_home_password_is_hardware_encrypted_and_biometric_bound() {
    let source =
        project_file("gen/android/app/src/main/java/tech/mindlink/bitsov/DeviceKeyPlugin.kt");
    for required in [
        "HOME_KEY_ALIAS_PREFIX",
        "KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT",
        "KeyProperties.BLOCK_MODE_GCM",
        "KeyProperties.ENCRYPTION_PADDING_NONE",
        "setUserAuthenticationRequired(true)",
        "setInvalidatedByBiometricEnrollment(true)",
        "KeyProperties.AUTH_BIOMETRIC_STRONG",
        "BiometricPrompt.CryptoObject(cipher)",
        "cipher.updateAAD(item.toByteArray(Charsets.UTF_8))",
        "args.secret != (args.suffix == \"seed-password\")",
        "args.suffix != \"seed-password\"",
        "verifiedDeviceKey(deviceAlias)",
        "fun storeHomeItem",
        "fun readHomeItem",
    ] {
        assert!(
            source.contains(required),
            "missing Android home-unlock storage invariant: {required}"
        );
    }
    for forbidden in ["android.util.Log", "Log.", "println(", "printStackTrace"] {
        assert!(
            !source.contains(forbidden),
            "home unlock secrets must never reach Android logs: {forbidden}"
        );
    }
}

#[test]
fn android_home_unlock_reuses_shared_flow_and_has_no_seed_password_ipc() {
    let keychain = project_file("src/home_keychain.rs");
    let unlock = project_file("src/home_unlock.rs");
    let app = project_file("src/app.rs");

    assert!(keychain.contains("#[cfg(target_os = \"android\")]"));
    assert!(keychain.contains("store_home_item"));
    assert!(keychain.contains("read_home_item"));
    assert!(unlock.contains("LockedConnection::connect"));
    assert!(unlock.contains("challenge.message"));
    assert!(unlock.contains("home_keychain::password(&node, Some(&blob))"));
    assert!(
        !app.contains("seed_password: String"),
        "a seed password must not be accepted from renderer IPC"
    );
}

#[test]
fn android_home_key_spec_prefers_strongbox_and_requires_biometrics_per_use() {
    let source = project_file(PLUGIN);
    let spec = normalized(kotlin_fn(&source, "homeKeySpec"));
    for required in [
        "KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT",
        ".setUserAuthenticationRequired(true)",
        ".setInvalidatedByBiometricEnrollment(true)",
        "builder.setUserAuthenticationParameters(0,KeyProperties.AUTH_BIOMETRIC_STRONG",
        "builder.setUserAuthenticationValidityDurationSeconds(-1)",
        "if(strongBox&&Build.VERSION.SDK_INT>=Build.VERSION_CODES.P){builder.setIsStrongBoxBacked(true)}",
    ] {
        assert!(
            spec.contains(required),
            "homeKeySpec lost an invariant: {required}"
        );
    }
    for single in [
        "setUserAuthenticationParameters(",
        "setUserAuthenticationValidityDurationSeconds(",
    ] {
        assert_eq!(
            spec.matches(single).count(),
            1,
            "homeKeySpec must not override its per-use authentication: {single}"
        );
    }
    for forbidden in ["(false)", "AUTH_DEVICE_CREDENTIAL"] {
        assert!(
            !spec.contains(forbidden),
            "homeKeySpec must not weaken the home unlock key: {forbidden}"
        );
    }

    let preferred = normalized(kotlin_fn(&source, "generatePreferredHomeKey"));
    for required in [
        "hasSystemFeature(\"android.hardware.strongbox_keystore\")",
        "if(hasStrongBox){try{return generateHomeKey(alias,true)}",
        "return generateHomeKey(alias,false)}",
    ] {
        assert!(
            preferred.contains(required),
            "home unlock keys must request StrongBox when available: {required}"
        );
    }
    assert!(normalized(kotlin_fn(&source, "generateHomeKey"))
        .contains("init(homeKeySpec(alias,strongBox))"));
    assert!(normalized(kotlin_fn(&source, "homeKey")).contains("generatePreferredHomeKey(alias)"));
}

#[test]
fn android_home_unlock_failures_never_delete_keys_or_records() {
    let source = project_file(PLUGIN);
    let probe = normalized(kotlin_fn(&source, "hardwareAvailable"));
    let create = normalized(kotlin_fn(&source, "create"));
    let reenroll = normalized(kotlin_fn(&source, "reenrollHomeKey"));
    assert!(probe.contains("val alias=\"${ALIAS_PREFIX}probe-${UUID.randomUUID()}\""));
    assert!(create.contains("val alias=\"$ALIAS_PREFIX${UUID.randomUUID()}\""));
    assert_eq!(
        source.matches("deleteEntry(").count(),
        probe.matches("deleteEntry(alias)").count()
            + create.matches("deleteEntry(alias)").count()
            + reenroll.matches("deleteEntry(homeAlias(deviceAlias))").count(),
        "only the signing-key probe, a failed signing-key create and an owner-requested \
         re-enroll of an invalidated home key may delete Keystore entries"
    );
    assert_eq!(reenroll.matches("deleteEntry(").count(), 1);
    for forbidden in [".remove(", ".clear()", "deleteSharedPreferences"] {
        assert!(
            !source.contains(forbidden),
            "home-node records must never be erased on Android: {forbidden}"
        );
    }

    let read = kotlin_fn(&source, "readHomeItem");
    let store = kotlin_fn(&source, "storeHomeItem");
    let read_flat = normalized(read);
    assert!(
        !read_flat.contains("edit()"),
        "reading a home-node record must never rewrite app storage"
    );
    assert!(
        !read_flat.contains("reenroll"),
        "a failed read must never re-enroll the home key"
    );
    assert!(read_flat.contains("homeKey(deviceAlias,false)"));
    assert!(!read_flat.contains("homeKey(deviceAlias,true)"));
    assert!(normalized(kotlin_fn(&source, "homeKey"))
        .contains("throw UnrecoverableKeyException(\"missing home unlock key\")"));

    for (body, buffer) in [(read, "ciphertext"), (store, "value")] {
        assert_eq!(
            normalized(block_after(body, "override fun onAuthenticationError")),
            format!(
                "{{{buffer}.fill(0)biometricOperation.set(false)\
                 invoke.resolve(result(biometricError(errorCode)))}}"
            ),
            "a cancelled or locked-out home prompt must only report its error"
        );
    }
    for body in [read, store] {
        for exception in [
            "catch (_: KeyPermanentlyInvalidatedException)",
            "catch (_: UnrecoverableKeyException)",
        ] {
            for block in blocks_after(body, exception) {
                assert!(
                    block.contains("result(ERROR_INVALID)"),
                    "an invalidated or missing home key must fail closed: {block}"
                );
            }
        }
    }
    let errors = normalized(kotlin_fn(&source, "biometricError"));
    assert!(errors.contains("BiometricPrompt.ERROR_USER_CANCELED,->ERROR_CANCELLED"));
    assert!(errors.contains(
        "BiometricPrompt.ERROR_LOCKOUT,BiometricPrompt.ERROR_LOCKOUT_PERMANENT,\
         BiometricPrompt.ERROR_NO_BIOMETRICS,->ERROR_BIOMETRY_UNAVAILABLE"
    ));

    for path in ["src/home_keychain.rs", "src/device_key_mobile.rs"] {
        let rust = project_file(path);
        for forbidden in ["delete", "remove"] {
            assert!(
                !rust.contains(forbidden),
                "{path} must not erase home-node records: {forbidden}"
            );
        }
    }
}

#[test]
fn android_home_secrets_are_cleared_in_kotlin_and_zeroized_in_rust() {
    let source = project_file(PLUGIN);
    let store = kotlin_fn(&source, "storeHomeItem");
    let decoded = store
        .find("val value = decodedValue(args.value)")
        .expect("storeHomeItem decodes the plaintext value");
    let mut previous = decoded;
    for (resolve, _) in store.match_indices("invoke.resolve(") {
        if resolve < decoded {
            continue;
        }
        let path = &store[previous..resolve];
        assert!(
            path.contains("value.fill(0)") || path.contains("value?.fill(0)"),
            "storeHomeItem resolves without clearing the plaintext: {path}"
        );
        previous = resolve;
    }
    let stored = normalized(block_after(store, "override fun onAuthenticationSucceeded"));
    for required in ["ciphertext.fill(0)", "encoded.fill(0)"] {
        assert!(
            stored.contains(required),
            "storeHomeItem no longer clears: {required}"
        );
    }

    let read = kotlin_fn(&source, "readHomeItem");
    let unlocked = normalized(block_after(read, "override fun onAuthenticationSucceeded"));
    let order: Vec<_> = [
        "Base64.encodeToString(plaintext,",
        "plaintext.fill(0)",
        "ciphertext.fill(0)",
        "invoke.resolve(response)",
    ]
    .iter()
    .map(|step| {
        unlocked
            .find(step)
            .unwrap_or_else(|| panic!("readHomeItem lost {step}"))
    })
    .collect();
    assert!(
        order.windows(2).all(|pair| pair[0] < pair[1]),
        "readHomeItem must clear the decrypted password before resolving"
    );
    let read_flat = normalized(read);
    for required in ["encoded.fill(0)", "iv.fill(0)"] {
        assert!(
            read_flat.contains(required),
            "readHomeItem no longer clears: {required}"
        );
    }

    let keychain = project_file("src/home_keychain.rs");
    for required in [
        "pub fn password(node: &str, device_blob: Option<&[u8]>) -> Result<Zeroizing<String>, String>",
        ") -> Result<Option<Zeroizing<Vec<u8>>>, String> {",
        ".map(|value| value.map(Zeroizing::new))",
        "Ok(Zeroizing::new(value.to_owned()))",
    ] {
        assert!(
            keychain.contains(required),
            "the home password must stay Zeroizing: {required}"
        );
    }
    assert!(project_file("src/home_node.rs").contains("pub password: zeroize::Zeroizing<String>,"));

    let mobile = project_file("src/device_key_mobile.rs");
    let android = block_after(&mobile, "mod android");
    for required in [
        "value: Option<Zeroizing<String>>,",
        "value: Zeroizing<String>,",
        "value: Zeroizing::new(STANDARD.encode(value)),",
    ] {
        assert!(
            android.contains(required),
            "base64 home-item values must be Zeroizing: {required}"
        );
    }
    for forbidden in [
        "value: String",
        "value: Option<String>",
        "value: STANDARD.encode(",
    ] {
        assert!(
            !android.contains(forbidden),
            "base64 home-item values must not be plain Strings: {forbidden}"
        );
    }
}

#[test]
fn android_remember_writes_through_store_home_item_under_the_read_side_key_spec() {
    let source = project_file(PLUGIN);
    let store = normalized(kotlin_fn(&source, "storeHomeItem"));
    for required in [
        "val cipher=homeEncryptCipher(deviceAlias,args.reenroll)",
        "cipher.updateAAD(item.toByteArray(Charsets.UTF_8))",
        "BiometricPrompt.CryptoObject(cipher)",
        "val deviceAlias=deviceAlias(args.blob)",
    ] {
        assert!(store.contains(required), "storeHomeItem lost {required}");
    }
    assert!(
        !store.contains("Cipher.getInstance("),
        "storeHomeItem must get its cipher only from homeEncryptCipher"
    );
    let encrypt = normalized(kotlin_fn(&source, "homeEncryptCipher"));
    assert!(encrypt.starts_with(
        "{val cipher=Cipher.getInstance(\"AES/GCM/NoPadding\")\
         try{cipher.init(Cipher.ENCRYPT_MODE,homeKey(deviceAlias,true))}"
    ));
    assert_eq!(
        encrypt.matches("homeKey(deviceAlias,true)").count(),
        2,
        "the write path must use homeKey, the single source of the read-side key spec"
    );
    assert!(normalized(&source).contains(
        "class StoreHomeItemArgs{var blob:String?=null var node:String=\"\"\
         var suffix:String=\"\"var value:String=\"\"var secret:Boolean=false \
         var reenroll:Boolean=false}"
    ));

    let keychain = normalized(&project_file("src/home_keychain.rs"));
    for required in [
        "#[cfg(target_os=\"android\")]pub fn save_password_for_device(node:&str,password:&[u8],\
         device_blob:&[u8],reenroll:bool,)->Result<(),String>{",
        "service(node,\"seed-password\")?;android_store(Some(device_blob),node,\
         \"seed-password\",password,true,reenroll)",
        "let _=name;android_store(device_blob,node,suffix,bytes,secret,false)",
        "super::device_key::store_home_item(device_blob,node,suffix,bytes,secret,reenroll)",
    ] {
        assert!(
            keychain.contains(required),
            "the Android write path changed: {required}"
        );
    }

    let mobile = project_file("src/device_key_mobile.rs");
    let android = normalized(block_after(&mobile, "mod android"));
    for required in [
        "if reenroll&&!secret{return Err(DeviceKeyError::Invalid);}",
        "value:Zeroizing::new(STANDARD.encode(value)),secret,reenroll,",
    ] {
        assert!(android.contains(required), "store_home_item lost {required}");
    }
}

#[test]
fn android_reenroll_replaces_only_an_invalidated_home_key_after_the_owner_asks() {
    let source = project_file(PLUGIN);
    assert_eq!(
        normalized(kotlin_fn(&source, "reenrollHomeKey")),
        "{verifiedDeviceKey(deviceAlias)keyStore().deleteEntry(homeAlias(deviceAlias))}",
        "re-enroll deletes exactly this device key's companion alias"
    );
    assert_eq!(
        source.matches("reenrollHomeKey(").count(),
        2,
        "re-enroll has one definition and one caller"
    );
    let encrypt = normalized(kotlin_fn(&source, "homeEncryptCipher"));
    assert!(
        encrypt.contains(
            "catch(invalidated:KeyPermanentlyInvalidatedException){if(!reenroll){throw invalidated}\
             reenrollHomeKey(deviceAlias)cipher.init(Cipher.ENCRYPT_MODE,homeKey(deviceAlias,true))}"
        ),
        "only a Keystore-reported permanent invalidation, with reenroll set, replaces the key"
    );
    assert_eq!(encrypt.matches("catch(").count(), 1);

    let unlock = project_file("src/home_unlock.rs");
    let remember = normalized(block_after(&unlock, "pub async fn remember("));
    assert!(
        remember.contains(
            "home_keychain::save_password_for_device(&offer.node,offer.password.as_bytes(),&blob,true,)"
        ),
        "re-enroll is requested only from the owner's Remember choice"
    );
    let take = remember.find(".take()").expect("the offer is single use");
    let declined = remember
        .find("if!remember{return Ok(());}")
        .expect("Not now saves nothing");
    let save = remember
        .find("save_password_for_device(")
        .expect("Remember saves");
    assert!(take < declined && declined < save);
    for required in [
        "if offer.offered.elapsed()>=REMEMBER_WINDOW{",
        "!=Some(offer.node.as_str()){",
        "if!record.registered{",
        "if saved.is_err()&&offer.offered.elapsed()<REMEMBER_WINDOW{state.home_remember.lock().unwrap().get_or_insert(offer);}",
    ] {
        assert!(remember.contains(required), "remember lost {required}");
    }
    for path in ["src/app.rs", "src/home_keychain.rs", "src/device_key_mobile.rs"] {
        assert!(
            !project_file(path).contains("save_password_for_device(&"),
            "{path} must not save a password outside home_unlock::remember"
        );
    }
    assert_eq!(unlock.matches("save_password_for_device(").count(), 1);
}

#[test]
fn android_typed_unlock_keeps_only_a_node_accepted_password_in_memory() {
    let app = project_file("src/app.rs");
    let normal = normalized(&app);
    assert!(normal.contains(
        "#[tauri::command]#[cfg(any(target_os=\"android\",all(target_os=\"macos\",desktop,not(feature=\"mobile\"))))]async fn node_unlock_password(\
         window:WebviewWindow<impl tauri::Runtime>,state:State<'_,NodeState>,\
         password:zeroize::Zeroizing<String>,)->Result<(),String>{\
         reject_sealed_window(&window)?;drop(window);\
         home_unlock::unlock_typed(state.inner(),password).await}"
    ));
    assert!(normal.contains(
        "#[tauri::command]#[cfg(any(target_os=\"android\",all(target_os=\"macos\",desktop,not(feature=\"mobile\"))))]async fn node_unlock_remember(\
         window:WebviewWindow<impl tauri::Runtime>,state:State<'_,NodeState>,remember:bool,\
         )->Result<(),String>{reject_sealed_window(&window)?;drop(window);\
         home_unlock::remember(state.inner(),remember).await}"
    ));
    for stub in ["node_unlock_password", "node_unlock_remember"] {
        assert!(
            normal.contains(&format!(
                "#[tauri::command]#[cfg(not(any(target_os=\"android\",all(target_os=\"macos\",desktop,not(feature=\"mobile\")))))]async fn {stub}(\
                 window:WebviewWindow<impl tauri::Runtime>)->Result<(),String>{{\
                 reject_sealed_window(&window)?;Err("
            )),
            "{stub} must take no input and do nothing on unsupported platforms"
        );
    }
    assert_eq!(
        app.matches("password: zeroize::Zeroizing<String>").count(),
        1,
        "node_unlock_password is the only password-bearing command"
    );
    assert!(!app.contains("seed_password: String"));
    assert!(normal
        .contains("#[cfg(any(target_os=\"android\",all(target_os=\"macos\",desktop,not(feature=\"mobile\"))))]home_remember:Arc<Mutex<Option<home_unlock::RememberOffer>>>,"));

    let unlock = project_file("src/home_unlock.rs");
    let flat = normalized(&unlock);
    assert!(flat.contains(
        "#[cfg(any(target_os=\"android\",all(target_os=\"macos\",desktop,not(feature=\"mobile\"))))]pub struct RememberOffer{node:String,\
         password:zeroize::Zeroizing<String>,offered:Instant,}"
    ));
    assert!(flat.contains("pub async fn unlock(state:&NodeState)->Result<(),String>{unlock_with(state,None).await}"));
    let typed = normalized(block_after(&unlock, "pub async fn unlock_typed("));
    assert!(typed.starts_with("{*state.home_remember.lock().unwrap()=None;"));
    assert!(typed.contains("if password.is_empty()||password.len()>4096{"));
    let shared = block_after(&unlock, "async fn unlock_with(");
    let accepted = shared
        .find("result.map_err(|e| e.to_string())?;")
        .expect("the node's answer is checked");
    let offered = shared
        .find("Some(RememberOffer {")
        .expect("an accepted typed password is offered");
    assert!(
        accepted < offered,
        "only a password the node accepted may be offered for saving"
    );
    assert!(shared.contains("home_keychain::password(&node, Some(&blob))"));
    for forbidden in ["println!", "eprintln!", "log::", "tracing::", "format!(\"{password"] {
        assert!(!unlock.contains(forbidden), "home_unlock must not log: {forbidden}");
    }
}

fn in_order(haystack: &str, steps: &[&str]) {
    let found: Vec<_> = steps
        .iter()
        .map(|step| haystack.find(step).unwrap_or_else(|| panic!("missing {step}")))
        .collect();
    assert!(found.windows(2).all(|pair| pair[0] < pair[1]), "out of order: {steps:?}");
}

#[test]
fn android_client_seed_is_kept_only_as_keystore_ciphertext() {
    let key = project_file("src/pairing/key.rs");
    let flat = normalized(&key);
    assert!(flat.contains(
        "match at_rest::installed(){Some(sealer)=>Self::load_or_create_sealed(dir,sealer),\
         None=>Self::load_or_create_plain(dir),}"
    ));
    let sealed = normalized(block_after(&key, "pub(crate) fn load_or_create_sealed("));
    in_order(
        &sealed,
        &[
            "let seed=if sealed_file_exists(dir)?{sealed_seed(&sealed,sealer)?}else{",
            "plain_seed(&plain)?",
            "if let Err(error)=write_verified_seed(&sealed,&seed,sealer){",
            "if!sealer.allows_plaintext_fallback(){return Err(error);}",
            "return if sealed_file_exists(dir)?{sealed_seed(&sealed,sealer).map(|seed|Self::from_seed(*seed))}else{Self::load_or_create_plain(dir)};",
            "match plain_seed(&plain){Ok(plain_seed)if*plain_seed==*seed=>{}",
            "if let Err(error)=discard(&plain){",
        ],
    );
    let write = normalized(block_after(&key, "\nfn write_verified_seed("));
    in_order(
        &write,
        &[
            ".seal(at_rest::CLIENT_SEED_PURPOSE,seed)",
            "temp.write_all(&ciphertext)",
            "temp.as_file().sync_all()",
            "let reopened=sealed_seed(temp.path(),sealer)?;",
            "if*reopened!=*seed{return Err(",
            "temp.persist_noclobber(path)",
            "std::fs::File::open(dir)",
        ],
    );
    let plain = normalized(block_after(&key, "fn load_or_create_plain("));
    assert!(plain.starts_with("{if sealed_file_exists(dir)?{return Err("));
    for forbidden in ["hex::encode", "write_all", "create_new_protected"] {
        assert!(
            !sealed.contains(forbidden),
            "the sealed key path must not write a plain seed: {forbidden}"
        );
    }
    assert!(normalized(block_after(&key, "\nfn sealed_seed("))
        .contains("sealer.open(at_rest::CLIENT_SEED_PURPOSE,&ciphertext)"));
    let discard = normalized(block_after(&key, "\nfn discard("));
    in_order(&discard, &["file.write_all(&zeros)", "std::fs::remove_file(path)"]);

    let at_rest = project_file("src/at_rest.rs");
    assert!(at_rest.contains("pub const CLIENT_SEED_PURPOSE: &str = \"client-ed25519-seed-v1\";"));
    assert!(at_rest.contains("format!(\"pairing-code-v1:{node_id}\")"));
}

#[test]
fn android_descriptor_keeps_only_public_pins_and_a_sealed_code() {
    let remote = project_file("src/remote_access.rs");
    let flat = normalized(&remote);
    assert!(flat.contains(
        "fn persist_at(path:&Path,descriptor:&RemoteDescriptor)->Result<(),RemoteError>{\
         persist_with(path,descriptor,at_rest::installed())}"
    ));
    let stored = normalized(block_after(&remote, "\nfn stored_bytes("));
    assert!(
        stored.starts_with("{let Some(sealer)=sealer else{return serde_json::to_vec(descriptor)"),
        "desktop keeps writing the descriptor unchanged"
    );
    for required in [
        ".seal(&at_rest::pairing_code_purpose(&descriptor.node_id),code.as_bytes())",
        "transport_pubkey:descriptor.transport_pubkey.clone(),",
        "code:None,sealed_code,",
    ] {
        assert!(stored.contains(required), "stored_bytes lost {required}");
    }
    assert_eq!(
        remote.matches("serde_json::to_vec(descriptor)").count(),
        1,
        "only the no-sealer branch may serialize the plaintext code"
    );
    assert!(flat.contains(
        "#[serde(default,skip_serializing_if=\"Option::is_none\")]sealed_code:Option<String>,"
    ));

    let load = normalized(block_after(&remote, "pub fn load_persisted("));
    assert!(load.contains("let sealer=at_rest::installed();"));
    assert!(load.contains("sealer.map(|_|REMOTE_CONFIG_LOCK.lock().unwrap())"));
    let load_with = normalized(block_after(&remote, "\nfn load_with("));
    in_order(
        &load_with,
        &[
            "let(persisted,migrate)=open_sealed_code(persisted,sealer)?;",
            "let descriptor=validate_descriptor(persisted)?;",
            "if migrate{",
            "if let Err(error)=persist_with(path,&descriptor,sealer){",
            "if!sealer.is_some_and(|sealer|sealer.allows_plaintext_fallback()){return Err(error);}",
            "Ok(Some(descriptor))}",
        ],
    );
    let persist = normalized(block_after(&remote, "\nfn persist_with("));
    in_order(
        &persist,
        &[
            "stored_bytes(descriptor,sealer)",
            "if bytes.len()>MAX_LINK_BYTES{",
            "std::io::Write::write_all(&mut file,&bytes)",
            "file.sync_all()",
            "let readback=std::fs::read(&tmp)",
            "let(opened,_)=open_sealed_code(stored,sealer)?;",
            "if opened.code!=descriptor.code{return Err(",
            "std::fs::rename(&tmp,path)",
        ],
    );
    let open = normalized(block_after(&remote, "\nfn open_sealed_code("));
    for required in [
        "let migrate=sealer.is_some()&&stored.code.is_some();",
        "let Some(sealer)=sealer else{return Err(",
        "if stored.code.is_some(){return Err(",
        ".open(&at_rest::pairing_code_purpose(&stored.node_id),&bytes)",
    ] {
        assert!(open.contains(required), "open_sealed_code lost {required}");
    }
    assert!(normalized(block_after(&remote, "\nfn saved_descriptor("))
        .starts_with("{let Some(sealer)=at_rest::installed()else{\
                      return serde_json::from_slice::<RemoteDescriptor>(bytes).ok();};"));
}

#[test]
fn android_at_rest_key_is_hardware_bound_and_opening_never_creates_it() {
    let source = project_file(PLUGIN);
    let spec = normalized(kotlin_fn(&source, "atRestKeySpec"));
    for required in [
        "KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT",
        ".setKeySize(256)",
        ".setBlockModes(KeyProperties.BLOCK_MODE_GCM)",
        ".setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)",
        ".setRandomizedEncryptionRequired(true)",
        "if(strongBox&&Build.VERSION.SDK_INT>=Build.VERSION_CODES.P){builder.setIsStrongBoxBacked(true)}",
    ] {
        assert!(spec.contains(required), "atRestKeySpec lost {required}");
    }
    for forbidden in ["setUserAuthentication", "setInvalidatedByBiometricEnrollment"] {
        assert!(
            !spec.contains(forbidden),
            "the client seed must survive fingerprint changes and open without a prompt: {forbidden}"
        );
    }
    let preferred = normalized(kotlin_fn(&source, "generatePreferredAtRestKey"));
    assert!(preferred.contains("if(hasStrongBox){try{return generateAtRestKey(true)}"));
    let key = normalized(kotlin_fn(&source, "atRestKey"));
    for required in [
        "throw UnrecoverableKeyException(\"missing at-rest key\")",
        "if(!isHardwareBacked(key)){throw",
    ] {
        assert!(key.contains(required), "atRestKey lost {required}");
    }
    let purpose = normalized(kotlin_fn(&source, "atRestPurpose"));
    for required in [
        "purpose==\"client-ed25519-seed-v1\"",
        "node!=purpose&&node.length==64&&",
        "\"bitsov.at-rest.$purpose\"",
    ] {
        assert!(purpose.contains(required), "atRestPurpose lost {required}");
    }

    let seal = normalized(kotlin_fn(&source, "seal"));
    let unseal = normalized(kotlin_fn(&source, "unseal"));
    for body in [&seal, &unseal] {
        assert!(body.contains("val aad=atRestPurpose(args.purpose)"));
        assert!(body.contains("if(aad==null||"));
        assert!(body.contains("cipher.updateAAD(aad)"));
    }
    assert!(seal.contains("cipher.init(Cipher.ENCRYPT_MODE,atRestKey(true))"));
    assert!(seal.contains("value.fill(0)invoke.resolve(response)}"));
    assert!(unseal.contains("atRestKey(false)"));
    assert!(unseal.contains("catch(_:AEADBadTagException){result(ERROR_INVALID)}"));
    assert_eq!(source.matches("atRestKey(true)").count(), 1, "only seal creates the key");
    assert!(!source.contains("deleteEntry(AT_REST_KEY_ALIAS"));

    let mobile = project_file("src/device_key_mobile.rs");
    let android = normalized(block_after(&mobile, "mod android"));
    for required in [
        "struct SealPayload<'a>{purpose:&'a str,value:Zeroizing<String>,}",
        "decode(checked(response)?.value).map(Zeroizing::new)",
        "impl bitsov_app::at_rest::Sealer for KeystoreSealer{",
    ] {
        assert!(android.contains(required), "the Keystore sealer bridge lost {required}");
    }

    let app = project_file("src/app.rs");
    let install = "#[cfg(target_os = \"android\")]\n            \
                   bitsov_app::at_rest::install(Arc::new(device_key::KeystoreSealer))?;";
    assert_eq!(app.matches("at_rest::install(").count(), 1);
    in_order(&app, &[install, "tauri::async_runtime::spawn(bootstrap_node(handle));"]);
}

#[test]
fn apple_keychain_home_paths_keep_their_keychain_calls() {
    let keychain = project_file("src/home_keychain.rs");
    assert_eq!(keychain.matches(APPLE_HOME_KEYCHAIN_CFG).count(), 2);

    let store = normalized(block_after(
        block_after(&keychain, "\nfn store("),
        APPLE_HOME_KEYCHAIN_CFG,
    ));
    for required in [
        "let _=device_blob;",
        "bitsov_ffi::home_keychain::store(&name,bytes,secret)",
        "if status==0{Ok(())}else{Err(",
    ] {
        assert!(
            store.contains(required),
            "macOS Keychain store changed: {required}"
        );
    }

    let read = normalized(block_after(
        block_after(&keychain, "\nfn read("),
        APPLE_HOME_KEYCHAIN_CFG,
    ));
    for required in [
        "let _=(secret,device_blob);",
        "bitsov_ffi::home_keychain::read(&name,16384)",
        "if status==-25300{return Ok(None);}",
        "if status!=0||length>bytes.len(){return Err(",
        "bytes.truncate(length);Ok(Some(bytes))",
    ] {
        assert!(
            read.contains(required),
            "macOS Keychain read changed: {required}"
        );
    }
    for block in [&store, &read] {
        assert!(
            !block.contains("device_key"),
            "the macOS Keychain path must not route through the Android plugin"
        );
    }

    let flat = normalized(&keychain);
    for required in [
        "#[cfg(not(target_os=\"android\"))]pub fn save_password(",
        "store(node,\"seed-password\",password,true,None)",
        "read(node,\"seed-password\",true,device_blob)",
        "read(node,\"box-transport\",false,None)",
        "store(&pin.node_id,\"box-transport\",&bytes,false,None)",
        "read(node,\"unlock-binding\",false,None)",
    ] {
        assert!(
            flat.contains(required),
            "macOS Keychain callers changed: {required}"
        );
    }
}

#[test]
fn android_manifest_adds_only_camera_audio_biometric_and_local_network_permissions() {
    let manifest = project_file("gen/android/app/src/main/AndroidManifest.xml");
    assert!(
        manifest.contains("android:allowBackup=\"false\""),
        "device-bound home-node records must not enter Android backup"
    );
    let declared: BTreeSet<_> = manifest
        .lines()
        .filter(|line| line.contains("<uses-permission "))
        .filter_map(|line| line.split("android:name=\"").nth(1))
        .filter_map(|tail| tail.split('"').next())
        .collect();

    assert_eq!(
        declared,
        BTreeSet::from([
            "android.permission.ACCESS_LOCAL_NETWORK",
            "android.permission.ACCESS_NETWORK_STATE",
            "android.permission.CAMERA",
            "android.permission.INTERNET",
            "android.permission.MODIFY_AUDIO_SETTINGS",
            "android.permission.RECORD_AUDIO",
            "android.permission.USE_BIOMETRIC",
            "android.permission.VIBRATE",
        ])
    );
    for removed in [
        "android.permission.ACCESS_NETWORK_STATE",
        "android.permission.VIBRATE",
    ] {
        assert!(
            manifest.contains(&format!("android:name=\"{removed}\" tools:node=\"remove\"")),
            "remove the scanner dependency's unused {removed} permission during manifest merge"
        );
    }
}

#[test]
fn android_plugins_are_registered_without_enabling_them_on_desktop() {
    let app = project_file("src/app.rs");
    let cargo = project_file("Cargo.toml");
    let mobile_capability = project_file("mobile-capabilities/default.json");

    assert!(app.contains("#[cfg(target_os = \"android\")]"));
    assert!(app.contains(".plugin(device_key::init())"));
    assert!(app.contains(".plugin(tauri_plugin_barcode_scanner::init())"));
    assert!(cargo.contains("tauri-plugin-barcode-scanner"));
    assert!(mobile_capability.contains("\"barcode-scanner:allow-scan\""));
    assert!(mobile_capability.contains("\"barcode-scanner:allow-check-permissions\""));
    assert!(mobile_capability.contains("\"barcode-scanner:allow-request-permissions\""));
}

#[test]
fn ios_home_keychain_only_stores_device_local_public_metadata() {
    let swift = project_file("native/home_metadata.swift");
    let valid = normalized(block_after(&swift, "static func valid("));
    assert!(valid.contains("[\"box-transport\",\"unlock-binding\"].contains(String(fields[3]))"));
    assert!(valid.contains("fields.count==4&&fields[0]==\"bitsov\"&&fields[1]==\"node\""));
    assert!(valid.contains("fields[2].utf8.count==64"));
    assert!(valid.contains("fields[2].utf8.allSatisfy{(48...57).contains($0)||(97...102).contains($0)}"));
    let bridge = normalized(block_after(&swift, "public func bitsov_home_store("));
    in_order(&bridge, &["secret==0", "else{return errSecParam}", "HomeMetadata().store("]);
    let query = normalized(block_after(&swift, "private func query("));
    assert!(query.contains("kSecAttrSynchronizable:false"));
    assert!(query.contains("kSecUseDataProtectionKeychain:true"));
    let store = normalized(block_after(&swift, "func store("));
    in_order(&store, &["guard Self.valid(service)", "else{return errSecParam}", "let base=query(service,context)",
        "attributes[kSecAttrAccessible]=kSecAttrAccessibleWhenUnlockedThisDeviceOnly", "let status=add(attributes as CFDictionary,nil)",
        "return update(base as CFDictionary,[kSecValueData:data,kSecAttrAccessible:kSecAttrAccessibleWhenUnlockedThisDeviceOnly]as CFDictionary)"]);
    let read = normalized(block_after(&swift, "func read("));
    in_order(&read, &["guard Self.valid(service)else{return errSecParam}", "var attributes=query(service,context)", "let status=copy("]);
    for body in [&store, &read] { assert!(body.contains("context.interactionNotAllowed=true")); }
    assert_eq!(swift.matches("kSecAttrSynchronizable").count(), 1, "no sync override");
    for forbidden in ["kSecAttrAccessGroup", "kSecUseKeychain", "kSecMatchSearchList", "seed-password"] {
        assert!(!swift.contains(forbidden), "iOS metadata must not enable {forbidden}");
    }
    let build = project_file("ffi/build.rs");
    let ios_compile = build.lines().find(|line| line.contains("if ios { compiler.args(")).unwrap();
    assert!(ios_compile.contains("../native/home_metadata.swift"));
}
