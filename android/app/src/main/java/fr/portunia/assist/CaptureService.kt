package fr.portunia.assist

import android.app.Activity
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.content.res.Configuration
import android.graphics.PixelFormat
import android.hardware.display.DisplayManager
import android.hardware.display.VirtualDisplay
import android.media.ImageReader
import android.media.projection.MediaProjection
import android.media.projection.MediaProjectionManager
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.os.IBinder
import android.os.SystemClock
import android.util.DisplayMetrics
import android.view.WindowManager

/**
 * Capture de l'écran pendant une session (service au premier plan, exigé par Android pour
 * MediaProjection) : chaque image part vers la partie Rust, au plus dix par seconde.
 * La notification reste affichée tant que l'écran est partagé, avec un bouton Arrêter.
 */
class CaptureService : Service() {
    private var projection: MediaProjection? = null
    private var display: VirtualDisplay? = null
    private var reader: ImageReader? = null
    private var size = Pair(0, 0)
    private val thread = HandlerThread("capture").apply { start() }
    private val handler = Handler(thread.looper)
    private var lastFrame = 0L
    private var accepted = false
    private val follow: (State) -> Unit = { s -> if (s is State.Ended || s is State.Idle) stopSelf() }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            Native.stop()
            stopSelf()
            return START_NOT_STICKY
        }
        if (projection != null) return START_NOT_STICKY
        val data: Intent? = if (Build.VERSION.SDK_INT >= 33) intent?.getParcelableExtra(EXTRA_DATA, Intent::class.java) else @Suppress("DEPRECATION") intent?.getParcelableExtra(EXTRA_DATA)
        val result = intent?.getIntExtra(EXTRA_RESULT, Activity.RESULT_CANCELED) ?: Activity.RESULT_CANCELED
        // Le service doit être au premier plan avant d'obtenir la capture (Android 14).
        if (Build.VERSION.SDK_INT >= 29) {
            startForeground(NOTIFICATION, notification(), ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION)
        } else {
            startForeground(NOTIFICATION, notification())
        }
        val manager = getSystemService(MediaProjectionManager::class.java)
        val p = data?.let { manager.getMediaProjection(result, it) }
        if (p == null) {
            Native.answer(-1)
            stopSelf()
            return START_NOT_STICKY
        }
        projection = p
        p.registerCallback(object : MediaProjection.Callback() {
            // Partage arrêté par Android (puce « Arrêter le partage », écran verrouillé…).
            override fun onStop() {
                Native.stop()
                stopSelf()
            }
        }, handler)
        Session.watch(follow)
        size = captureSize()
        val r = newReader(size)
        display = p.createVirtualDisplay("portunia-assist", size.first, size.second, densityDpi(), DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR, r.surface, null, handler)
        reader = r
        return START_NOT_STICKY
    }

    private fun newReader(s: Pair<Int, Int>): ImageReader {
        val r = ImageReader.newInstance(s.first, s.second, PixelFormat.RGBA_8888, 2)
        r.setOnImageAvailableListener({ ir ->
            val image = ir.acquireLatestImage() ?: return@setOnImageAvailableListener
            try {
                val now = SystemClock.elapsedRealtime()
                if (now - lastFrame >= 90) {
                    lastFrame = now
                    val plane = image.planes[0]
                    Native.frame(plane.buffer, image.width, image.height, plane.rowStride)
                    // La première image est là : l'accord part, l'écran peut être servi.
                    if (!accepted) {
                        accepted = true
                        Native.answer(0)
                    }
                }
            } finally {
                image.close()
            }
        }, handler)
        return r
    }

    /** Rotation : l'image suit l'orientation du téléphone. */
    override fun onConfigurationChanged(newConfig: Configuration) {
        super.onConfigurationChanged(newConfig)
        val d = display ?: return
        val next = captureSize()
        if (next == size) return
        size = next
        val old = reader
        val r = newReader(next)
        d.resize(next.first, next.second, densityDpi())
        d.surface = r.surface
        reader = r
        old?.close()
    }

    override fun onDestroy() {
        Session.unwatch(follow)
        display?.release()
        reader?.close()
        projection?.stop()
        projection = null
        thread.quitSafely()
        super.onDestroy()
    }

    private fun metrics(): DisplayMetrics {
        val m = DisplayMetrics()
        @Suppress("DEPRECATION")
        (getSystemService(Context.WINDOW_SERVICE) as WindowManager).defaultDisplay.getRealMetrics(m)
        return m
    }

    private fun densityDpi(): Int = metrics().densityDpi

    /** Taille envoyée : l'écran réduit à 1280 pixels au plus de haut ou de large. */
    private fun captureSize(): Pair<Int, Int> {
        val m = metrics()
        val scale = minOf(1.0, 1280.0 / maxOf(m.widthPixels, m.heightPixels))
        val w = ((m.widthPixels * scale).toInt() / 4) * 4
        val h = ((m.heightPixels * scale).toInt() / 2) * 2
        return Pair(maxOf(w, 4), maxOf(h, 2))
    }

    private fun notification(): Notification {
        val nm = getSystemService(NotificationManager::class.java)
        if (Build.VERSION.SDK_INT >= 26) {
            nm.createNotificationChannel(NotificationChannel(CHANNEL, t("Screen sharing", "Partage de l'écran"), NotificationManager.IMPORTANCE_LOW))
        }
        val stop = PendingIntent.getService(this, 1, Intent(this, CaptureService::class.java).setAction(ACTION_STOP), PendingIntent.FLAG_IMMUTABLE)
        val open = PendingIntent.getActivity(this, 2, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE)
        val builder = if (Build.VERSION.SDK_INT >= 26) Notification.Builder(this, CHANNEL) else @Suppress("DEPRECATION") Notification.Builder(this)
        return builder
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(t("Your screen is being shared", "Votre écran est partagé"))
            .setContentText(t("Portunia Assistance · tap Stop to end", "Portunia Assistance · touchez Arrêter pour finir"))
            .setContentIntent(open)
            .setOngoing(true)
            .addAction(Notification.Action.Builder(null, t("Stop", "Arrêter"), stop).build())
            .build()
    }

    companion object {
        const val EXTRA_RESULT = "result"
        const val EXTRA_DATA = "data"
        const val ACTION_STOP = "fr.portunia.assist.STOP"
        private const val CHANNEL = "partage"
        private const val NOTIFICATION = 1
    }
}
