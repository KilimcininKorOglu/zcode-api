package com.zcode.proxy.ui.theme

import android.app.Activity
import android.content.Context
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Shapes
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.Density
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.unit.dp
import androidx.core.view.WindowCompat

/** Three appearance modes: follow system (default) / light / dark. Preference stored in SharedPreferences. */
enum class ThemeMode {
    FOLLOW_SYSTEM,
    LIGHT,
    DARK,
}

/** Effective dark state (incl. manual override); components use it for dark-only tweaks (e.g. icon padding). */
val LocalDarkTheme = staticCompositionLocalOf { false }

@Composable
fun isDarkTheme(): Boolean = LocalDarkTheme.current

object ThemePrefs {
    private const val PREFS = "ui_prefs"
    private const val KEY_THEME_MODE = "theme_mode"

    fun load(context: Context): ThemeMode {
        val ordinal = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .getInt(KEY_THEME_MODE, ThemeMode.FOLLOW_SYSTEM.ordinal)
        return ThemeMode.entries.getOrElse(ordinal) { ThemeMode.FOLLOW_SYSTEM }
    }

    fun save(context: Context, mode: ThemeMode) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit()
            .putInt(KEY_THEME_MODE, mode.ordinal)
            .apply()
    }
}

private val LightColors = lightColorScheme(
    primary = LightPrimary,
    onPrimary = LightOnPrimary,
    primaryContainer = LightPrimaryContainer,
    onPrimaryContainer = LightOnPrimaryContainer,
    secondary = LightSecondary,
    onSecondary = Color(0xFFFFFFFF),
    secondaryContainer = LightSecondaryContainer,
    onSecondaryContainer = LightOnSecondaryContainer,
    tertiary = LightTertiary,
    onTertiary = LightOnTertiary,
    error = LightError,
    onError = LightOnError,
    background = LightSurface,
    onBackground = LightOnSurface,
    surface = LightSurface,
    onSurface = LightOnSurface,
    surfaceVariant = LightSurfaceContainerLow,
    onSurfaceVariant = LightOnSurfaceVariant,
    outline = LightOutline,
    outlineVariant = LightOutlineVariant,
    surfaceContainerLowest = LightSurfaceContainerLowest,
    surfaceContainerLow = LightSurfaceContainerLow,
    surfaceContainer = LightSurfaceContainer,
    surfaceContainerHigh = LightSurfaceContainerHigh,
    surfaceContainerHighest = LightSurfaceContainerHighest,
)

private val DarkColors = darkColorScheme(
    primary = DarkPrimary,
    onPrimary = DarkOnPrimary,
    primaryContainer = DarkPrimaryContainer,
    onPrimaryContainer = DarkOnPrimaryContainer,
    secondary = DarkSecondary,
    onSecondary = Color(0xFF07161F),
    secondaryContainer = DarkSecondaryContainer,
    onSecondaryContainer = DarkOnSecondaryContainer,
    tertiary = DarkTertiary,
    onTertiary = DarkOnTertiary,
    error = DarkError,
    onError = DarkOnError,
    background = DarkSurface,
    onBackground = DarkOnSurface,
    surface = DarkSurface,
    onSurface = DarkOnSurface,
    surfaceVariant = DarkSurfaceContainerLow,
    onSurfaceVariant = DarkOnSurfaceVariant,
    outline = DarkOutline,
    outlineVariant = DarkOutlineVariant,
    surfaceContainerLowest = DarkSurfaceContainerLowest,
    surfaceContainerLow = DarkSurfaceContainerLow,
    surfaceContainer = DarkSurfaceContainer,
    surfaceContainerHigh = DarkSurfaceContainerHigh,
    surfaceContainerHighest = DarkSurfaceContainerHighest,
)

private val AppShapes = Shapes(
    extraSmall = RoundedCornerShape(6.dp),
    small = RoundedCornerShape(10.dp),
    medium = RoundedCornerShape(20.dp),
    large = RoundedCornerShape(24.dp),
    extraLarge = RoundedCornerShape(28.dp),
)

/** Global visual scale: shrink everything 5% (dp+sp together) so narrow screens are not squeezed. */
private const val UiScale = 0.95f

/**
 * Follow-system sync chain: system dark toggle → Configuration.uiMode change →
 * MainActivity declares no configChanges, so the Activity is recreated → isSystemInDarkTheme()
 * recomposes with the new value. Manual three-way overrides are persisted by the caller and passed via [themeMode].
 */
@Composable
fun ZcodeTheme(
    themeMode: ThemeMode = ThemeMode.FOLLOW_SYSTEM,
    content: @Composable () -> Unit,
) {
    val dark = when (themeMode) {
        ThemeMode.FOLLOW_SYSTEM -> isSystemInDarkTheme()
        ThemeMode.LIGHT -> false
        ThemeMode.DARK -> true
    }
    val colorScheme = if (dark) DarkColors else LightColors
    val view = LocalView.current
    if (!view.isInEditMode) {
        SideEffect {
            val window = (view.context as Activity).window
            WindowCompat.getInsetsController(window, view).apply {
                isAppearanceLightStatusBars = !dark
                isAppearanceLightNavigationBars = !dark
            }
        }
    }
    val baseDensity = LocalDensity.current
    CompositionLocalProvider(
        LocalDensity provides Density(baseDensity.density * UiScale, baseDensity.fontScale * UiScale),
        LocalDarkTheme provides dark,
    ) {
        MaterialTheme(
            colorScheme = colorScheme,
            typography = AppTypography,
            shapes = AppShapes,
            content = content,
        )
    }
}

/** Semantic color shortcuts: online/success = pine green, 429/waiting = ochre. */
val lightSuccess = Color(0xFF21A675)
val darkSuccess = Color(0xFF5BC89B)
val lightWarning = Color(0xFFA9760B)
val darkWarning = Color(0xFFE0BC5E)

@Composable
fun successColor(): Color = if (isSystemInDarkTheme()) darkSuccess else lightSuccess

@Composable
fun warningColor(): Color = if (isSystemInDarkTheme()) darkWarning else lightWarning

/** Muted text inside cards (dimmed logs / hints). */
@Composable
fun dimColor(): Color = if (isSystemInDarkTheme()) DarkDim else LightDim
