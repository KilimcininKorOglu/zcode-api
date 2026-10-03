package com.zcode.proxy.ui.theme

import androidx.compose.material3.Typography
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import com.zcode.proxy.R

/**
 * Monospace font for data voices (addresses / numbers / logs): JetBrains Mono (SIL OFL 1.1,
 * full license in Android-APP/fonts-OFL.txt). CJK glyphs fall back to system fonts.
 */
val Mono = FontFamily(
    Font(R.font.jetbrainsmono_regular, FontWeight.Normal),
    Font(R.font.jetbrainsmono_medium, FontWeight.Medium),
    Font(R.font.jetbrainsmono_semibold, FontWeight.SemiBold),
    Font(R.font.jetbrainsmono_bold, FontWeight.Bold),
)

val AppTypography = Typography()
