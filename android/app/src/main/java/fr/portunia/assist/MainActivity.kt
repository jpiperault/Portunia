package fr.portunia.assist

import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.media.projection.MediaProjectionManager
import android.os.Build
import android.os.Bundle
import android.text.InputType
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.inputmethod.EditorInfo
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView

/**
 * Écran de la personne aidée : adresse du serveur, code à dicter, accord, session en cours.
 * L'adresse peut aussi venir d'un lien portunia-assist://acces.exemple.fr.
 */
class MainActivity : Activity() {
    private lateinit var root: LinearLayout
    private val follow: (State) -> Unit = { render(it) }
    private val dark get() = (resources.configuration.uiMode and android.content.res.Configuration.UI_MODE_NIGHT_MASK) == android.content.res.Configuration.UI_MODE_NIGHT_YES
    private val fg get() = if (dark) Color.rgb(230, 234, 240) else Color.rgb(24, 28, 36)
    private val muted get() = if (dark) Color.rgb(150, 160, 175) else Color.rgb(95, 105, 120)
    private val accent = Color.rgb(47, 111, 235)
    private val danger = Color.rgb(205, 55, 55)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.decorView.setBackgroundColor(if (dark) Color.rgb(18, 21, 27) else Color.rgb(246, 247, 250))
        root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(24), dp(40), dp(24), dp(24))
        }
        setContentView(ScrollView(this).apply { addView(root) })
        intent?.data?.let { remember(it.host ?: it.toString()) }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        intent.data?.let { remember(it.host ?: it.toString()) }
        render(Session.state)
    }

    override fun onStart() {
        super.onStart()
        Session.watch(follow)
    }

    override fun onStop() {
        Session.unwatch(follow)
        super.onStop()
    }

    private fun dp(v: Int) = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v.toFloat(), resources.displayMetrics).toInt()

    private fun text(s: String, size: Float = 16f, color: Int = fg, bold: Boolean = false) = TextView(this).apply {
        text = s
        textSize = size
        setTextColor(color)
        if (bold) typeface = Typeface.DEFAULT_BOLD
        setPadding(0, dp(6), 0, dp(6))
    }

    private fun button(label: String, color: Int = accent, filled: Boolean = true, action: () -> Unit) = Button(this).apply {
        text = label
        isAllCaps = false
        textSize = 16f
        setTextColor(if (filled) Color.WHITE else color)
        background = GradientDrawable().apply {
            cornerRadius = dp(10).toFloat()
            if (filled) setColor(color) else setStroke(dp(1), color)
        }
        layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(52)).apply { topMargin = dp(12) }
        setOnClickListener { action() }
    }

    private fun header() {
        root.addView(text("Portunia Assistance", 24f, bold = true))
    }

    private fun prefs() = getSharedPreferences("assistance", MODE_PRIVATE)

    private fun remember(server: String) {
        val host = hostOf(server)
        if (host.isNotEmpty()) prefs().edit().putString("serveur", host).apply()
    }

    /** « acces.exemple.fr », « https://acces.exemple.fr/assistance » → acces.exemple.fr */
    private fun hostOf(input: String): String {
        val rest = input.trim().substringAfter("://")
        return rest.substringBefore('/').substringBefore('?').substringBefore('#').substringAfterLast('@').lowercase()
    }

    private fun render(state: State) {
        root.removeAllViews()
        header()
        when (state) {
            is State.Idle -> idle()
            is State.Connecting -> {
                root.addView(text(t("Connecting…", "Connexion…"), color = muted))
                root.addView(button(t("Cancel", "Annuler"), filled = false) { cancel() })
            }
            is State.Code -> {
                root.addView(text(t("Read this code to the person helping you:", "Dictez ce code à la personne qui vous aide :"), color = muted))
                root.addView(text(state.code, 40f, bold = true).apply {
                    gravity = Gravity.CENTER
                    letterSpacing = 0.08f
                    setPadding(0, dp(24), 0, dp(24))
                })
                root.addView(text(t("Nobody can see your screen until you allow it.", "Personne ne voit votre écran sans votre accord."), 14f, muted))
                root.addView(button(t("Cancel", "Annuler"), filled = false) { cancel() })
            }
            is State.Asking -> asking(state.who)
            is State.Connected -> {
                root.addView(text(t("${state.who.lineSequence().first()} sees your screen.", "${state.who.lineSequence().first()} voit votre écran."), 18f, bold = true))
                root.addView(text(t(
                    "They can only look: they cannot touch or type. You can leave this app, the sharing continues until you stop it.",
                    "Cette personne peut seulement regarder : elle ne peut ni toucher ni écrire. Vous pouvez quitter l'appli, le partage continue jusqu'à ce que vous l'arrêtiez.",
                ), color = muted))
                root.addView(button(t("Stop sharing", "Arrêter le partage"), danger) { Native.stop() })
            }
            is State.Ended -> {
                root.addView(text(state.reason, 18f))
                root.addView(button(t("Back", "Retour")) { Session.set(State.Idle) })
            }
        }
    }

    private fun idle() {
        root.addView(text(t(
            "Let someone you trust see your screen to help you. You will be asked before anything is shown.",
            "Laissez une personne de confiance voir votre écran pour vous aider. Votre accord sera demandé avant tout partage.",
        ), color = muted))
        root.addView(text(t("Server address (given by the person helping you)", "Adresse du serveur (donnée par la personne qui vous aide)"), 14f, muted).apply { setPadding(0, dp(18), 0, dp(4)) })
        val field = EditText(this).apply {
            hint = "acces.exemple.fr"
            setText(prefs().getString("serveur", ""))
            setTextColor(fg)
            setHintTextColor(muted)
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI
            imeOptions = EditorInfo.IME_ACTION_GO
            isSingleLine = true
        }
        root.addView(field)
        val error = text("", 14f, danger).apply { visibility = View.GONE }
        val go = {
            val host = hostOf(field.text.toString())
            if (host.isEmpty() || !host.contains('.') && !host.contains(':')) {
                error.text = t("Enter the address given by the person helping you.", "Saisissez l'adresse donnée par la personne qui vous aide.")
                error.visibility = View.VISIBLE
            } else {
                remember(host)
                start(host)
            }
        }
        field.setOnEditorActionListener { _, id, _ -> if (id == EditorInfo.IME_ACTION_GO) { go(); true } else false }
        root.addView(error)
        root.addView(button(t("Get a code", "Obtenir un code")) { go() })
    }

    private fun asking(who: String) {
        val lines = who.lines()
        root.addView(text(t("Someone wants to see your screen", "Quelqu'un veut voir votre écran"), 18f, bold = true))
        root.addView(text(lines.first(), 20f, accent, bold = true))
        if (lines.size > 1) root.addView(text(lines.drop(1).joinToString("\n").trim(), 14f, muted))
        root.addView(text(t(
            "Only accept if you asked this person for help. Microsoft, Google, your bank or the police will never ask you this.",
            "N'acceptez que si vous avez demandé de l'aide à cette personne. Ni Microsoft, ni Google, ni votre banque, ni la police ne vous le demanderont jamais.",
        ), 14f, danger).apply { setPadding(0, dp(14), 0, dp(6)) })
        root.addView(text(t(
            "They will only see your screen: they cannot touch or type. Android will then ask you to confirm the sharing.",
            "Cette personne verra seulement votre écran : elle ne pourra ni toucher ni écrire. Android vous demandera ensuite de confirmer le partage.",
        ), 14f, muted))
        root.addView(button(t("Show my screen", "Montrer mon écran")) { askCapture() })
        root.addView(button(t("Decline", "Refuser"), danger, filled = false) { Native.answer(-1) })
    }

    private fun start(host: String) {
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(arrayOf(android.Manifest.permission.POST_NOTIFICATIONS), 2)
        }
        Session.set(State.Connecting)
        Native.start("wss://$host/assistance/relais", resources.configuration.locales[0].language == "fr")
    }

    private fun cancel() {
        Native.stop()
        Session.set(State.Idle)
    }

    @Suppress("DEPRECATION")
    private fun askCapture() {
        val manager = getSystemService(MediaProjectionManager::class.java)
        startActivityForResult(manager.createScreenCaptureIntent(), CAPTURE)
    }

    @Deprecated("startActivityForResult suffit ici, sans bibliothèque AndroidX")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode != CAPTURE) return
        if (resultCode != RESULT_OK || data == null) {
            Native.answer(-1)
            return
        }
        val service = Intent(this, CaptureService::class.java)
            .putExtra(CaptureService.EXTRA_RESULT, resultCode)
            .putExtra(CaptureService.EXTRA_DATA, data)
        if (Build.VERSION.SDK_INT >= 26) startForegroundService(service) else startService(service)
    }

    companion object {
        private const val CAPTURE = 1
    }
}
