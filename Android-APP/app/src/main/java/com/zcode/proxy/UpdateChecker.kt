package com.zcode.proxy

import android.content.Context
import android.util.Log
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

/** GitHub Release metadata (https://github.com/KilimcininKorOglu/zcode-api/releases). */
data class UpdateInfo(
    val tag: String,
    val htmlUrl: String,
    val apkUrl: String?,
    val notes: String?,
)

object UpdateChecker {
    private const val TAG = "UpdateChecker"
    private const val LATEST_API = "https://api.github.com/repos/KilimcininKorOglu/zcode-api/releases/latest"
    const val RELEASES_PAGE = "https://github.com/KilimcininKorOglu/zcode-api/releases"
    private const val CONNECT_TIMEOUT_MS = 10_000
    private const val READ_TIMEOUT_MS = 15_000

    /** Fail silently: GitHub unreachable / rate-limited / malformed responses all return null and never affect startup. */
    suspend fun fetchLatest(): UpdateInfo? = withContext(Dispatchers.IO) {
        try {
            val conn = URL(LATEST_API).openConnection() as HttpURLConnection
            try {
                conn.connectTimeout = CONNECT_TIMEOUT_MS
                conn.readTimeout = READ_TIMEOUT_MS
                conn.setRequestProperty("Accept", "application/vnd.github+json")
                // GitHub API rejects requests without a User-Agent (403)
                conn.setRequestProperty("User-Agent", "ZCodeProxy-Android")
                if (conn.responseCode != HttpURLConnection.HTTP_OK) {
                    Log.w(TAG, "releases/latest HTTP ${conn.responseCode}")
                    null
                } else {
                    parse(conn.inputStream.bufferedReader().use { it.readText() })
                }
            } finally {
                conn.disconnect()
            }
        } catch (t: Throwable) {
            Log.i(TAG, "update check failed: ${t.message}")
            null
        }
    }

    private fun parse(text: String): UpdateInfo? = try {
        val json = JSONObject(text)
        val tag = json.optString("tag_name")
        if (tag.isBlank()) {
            null
        } else {
            UpdateInfo(
                tag = tag,
                htmlUrl = json.optString("html_url", RELEASES_PAGE).ifBlank { RELEASES_PAGE },
                apkUrl = json.optJSONArray("assets")?.let { arr ->
                    (0 until arr.length())
                        .map { arr.getJSONObject(it) }
                        .filter { it.optString("name").endsWith(".apk", ignoreCase = true) }
                        // Prefer signed release APKs, then debug APKs
                        .sortedBy { if (it.optString("name").contains("release", ignoreCase = true)) 0 else 1 }
                        .firstOrNull()
                        ?.optString("browser_download_url")
                        ?.ifBlank { null }
                },
                notes = json.optString("body").ifBlank { null },
            )
        }
    } catch (t: Throwable) {
        Log.w(TAG, "failed to parse release payload: ${t.message}")
        null
    }

    /**
     * Compare the first three numeric segments part by part. current comes from the APK versionName: release CI writes
     * the full tag (e.g. "v5.0.0"); local/dev builds are "<package.json version>-android"
     * (build.gradle.kts derives it from the repo package.json, and release CI auto-bumps and commits it),
     * so a prompt appears only when the official release is newer than the repo version. /releases/latest never returns
     * prereleases, so no alpha/beta/rc suffix handling is needed.
     */
    fun isNewer(current: String?, latestTag: String): Boolean {
        if (current.isNullOrBlank()) return true
        val cur = numericParts(current)
        val lat = numericParts(latestTag)
        if (lat.isEmpty()) return false
        val n = maxOf(cur.size, lat.size, 3)
        for (i in 0 until n) {
            val c = cur.getOrElse(i) { 0 }
            val l = lat.getOrElse(i) { 0 }
            if (c != l) return l > c
        }
        return false
    }

    private fun numericParts(v: String): List<Int> =
        Regex("\\d+").findAll(v).take(3).mapNotNull { it.value.toIntOrNull() }.toList()
}

/** Persisted update prefs: tags marked "skip this version" stop auto-popping; the auto-check switch (default on) controls startup queries. Manual checks are unaffected. */
object UpdatePrefs {
    private const val PREFS = "update_prefs"
    private const val KEY_SKIPPED_TAG = "skipped_tag"
    private const val KEY_AUTO_CHECK = "auto_check"

    fun loadSkipped(context: Context): String? =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY_SKIPPED_TAG, null)

    fun saveSkipped(context: Context, tag: String) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit()
            .putString(KEY_SKIPPED_TAG, tag)
            .apply()
    }

    fun loadAutoCheck(context: Context): Boolean =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getBoolean(KEY_AUTO_CHECK, true)

    fun saveAutoCheck(context: Context, enabled: Boolean) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit()
            .putBoolean(KEY_AUTO_CHECK, enabled)
            .apply()
    }
}
