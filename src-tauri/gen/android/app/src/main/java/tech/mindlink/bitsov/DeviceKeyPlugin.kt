package tech.mindlink.bitsov

import android.app.Activity
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

private const val KEYSTORE = "AndroidKeyStore"
private const val ALIAS_PREFIX = "bitsov-device-v1:"
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

@TauriPlugin
class DeviceKeyPlugin(private val activity: Activity) : Plugin(activity) {
    private val signing = AtomicBoolean(false)
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

    private fun isHardwareBacked(privateKey: PrivateKey): Boolean {
        val keyInfo = KeyFactory.getInstance(privateKey.algorithm, KEYSTORE)
            .getKeySpec(privateKey, KeyInfo::class.java)
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            keyInfo.securityLevel == KeyProperties.SECURITY_LEVEL_STRONGBOX ||
                keyInfo.securityLevel == KeyProperties.SECURITY_LEVEL_TRUSTED_ENVIRONMENT
        } else {
            @Suppress("DEPRECATION")
            keyInfo.isInsideSecureHardware
        }
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
        if (!signing.compareAndSet(false, true)) {
            invoke.resolve(result(ERROR_OTHER))
            return
        }

        try {
            val signature = Signature.getInstance("SHA256withECDSA")
            val private = privateKey(alias)
            if (!isHardwareBacked(private)) {
                signing.set(false)
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
                        signing.set(false)
                        invoke.resolve(result(biometricError(errorCode)))
                    }

                    override fun onAuthenticationSucceeded(
                        authenticationResult: BiometricPrompt.AuthenticationResult,
                    ) {
                        try {
                            val authenticated =
                                authenticationResult.cryptoObject?.signature
                                    ?: throw IllegalStateException("missing authenticated signature")
                            authenticated.update(message)
                            val der = authenticated.sign()
                            invoke.resolve(result {
                                put(
                                    "signature",
                                    Base64.encodeToString(der, Base64.NO_WRAP),
                                )
                            })
                        } catch (_: KeyPermanentlyInvalidatedException) {
                            invoke.resolve(result(ERROR_INVALID))
                        } catch (_: Exception) {
                            invoke.resolve(result(ERROR_OTHER))
                        } finally {
                            signing.set(false)
                        }
                    }
                },
            )
            val promptInfo = BiometricPrompt.PromptInfo.Builder()
                .setTitle("Approve with BitSov")
                .setDescription(args.reason.take(300))
                .setAllowedAuthenticators(BiometricManager.Authenticators.BIOMETRIC_STRONG)
                .setNegativeButtonText("Cancel")
                .build()
            activity.runOnUiThread {
                prompt.authenticate(promptInfo, BiometricPrompt.CryptoObject(signature))
            }
        } catch (_: KeyPermanentlyInvalidatedException) {
            signing.set(false)
            invoke.resolve(result(ERROR_INVALID))
        } catch (_: UnrecoverableKeyException) {
            signing.set(false)
            invoke.resolve(result(ERROR_INVALID))
        } catch (_: Exception) {
            signing.set(false)
            invoke.resolve(result(ERROR_OTHER))
        }
    }
}
