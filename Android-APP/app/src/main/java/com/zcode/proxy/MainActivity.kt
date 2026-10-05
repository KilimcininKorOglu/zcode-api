package com.zcode.proxy

import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Home
import androidx.compose.material.icons.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.Menu
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.platform.ClipboardManager
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.testTag
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.graphics.drawable.toBitmap
import com.zcode.proxy.ui.theme.Mono
import com.zcode.proxy.ui.theme.ThemeMode
import com.zcode.proxy.ui.theme.ThemePrefs
import com.zcode.proxy.ui.theme.ZcodeTheme
import com.zcode.proxy.ui.theme.dimColor
import com.zcode.proxy.ui.theme.isDarkTheme
import com.zcode.proxy.ui.theme.successColor
import com.zcode.proxy.ui.theme.warningColor
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject
import java.text.DecimalFormat
import java.text.DecimalFormatSymbols
import java.util.Locale

class MainActivity : ComponentActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        startService(Intent(this, ServerService::class.java))
        setContent {
            var themeMode by remember { mutableStateOf(ThemePrefs.load(this)) }
            ZcodeTheme(themeMode) {
                AppScreen(
                    themeMode = themeMode,
                    onThemeModeChange = { mode ->
                        themeMode = mode
                        ThemePrefs.save(this, mode)
                    },
                )
            }
        }
    }

    companion object {
        var controlClient: ControlClient? = null
    }
}

private const val POLL_INTERVAL_MS = 1500L
private const val MAX_LOG_LINES = 500

/** Coding count-window length (denominator of the time progress bar); labels map 1:1 to windows. */
private const val FIVE_HOUR_WINDOW_MS = 5 * 60 * 60 * 1000L
private const val WEEK_WINDOW_MS = 7 * 24 * 60 * 60 * 1000L
private const val LABEL_5H = "5h"
private const val LABEL_WEEK = "Weekly"

@Composable
private fun AppScreen(themeMode: ThemeMode, onThemeModeChange: (ThemeMode) -> Unit) {
    val scope = rememberCoroutineScope()
    val clipboard = LocalClipboardManager.current
    val context = LocalContext.current

    var reachable by remember { mutableStateOf(false) }
    var loggedIn by remember { mutableStateOf(false) }
    var provider by remember { mutableStateOf("bigmodel") }
    var plan by remember { mutableStateOf("coding-plan") }
    var proxyPort by remember { mutableStateOf(0) }
    var proxyRunning by remember { mutableStateOf(false) }
    var logCursor by remember { mutableStateOf(0) }
    val logs = remember { mutableStateListOf<String>() }
    var toast by remember { mutableStateOf<String?>(null) }
    var tab by rememberSaveable { mutableStateOf(0) }

    // Plan usage (replaces the old "last 60 min requests" sparkline): fetch once after login + tap to refresh,
    // No polling — billing/monitor gateways are rate-limited (same manual-refresh policy as the TUI).
    var quotaUi by remember { mutableStateOf<QuotaUi?>(null) }
    var quotaStatus by remember { mutableStateOf("idle") } // idle | loading | ok | empty | error
    var quotaErrorMsg by remember { mutableStateOf("") }
    var quotaInFlight by remember { mutableStateOf(false) }

    // Update check (GitHub Releases): auto-check once per launch, manual trigger on the settings page
    val currentVersion = remember {
        runCatching { context.packageManager.getPackageInfo(context.packageName, 0).versionName }.getOrNull()
    }
    var updateInfo by remember { mutableStateOf<UpdateInfo?>(null) }
    var updateChecking by remember { mutableStateOf(false) }
    var updateCheckFailed by remember { mutableStateOf(false) }
    var showUpdateDialog by remember { mutableStateOf(false) }
    var skippedTag by remember { mutableStateOf(UpdatePrefs.loadSkipped(context)) }
    var autoCheckUpdate by remember { mutableStateOf(UpdatePrefs.loadAutoCheck(context)) }

    fun checkForUpdate(manual: Boolean) {
        scope.launch {
            updateChecking = true
            val info = UpdateChecker.fetchLatest()
            updateChecking = false
            if (info == null) {
                updateCheckFailed = true
                if (manual) toast = "Update check failed, GitHub unreachable"
                return@launch
            }
            updateCheckFailed = false
            updateInfo = info
            val hasUpdate = UpdateChecker.isNewer(currentVersion, info.tag)
            if (manual) toast = if (hasUpdate) "New version available ${info.tag}" else "Already on the latest version"
            if (hasUpdate && (manual || info.tag != skippedTag)) showUpdateDialog = true
        }
    }

    // Auto-check once per launch (can be disabled on the settings page; manual checks ignore the switch)
    LaunchedEffect(Unit) { if (autoCheckUpdate) checkForUpdate(manual = false) }

    // Uptime: record start on false->true; refresh every second only for the hero-card uptime
    var runningSince by remember { mutableStateOf<Long?>(null) }
    var nowMs by remember { mutableLongStateOf(0L) }
    LaunchedEffect(proxyRunning) {
        runningSince = if (proxyRunning) System.currentTimeMillis() else null
        nowMs = System.currentTimeMillis()
        if (proxyRunning) {
            while (isActive) {
                delay(1000)
                nowMs = System.currentTimeMillis()
            }
        }
    }

    // Polling: status + incremental getLogs (same protocol as before, 1.5s)
    LaunchedEffect(Unit) {
        while (true) {
            val cc = MainActivity.controlClient
            if (cc == null) {
                reachable = false
            } else {
                val resp = cc.status()
                if (resp != null) {
                    reachable = true
                    loggedIn = resp.optBoolean("loggedIn", false)
                    provider = resp.optString("provider", provider)
                    plan = resp.optString("plan", plan)
                    proxyPort = resp.optInt("proxyPort", 0)
                    proxyRunning = proxyPort > 0
                } else {
                    reachable = false
                }
                val logsResp = cc.getLogs(logCursor)
                if (logsResp != null && logsResp.optBoolean("ok", false)) {
                    val next = logsResp.optInt("nextSince", logCursor)
                    val arr = logsResp.optJSONArray("lines")
                    if (arr != null && arr.length() > 0) {
                        val newLines = ArrayList<String>(arr.length())
                        for (i in 0 until arr.length()) newLines.add(arr.getString(i))
                        logs.addAll(newLines)
                        while (logs.size > MAX_LOG_LINES) logs.removeAt(0)
                    }
                    logCursor = next
                }
            }
            delay(POLL_INTERVAL_MS)
        }
    }

    LaunchedEffect(toast) {
        if (toast != null) {
            delay(2500)
            toast = null
        }
    }

    val errRegex = remember { Regex("\\b(4\\d\\d|5\\d\\d)\\b") }
    val errorCount = logs.count { errRegex.containsMatchIn(it) }

    fun refreshQuota() {
        if (quotaInFlight) return
        quotaInFlight = true
        // Keep old values and refresh in place when data exists (loading placeholder only for the first fetch)
        if (quotaUi == null) quotaStatus = "loading"
        scope.launch {
            val r = MainActivity.controlClient?.quota()
            if (r != null && r.optBoolean("ok", false)) {
                val parsed = parseQuota(r, plan)
                quotaUi = parsed
                quotaStatus = if (parsed != null && parsed.rows.isNotEmpty()) "ok" else "empty"
            } else {
                quotaErrorMsg = r?.optString("error") ?: ""
                quotaStatus = "error"
            }
            quotaInFlight = false
        }
    }

    // Auto-fetch once on login-state/plan change; clear on logout (billing calls need credentials)
    LaunchedEffect(loggedIn, plan) {
        if (loggedIn) refreshQuota() else {
            quotaUi = null
            quotaStatus = "idle"
            quotaErrorMsg = ""
        }
    }

    fun changeProvider(p: String) {
        scope.launch {
            val r = MainActivity.controlClient?.setConfig(provider = p)
            if (r != null && r.optBoolean("ok", false)) {
                provider = p
                toast = "Provider → ${if (p == "zai") "Z.AI" else "Zhipu"}"
            } else {
                toast = "Switch failed: ${r?.optString("error") ?: "Node not responding"}"
            }
        }
    }

    fun changePlan(p: String) {
        scope.launch {
            val r = MainActivity.controlClient?.setConfig(plan = p)
            if (r != null && r.optBoolean("ok", false)) {
                plan = p
                toast = "Plan → $p"
            } else {
                toast = "Switch failed: ${r?.optString("error") ?: "Node not responding"}"
            }
        }
    }

    fun startLogin() {
        scope.launch {
            val r = MainActivity.controlClient?.startOAuth(provider)
            if (r != null && r.optBoolean("ok", false)) {
                openInBrowser(context, r.optString("authorizeUrl"))
                toast = "Complete authorization in the browser, then return here; if the browser says it cannot open the zcode:// link, ignore it"
            } else {
                toast = "Login failed: ${r?.optString("error") ?: "Node not responding"}"
            }
        }
    }

    fun logout() {
        scope.launch {
            val r = MainActivity.controlClient?.logout()
            toast = if (r != null && r.optBoolean("ok", false)) "Logged out" else "Logout failed"
        }
    }

    fun startProxy() {
        scope.launch {
            val r = MainActivity.controlClient?.startProxy()
            toast = if (r != null && r.optBoolean("ok", false)) {
                "Proxy started · 127.0.0.1:${r.optInt("port")}"
            } else {
                "Start failed: ${r?.optString("error") ?: "Node not responding"}"
            }
        }
    }

    fun stopProxy() {
        scope.launch {
            val r = MainActivity.controlClient?.stopProxy()
            toast = if (r != null && r.optBoolean("ok", false)) "Proxy stopped" else "Stop failed: ${r?.optString("error") ?: "Node not responding"}"
        }
    }

    val cs = MaterialTheme.colorScheme

    Box(Modifier.fillMaxSize().background(cs.background)) {
        Column(Modifier.fillMaxSize().statusBarsPadding()) {
            when (tab) {
                0 -> {
                    // ── Home ──
                    LazyColumn(
                        modifier = Modifier.fillMaxSize(),
                        verticalArrangement = Arrangement.spacedBy(12.dp),
                        contentPadding = PaddingValues(top = 4.dp, start = 16.dp, end = 16.dp, bottom = 120.dp),
                    ) {
                        item {
                            TopBar(
                                subtitle = when {
                                    !reachable -> "Local reverse proxy · Node not responding"
                                    else -> "Local reverse proxy · Connected"
                                },
                                onSettings = { tab = 2 },
                            )
                        }
                        item {
                            HeroCard(
                                reachable = reachable,
                                loggedIn = loggedIn,
                                proxyRunning = proxyRunning,
                                proxyPort = proxyPort,
                                plan = plan,
                                uptimeText = runningSince?.let { formatDuration(nowMs - it) },
                                quotaUi = quotaUi,
                                quotaStatus = quotaStatus,
                                quotaErrorMsg = quotaErrorMsg,
                                clipboard = clipboard,
                                onCopied = { toast = "Copied 127.0.0.1:$proxyPort" },
                                onStart = ::startProxy,
                                onStop = ::stopProxy,
                                onRefreshQuota = ::refreshQuota,
                            )
                        }
                        item {
                            AccountCard(
                                reachable = reachable,
                                loggedIn = loggedIn,
                                provider = provider,
                                proxyRunning = proxyRunning,
                                onLogin = ::startLogin,
                                onLogout = ::logout,
                            )
                        }
                        item {
                            AccessConfigCard(
                                reachable = reachable,
                                proxyRunning = proxyRunning,
                                provider = provider,
                                plan = plan,
                                onProviderChange = ::changeProvider,
                                onPlanChange = ::changePlan,
                            )
                        }
                        item {
                            LogsPreviewCard(
                                logs = logs,
                                errorCount = errorCount,
                                errRegex = errRegex,
                                onOpenLogs = { tab = 1 },
                            )
                        }
                    }
                }
                1 -> LogsScreen(
                    logs = logs,
                    errRegex = errRegex,
                    onClear = { logs.clear() },
                )
                2 -> SettingsScreen(
                    themeMode = themeMode,
                    onThemeModeChange = onThemeModeChange,
                    provider = provider,
                    plan = plan,
                    proxyPort = proxyPort,
                    proxyRunning = proxyRunning,
                    reachable = reachable,
                    loggedIn = loggedIn,
                    currentVersion = currentVersion,
                    updateInfo = updateInfo,
                    updateChecking = updateChecking,
                    updateCheckFailed = updateCheckFailed,
                    onCheckUpdate = { checkForUpdate(manual = true) },
                    autoCheckUpdate = autoCheckUpdate,
                    onAutoCheckUpdateChange = { enabled ->
                        autoCheckUpdate = enabled
                        UpdatePrefs.saveAutoCheck(context, enabled)
                    },
                )
            }
        }

        // Bottom nav
        Column(Modifier.align(Alignment.BottomCenter).fillMaxWidth()) {
            HorizontalDivider(color = cs.outlineVariant, thickness = 1.dp)
            Row(
                Modifier
                    .fillMaxWidth()
                    .background(cs.surfaceContainer)
                    .navigationBarsPadding()
                    .height(68.dp),
            ) {
                NavItem("Home", Icons.Filled.Home, tab == 0, Modifier.weight(1f)) { tab = 0 }
                NavItem("Logs", Icons.Filled.Menu, tab == 1, Modifier.weight(1f)) { tab = 1 }
                NavItem("Settings", Icons.Filled.Settings, tab == 2, Modifier.weight(1f)) { tab = 2 }
            }
        }

        // toast
        toast?.let { msg ->
            Surface(
                color = cs.inverseSurface,
                contentColor = cs.inverseOnSurface,
                shape = RoundedCornerShape(10.dp),
                shadowElevation = 4.dp,
                modifier = Modifier
                    .align(Alignment.BottomCenter)
                    .padding(bottom = 100.dp),
            ) {
                Text(msg, fontSize = 13.sp, modifier = Modifier.padding(horizontal = 14.dp, vertical = 10.dp))
            }
        }
    }

    // New-version dialog (shared by launch auto-check / settings manual check)
    if (showUpdateDialog) {
        updateInfo?.let { info ->
            AlertDialog(
                onDismissRequest = { showUpdateDialog = false },
                title = { Text("New version available", fontWeight = FontWeight.SemiBold) },
                text = {
                    Column {
                        Text(
                            "Latest ${info.tag} · Current ${currentVersion ?: "unknown"}",
                            fontFamily = Mono,
                            fontSize = 13.sp,
                            color = cs.onSurfaceVariant,
                        )
                        info.notes?.let { notes ->
                            Spacer(Modifier.height(10.dp))
                            Text(
                                notes.trim(),
                                fontSize = 12.sp,
                                lineHeight = 18.sp,
                                color = cs.onSurfaceVariant,
                                maxLines = 10,
                                overflow = TextOverflow.Ellipsis,
                            )
                        }
                    }
                },
                confirmButton = {
                    TextButton(onClick = {
                        showUpdateDialog = false
                        openInBrowser(context, info.apkUrl ?: info.htmlUrl)
                    }) { Text("Download", fontWeight = FontWeight.Medium) }
                },
                dismissButton = {
                    Row {
                        TextButton(onClick = {
                            skippedTag = info.tag
                            UpdatePrefs.saveSkipped(context, info.tag)
                            showUpdateDialog = false
                        }) { Text("Skip this version") }
                        TextButton(onClick = { showUpdateDialog = false }) { Text("Later") }
                    }
                },
            )
        }
    }
}

@Composable
private fun TopBar(subtitle: String, onSettings: () -> Unit) {
    val cs = MaterialTheme.colorScheme
    val context = LocalContext.current
    Row(
        Modifier.fillMaxWidth().padding(vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        val appIcon = remember {
            runCatching {
                context.packageManager.getApplicationIcon(context.packageName).toBitmap(96, 96)
            }.getOrNull()
        }
        if (appIcon != null) {
            // On dark mode the icon on black needs a brightened pad + border so it does not blend into the background (same as option A mock)
            val dark = isDarkTheme()
            val iconShape = RoundedCornerShape(10.dp)
            Image(
                bitmap = appIcon.asImageBitmap(),
                contentDescription = null,
                modifier = Modifier
                    .size(40.dp)
                    .clip(iconShape)
                    .then(
                        if (dark) Modifier
                            .background(cs.surfaceContainerHigh)
                            .border(1.dp, cs.outlineVariant, iconShape)
                        else Modifier,
                    ),
            )
        } else {
            Box(
                Modifier
                    .size(40.dp)
                    .clip(RoundedCornerShape(10.dp))
                    .background(cs.primary),
                contentAlignment = Alignment.Center,
            ) {
                Text("Z", color = cs.onPrimary, fontWeight = FontWeight.Bold, fontSize = 20.sp)
            }
        }
        Spacer(Modifier.width(12.dp))
        Column {
            Text("ZCode Proxy", fontSize = 20.sp, fontWeight = FontWeight.SemiBold, color = cs.onSurface)
            Text(subtitle, fontSize = 12.sp, color = cs.onSurfaceVariant)
        }
        Spacer(Modifier.weight(1f))
        IconButton(onClick = onSettings) {
            Icon(Icons.Filled.Settings, contentDescription = "Settings", tint = cs.onSurfaceVariant)
        }
    }
}

@Composable
private fun HeroCard(
    reachable: Boolean,
    loggedIn: Boolean,
    proxyRunning: Boolean,
    proxyPort: Int,
    plan: String,
    uptimeText: String?,
    quotaUi: QuotaUi?,
    quotaStatus: String,
    quotaErrorMsg: String,
    clipboard: ClipboardManager,
    onCopied: () -> Unit,
    onStart: () -> Unit,
    onStop: () -> Unit,
    onRefreshQuota: () -> Unit,
) {
    val cs = MaterialTheme.colorScheme
    Column(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(24.dp))
            .background(cs.primaryContainer)
            .padding(20.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            val (dotColor, stateText) = when {
                proxyRunning -> successColor() to "Running"
                !reachable -> MaterialTheme.colorScheme.error to "Node not responding"
                !loggedIn -> cs.onSurfaceVariant to "Not logged in"
                else -> cs.onSurfaceVariant to "Stopped"
            }
            StatusDot(dotColor, pulse = proxyRunning)
            Spacer(Modifier.width(10.dp))
            Text(stateText, fontSize = 20.sp, fontWeight = FontWeight.SemiBold, color = cs.onPrimaryContainer)
            Spacer(Modifier.weight(1f))
            Surface(shape = RoundedCornerShape(50), color = cs.primary.copy(alpha = 0.14f)) {
                Text(
                    plan,
                    fontFamily = Mono,
                    fontSize = 12.sp,
                    color = cs.onPrimaryContainer,
                    modifier = Modifier.padding(horizontal = 12.dp, vertical = 5.dp),
                )
            }
        }
        Spacer(Modifier.height(16.dp))
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                if (proxyRunning) "127.0.0.1:$proxyPort" else "Not started",
                fontFamily = Mono,
                fontSize = 24.sp,
                fontWeight = FontWeight.SemiBold,
                color = cs.onPrimaryContainer,
                modifier = Modifier.weight(1f),
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            if (proxyRunning) {
                Surface(
                    shape = RoundedCornerShape(50),
                    color = Color.Transparent,
                    border = BorderStroke(1.5.dp, cs.primary.copy(alpha = 0.45f)),
                    onClick = {
                        clipboard.setText(AnnotatedString("http://127.0.0.1:$proxyPort"))
                        onCopied()
                    },
                ) {
                    Row(
                        Modifier.padding(horizontal = 14.dp, vertical = 7.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        CopyGlyph(cs.onPrimaryContainer.copy(alpha = 0.85f))
                        Spacer(Modifier.width(6.dp))
                        Text("Copy", fontSize = 13.sp, color = cs.onPrimaryContainer)
                    }
                }
            }
        }
        Spacer(Modifier.height(14.dp))
        QuotaBlock(
            loggedIn = loggedIn,
            quotaUi = quotaUi,
            status = quotaStatus,
            errorMsg = quotaErrorMsg,
            uptimeText = uptimeText,
            onRefresh = onRefreshQuota,
        )
        Spacer(Modifier.height(14.dp))
        Button(
            onClick = if (proxyRunning) onStop else onStart,
            enabled = if (proxyRunning) reachable else reachable && loggedIn,
            shape = RoundedCornerShape(50),
            colors = ButtonDefaults.buttonColors(
                containerColor = cs.primary,
                contentColor = cs.onPrimary,
                disabledContainerColor = cs.onSurfaceVariant.copy(alpha = 0.25f),
                disabledContentColor = cs.onSurfaceVariant,
            ),
            modifier = Modifier
                .fillMaxWidth()
                .height(52.dp)
                .semantics { testTag = if (proxyRunning) "stopButton" else "startButton" },
        ) {
            if (proxyRunning) {
                Box(
                    Modifier
                        .size(14.dp)
                        .clip(RoundedCornerShape(3.dp))
                        .background(cs.onPrimary),
                )
                Spacer(Modifier.width(10.dp))
                Text("Stop proxy", fontSize = 16.sp, fontWeight = FontWeight.SemiBold)
            } else {
                Text("Start proxy", fontSize = 16.sp, fontWeight = FontWeight.SemiBold)
            }
        }
    }
}

@Composable
private fun AccountCard(
    reachable: Boolean,
    loggedIn: Boolean,
    provider: String,
    proxyRunning: Boolean,
    onLogin: () -> Unit,
    onLogout: () -> Unit,
) {
    val cs = MaterialTheme.colorScheme
    Row(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(24.dp))
            .background(cs.surfaceContainerLow)
            .padding(16.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            Modifier
                .size(48.dp)
                .clip(CircleShape)
                .background(cs.primaryContainer),
            contentAlignment = Alignment.Center,
        ) {
            Text("Z", fontSize = 22.sp, fontWeight = FontWeight.Bold, color = cs.onPrimaryContainer)
        }
        Spacer(Modifier.width(12.dp))
        Column(Modifier.weight(1f)) {
            Text(
                if (provider == "zai") "Z.AI account" else "Zhipu account",
                fontSize = 16.sp,
                fontWeight = FontWeight.SemiBold,
                color = cs.onSurface,
            )
            Spacer(Modifier.height(3.dp))
            Row(verticalAlignment = Alignment.CenterVertically) {
                Box(
                    Modifier
                        .size(8.dp)
                        .clip(CircleShape)
                        .background(if (loggedIn) successColor() else cs.error),
                )
                Spacer(Modifier.width(6.dp))
                Text(
                    when {
                        proxyRunning && loggedIn -> "Logged in · proxy running · logout locked"
                        proxyRunning -> "Not logged in · proxy running"
                        loggedIn -> "Logged in · OAuth"
                        else -> "Not logged in"
                    },
                    fontSize = 13.sp,
                    color = cs.onSurfaceVariant,
                )
            }
        }
        if (loggedIn) {
            OutlinedButton(
                onClick = onLogout,
                enabled = reachable && !proxyRunning,
                shape = RoundedCornerShape(50),
                colors = ButtonDefaults.outlinedButtonColors(
                    contentColor = cs.error,
                    disabledContentColor = cs.error.copy(alpha = 0.38f),
                ),
                border = BorderStroke(1.5.dp, cs.error.copy(alpha = if (reachable && !proxyRunning) 0.55f else 0.25f)),
                modifier = Modifier.semantics { testTag = "logoutButton" },
            ) {
                Text("Log out", fontSize = 14.sp, fontWeight = FontWeight.Medium)
            }
        } else {
            Button(
                onClick = onLogin,
                enabled = reachable,
                shape = RoundedCornerShape(50),
                colors = ButtonDefaults.buttonColors(containerColor = cs.primary, contentColor = cs.onPrimary),
                modifier = Modifier.semantics { testTag = "loginButton" },
            ) {
                Text("Log in", fontSize = 14.sp, fontWeight = FontWeight.Medium)
            }
        }
    }
}

@Composable
private fun AccessConfigCard(
    reachable: Boolean,
    proxyRunning: Boolean,
    provider: String,
    plan: String,
    onProviderChange: (String) -> Unit,
    onPlanChange: (String) -> Unit,
) {
    val cs = MaterialTheme.colorScheme
    val enabled = reachable && !proxyRunning
    Column(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(24.dp))
            .background(cs.surfaceContainerLow)
            .padding(16.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text("Connection", fontSize = 16.sp, fontWeight = FontWeight.SemiBold, color = cs.onSurface)
            Spacer(Modifier.weight(1f))
            Text(
                when {
                    proxyRunning -> "Running · switching locked"
                    !reachable -> "Node not responding"
                    else -> "Stop the proxy to switch"
                },
                fontSize = 12.sp,
                color = dimColor(),
            )
        }
        HorizontalDivider(color = cs.outlineVariant, thickness = 1.dp, modifier = Modifier.padding(vertical = 12.dp))
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text("Provider", fontSize = 13.sp, color = cs.onSurfaceVariant, modifier = Modifier.width(52.dp))
            SegChip("Z.AI", provider == "zai", enabled, modifier = Modifier.weight(1f), fill = true) { onProviderChange("zai") }
            Spacer(Modifier.width(8.dp))
            SegChip("Zhipu", provider == "bigmodel", enabled, modifier = Modifier.weight(1f), fill = true) { onProviderChange("bigmodel") }
        }
        Spacer(Modifier.height(14.dp))
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text("Plan", fontSize = 13.sp, color = cs.onSurfaceVariant, modifier = Modifier.width(52.dp))
            SegChip("coding-plan", plan == "coding-plan", enabled, modifier = Modifier.weight(1f), fill = true, mono = true) { onPlanChange("coding-plan") }
            Spacer(Modifier.width(8.dp))
            SegChip("start-plan", plan == "start-plan", enabled, modifier = Modifier.weight(1f), fill = true, mono = true) { onPlanChange("start-plan") }
        }
    }
}

@Composable
private fun LogsPreviewCard(
    logs: List<String>,
    errorCount: Int,
    errRegex: Regex,
    onOpenLogs: () -> Unit,
) {
    val cs = MaterialTheme.colorScheme
    Column(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(24.dp))
            .background(cs.surfaceContainerLow)
            .clickable(onClick = onOpenLogs)
            .padding(16.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text("Live logs", fontSize = 16.sp, fontWeight = FontWeight.SemiBold, color = cs.onSurface)
            Spacer(Modifier.width(8.dp))
            Surface(shape = RoundedCornerShape(50), color = cs.secondaryContainer) {
                Text(
                    "${logs.size}",
                    fontFamily = Mono,
                    fontSize = 11.sp,
                    fontWeight = FontWeight.SemiBold,
                    color = cs.onSecondaryContainer,
                    modifier = Modifier.padding(horizontal = 9.dp, vertical = 3.dp),
                )
            }
            Spacer(Modifier.weight(1f))
            Text(
                "$errorCount errors",
                fontFamily = Mono,
                fontSize = 12.sp,
                fontWeight = FontWeight.SemiBold,
                color = if (errorCount == 0) successColor() else cs.error,
            )
            Spacer(Modifier.width(10.dp))
            Text("View all", fontSize = 13.sp, fontWeight = FontWeight.Medium, color = cs.primary)
            Icon(
                Icons.Filled.KeyboardArrowRight,
                contentDescription = null,
                tint = cs.primary,
                modifier = Modifier.size(18.dp),
            )
        }
        HorizontalDivider(color = cs.outlineVariant, thickness = 1.dp, modifier = Modifier.padding(vertical = 10.dp))
        if (logs.isEmpty()) {
            Text(
                "No requests yet — send a chat from your coding tool to try",
                fontSize = 12.sp,
                color = dimColor(),
                modifier = Modifier.padding(vertical = 10.dp),
            )
        } else {
            logs.takeLast(5).forEach { line ->
                Text(
                    line,
                    fontFamily = Mono,
                    fontSize = 11.sp,
                    lineHeight = 17.sp,
                    color = if (errRegex.containsMatchIn(line)) cs.error else cs.onSurfaceVariant,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.padding(vertical = 2.dp),
                )
            }
        }
        Text(
            "Tap the card or "View all" (top right) for full logs",
            fontSize = 12.sp,
            color = dimColor(),
            textAlign = TextAlign.Center,
            modifier = Modifier
                .fillMaxWidth()
                .padding(top = 10.dp),
        )
    }
}

@Composable
private fun LogsScreen(logs: MutableList<String>, errRegex: Regex, onClear: () -> Unit) {
    val cs = MaterialTheme.colorScheme
    val clipboard = LocalClipboardManager.current
    var filter by rememberSaveable { mutableStateOf(0) } // 0 All 1 Success 2 Errors
    val filtered = remember(logs.size, filter) {
        when (filter) {
            1 -> logs.filter { it.contains("\\b2\\d\\d\\b".toRegex()) }
            2 -> logs.filter { errRegex.containsMatchIn(it) }
            else -> logs.toList()
        }
    }
    val listState = rememberLazyListState()
    LaunchedEffect(filtered.size) {
        if (filtered.isNotEmpty()) listState.scrollToItem(filtered.lastIndex)
    }
    Column(Modifier.fillMaxSize()) {
        Row(
            Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text("Live logs (${filtered.size})", fontSize = 18.sp, fontWeight = FontWeight.SemiBold, color = cs.onSurface)
            Spacer(Modifier.weight(1f))
            TextButton(
                onClick = { clipboard.setText(AnnotatedString(filtered.joinToString("\n"))) },
                enabled = filtered.isNotEmpty(),
            ) { Text("Copy", fontSize = 13.sp) }
            TextButton(onClick = onClear, enabled = logs.isNotEmpty()) { Text("Clear", fontSize = 13.sp) }
        }
        Row(Modifier.padding(horizontal = 16.dp)) {
            SegChip("All", filter == 0, true) { filter = 0 }
            Spacer(Modifier.width(8.dp))
            SegChip("Success", filter == 1, true) { filter = 1 }
            Spacer(Modifier.width(8.dp))
            SegChip("Errors", filter == 2, true) { filter = 2 }
        }
        HorizontalDivider(color = cs.outlineVariant, thickness = 1.dp, modifier = Modifier.padding(vertical = 8.dp))
        if (filtered.isEmpty()) {
            Text(
                "No logs yet",
                fontSize = 13.sp,
                color = dimColor(),
                modifier = Modifier.padding(16.dp),
            )
        } else {
            LazyColumn(
                state = listState,
                modifier = Modifier.fillMaxSize().padding(horizontal = 16.dp),
                contentPadding = PaddingValues(bottom = 110.dp, top = 4.dp),
            ) {
                items(filtered.size) { idx ->
                    val line = filtered[idx]
                    Text(
                        line,
                        fontFamily = Mono,
                        fontSize = 11.sp,
                        lineHeight = 17.sp,
                        color = if (errRegex.containsMatchIn(line)) cs.error else cs.onSurfaceVariant,
                        modifier = Modifier.padding(vertical = 1.dp),
                    )
                }
            }
        }
    }
}

@Composable
private fun SettingsScreen(
    themeMode: ThemeMode,
    onThemeModeChange: (ThemeMode) -> Unit,
    provider: String,
    plan: String,
    proxyPort: Int,
    proxyRunning: Boolean,
    reachable: Boolean,
    loggedIn: Boolean,
    currentVersion: String?,
    updateInfo: UpdateInfo?,
    updateChecking: Boolean,
    updateCheckFailed: Boolean,
    onCheckUpdate: () -> Unit,
    autoCheckUpdate: Boolean,
    onAutoCheckUpdateChange: (Boolean) -> Unit,
) {
    val cs = MaterialTheme.colorScheme
    Column(
        Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = 16.dp)
            .padding(bottom = 120.dp),
    ) {
        Text("Settings", fontSize = 20.sp, fontWeight = FontWeight.SemiBold, color = cs.onSurface, modifier = Modifier.padding(vertical = 10.dp))
        CardBlock(title = "Appearance") {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text("Theme", fontSize = 13.sp, color = cs.onSurfaceVariant, modifier = Modifier.width(64.dp))
                SegChip("System", themeMode == ThemeMode.FOLLOW_SYSTEM, true) { onThemeModeChange(ThemeMode.FOLLOW_SYSTEM) }
                Spacer(Modifier.width(8.dp))
                SegChip("Light", themeMode == ThemeMode.LIGHT, true) { onThemeModeChange(ThemeMode.LIGHT) }
                Spacer(Modifier.width(8.dp))
                SegChip("Dark", themeMode == ThemeMode.DARK, true) { onThemeModeChange(ThemeMode.DARK) }
            }
            Spacer(Modifier.height(6.dp))
            Text("When following the system, dark-mode switches apply instantly", fontSize = 12.sp, color = dimColor())
        }
        Spacer(Modifier.height(12.dp))
        CardBlock(title = "Connection info") {
            SettingRow("Provider", if (provider == "zai") "Z.AI" else "Zhipu")
            SettingRow("Plan", plan)
            SettingRow(
                "Status",
                when {
                    proxyRunning -> "127.0.0.1:$proxyPort · Running"
                    reachable -> "Not started"
                    else -> "Node not responding"
                },
                valueColor = if (proxyRunning) successColor() else cs.onSurface,
            )
            SettingRow("Login", if (loggedIn) "Logged in" else "Not logged in")
            Spacer(Modifier.height(4.dp))
            Text("Switch provider/plan on the Home "Connection" card", fontSize = 12.sp, color = dimColor())
        }
        Spacer(Modifier.height(12.dp))
        CardBlock(title = "About") {
            SettingRow("App", "ZCode Proxy")
            SettingRow("Version", currentVersion ?: "—")
            SettingRow("Control protocol", "Node · 127.0.0.1 loopback only")
            Spacer(Modifier.height(6.dp))
            Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth()) {
                Column(Modifier.weight(1f)) {
                    Text("Auto-check for updates", fontSize = 14.sp, color = cs.onSurfaceVariant)
                    Text("Query GitHub Releases at startup", fontSize = 12.sp, color = dimColor())
                }
                Switch(checked = autoCheckUpdate, onCheckedChange = onAutoCheckUpdateChange)
            }
            val (updateText, updateColor) = when {
                updateChecking -> "Checking…" to dimColor()
                updateInfo != null ->
                    if (UpdateChecker.isNewer(currentVersion, updateInfo.tag)) {
                        "${updateInfo.tag} available" to cs.primary
                    } else {
                        "Up to date (${updateInfo.tag})" to successColor()
                    }
                updateCheckFailed -> "Check failed · GitHub unreachable" to cs.error
                else -> "Not checked" to dimColor()
            }
            Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth()) {
                Text("Updates", fontSize = 14.sp, color = cs.onSurfaceVariant)
                Spacer(Modifier.width(12.dp))
                Text(updateText, fontSize = 13.sp, color = updateColor, modifier = Modifier.weight(1f))
                TextButton(onClick = onCheckUpdate, enabled = !updateChecking) {
                    Text(if (updateChecking) "Checking…" else "Check for updates", fontSize = 13.sp)
                }
            }
            Spacer(Modifier.height(4.dp))
            Text("Updates come from GitHub Releases · KilimcininKorOglu/zcode-api", fontSize = 12.sp, color = dimColor())
            Text("Upstream: Z.AI / Zhipu open platform (OAuth login)", fontSize = 12.sp, color = dimColor())
        }
    }
}

@Composable
private fun CardBlock(title: String, content: @Composable () -> Unit) {
    val cs = MaterialTheme.colorScheme
    Column(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(24.dp))
            .background(cs.surfaceContainerLow)
            .padding(16.dp),
    ) {
        Text(title, fontSize = 16.sp, fontWeight = FontWeight.SemiBold, color = cs.onSurface)
        HorizontalDivider(color = cs.outlineVariant, thickness = 1.dp, modifier = Modifier.padding(vertical = 12.dp))
        content()
    }
}

@Composable
private fun SettingRow(label: String, value: String, valueColor: Color = MaterialTheme.colorScheme.onSurface) {
    Row(Modifier.fillMaxWidth().padding(vertical = 6.dp)) {
        Text(label, fontSize = 14.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Spacer(Modifier.weight(1f))
        Text(value, fontSize = 14.sp, fontWeight = FontWeight.Medium, color = valueColor)
    }
}

@Composable
private fun NavItem(label: String, icon: androidx.compose.ui.graphics.vector.ImageVector, selected: Boolean, modifier: Modifier = Modifier, onClick: () -> Unit) {
    val cs = MaterialTheme.colorScheme
    Column(
        modifier
            .fillMaxSize()
            .clickable(onClick = onClick),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        Box(
            Modifier
                .clip(RoundedCornerShape(50))
                .background(if (selected) cs.secondaryContainer else Color.Transparent)
                .padding(horizontal = 16.dp, vertical = 2.dp),
        ) {
            Icon(
                icon,
                contentDescription = label,
                tint = if (selected) cs.primary else cs.onSurfaceVariant,
                modifier = Modifier.size(22.dp),
            )
        }
        Text(
            label,
            fontSize = 11.sp,
            fontWeight = if (selected) FontWeight.SemiBold else FontWeight.Normal,
            color = if (selected) cs.primary else cs.onSurfaceVariant,
        )
    }
}

@Composable
private fun SegChip(
    text: String,
    selected: Boolean,
    enabled: Boolean,
    modifier: Modifier = Modifier,
    fill: Boolean = false,
    mono: Boolean = false,
    onClick: () -> Unit,
) {
    val cs = MaterialTheme.colorScheme
    Surface(
        onClick = onClick,
        enabled = enabled,
        shape = RoundedCornerShape(50),
        color = if (selected) cs.primary else cs.background,
        border = if (selected) null else BorderStroke(1.dp, cs.outlineVariant),
        modifier = modifier
            .then(if (fill) Modifier.fillMaxWidth() else Modifier)
            .semantics { testTag = "seg_$text" },
    ) {
        Text(
            text,
            fontFamily = if (mono) Mono else null,
            fontSize = if (mono) 12.sp else 13.sp,
            fontWeight = if (selected) FontWeight.SemiBold else FontWeight.Normal,
            color = when {
                selected -> cs.onPrimary
                !enabled -> cs.onSurfaceVariant.copy(alpha = 0.5f)
                else -> cs.onSurfaceVariant
            },
            textAlign = if (fill) TextAlign.Center else null,
            maxLines = 1,
            modifier = Modifier
                .padding(horizontal = if (mono) 8.dp else 16.dp, vertical = 8.dp)
                .then(if (fill) Modifier.fillMaxWidth() else Modifier),
        )
    }
}

@Composable
private fun StatusDot(color: Color, pulse: Boolean) {
    if (pulse) {
        val alpha by rememberInfiniteTransition(label = "statusPulse").animateFloat(
            initialValue = 0.12f,
            targetValue = 0.4f,
            animationSpec = infiniteRepeatable(tween(1100, easing = LinearEasing), RepeatMode.Reverse),
            label = "statusPulseAlpha",
        )
        Box(contentAlignment = Alignment.Center) {
            Box(Modifier.size(24.dp).clip(CircleShape).background(color.copy(alpha = alpha)))
            Box(Modifier.size(12.dp).clip(CircleShape).background(color))
        }
    } else {
        Box(Modifier.size(12.dp).clip(CircleShape).background(color))
    }
}

/**
 * Plan-usage row. When `progress == null` only the track is drawn (no ratio data to draw).
 * `striped = true` is the time progress bar for coding count windows (fill = time-until-reset progress, striped) —
 * fallback only when upstream omits percentage; with percentage a solid remaining-ratio bar is used (same semantics as credit bars).
 * Values always start with the remainder (upstream number may be dirty; never render X/Y, see live data pr56/#57).
 */
private data class QuotaRowUi(
    val label: String,
    val value: String,
    val progress: Float?,
    val striped: Boolean,
    /** Credit/remaining-ratio band: 0 healthy / 1 low (<=30%) / 2 critical (<=10%); time progress bars are always 0. */
    val warnLevel: Int = 0,
    /** Inline reset hint (e.g. "in 1h 54m" / "expires 2026-12-31"); null hides it. */
    val resetText: String? = null,
)

private data class QuotaUi(
    /** Coding tier string (data.level, e.g. "max"); credit plans have no tier → null. */
    val level: String?,
    val rows: List<QuotaRowUi>,
    /** Snapshot serverTime (epoch ms) — time progress bars use server time as "now" to avoid device clock skew. */
    val nowMs: Long,
)

@Composable
private fun QuotaBlock(
    loggedIn: Boolean,
    quotaUi: QuotaUi?,
    status: String,
    errorMsg: String,
    uptimeText: String?,
    onRefresh: () -> Unit,
) {
    val cs = MaterialTheme.colorScheme
    Column(
        Modifier
            .fillMaxWidth()
            .clickable(enabled = loggedIn, onClick = onRefresh),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text("Plan usage", fontSize = 11.sp, color = cs.onPrimaryContainer.copy(alpha = 0.65f))
            quotaUi?.level?.let { level ->
                Spacer(Modifier.width(8.dp))
                Surface(shape = RoundedCornerShape(50), color = cs.primary.copy(alpha = 0.14f)) {
                    Text(
                        level,
                        fontFamily = Mono,
                        fontSize = 10.sp,
                        fontWeight = FontWeight.SemiBold,
                        color = cs.onPrimaryContainer,
                        modifier = Modifier.padding(horizontal = 8.dp, vertical = 2.dp),
                    )
                }
            }
            Spacer(Modifier.weight(1f))
            Text(
                uptimeText?.let { "UP $it" } ?: "UP —",
                fontFamily = Mono,
                fontSize = 11.sp,
                color = cs.onPrimaryContainer.copy(alpha = 0.65f),
            )
        }
        Spacer(Modifier.height(12.dp))
        val ui = quotaUi
        when {
            !loggedIn -> QuotaHint("Log in to view plan usage")
            status == "loading" && ui == null -> QuotaPlaceholderRows()
            status == "error" -> Column {
                QuotaHint(if (errorMsg.isBlank()) "Failed to load usage" else "Failed to load usage · $errorMsg")
                Spacer(Modifier.height(4.dp))
                Text(
                    "Tap to retry",
                    fontSize = 11.sp,
                    fontWeight = FontWeight.Medium,
                    color = cs.primary,
                )
            }
            else -> {
                // quotaUi is a delegated property (by remember), no smart cast — read row lists explicitly as fallback
                val rows = ui?.rows.orEmpty()
                if (rows.isEmpty()) {
                    QuotaHint("No usage data · tap refresh")
                } else {
                    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                        rows.forEach { QuotaRow(it) }
                    }
                }
            }
        }
    }
}

@Composable
private fun QuotaHint(text: String) {
    Text(
        text,
        fontSize = 11.sp,
        color = MaterialTheme.colorScheme.onPrimaryContainer.copy(alpha = 0.5f),
        maxLines = 1,
        overflow = TextOverflow.Ellipsis,
    )
}

@Composable
private fun QuotaPlaceholderRows() {
    val cs = MaterialTheme.colorScheme
    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
        listOf(LABEL_5H, LABEL_WEEK).forEach { label ->
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    label,
                    fontSize = 12.sp,
                    fontWeight = FontWeight.SemiBold,
                    color = cs.onPrimaryContainer.copy(alpha = 0.5f),
                )
                Spacer(Modifier.width(10.dp))
                Box(
                    Modifier
                        .weight(1f)
                        .height(6.dp)
                        .clip(RoundedCornerShape(3.dp))
                        .background(cs.onPrimaryContainer.copy(alpha = 0.08f)),
                )
                Spacer(Modifier.width(10.dp))
                Text(
                    "…",
                    fontFamily = Mono,
                    fontSize = 12.sp,
                    color = cs.onPrimaryContainer.copy(alpha = 0.4f),
                )
            }
        }
    }
}

@Composable
private fun QuotaRow(row: QuotaRowUi) {
    val cs = MaterialTheme.colorScheme
    val barColor = if (row.striped) {
        cs.primary
    } else {
        when (row.warnLevel) {
            1 -> warningColor()
            2 -> cs.error
            else -> cs.primary
        }
    }
    val valueColor = if (row.striped) cs.onPrimaryContainer else barColor
    Row(verticalAlignment = Alignment.CenterVertically) {
        Text(
            row.label,
            fontSize = 12.sp,
            fontWeight = FontWeight.SemiBold,
            color = cs.onPrimaryContainer,
            maxLines = 1,
        )
        Spacer(Modifier.width(10.dp))
        QuotaBar(
            progress = row.progress,
            striped = row.striped,
            color = barColor,
            modifier = Modifier.weight(1f),
        )
        Spacer(Modifier.width(10.dp))
        Column(horizontalAlignment = Alignment.End) {
            Text(
                row.value,
                fontFamily = Mono,
                fontSize = 12.sp,
                fontWeight = FontWeight.SemiBold,
                color = valueColor,
            )
            row.resetText?.let { reset ->
                Text(
                    reset,
                    fontFamily = Mono,
                    fontSize = 10.sp,
                    color = cs.onPrimaryContainer.copy(alpha = 0.55f),
                )
            }
        }
    }
}

@Composable
private fun QuotaBar(progress: Float?, striped: Boolean, color: Color, modifier: Modifier = Modifier) {
    // Mock spec: track primary@12%; coding stripes = 8dp period / 4dp bar (45% over 15% base);
    // credit solid bars shrink with the remainder and recolor by threshold. 3dp corners handled by clip.
    Canvas(modifier.height(6.dp).clip(RoundedCornerShape(3.dp))) {
        drawRect(color.copy(alpha = 0.12f))
        progress?.let { p ->
            val w = size.width * p.coerceIn(0f, 1f)
            if (w <= 0f) return@let
            if (striped) {
                drawRect(color.copy(alpha = 0.15f), size = Size(w, size.height))
                val period = 8.dp.toPx()
                val stripe = 4.dp.toPx()
                var x = 0f
                while (x < w) {
                    drawRect(
                        color.copy(alpha = 0.45f),
                        topLeft = Offset(x, 0f),
                        size = Size(minOf(stripe, w - x), size.height),
                    )
                    x += period
                }
            } else {
                drawRect(color, size = Size(w, size.height))
            }
        }
    }
}

/** Epoch seconds and millis both seen upstream: >1e12 is treated as millis. */
private fun toEpochMs(v: Long): Long = if (v > 1_000_000_000_000L) v else v * 1000L

private fun optStringOrNull(o: JSONObject, key: String): String? {
    if (!o.has(key) || o.isNull(key)) return null
    return o.optString(key, "").trim().ifBlank { null }
}

private fun optNumberOrNull(o: JSONObject, key: String): Double? {
    if (!o.has(key) || o.isNull(key)) return null
    return o.optDouble(key).takeUnless { it.isNaN() }
}

private fun optEpochMsOrNull(o: JSONObject, key: String): Long? =
    optNumberOrNull(o, key)?.toLong()?.let(::toEpochMs)

/**
 * Assemble the usage block view. The plane follows the home plan switch (coding-plan → monitor windows / start-plan →
 * billing credit buckets), falling back to the other plane when the preferred one has no rows; level is attached only when coding rows are used.
 */
private fun parseQuota(resp: JSONObject, plan: String): QuotaUi? {
    if (!resp.optBoolean("ok", false)) return null
    val quota = resp.optJSONObject("quota") ?: return null
    val nowMs = optNumberOrNull(quota, "serverTime")?.toLong()
        ?.let { if (it > 0) toEpochMs(it) else System.currentTimeMillis() }
        ?: System.currentTimeMillis()
    val coding = quota.optJSONObject("codingPlan")
    val balances = quota.optJSONArray("balances")
    val codingRowsList = codingRows(coding, nowMs)
    val creditRowsList = creditRows(balances, nowMs)
    val level = coding?.let { optStringOrNull(it, "level") }
    return if (plan == "coding-plan") {
        if (codingRowsList.isNotEmpty()) QuotaUi(level, codingRowsList, nowMs)
        else QuotaUi(null, creditRowsList, nowMs)
    } else {
        if (creditRowsList.isNotEmpty()) QuotaUi(null, creditRowsList, nowMs)
        else QuotaUi(level, codingRowsList, nowMs)
    }
}

/** Minimal normalized row set for the monitor plane limits[] (only fields used for rendering). */
private data class CodingLimitRow(
    val type: String,
    val unit: String?,
    val remaining: Double?,
    val resetMs: Long?,
    /** Upstream percentage = used ratio (0-100); missing/out-of-range → null. Live data 2026-09-30: 2/3/60. */
    val percentage: Double?,
)

/** Window-name fallback: rows without reset time fall back to the friendly type name; never show raw TIME_LIMIT. */
private fun friendlyWindowType(type: String): String = when (type) {
    "TOKENS_LIMIT" -> "Token"
    "TIME_LIMIT" -> "Cycle"
    else -> type.take(10)
}

/**
 * Coding window rows. Window names follow ascending-reset rank + horizon check (5h → Weekly → Monthly) —
 * pinned with live data (2026-09-30, max tier): the three windows reset in 4h30m / 3d18h / 14d, landing on the three
 * ranks, and the 5h/Weekly rows are TOKENS_LIMIT rows (labeling by type would misplace them). Bars draw the remaining ratio
 * (falling back to time-progress stripes for 5h/Weekly when percentage is missing); value = remaining count or remaining P%.
 */
private fun codingRows(coding: JSONObject?, nowMs: Long): List<QuotaRowUi> {
    val limits = coding?.optJSONArray("limits") ?: return emptyList()
    val parsed = buildList {
        for (i in 0 until limits.length()) {
            val o = limits.optJSONObject(i) ?: continue
            val type = optStringOrNull(o, "type") ?: continue
            add(
                CodingLimitRow(
                    type,
                    optStringOrNull(o, "unit"),
                    optNumberOrNull(o, "remaining"),
                    optEpochMsOrNull(o, "nextResetTime"),
                    optNumberOrNull(o, "percentage")?.takeIf { it in 0.0..100.0 },
                ),
            )
        }
    }.sortedWith(compareBy { it.resetMs ?: Long.MAX_VALUE })
    val chosen = parsed.take(3)
    if (chosen.isEmpty()) return emptyList()
    return chosen.mapIndexed { i, l ->
        val horizon = l.resetMs?.let { it - nowMs }
        val label = when {
            i == 0 && horizon != null && horizon <= 6 * 3600_000L -> LABEL_5H
            i == 1 && horizon != null && horizon <= 8 * 86_400_000L -> LABEL_WEEK
            i == 2 && horizon != null && horizon <= 45 * 86_400_000L -> "Monthly"
            horizon == null -> friendlyWindowType(l.type)
            horizon in 0..(45 * 86_400_000L) -> "Monthly"
            else -> "Cycle"
        }
        // percentage = used ratio (self-consistent live signal; total/number are dirty, never fabricate X/Y)
        val remainingFrac = l.percentage?.let { ((100f - it.toFloat()) / 100f).coerceIn(0f, 1f) }
        val progress = remainingFrac ?: when (label) {
            LABEL_5H -> l.resetMs?.let { (1f - (it - nowMs).toFloat() / FIVE_HOUR_WINDOW_MS).coerceIn(0f, 1f) }
            LABEL_WEEK -> l.resetMs?.let { (1f - (it - nowMs).toFloat() / WEEK_WINDOW_MS).coerceIn(0f, 1f) }
            else -> null
        }
        val warnLevel = when {
            remainingFrac == null -> 0
            remainingFrac <= 0.10f -> 2
            remainingFrac <= 0.30f -> 1
            else -> 0
        }
        val resetText = l.resetMs?.let { fmtResetCountdown(it, nowMs) }
        val value = when {
            l.remaining != null -> "${fmtCount(l.remaining.toLong())} ${l.unit ?: "left"}"
            remainingFrac != null -> "${(remainingFrac * 100).toInt()}% left"
            else -> "—"
        }
        QuotaRowUi(
            label,
            value,
            progress,
            striped = remainingFrac == null,
            warnLevel = warnLevel,
            resetText = resetText,
        )
    }
}

/** Minimal normalized row set for the billing plane balances[]. */
private data class CreditBucket(
    val showName: String,
    val remaining: Double,
    val total: Double,
    val expiresMs: Long?,
)

/**
 * Credit bucket rows. Target shape (pinned to user/official panels): 5h + Weekly windows, single total pool.
 * Bucket → window mapping uses ascending expiry: only buckets expiring within 8h use window labels, otherwise (trial-plan
 * long-lived buckets) fall back to showName labels — with fewer than 2 buckets or mismatched shapes, degrade honestly instead of forcing window semantics.
 */
private fun creditRows(balances: JSONArray?, nowMs: Long): List<QuotaRowUi> {
    val arr = balances ?: return emptyList()
    val list = buildList {
        for (i in 0 until arr.length()) {
            val o = arr.optJSONObject(i) ?: continue
            add(
                CreditBucket(
                    optStringOrNull(o, "showName") ?: "",
                    optNumberOrNull(o, "remainingUnits") ?: 0.0,
                    optNumberOrNull(o, "totalUnits") ?: 0.0,
                    optEpochMsOrNull(o, "expiresAt"),
                ),
            )
        }
    }.sortedWith(compareBy { it.expiresMs ?: Long.MAX_VALUE })
    if (list.isEmpty()) return emptyList()
    val nearestExpiry = list[0].expiresMs
    val windowed = list.size >= 2 &&
        nearestExpiry != null &&
        nearestExpiry <= nowMs + 8 * 60 * 60 * 1000L
    return list.take(2).mapIndexed { i, b ->
        val label = when {
            windowed -> if (i == 0) LABEL_5H else LABEL_WEEK
            list.size == 1 -> b.showName.ifBlank { "Total" }.take(10)
            else -> b.showName.ifBlank { "Quota" }.take(10)
        }
        val progress = if (b.total > 0) (b.remaining / b.total).toFloat().coerceIn(0f, 1f) else null
        val frac = if (b.total > 0) b.remaining / b.total else 1.0
        val warnLevel = when {
            b.total <= 0.0 -> 0
            frac <= 0.10 -> 2
            frac <= 0.30 -> 1
            else -> 0
        }
        // Window buckets show the reset countdown; long-lived buckets (trial plans) show the expiry date instead
        val resetText = b.expiresMs?.let { exp ->
            if (windowed || exp - nowMs <= 7 * 24 * 60 * 60 * 1000L) {
                fmtResetCountdown(exp, nowMs)
            } else {
                fmtExpiryDate(exp)
            }
        }
        QuotaRowUi(
            label,
            "${fmtCredit(b.remaining.toLong())} / ${fmtCredit(b.total.toLong())}",
            progress,
            striped = false,
            warnLevel = warnLevel,
            resetText = resetText,
        )
    }
}

/** `3,894` — full-precision thousands separators (contract for count values, same semantics as TUI fmtUnits). */
private fun fmtCount(n: Long): String =
    DecimalFormat("#,###", DecimalFormatSymbols(Locale.US)).format(n)

/** Reset countdown: `in 1h 54m` / `in 3d 06h` / past → `resetting soon`. */
private fun fmtResetCountdown(resetMs: Long, nowMs: Long): String {
    val diff = resetMs - nowMs
    if (diff <= 0) return "resetting soon"
    val minutes = diff / 60000L
    return when {
        minutes >= 1440 -> "in %dd %02dh".format(minutes / 1440, (minutes % 1440) / 60)
        minutes >= 60 -> "in %dh %02dm".format(minutes / 60, minutes % 60)
        else -> "in ${minutes}m"
    }
}

/** Long-lived bucket expiry hint: `expires 2026-12-31`. */
private fun fmtExpiryDate(expMs: Long): String =
    java.text.SimpleDateFormat("yyyy-MM-dd", Locale.US).format(java.util.Date(expMs)) + " expiry"

/** Compact credit display: >=1e8 Yi / >=1e4 Wan (e.g. 6.4W / 10W), otherwise thousands separators. */
private fun fmtCredit(n: Long): String = when {
    n >= 100_000_000L -> trimScale(n / 1e8) + "Y"
    n >= 10_000L -> trimScale(n / 1e4) + "W"
    else -> fmtCount(n)
}

private fun trimScale(v: Double): String {
    val s = String.format(Locale.US, "%.1f", v)
    return if (s.endsWith(".0")) s.dropLast(2) else s
}

@Composable
private fun CopyGlyph(color: Color) {
    Box(Modifier.size(15.dp)) {
        Box(
            Modifier
                .align(Alignment.TopStart)
                .size(width = 10.dp, height = 12.dp)
                .border(1.5.dp, color, RoundedCornerShape(2.dp)),
        )
        Box(
            Modifier
                .align(Alignment.BottomEnd)
                .size(width = 10.dp, height = 12.dp)
                .clip(RoundedCornerShape(2.dp))
                .background(color),
        )
    }
}

/** Open URLs via Custom Tabs, falling back to system ACTION_VIEW when unsupported; silent on further failure (shared by login/update downloads). */
private fun openInBrowser(context: android.content.Context, url: String) {
    val customTabsIntent = androidx.browser.customtabs.CustomTabsIntent.Builder()
        .setShowTitle(true)
        .build()
    try {
        customTabsIntent.launchUrl(context, android.net.Uri.parse(url))
    } catch (e: Exception) {
        val fallback = android.content.Intent(android.content.Intent.ACTION_VIEW, android.net.Uri.parse(url))
        fallback.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK)
        try {
            context.startActivity(fallback)
        } catch (_: Exception) {
        }
    }
}

private fun formatDuration(ms: Long): String {
    val totalSeconds = ms / 1000
    val h = totalSeconds / 3600
    val m = (totalSeconds % 3600) / 60
    val s = totalSeconds % 60
    return "%02d:%02d:%02d".format(h, m, s)
}
