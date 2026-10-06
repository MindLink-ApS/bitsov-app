package tech.mindlink.bitsov

import android.app.Activity
import android.content.Context
import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyInfo
import android.security.keystore.KeyPermanentlyInvalidatedException
import android.security.keystore.KeyProperties
import android.security.keystore.StrongBoxUnavailableException
import android.util.Base64
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.math.BigInteger
import java.security.Key
import java.security.KeyFactory
import java.security.KeyPair
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.PrivateKey
import java.security.ProviderException
import java.security.Signature
import java.security.UnrecoverableKeyException
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec
import java.util.UUID
import java.util.concurrent.atomic.AtomicBoolean
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.SecretKeyFactory
import javax.crypto.spec.GCMParameterSpec

private const val KEYSTORE = "AndroidKeyStore"
private const val ALIAS_PREFIX = "bitsov-device-v1:"
private const val HOME_KEY_ALIAS_PREFIX = "bitsov-home-unlock-v1:"
private const val HOME_PREFERENCES = "bitsov-home-node-v1"
private const val HOME_CIPHER_VERSION: Byte = 1
private const val GCM_IV_BYTES = 12
private const val ERROR_UNAVAILABLE = -1
private const val ERROR_CANCELLED = -2
private const val ERROR_INVALID = -3
private const val ERROR_BIOMETRY_UNAVAILABLE = -7
private const val ERROR_OTHER = -100

@InvokeArg
class CreateArgs {
    var policy: String = ""
}

@InvokeArg
class BlobArgs {
    var blob: String = ""
}

@InvokeArg
class SignArgs {
    var blob: String = ""
    var message: String = ""
    var reason: String = ""
}

@InvokeArg
class StoreHomeItemArgs {
    var blob: String? = null
    var node: String = ""
    var suffix: String = ""
    var value: String = ""
    var secret: Boolean = false
}

@InvokeArg
class ReadHomeItemArgs {
    var blob: String? = null
    var node: String = ""
    var suffix: String = ""
    var secret: Boolean = false
}

@TauriPlugin
class DeviceKeyPlugin(private val activity: Activity) : Plugin(activity) {
    private val biometricOperation = AtomicBoolean(false)
    @Volatile private var hardwareBacked: Boolean? = null

    private fun keyStore(): KeyStore =
        KeyStore.getInstance(KEYSTORE).apply { load(null) }

    private fun result(errorCode: Int? = null, block: (JSObject.() -> Unit)? = null): JSObject =
        JSObject().apply {
            put("errorCode", errorCode)
            block?.invoke(this)
        }

    private fun biometricAvailable(): Boolean =
        BiometricManager.from(activity).canAuthenticate(BiometricManager.Authenticators.BIOMETRIC_STRONG) ==
            BiometricManager.BIOMETRIC_SUCCESS

    private fun keySpec(alias: String, strongBox: Boolean): KeyGenParameterSpec {
        val builder = KeyGenParameterSpec.Builder(
            alias,
            KeyProperties.PURPOSE_SIGN or KeyProperties.PURPOSE_VERIFY,
        )
            .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
            .setDigests(KeyProperties.DIGEST_SHA256)
            .setUserAuthenticationRequired(true)
            .setInvalidatedByBiometricEnrollment(true)

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            builder.setUserAuthenticationParameters(
                0,
                KeyProperties.AUTH_BIOMETRIC_STRONG,
            )
        } else {
            @Suppress("DEPRECATION")
            builder.setUserAuthenticationValidityDurationSeconds(-1)
        }
        if (strongBox && Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            builder.setIsStrongBoxBacked(true)
        }
        return builder.build()
    }

    private fun generate(alias: String, strongBox: Boolean): KeyPair =
        KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, KEYSTORE).run {
            initialize(keySpec(alias, strongBox))
            generateKeyPair()
        }

    private fun generatePreferred(alias: String): KeyPair {
        val hasStrongBox =
            Build.VERSION.SDK_INT >= Build.VERSION_CODES.P &&
                activity.packageManager.hasSystemFeature("android.hardware.strongbox_keystore")
        if (hasStrongBox) {
            try {
                return generate(alias, true)
            } catch (_: StrongBoxUnavailableException) {
                // StrongBox can be advertised but exhausted; fall back to the TEE.
            } catch (_: ProviderException) {
                // A temporarily unavailable StrongBox must not disable a valid TEE.
            }
        }
        return generate(alias, false)
    }

    private fun keyInfo(key: Key): KeyInfo = when (key) {
        is PrivateKey -> KeyFactory.getInstance(key.algorithm, KEYSTORE)
            .getKeySpec(key, KeyInfo::class.java)
        is SecretKey -> SecretKeyFactory.getInstance(key.algorithm, KEYSTORE)
            .getKeySpec(key, KeyInfo::class.java) as KeyInfo
        else -> throw IllegalArgumentException("unsupported Android Keystore key")
    }

    private fun isHardwareBacked(key: Key): Boolean {
        val keyInfo = keyInfo(key)
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            keyInfo.securityLevel == KeyProperties.SECURITY_LEVEL_STRONGBOX ||
                keyInfo.securityLevel == KeyProperties.SECURITY_LEVEL_TRUSTED_ENVIRONMENT
        } else {
            @Suppress("DEPRECATION")
            keyInfo.isInsideSecureHardware
        }
    }

    private fun homeKeySpec(alias: String, strongBox: Boolean): KeyGenParameterSpec {
        val builder = KeyGenParameterSpec.Builder(
            alias,
            KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
        )
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setRandomizedEncryptionRequired(true)
            .setUserAuthenticationRequired(true)
            .setInvalidatedByBiometricEnrollment(true)

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            builder.setUserAuthenticationParameters(
                0,
                KeyProperties.AUTH_BIOMETRIC_STRONG,
            )
        } else {
            @Suppress("DEPRECATION")
            builder.setUserAuthenticationValidityDurationSeconds(-1)
        }
        if (strongBox && Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            builder.setIsStrongBoxBacked(true)
        }
        return builder.build()
    }

    private fun generateHomeKey(alias: String, strongBox: Boolean): SecretKey =
        KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE).run {
            init(homeKeySpec(alias, strongBox))
            generateKey()
        }

    private fun generatePreferredHomeKey(alias: String): SecretKey {
        val hasStrongBox =
            Build.VERSION.SDK_INT >= Build.VERSION_CODES.P &&
                activity.packageManager.hasSystemFeature("android.hardware.strongbox_keystore")
        if (hasStrongBox) {
            try {
                return generateHomeKey(alias, true)
            } catch (_: StrongBoxUnavailableException) {
                // Match the signing-key policy: a hardware TEE remains acceptable.
            } catch (_: ProviderException) {
                // A temporarily unavailable StrongBox must not disable a valid TEE.
            }
        }
        return generateHomeKey(alias, false)
    }

    @Synchronized
    private fun hardwareAvailable(): Boolean {
        hardwareBacked?.let { return it }
        val alias = "${ALIAS_PREFIX}probe-${UUID.randomUUID()}"
        val available = try {
            val pair = generatePreferred(alias)
            isHardwareBacked(pair.private)
        } catch (_: Exception) {
            false
        } finally {
            try {
                keyStore().deleteEntry(alias)
            } catch (_: Exception) {
                // A failed probe did not necessarily create an entry.
            }
        }
        hardwareBacked = available
        return available
    }

    private fun encodedAlias(alias: String): String =
        Base64.encodeToString(alias.toByteArray(Charsets.UTF_8), Base64.NO_WRAP)

    private fun alias(blob: String): String? = try {
        val decoded = Base64.decode(blob, Base64.DEFAULT).toString(Charsets.UTF_8)
        decoded.takeIf {
            it.startsWith(ALIAS_PREFIX) &&
                it.length in (ALIAS_PREFIX.length + 32)..(ALIAS_PREFIX.length + 64) &&
                it.drop(ALIAS_PREFIX.length).all { char ->
                    char.isDigit() || char in 'a'..'f' || char == '-'
                }
        }
    } catch (_: IllegalArgumentException) {
        null
    }

    private fun fixedWidth(value: BigInteger): ByteArray {
        val source = value.toByteArray()
        val unsigned = if (source.size == 33 && source[0] == 0.toByte()) {
            source.copyOfRange(1, source.size)
        } else {
            source
        }
        require(unsigned.size <= 32)
        return ByteArray(32).also {
            unsigned.copyInto(it, destinationOffset = 32 - unsigned.size)
        }
    }

    private fun publicKey(alias: String): ByteArray {
        val public = keyStore().getCertificate(alias)?.publicKey as? ECPublicKey
            ?: throw UnrecoverableKeyException("missing Android Keystore public key")
        return byteArrayOf(0x04) +
            fixedWidth(public.w.affineX) +
            fixedWidth(public.w.affineY)
    }

    private fun privateKey(alias: String): PrivateKey =
        keyStore().getKey(alias, null) as? PrivateKey
            ?: throw UnrecoverableKeyException("missing Android Keystore private key")

    private fun homeAlias(deviceAlias: String): String =
        "$HOME_KEY_ALIAS_PREFIX${deviceAlias.removePrefix(ALIAS_PREFIX)}"

    private fun homeItem(node: String, suffix: String): String? {
        val validNode =
            node.length == 64 &&
                node.all { char -> char.isDigit() || char in 'a'..'f' }
        val validSuffix =
            suffix == "box-transport" ||
                suffix == "unlock-binding" ||
                suffix == "seed-password"
        return if (validNode && validSuffix) "bitsov.node.$node.$suffix" else null
    }

    private fun decodedValue(value: String): ByteArray? = try {
        Base64.decode(value, Base64.DEFAULT)
    } catch (_: IllegalArgumentException) {
        null
    }

    private fun deviceAlias(blob: String?): String? =
        blob?.let(::alias)

    private fun verifiedDeviceKey(deviceAlias: String): PrivateKey {
        val key = privateKey(deviceAlias)
        if (!isHardwareBacked(key)) {
            throw UnrecoverableKeyException("device key is not hardware backed")
        }
        return key
    }

    private fun homeKey(deviceAlias: String, create: Boolean): SecretKey {
        // The companion alias is derived from the exact enrolled signing-key
        // alias. Refuse an orphaned ciphertext if that signing key disappeared.
        verifiedDeviceKey(deviceAlias)
        val alias = homeAlias(deviceAlias)
        val existing = keyStore().getKey(alias, null) as? SecretKey
        val key = existing ?: if (create) {
            generatePreferredHomeKey(alias)
        } else {
            throw UnrecoverableKeyException("missing home unlock key")
        }
        if (!isHardwareBacked(key)) {
            throw UnrecoverableKeyException("home unlock key is not hardware backed")
        }
        return key
    }

    private fun preferences() =
        activity.getSharedPreferences(HOME_PREFERENCES, Context.MODE_PRIVATE)

    private fun promptInfo(reason: String): BiometricPrompt.PromptInfo =
        BiometricPrompt.PromptInfo.Builder()
            .setTitle("Approve with BitSov")
            .setDescription(reason.take(300))
            .setAllowedAuthenticators(BiometricManager.Authenticators.BIOMETRIC_STRONG)
            .setNegativeButtonText("Cancel")
            .build()

    @Command
    fun availability(invoke: Invoke) {
        val hardware = hardwareAvailable()
        invoke.resolve(JSObject().apply {
            put("hardwareBacked", hardware)
            put("biometricsAvailable", hardware && biometricAvailable())
        })
    }

    @Command
    fun create(invoke: Invoke) {
        val args = invoke.parseArgs(CreateArgs::class.java)
        if (args.policy != "biometry") {
            invoke.resolve(result(ERROR_UNAVAILABLE))
            return
        }
        if (!biometricAvailable()) {
            invoke.resolve(result(ERROR_BIOMETRY_UNAVAILABLE))
            return
        }

        val alias = "$ALIAS_PREFIX${UUID.randomUUID()}"
        try {
            val pair = generatePreferred(alias)
            if (!isHardwareBacked(pair.private)) {
                keyStore().deleteEntry(alias)
                invoke.resolve(result(ERROR_UNAVAILABLE))
                return
            }
            val public = publicKey(alias)
            invoke.resolve(result {
                put("blob", encodedAlias(alias))
                put("publicKey", Base64.encodeToString(public, Base64.NO_WRAP))
            })
        } catch (_: Exception) {
            try {
                keyStore().deleteEntry(alias)
            } catch (_: Exception) {
                // Nothing else can use a partial entry.
            }
            invoke.resolve(result(ERROR_UNAVAILABLE))
        }
    }

    @Command
    fun publicKey(invoke: Invoke) {
        val args = invoke.parseArgs(BlobArgs::class.java)
        val alias = alias(args.blob)
        if (alias == null) {
            invoke.resolve(result(ERROR_INVALID))
            return
        }
        try {
            val private = privateKey(alias)
            if (!isHardwareBacked(private)) {
                invoke.resolve(result(ERROR_UNAVAILABLE))
                return
            }
            invoke.resolve(result {
                put("publicKey", Base64.encodeToString(publicKey(alias), Base64.NO_WRAP))
            })
        } catch (_: KeyPermanentlyInvalidatedException) {
            invoke.resolve(result(ERROR_INVALID))
        } catch (_: UnrecoverableKeyException) {
            invoke.resolve(result(ERROR_INVALID))
        } catch (_: Exception) {
            invoke.resolve(result(ERROR_INVALID))
        }
    }

    private fun biometricError(code: Int): Int = when (code) {
        BiometricPrompt.ERROR_CANCELED,
        BiometricPrompt.ERROR_NEGATIVE_BUTTON,
        BiometricPrompt.ERROR_USER_CANCELED,
        -> ERROR_CANCELLED
        BiometricPrompt.ERROR_HW_NOT_PRESENT,
        BiometricPrompt.ERROR_HW_UNAVAILABLE,
        BiometricPrompt.ERROR_SECURITY_UPDATE_REQUIRED,
        -> ERROR_UNAVAILABLE
        BiometricPrompt.ERROR_LOCKOUT,
        BiometricPrompt.ERROR_LOCKOUT_PERMANENT,
        BiometricPrompt.ERROR_NO_BIOMETRICS,
        -> ERROR_BIOMETRY_UNAVAILABLE
        else -> ERROR_OTHER - code
    }

    @Command
    fun sign(invoke: Invoke) {
        val args = invoke.parseArgs(SignArgs::class.java)
        val alias = alias(args.blob)
        if (alias == null) {
            invoke.resolve(result(ERROR_INVALID))
            return
        }
        if (!biometricAvailable()) {
            invoke.resolve(result(ERROR_BIOMETRY_UNAVAILABLE))
            return
        }
        val fragmentActivity = activity as? FragmentActivity
        if (fragmentActivity == null) {
            invoke.resolve(result(ERROR_UNAVAILABLE))
            return
        }
        if (!biometricOperation.compareAndSet(false, true)) {
            invoke.resolve(result(ERROR_OTHER))
            return
        }

        try {
            val signature = Signature.getInstance("SHA256withECDSA")
            val private = privateKey(alias)
            if (!isHardwareBacked(private)) {
                biometricOperation.set(false)
                invoke.resolve(result(ERROR_UNAVAILABLE))
                return
            }
            signature.initSign(private)
            val message = Base64.decode(args.message, Base64.DEFAULT)
            val executor = ContextCompat.getMainExecutor(activity)
            val prompt = BiometricPrompt(
                fragmentActivity,
                executor,
                object : BiometricPrompt.AuthenticationCallback() {
                    override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
                        biometricOperation.set(false)
                        invoke.resolve(result(biometricError(errorCode)))
                    }

                    override fun onAuthenticationSucceeded(
                        authenticationResult: BiometricPrompt.AuthenticationResult,
                    ) {
                        val response = try {
                            val authenticated =
                                authenticationResult.cryptoObject?.signature
                                    ?: throw IllegalStateException("missing authenticated signature")
                            authenticated.update(message)
                            val der = authenticated.sign()
                            result {
                                put(
                                    "signature",
                                    Base64.encodeToString(der, Base64.NO_WRAP),
                                )
                            }
                        } catch (_: KeyPermanentlyInvalidatedException) {
                            result(ERROR_INVALID)
                        } catch (_: Exception) {
                            result(ERROR_OTHER)
                        }
                        message.fill(0)
                        biometricOperation.set(false)
                        invoke.resolve(response)
                    }
                },
            )
            activity.runOnUiThread {
                prompt.authenticate(
                    promptInfo(args.reason),
                    BiometricPrompt.CryptoObject(signature),
                )
            }
        } catch (_: KeyPermanentlyInvalidatedException) {
            biometricOperation.set(false)
            invoke.resolve(result(ERROR_INVALID))
        } catch (_: UnrecoverableKeyException) {
            biometricOperation.set(false)
            invoke.resolve(result(ERROR_INVALID))
        } catch (_: Exception) {
            biometricOperation.set(false)
            invoke.resolve(result(ERROR_OTHER))
        }
    }

    @Command
    fun storeHomeItem(invoke: Invoke) {
        val args = invoke.parseArgs(StoreHomeItemArgs::class.java)
        val item = homeItem(args.node, args.suffix)
        val value = decodedValue(args.value)
        if (
            item == null ||
            value == null ||
            value.size > 16_384 ||
            (args.secret && value.size !in 1..4096) ||
            args.secret != (args.suffix == "seed-password")
        ) {
            value?.fill(0)
            invoke.resolve(result(ERROR_INVALID))
            return
        }
        if (!args.secret) {
            val saved = preferences().edit().putString(item, args.value).commit()
            value.fill(0)
            invoke.resolve(result(if (saved) null else ERROR_OTHER))
            return
        }
        if (args.suffix != "seed-password") {
            value.fill(0)
            invoke.resolve(result(ERROR_INVALID))
            return
        }
        val deviceAlias = deviceAlias(args.blob)
        if (deviceAlias == null || !biometricAvailable()) {
            value.fill(0)
            invoke.resolve(
                result(
                    if (deviceAlias == null) ERROR_INVALID else ERROR_BIOMETRY_UNAVAILABLE,
                ),
            )
            return
        }
        val fragmentActivity = activity as? FragmentActivity
        if (fragmentActivity == null) {
            value.fill(0)
            invoke.resolve(result(ERROR_UNAVAILABLE))
            return
        }
        if (!biometricOperation.compareAndSet(false, true)) {
            value.fill(0)
            invoke.resolve(result(ERROR_OTHER))
            return
        }

        try {
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.ENCRYPT_MODE, homeKey(deviceAlias, true))
            cipher.updateAAD(item.toByteArray(Charsets.UTF_8))
            val executor = ContextCompat.getMainExecutor(activity)
            val prompt = BiometricPrompt(
                fragmentActivity,
                executor,
                object : BiometricPrompt.AuthenticationCallback() {
                    override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
                        value.fill(0)
                        biometricOperation.set(false)
                        invoke.resolve(result(biometricError(errorCode)))
                    }

                    override fun onAuthenticationSucceeded(
                        authenticationResult: BiometricPrompt.AuthenticationResult,
                    ) {
                        val response = try {
                            val authenticated =
                                authenticationResult.cryptoObject?.cipher
                                    ?: throw IllegalStateException("missing authenticated cipher")
                            val ciphertext = authenticated.doFinal(value)
                            if (authenticated.iv.size != GCM_IV_BYTES) {
                                ciphertext.fill(0)
                                throw IllegalStateException("invalid Android Keystore GCM IV")
                            }
                            val encoded = ByteArray(1 + GCM_IV_BYTES + ciphertext.size)
                            encoded[0] = HOME_CIPHER_VERSION
                            authenticated.iv.copyInto(encoded, destinationOffset = 1)
                            ciphertext.copyInto(encoded, destinationOffset = 1 + GCM_IV_BYTES)
                            ciphertext.fill(0)
                            val saved = preferences().edit()
                                .putString(item, Base64.encodeToString(encoded, Base64.NO_WRAP))
                                .commit()
                            encoded.fill(0)
                            result(if (saved) null else ERROR_OTHER)
                        } catch (_: KeyPermanentlyInvalidatedException) {
                            result(ERROR_INVALID)
                        } catch (_: Exception) {
                            result(ERROR_OTHER)
                        }
                        value.fill(0)
                        biometricOperation.set(false)
                        invoke.resolve(response)
                    }
                },
            )
            activity.runOnUiThread {
                prompt.authenticate(
                    promptInfo("Protect your BitSov home node password"),
                    BiometricPrompt.CryptoObject(cipher),
                )
            }
        } catch (_: KeyPermanentlyInvalidatedException) {
            value.fill(0)
            biometricOperation.set(false)
            invoke.resolve(result(ERROR_INVALID))
        } catch (_: UnrecoverableKeyException) {
            value.fill(0)
            biometricOperation.set(false)
            invoke.resolve(result(ERROR_INVALID))
        } catch (_: Exception) {
            value.fill(0)
            biometricOperation.set(false)
            invoke.resolve(result(ERROR_OTHER))
        }
    }

    @Command
    fun readHomeItem(invoke: Invoke) {
        val args = invoke.parseArgs(ReadHomeItemArgs::class.java)
        val item = homeItem(args.node, args.suffix)
        if (item == null || args.secret != (args.suffix == "seed-password")) {
            invoke.resolve(result(ERROR_INVALID))
            return
        }
        val stored = preferences().getString(item, null)
        if (stored == null) {
            invoke.resolve(result {
                put("found", false)
            })
            return
        }
        if (stored.length > 32_768) {
            invoke.resolve(result(ERROR_INVALID))
            return
        }
        if (!args.secret) {
            invoke.resolve(result {
                put("found", true)
                put("value", stored)
            })
            return
        }
        if (args.suffix != "seed-password") {
            invoke.resolve(result(ERROR_INVALID))
            return
        }
        val encoded = decodedValue(stored)
        if (
            encoded == null ||
            encoded.size <= 1 + GCM_IV_BYTES + 16 ||
            encoded[0] != HOME_CIPHER_VERSION
        ) {
            encoded?.fill(0)
            invoke.resolve(result(ERROR_INVALID))
            return
        }
        val deviceAlias = deviceAlias(args.blob)
        if (deviceAlias == null || !biometricAvailable()) {
            encoded.fill(0)
            invoke.resolve(
                result(
                    if (deviceAlias == null) ERROR_INVALID else ERROR_BIOMETRY_UNAVAILABLE,
                ),
            )
            return
        }
        val fragmentActivity = activity as? FragmentActivity
        if (fragmentActivity == null) {
            encoded.fill(0)
            invoke.resolve(result(ERROR_UNAVAILABLE))
            return
        }
        if (!biometricOperation.compareAndSet(false, true)) {
            encoded.fill(0)
            invoke.resolve(result(ERROR_OTHER))
            return
        }

        try {
            val iv = encoded.copyOfRange(1, 1 + GCM_IV_BYTES)
            val ciphertext = encoded.copyOfRange(1 + GCM_IV_BYTES, encoded.size)
            encoded.fill(0)
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(
                Cipher.DECRYPT_MODE,
                homeKey(deviceAlias, false),
                GCMParameterSpec(128, iv),
            )
            iv.fill(0)
            cipher.updateAAD(item.toByteArray(Charsets.UTF_8))
            val executor = ContextCompat.getMainExecutor(activity)
            val prompt = BiometricPrompt(
                fragmentActivity,
                executor,
                object : BiometricPrompt.AuthenticationCallback() {
                    override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
                        ciphertext.fill(0)
                        biometricOperation.set(false)
                        invoke.resolve(result(biometricError(errorCode)))
                    }

                    override fun onAuthenticationSucceeded(
                        authenticationResult: BiometricPrompt.AuthenticationResult,
                    ) {
                        val response = try {
                            val authenticated =
                                authenticationResult.cryptoObject?.cipher
                                    ?: throw IllegalStateException("missing authenticated cipher")
                            val plaintext = authenticated.doFinal(ciphertext)
                            val resolved = result {
                                put("found", true)
                                put("value", Base64.encodeToString(plaintext, Base64.NO_WRAP))
                            }
                            plaintext.fill(0)
                            resolved
                        } catch (_: KeyPermanentlyInvalidatedException) {
                            result(ERROR_INVALID)
                        } catch (_: Exception) {
                            result(ERROR_OTHER)
                        }
                        ciphertext.fill(0)
                        biometricOperation.set(false)
                        invoke.resolve(response)
                    }
                },
            )
            activity.runOnUiThread {
                prompt.authenticate(
                    promptInfo("Unlock your BitSov home node"),
                    BiometricPrompt.CryptoObject(cipher),
                )
            }
        } catch (_: KeyPermanentlyInvalidatedException) {
            encoded.fill(0)
            biometricOperation.set(false)
            invoke.resolve(result(ERROR_INVALID))
        } catch (_: UnrecoverableKeyException) {
            encoded.fill(0)
            biometricOperation.set(false)
            invoke.resolve(result(ERROR_INVALID))
        } catch (_: Exception) {
            encoded.fill(0)
            biometricOperation.set(false)
            invoke.resolve(result(ERROR_OTHER))
        }
    }
}
