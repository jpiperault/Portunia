package fr.portunia.gate

import android.app.Activity
import android.app.AlertDialog
import android.content.ActivityNotFoundException
import android.content.Intent
import android.content.res.Configuration
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.hardware.biometrics.BiometricManager
import android.hardware.biometrics.BiometricPrompt
import android.net.Uri
import android.net.http.SslError
import android.os.Build
import android.os.Bundle
import android.os.CancellationSignal
import android.provider.Settings
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyPermanentlyInvalidatedException
import android.security.keystore.KeyProperties
import android.security.keystore.StrongBoxUnavailableException
import android.text.InputType
import android.util.Base64
import android.util.TypedValue
import android.view.Gravity
import android.view.KeyEvent
import android.view.View
import android.view.ViewGroup
import android.view.WindowInsets
import android.view.WindowInsetsController
import android.view.WindowManager
import android.view.inputmethod.EditorInfo
import android.webkit.CookieManager
import android.webkit.JavascriptInterface
import android.webkit.PermissionRequest
import android.webkit.SslErrorHandler
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.PrivateKey
import java.security.Signature
import java.security.spec.ECGenParameterSpec
import java.util.Locale
import org.json.JSONObject

/**
 * Portunia Gate pour Android : le portail web d'une Gate dans une application. Les écrans, les
 * règles, le coffre, l'enregistrement et le journal sont ceux du portail ; l'application ajoute
 * l'adresse retenue, le plein écran, l'écran gardé allumé pendant une session, le choix de
 * fichiers et les liens vers d'autres sites ouverts dans le navigateur.
 * L'adresse peut venir d'un lien portunia-gate://gate.exemple.fr.
 *
 * Téléphone enrôlé (Gate 0.47, Android 11 et plus) : après une connexion par mot de passe et
 * code, l'application propose de créer une clé P-256 dans le Keystore, utilisable seulement
 * après l'empreinte ; la Gate en garde la clé publique. Ensuite, l'empreinte suffit : la Gate
 * envoie un défi, la clé le signe, la Gate ouvre la session du portail.
 */
class MainActivity : Activity() {
    private lateinit var frame: FrameLayout
    private var web: WebView? = null
    private var overlay: View? = null
    private var custom: View? = null
    private var customCallback: WebChromeClient.CustomViewCallback? = null
    private var files: ValueCallback<Array<Uri>>? = null

    private val prefs by lazy { getSharedPreferences("gate", MODE_PRIVATE) }
    private val fr get() = Locale.getDefault().language == "fr"
    private fun t(en: String, fr: String) = if (this.fr) fr else en

    private val dark get() = (resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES
    // Couleurs du portail (app.css).
    private val bg get() = if (dark) Color.rgb(15, 17, 21) else Color.rgb(238, 241, 245)
    private val fg get() = if (dark) Color.rgb(233, 235, 239) else Color.rgb(27, 31, 39)
    private val muted get() = if (dark) Color.rgb(154, 161, 173) else Color.rgb(94, 102, 117)
    private val field get() = if (dark) Color.rgb(23, 26, 32) else Color.WHITE
    private val line get() = if (dark) Color.rgb(38, 42, 51) else Color.rgb(221, 225, 232)
    private val accent get() = if (dark) Color.rgb(106, 165, 255) else Color.rgb(37, 99, 214)
    private val accentInk get() = if (dark) Color.rgb(14, 26, 46) else Color.WHITE
    private val danger get() = if (dark) Color.rgb(255, 123, 123) else Color.rgb(194, 59, 59)

    private val base: String? get() = prefs.getString("adresse", null)
    /** Agent utilisateur de la WebView, repris par les requêtes de l'application. */
    private var userAgent = "PortuniaGate/${BuildConfig.VERSION_NAME}"
    private var offered = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        frame = FrameLayout(this)
        setContentView(frame)
        edgeToEdge()
        colors()
        val link = intent?.data?.let { address(it.toString()) }
        if (link != null) prefs.edit().putString("adresse", link).apply()
        val b = base
        if (b == null) setup() else portal(b)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        val link = intent.data?.let { address(it.toString()) } ?: return
        if (link == base) return
        AlertDialog.Builder(this)
            .setTitle(t("Open this Gate?", "Ouvrir cette Gate ?"))
            .setMessage(link)
            .setPositiveButton(t("Open", "Ouvrir")) { _, _ -> use(link) }
            .setNegativeButton(t("Cancel", "Annuler"), null)
            .show()
    }

    override fun onConfigurationChanged(newConfig: Configuration) {
        super.onConfigurationChanged(newConfig)
        colors()
        if (web == null && overlay != null) setup()
    }

    override fun onPause() {
        CookieManager.getInstance().flush()
        super.onPause()
    }

    override fun onDestroy() {
        web?.destroy()
        super.onDestroy()
    }

    // ---------- Fenêtre ----------

    /** Bord à bord : marges des barres système et du clavier appliquées au contenu. */
    private fun edgeToEdge() {
        if (Build.VERSION.SDK_INT >= 30) {
            window.setDecorFitsSystemWindows(false)
            frame.setOnApplyWindowInsetsListener { v, insets ->
                val bars = insets.getInsets(WindowInsets.Type.systemBars() or WindowInsets.Type.displayCutout())
                val ime = insets.getInsets(WindowInsets.Type.ime())
                if (custom == null) v.setPadding(bars.left, bars.top, bars.right, maxOf(bars.bottom, ime.bottom))
                else v.setPadding(0, 0, 0, 0)
                WindowInsets.CONSUMED
            }
        } else {
            @Suppress("DEPRECATION")
            window.decorView.systemUiVisibility = View.SYSTEM_UI_FLAG_LAYOUT_STABLE or View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN or View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
            frame.setOnApplyWindowInsetsListener { v, insets ->
                @Suppress("DEPRECATION")
                if (custom == null) v.setPadding(insets.systemWindowInsetLeft, insets.systemWindowInsetTop, insets.systemWindowInsetRight, insets.systemWindowInsetBottom)
                else v.setPadding(0, 0, 0, 0)
                @Suppress("DEPRECATION")
                insets.consumeSystemWindowInsets()
            }
        }
    }

    private fun colors() {
        frame.setBackgroundColor(bg)
        @Suppress("DEPRECATION")
        window.statusBarColor = Color.TRANSPARENT
        @Suppress("DEPRECATION")
        window.navigationBarColor = Color.TRANSPARENT
        if (Build.VERSION.SDK_INT >= 30) {
            val light = WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS or WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS
            window.insetsController?.setSystemBarsAppearance(if (dark) 0 else light, light)
        }
    }

    private fun dp(v: Int) = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v.toFloat(), resources.displayMetrics).toInt()

    private fun text(s: String, size: Float = 15f, color: Int = fg, bold: Boolean = false) = TextView(this).apply {
        text = s
        textSize = size
        setTextColor(color)
        if (bold) typeface = Typeface.DEFAULT_BOLD
        setPadding(0, dp(4), 0, dp(4))
    }

    private fun button(label: String, filled: Boolean = true, action: () -> Unit) = Button(this).apply {
        text = label
        isAllCaps = false
        textSize = 15f
        setTextColor(if (filled) accentInk else accent)
        background = GradientDrawable().apply {
            cornerRadius = dp(10).toFloat()
            if (filled) setColor(accent) else setStroke(dp(1), line)
        }
        stateListAnimator = null
        setOnClickListener { action() }
    }

    private fun gap(h: Int) = View(this).apply { layoutParams = LinearLayout.LayoutParams(1, dp(h)) }

    /** Écran centré, défilant (formulaire d'adresse, erreur). */
    private fun page(vararg views: View): View {
        val col = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(24), dp(36), dp(24), dp(24))
            for (v in views) {
                if (v is Button) addView(v, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(50)).apply { topMargin = dp(10) })
                else addView(v)
            }
        }
        val box = FrameLayout(this).apply {
            addView(col, FrameLayout.LayoutParams(minOf(dp(420), resources.displayMetrics.widthPixels), ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.CENTER_HORIZONTAL))
        }
        return ScrollView(this).apply {
            setBackgroundColor(bg)
            isFillViewport = true
            addView(box)
        }
    }

    private fun logo() = ImageView(this).apply {
        setImageResource(R.mipmap.ic_launcher)
        layoutParams = LinearLayout.LayoutParams(dp(72), dp(72)).apply { gravity = Gravity.CENTER_HORIZONTAL; bottomMargin = dp(8) }
    }

    private fun show(v: View) {
        overlay?.let { frame.removeView(it) }
        overlay = v
        frame.addView(v, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
    }

    private fun hideOverlay() {
        overlay?.let { frame.removeView(it) }
        overlay = null
    }

    // ---------- Adresse de la Gate ----------

    /** « gate.exemple.fr », « https://gate.exemple.fr:8443/… » ou « portunia-gate://… » → https://hôte[:port]. */
    private fun address(input: String): String? {
        var s = input.trim()
        if (s.isEmpty()) return null
        s = s.replaceFirst(Regex("^portunia-gate://", RegexOption.IGNORE_CASE), "https://")
        if (!s.contains("://")) s = "https://$s"
        val u = Uri.parse(s)
        if (!u.scheme.equals("https", true)) return null
        val host = u.host?.lowercase()?.takeIf { it.isNotEmpty() && !it.contains(' ') } ?: return null
        return if (u.port > 0 && u.port != 443) "https://$host:${u.port}" else "https://$host"
    }

    private fun use(addr: String) {
        prefs.edit().putString("adresse", addr).apply()
        web?.let { frame.removeView(it); it.destroy() }
        web = null
        portal(addr)
    }

    private fun setup() {
        web?.let { frame.removeView(it); it.destroy() }
        web = null
        val input = EditText(this).apply {
            setText(base?.removePrefix("https://") ?: "")
            hint = "gate.exemple.fr"
            setSingleLine()
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI
            imeOptions = EditorInfo.IME_ACTION_GO
            textSize = 16f
            setTextColor(fg)
            setHintTextColor(muted)
            background = GradientDrawable().apply { cornerRadius = dp(10).toFloat(); setColor(field); setStroke(dp(1), line) }
            setPadding(dp(14), dp(12), dp(14), dp(12))
        }
        val error = text("", 13.5f, danger).apply { visibility = View.GONE }
        val go = {
            val addr = address(input.text.toString())
            if (addr == null) {
                error.text = t("Give the address of the portal, for example gate.example.com (HTTPS only).", "Indiquez l'adresse du portail, par exemple gate.exemple.fr (HTTPS seulement).")
                error.visibility = View.VISIBLE
            } else use(addr)
        }
        input.setOnEditorActionListener { _, id, ev ->
            if (id == EditorInfo.IME_ACTION_GO || ev?.keyCode == KeyEvent.KEYCODE_ENTER) { go(); true } else false
        }
        show(page(
            logo(),
            text("Portunia Gate", 22f, fg, true).apply { gravity = Gravity.CENTER_HORIZONTAL },
            text(t("Access to your servers through the web portal of your Gate.", "Accès à vos serveurs par le portail web de votre Gate."), 14.5f, muted).apply { gravity = Gravity.CENTER_HORIZONTAL },
            gap(18),
            text(t("Portal address", "Adresse du portail"), 13f, muted),
            input,
            error,
            button(t("Open", "Ouvrir"), action = go),
            gap(10),
            text(t(
                "Given by your administrator. You sign in as in a browser: same account, same code, same rules; the Gate records and logs sessions in the same way.",
                "Donnée par votre administrateur. La connexion est celle du navigateur : même compte, même code, mêmes règles ; la Gate enregistre et note les sessions de la même façon."), 12.5f, muted),
        ))
        input.requestFocus()
    }

    private fun failure(message: String) {
        val addr = base ?: return setup()
        web?.visibility = View.INVISIBLE
        show(page(
            logo(),
            text(t("Cannot reach the Gate", "Gate injoignable"), 20f, fg, true).apply { gravity = Gravity.CENTER_HORIZONTAL },
            text(addr.removePrefix("https://"), 14f, muted).apply { gravity = Gravity.CENTER_HORIZONTAL },
            gap(10),
            text(message, 14f, danger),
            button(t("Try again", "Réessayer")) {
                hideOverlay()
                web?.visibility = View.VISIBLE
                web?.loadUrl("$addr/?accueil") ?: portal(addr)
            },
            button(t("Change the address", "Changer d'adresse"), filled = false) { setup() },
        ))
    }

    // ---------- Portail ----------

    private fun sameGate(u: Uri): Boolean {
        val b = Uri.parse(base ?: return false)
        val port = if (u.port > 0) u.port else 443
        val bport = if (b.port > 0) b.port else 443
        return u.scheme.equals("https", true) && u.host.equals(b.host, true) && port == bport
    }

    private fun external(u: Uri) {
        try {
            startActivity(Intent(Intent.ACTION_VIEW, u).addCategory(Intent.CATEGORY_BROWSABLE))
        } catch (_: ActivityNotFoundException) {
            Toast.makeText(this, t("No application can open this link.", "Aucune application ne peut ouvrir ce lien."), Toast.LENGTH_SHORT).show()
        }
    }

    /** Écran gardé allumé pendant un terminal, un Bureau à distance ou une interface web. */
    private fun keepAwake(url: String?) {
        val path = url?.let { Uri.parse(it).path } ?: ""
        if (path.startsWith("/session/") || path.startsWith("/bureau/") || path.startsWith("/web/")) window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        else window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
    }

    private fun portal(addr: String) {
        hideOverlay()
        val w = web ?: WebView(this).also { w ->
            web = w
            w.setBackgroundColor(bg)
            frame.addView(w, 0, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
            WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)
            w.settings.apply {
                javaScriptEnabled = true
                domStorageEnabled = true
                mediaPlaybackRequiresUserGesture = false
                allowFileAccess = false
                allowContentAccess = false
                textZoom = 100
                // Le portail reconnaît l'application (barre de touches, gestes).
                userAgentString = "$userAgentString PortuniaGate/${BuildConfig.VERSION_NAME}"
            }
            CookieManager.getInstance().apply {
                setAcceptCookie(true)
                // Turnstile (anti-robot de Cloudflare) vit dans un cadre d'un autre site.
                setAcceptThirdPartyCookies(w, true)
            }
            userAgent = w.settings.userAgentString
            w.addJavascriptInterface(Bridge(), "PortuniaGateApp")
            w.webViewClient = object : WebViewClient() {
                override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                    if (!request.isForMainFrame || sameGate(request.url)) return false
                    // Autre site (lien, connexion unique d'une interface web…) : le navigateur.
                    external(request.url)
                    return true
                }

                override fun doUpdateVisitedHistory(view: WebView, url: String?, isReload: Boolean) = keepAwake(url)

                override fun onPageFinished(view: WebView, url: String?) {
                    keepAwake(url)
                    CookieManager.getInstance().flush()
                    // Connexion par empreinte refusée : téléphone retiré, expiré ou compte changé.
                    if (url?.contains("appareil=refuse") == true && deviceId() != null) {
                        forget()
                        Toast.makeText(this@MainActivity, t("This phone is no longer enrolled: sign in with your password and code.", "Ce téléphone n'est plus enrôlé : connectez-vous avec mot de passe et code."), Toast.LENGTH_LONG).show()
                    }
                }

                override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
                    if (request.isForMainFrame) failure(error.description?.toString() ?: t("Network error", "Erreur réseau"))
                }

                override fun onReceivedSslError(view: WebView, handler: SslErrorHandler, error: SslError) {
                    handler.cancel()
                    if (sameGate(Uri.parse(error.url))) failure(t(
                        "The certificate of the Gate is not valid for this address. Check the address, or ask your administrator.",
                        "Le certificat de la Gate n'est pas valable pour cette adresse. Vérifiez l'adresse, ou adressez-vous à votre administrateur."))
                }
            }
            w.webChromeClient = object : WebChromeClient() {
                override fun onShowCustomView(view: View, callback: CustomViewCallback) {
                    custom?.let { onHideCustomView() }
                    custom = view
                    customCallback = callback
                    frame.addView(view, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
                    bars(false)
                }

                override fun onHideCustomView() {
                    custom?.let { frame.removeView(it) }
                    custom = null
                    customCallback?.onCustomViewHidden()
                    customCallback = null
                    bars(true)
                }

                override fun onShowFileChooser(view: WebView, callback: ValueCallback<Array<Uri>>, params: FileChooserParams): Boolean {
                    files?.onReceiveValue(null)
                    files = callback
                    val pick = params.createIntent().apply {
                        if (params.mode == FileChooserParams.MODE_OPEN_MULTIPLE) putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
                    }
                    return try {
                        startActivityForResult(pick, FILES)
                        true
                    } catch (_: ActivityNotFoundException) {
                        files = null
                        false
                    }
                }

                // Caméra, micro, position : jamais pour le portail.
                override fun onPermissionRequest(request: PermissionRequest) = request.deny()
            }
            w.setDownloadListener { url, _, _, _, _ ->
                val u = Uri.parse(url)
                if (u.scheme == "blob" || u.scheme == "data") {
                    Toast.makeText(this, t("This download is not available in the app yet: use a browser.", "Ce téléchargement n'est pas encore possible dans l'application : utilisez un navigateur."), Toast.LENGTH_LONG).show()
                } else external(u)
            }
        }
        w.visibility = View.VISIBLE
        if (deviceId() != null && hasKey()) locked() else w.loadUrl("$addr/?accueil")
    }

    // ---------- Empreinte : téléphone enrôlé ----------

    private inner class Bridge {
        /** Connexion par mot de passe et code réussie dans le portail. */
        @JavascriptInterface
        fun connecte() {
            runOnUiThread { try { offer() } catch (_: Exception) {} }
        }
    }

    private val alias get() = "gate:${base ?: ""}"
    private fun deviceId(): String? = prefs.getString("appareil:${base ?: ""}", null)
    private fun keyStore() = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
    private fun hasKey() = try { keyStore().containsAlias(alias) } catch (_: Exception) { false }

    private fun biometricReady(): Boolean = try {
        Build.VERSION.SDK_INT >= 30 && getSystemService(BiometricManager::class.java)
            ?.canAuthenticate(BiometricManager.Authenticators.BIOMETRIC_STRONG) == BiometricManager.BIOMETRIC_SUCCESS
    } catch (_: Exception) {
        false
    }

    /** Oublie l'enrôlement sur ce téléphone (clé et identifiant). */
    private fun forget() {
        try { keyStore().deleteEntry(alias) } catch (_: Exception) {}
        prefs.edit().remove("appareil:${base ?: ""}").apply()
    }

    /** Requête de l'application vers le portail, avec les cookies de la WebView. Hors du fil principal. */
    private fun http(method: String, path: String, body: JSONObject? = null): Pair<Int, JSONObject> {
        val c = URL((base ?: "") + path).openConnection() as HttpURLConnection
        c.requestMethod = method
        c.connectTimeout = 10_000
        c.readTimeout = 20_000
        c.instanceFollowRedirects = false
        CookieManager.getInstance().getCookie(base)?.let { c.setRequestProperty("Cookie", it) }
        c.setRequestProperty("X-Portunia-Gate", "portail")
        c.setRequestProperty("User-Agent", userAgent)
        if (body != null) {
            c.doOutput = true
            c.setRequestProperty("Content-Type", "application/json")
            c.outputStream.use { it.write(body.toString().toByteArray()) }
        }
        val code = c.responseCode
        val text = (if (code < 400) c.inputStream else c.errorStream)?.bufferedReader()?.use { it.readText() } ?: ""
        return code to (try { JSONObject(text) } catch (_: Exception) { JSONObject() })
    }

    private fun background(work: () -> Unit) = Thread {
        try { work() } catch (e: Exception) {
            runOnUiThread { Toast.makeText(this, e.message ?: t("Network error", "Erreur réseau"), Toast.LENGTH_LONG).show() }
        }
    }.start()

    /** Demande l'empreinte, puis signe avec la clé du téléphone. */
    private fun withFingerprint(title: String, data: ByteArray, done: (ByteArray) -> Unit, cancelled: () -> Unit) {
        if (Build.VERSION.SDK_INT < 30) return cancelled()
        val sig = try {
            Signature.getInstance("SHA256withECDSA").apply { initSign(keyStore().getKey(alias, null) as PrivateKey) }
        } catch (_: KeyPermanentlyInvalidatedException) {
            // Empreinte ajoutée ou retirée sur le téléphone : la clé n'est plus utilisable.
            forget()
            Toast.makeText(this, t("The fingerprints of this phone changed: enrol it again after signing in.", "Les empreintes du téléphone ont changé : enrôlez-le de nouveau après la connexion."), Toast.LENGTH_LONG).show()
            return cancelled()
        } catch (_: Exception) {
            forget()
            return cancelled()
        }
        val prompt = BiometricPrompt.Builder(this)
            .setTitle(title)
            .setSubtitle(base?.removePrefix("https://") ?: "")
            .setAllowedAuthenticators(BiometricManager.Authenticators.BIOMETRIC_STRONG)
            .setNegativeButton(t("Cancel", "Annuler"), mainExecutor) { _, _ -> cancelled() }
            .build()
        prompt.authenticate(BiometricPrompt.CryptoObject(sig), CancellationSignal(), mainExecutor, object : BiometricPrompt.AuthenticationCallback() {
            override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                val s = result.cryptoObject?.signature ?: return cancelled()
                s.update(data)
                done(s.sign())
            }

            override fun onAuthenticationError(code: Int, message: CharSequence?) {
                if (code != BiometricPrompt.BIOMETRIC_ERROR_USER_CANCELED && code != BiometricPrompt.BIOMETRIC_ERROR_CANCELED) {
                    Toast.makeText(this@MainActivity, message ?: "", Toast.LENGTH_SHORT).show()
                }
                cancelled()
            }
        })
    }

    /** Après une connexion par mot de passe et code : proposer l'empreinte pour la suite. */
    private fun offer() {
        if (offered || deviceId() != null || !biometricReady() || prefs.getBoolean("jamais:${base ?: ""}", false)) return
        offered = true
        AlertDialog.Builder(this)
            .setTitle(t("Sign in with your fingerprint?", "Se connecter avec l'empreinte ?"))
            .setMessage(t(
                "Next time, your fingerprint will be enough to open the portal on this phone. A key is created in the phone's secure chip; the Gate keeps only its public part and you can remove it at any time.",
                "La prochaine fois, votre empreinte suffira pour ouvrir le portail sur ce téléphone. Une clé est créée dans la puce sécurisée du téléphone ; la Gate n'en garde que la partie publique et vous pouvez la retirer à tout moment."))
            .setPositiveButton(t("Enable", "Activer")) { _, _ -> enrol() }
            .setNegativeButton(t("Later", "Plus tard"), null)
            .setNeutralButton(t("Never on this phone", "Jamais sur ce téléphone")) { _, _ -> prefs.edit().putBoolean("jamais:${base ?: ""}", true).apply() }
            .show()
    }

    private fun enrol() {
        if (Build.VERSION.SDK_INT < 30) return
        forget()
        val pub = try {
            fun spec(strongBox: Boolean) = KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_SIGN)
                .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
                .setDigests(KeyProperties.DIGEST_SHA256)
                .setUserAuthenticationRequired(true)
                .setUserAuthenticationParameters(0, KeyProperties.AUTH_BIOMETRIC_STRONG)
                .setInvalidatedByBiometricEnrollment(true)
                .setIsStrongBoxBacked(strongBox)
                .build()
            val gen = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, "AndroidKeyStore")
            try { gen.initialize(spec(true)); gen.generateKeyPair() } catch (_: StrongBoxUnavailableException) { gen.initialize(spec(false)); gen.generateKeyPair() }
            keyStore().getCertificate(alias).publicKey.encoded
        } catch (e: Exception) {
            forget()
            Toast.makeText(this, e.message ?: "", Toast.LENGTH_LONG).show()
            return
        }
        // L'empreinte confirme que la clé est utilisable avant de la donner à la Gate.
        withFingerprint(t("Enable fingerprint sign-in", "Activer la connexion par empreinte"), "enrolement".toByteArray(), {
            val name = Settings.Global.getString(contentResolver, Settings.Global.DEVICE_NAME)?.takeIf { it.isNotBlank() } ?: "${Build.MANUFACTURER} ${Build.MODEL}"
            background {
                val (code, r) = http("POST", "/api/appareils", JSONObject().put("nom", name).put("cle", Base64.encodeToString(pub, Base64.NO_WRAP)))
                runOnUiThread {
                    if (code == 200 && r.optString("id").isNotEmpty()) {
                        prefs.edit().putString("appareil:${base ?: ""}", r.getString("id")).apply()
                        Toast.makeText(this, t("Fingerprint sign-in enabled on this phone", "Connexion par empreinte activée sur ce téléphone"), Toast.LENGTH_LONG).show()
                    } else {
                        forget()
                        AlertDialog.Builder(this).setTitle(t("Not enabled", "Pas activée")).setMessage(r.optString("erreur", "HTTP $code")).setPositiveButton("OK", null).show()
                    }
                }
            }
        }, { forget() })
    }

    /** Écran de déverrouillage : empreinte, ou connexion habituelle. */
    private fun locked() {
        show(page(
            logo(),
            text("Portunia Gate", 22f, fg, true).apply { gravity = Gravity.CENTER_HORIZONTAL },
            text(base?.removePrefix("https://") ?: "", 14f, muted).apply { gravity = Gravity.CENTER_HORIZONTAL },
            gap(16),
            button(t("Unlock with fingerprint", "Déverrouiller avec l'empreinte")) { unlock() },
            button(t("Sign in with password and code", "Se connecter avec mot de passe et code"), filled = false) {
                hideOverlay()
                web?.loadUrl("${base}/?accueil")
            },
        ))
        unlock()
    }

    private fun unlock() {
        val id = deviceId() ?: return
        background {
            val (code, r) = http("POST", "/api/appareil/defi", JSONObject().put("appareil", id))
            val challenge = r.optString("defi")
            runOnUiThread {
                if (code != 200 || challenge.isEmpty()) {
                    Toast.makeText(this, r.optString("erreur", t("Cannot reach the Gate", "Gate injoignable")), Toast.LENGTH_LONG).show()
                    return@runOnUiThread
                }
                withFingerprint(t("Sign in to the portal", "Connexion au portail"), "portunia-gate-appareil:$id:$challenge".toByteArray(), { sig ->
                    hideOverlay()
                    val form = "appareil=$id&defi=${URLEncoder.encode(challenge, "UTF-8")}&signature=${URLEncoder.encode(Base64.encodeToString(sig, Base64.NO_WRAP), "UTF-8")}"
                    web?.postUrl("${base}/api/appareil/connexion", form.toByteArray())
                }, {
                    // Plus de clé (empreintes changées) : connexion habituelle.
                    if (deviceId() == null) { hideOverlay(); web?.loadUrl("${base}/?accueil") }
                })
            }
        }
    }

    /** Retire ce téléphone de la Gate (session du portail ouverte) et oublie la clé. */
    private fun disableFingerprint() {
        val id = deviceId() ?: return
        background {
            val (code, _) = http("DELETE", "/api/appareils/$id")
            runOnUiThread {
                forget()
                Toast.makeText(this, if (code == 200) t("Fingerprint sign-in disabled", "Connexion par empreinte désactivée") else t("Disabled on this phone; the Gate will drop it after 90 days", "Désactivée sur ce téléphone ; la Gate l'oubliera après 90 jours"), Toast.LENGTH_LONG).show()
                web?.loadUrl("${base}/?accueil")
            }
        }
    }

    /** Barres système affichées ou masquées (plein écran du terminal ou du Bureau à distance). */
    private fun bars(visible: Boolean) {
        if (Build.VERSION.SDK_INT >= 30) {
            window.insetsController?.let {
                if (visible) it.show(WindowInsets.Type.systemBars())
                else {
                    it.systemBarsBehavior = WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
                    it.hide(WindowInsets.Type.systemBars())
                }
            }
        } else {
            @Suppress("DEPRECATION")
            window.decorView.systemUiVisibility = View.SYSTEM_UI_FLAG_LAYOUT_STABLE or View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN or View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION or
                (if (visible) 0 else View.SYSTEM_UI_FLAG_FULLSCREEN or View.SYSTEM_UI_FLAG_HIDE_NAVIGATION or View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY)
        }
        frame.requestApplyInsets()
    }

    @Deprecated("Fichiers choisis pour le portail")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        if (requestCode != FILES) return super.onActivityResult(requestCode, resultCode, data)
        val clip = data?.clipData
        val result = if (resultCode == RESULT_OK && clip != null && clip.itemCount > 0) Array(clip.itemCount) { clip.getItemAt(it).uri }
        else WebChromeClient.FileChooserParams.parseResult(resultCode, data)
        files?.onReceiveValue(result)
        files = null
    }

    @Deprecated("Retour : plein écran, page précédente, puis choix de la Gate ou sortie")
    override fun onBackPressed() {
        val w = web
        when {
            custom != null -> (w?.webChromeClient as? WebChromeClient)?.onHideCustomView()
            overlay != null && base != null && w != null && w.visibility == View.VISIBLE -> hideOverlay()
            w != null && overlay == null && w.canGoBack() -> w.goBack()
            w != null && overlay == null -> {
                val items = mutableListOf(t("Quit", "Quitter") to { finish() }, t("Change the address", "Changer d'adresse") to { setup() })
                if (deviceId() != null) items.add(t("Disable fingerprint sign-in", "Désactiver la connexion par empreinte") to { disableFingerprint() })
                else if (biometricReady()) items.add(t("Enable fingerprint sign-in (after signing in)", "Activer la connexion par empreinte (après connexion)") to {
                    prefs.edit().remove("jamais:${base ?: ""}").apply()
                    offered = false
                    Toast.makeText(this, t("Sign in with your password and code: the app will offer it.", "Connectez-vous avec mot de passe et code : l'application le proposera."), Toast.LENGTH_LONG).show()
                })
                AlertDialog.Builder(this)
                    .setTitle(base?.removePrefix("https://") ?: "Portunia Gate")
                    .setItems(items.map { it.first }.toTypedArray()) { _, i -> items[i].second() }
                    .setNegativeButton(t("Cancel", "Annuler"), null)
                    .show()
            }
            else -> @Suppress("DEPRECATION") super.onBackPressed()
        }
    }

    companion object {
        private const val FILES = 1
    }
}
