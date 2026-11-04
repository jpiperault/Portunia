package fr.portunia.assist

import android.os.Handler
import android.os.Looper
import java.util.Locale

/** Texte dans la langue du téléphone (anglais par défaut). */
fun t(en: String, fr: String): String = if (Locale.getDefault().language == "fr") fr else en

/** Où en est l'assistance. */
sealed class State {
    object Idle : State()
    object Connecting : State()
    data class Code(val code: String) : State()
    data class Asking(val who: String) : State()
    data class Connected(val who: String) : State()
    data class Ended(val reason: String) : State()
}

/**
 * État de la session, partagé entre l'écran et le service de capture. Les méthodes `on…` sont
 * appelées par la partie Rust, depuis son propre fil.
 */
object Session {
    private val main = Handler(Looper.getMainLooper())
    var state: State = State.Idle
        private set
    private val listeners = mutableListOf<(State) -> Unit>()

    /** Suit l'état (appelé tout de suite avec l'état actuel), sur le fil principal. */
    fun watch(listener: (State) -> Unit) {
        listeners.add(listener)
        listener(state)
    }

    fun unwatch(listener: (State) -> Unit) {
        listeners.remove(listener)
    }

    fun set(next: State) {
        main.post {
            state = next
            listeners.toList().forEach { it(next) }
        }
    }

    @JvmStatic fun onCode(code: String) = set(State.Code(code))
    @JvmStatic fun onConsent(who: String) = set(State.Asking(who))
    @JvmStatic fun onConnected(who: String) = set(State.Connected(who))
    @JvmStatic fun onEnded(reason: String) = set(State.Ended(reason))
}
