package fr.portunia.assist

import java.nio.ByteBuffer

/** Partie Rust (android/rust) : relais, code, chiffrement et serveur RDP de l'écran. */
object Native {
    init {
        System.loadLibrary("portunia_assist")
    }

    /** Démarre une assistance sur le relais `url` (wss://…/assistance/relais). */
    @JvmStatic external fun start(url: String, french: Boolean)

    /** Réponse à la demande d'accès : 0 accepté (vue seule), -1 refusé. */
    @JvmStatic external fun answer(value: Int)

    /** Image de la capture, RGBA_8888, `stride` octets par ligne. */
    @JvmStatic external fun frame(buffer: ByteBuffer, width: Int, height: Int, stride: Int)

    @JvmStatic external fun stop()
}
