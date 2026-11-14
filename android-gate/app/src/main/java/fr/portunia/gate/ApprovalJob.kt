package fr.portunia.gate

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.job.JobInfo
import android.app.job.JobParameters
import android.app.job.JobScheduler
import android.app.job.JobService
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.app.Notification
import android.webkit.CookieManager
import java.net.HttpURLConnection
import java.net.URL
import java.util.Locale
import org.json.JSONObject

/**
 * Approbateur (Gate 0.51, Portunia 0.94) : toutes les 15 minutes, l'application regarde les
 * demandes d'accès à décider et en signale chaque nouvelle par une notification. La lecture
 * passe par la session du portail ouverte dans l'application, sans la prolonger (« veille ») :
 * une session expirée ou fermée arrête les notifications jusqu'à la prochaine connexion.
 * Toucher la notification ouvre le portail sur la liste « À décider ».
 */
class ApprovalJob : JobService() {
    override fun onStartJob(params: JobParameters): Boolean {
        Thread {
            try { check(this) } catch (_: Exception) {}
            jobFinished(params, false)
        }.start()
        return true
    }

    override fun onStopJob(params: JobParameters) = true

    companion object {
        private const val JOB = 4201
        private const val CHANNEL = "approbations"

        private fun fr() = Locale.getDefault().language == "fr"
        private fun t(en: String, fr: String) = if (fr()) fr else en

        /** Lance la vérification périodique (une seule à la fois). */
        fun schedule(context: Context) {
            val scheduler = context.getSystemService(JobScheduler::class.java) ?: return
            if (scheduler.getPendingJob(JOB) != null) return
            val job = JobInfo.Builder(JOB, ComponentName(context, ApprovalJob::class.java))
                .setPeriodic(15 * 60 * 1000L)
                .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
                .setPersisted(true)
                .build()
            scheduler.schedule(job)
        }

        fun cancel(context: Context) {
            context.getSystemService(JobScheduler::class.java)?.cancel(JOB)
        }

        /** Demandes à décider ; une notification pour chaque nouvelle. */
        fun check(context: Context) {
            val prefs = context.getSharedPreferences("gate", Context.MODE_PRIVATE)
            val base = prefs.getString("adresse", null) ?: return
            val cookie = CookieManager.getInstance().getCookie(base) ?: return
            val c = URL("$base/api/approbations?veille=1").openConnection() as HttpURLConnection
            c.connectTimeout = 10_000
            c.readTimeout = 20_000
            c.instanceFollowRedirects = false
            c.setRequestProperty("Cookie", cookie)
            c.setRequestProperty("X-Portunia-Gate", "portail")
            c.setRequestProperty("User-Agent", "PortuniaGate/${BuildConfig.VERSION_NAME}")
            if (c.responseCode != 200) return
            val body = JSONObject(c.inputStream.bufferedReader().use { it.readText() })
            if (!body.optBoolean("approbateur")) {
                cancel(context)
                return
            }
            val list = body.optJSONArray("a_traiter") ?: return
            val seen = prefs.getStringSet("approbations-vues", emptySet()) ?: emptySet()
            val now = mutableSetOf<String>()
            for (i in 0 until list.length()) {
                val r = list.getJSONObject(i)
                val id = r.optString("id")
                now.add(id)
                if (id !in seen) notify(context, id, r)
            }
            prefs.edit().putStringSet("approbations-vues", now).apply()
        }

        private fun notify(context: Context, id: String, r: JSONObject) {
            val manager = context.getSystemService(NotificationManager::class.java) ?: return
            if (manager.getNotificationChannel(CHANNEL) == null) {
                manager.createNotificationChannel(NotificationChannel(CHANNEL, t("Access requests", "Demandes d'accès"), NotificationManager.IMPORTANCE_HIGH))
            }
            val open = Intent(context, MainActivity::class.java).putExtra("chemin", "/?approbations").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
            val tap = PendingIntent.getActivity(context, id.hashCode(), open, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
            val who = r.optString("compte")
            val server = r.optString("serveur")
            val reason = r.optString("motif")
            val n = Notification.Builder(context, CHANNEL)
                .setSmallIcon(R.mipmap.ic_launcher)
                .setContentTitle(t("Access request: $who → $server", "Demande d'accès : $who → $server"))
                .setContentText(reason)
                .setStyle(Notification.BigTextStyle().bigText(reason))
                .setContentIntent(tap)
                .setAutoCancel(true)
                .setCategory(Notification.CATEGORY_MESSAGE)
                .build()
            manager.notify(id.hashCode(), n)
        }
    }
}
