# Android App UI Redesign Plan

> Status: design phase (one of three to be picked)
> Preview size: **1080 x 2400 (20:9, mainstream slab FHD+, e.g. Pixel 8 / Redmi K70 / OnePlus Ace series)**
> Preview files: `Android-APP/design/previews/option-{a,b,c}-{light,dark}.svg`

---

## 1. Current state and problems (based on the existing `MainActivity.kt`)

| # | Problem | Current state |
|---|------|------|
| 1 | Single scrolling column of three cards, no navigation | Settings&Login / Proxy Control / Logs all squeezed on one screen; log area `heightIn(max=600dp)` crushed by content above |
| 2 | Default Material baseline theme | `MaterialTheme {}` passes no `colorScheme` — purple baseline + hand-written hardcoded colors (`0xFF16A34A` etc.), no brand feel, inconsistent light/dark behavior |
| 3 | Weak status expression | One small `StatusPill` carries all reachable/loggedIn semantics; proxy running state is a single small line |
| 4 | Unfriendly logs | 11sp monospace squeezed in a small card, no filter/copy/clear |
| 5 | No edge-to-edge, no motion | Default layout, no system-bar adaptation, no status motion |

## 2. Information architecture (shared by all three options, only the skin changes)

```
MainActivity
├── Home tab (default) ────────────────────────┐
│   Top: app name + status pill + settings entry│
│   (1) Run hero card: status light + Running/Stopped │ ← status/startProxy/stopProxy
│      127.0.0.1:{port} (tap to copy) + uptime  │
│      Big button: Start proxy / Stop proxy     │
│   (2) Account card: provider·plan, login state│ ← startOAuth/logout
│      OAuth login/logout button on the right of this card │ (whole card becomes a login CTA when logged out)
│   (3) Connection card: provider Z.AI/Zhipu segmented switch, │ ← setConfig
│      plan coding-plan/start-plan segmented switch; │
│      locked with a hint while the proxy runs   │
│   (4) Live log preview (last 5 lines + error count, │ ← getLogs polling
│      tap to open the Logs tab)                 │
├── Logs tab: full-screen log console (mono, status coloring, │
│   All/Success/Errors filter chips, copy/clear/auto-scroll) │
└── Settings tab: port, appearance (system/light/dark),     │
    about (version/control protocol) — provider/plan moved to Home │
```

All 8 `ControlClient` commands (status/startOAuth/deliverOAuthCode/setConfig/startProxy/stopProxy/getLogs/logout) have a home; the polling architecture (1.5s status + incremental getLogs) stays unchanged — only the presentation layer is rebuilt.

## 3. Auto light/dark: technical approach (researched, Compose-native)

1. **Follow system (default)**: `MaterialTheme(colorScheme = if (isSystemInDarkTheme()) darkScheme else lightScheme)`. `isSystemInDarkTheme()` reads the system `UI_MODE_NIGHT_*`; when the user flips dark mode in the system shortcut **the Activity recreates/recomposes automatically with no hand-written listener**.
2. **Brand palette first, Material You dynamic color second**: on Android 12+ offer a "use wallpaper colors" switch, `dynamicLightColorScheme(context)` / `dynamicDarkColorScheme(context)`; below 12 or with the switch off, fall back to this plan's brand palette (per-option light/dark tokens, see previews).
3. **System-bar adaptation**: `enableEdgeToEdge()` + `WindowCompat.getInsetsController(...).isAppearanceLightStatusBars = !darkTheme`; status-bar icons turn white automatically in dark mode, content draws behind status/gesture bars.
4. **Manual overrides** (Appearance on the settings page: System / Light / Dark): preference stored in DataStore; implementation owns a `ThemeMode` state (falls back to `isSystemInDarkTheme()` when following the system), no `AppCompatDelegate` needed (pure Compose app has no AppCompat dependency).
5. **Resource-layer fallback**: XML launch screens/icons adapted via `values-night/` in sync (optional, not the focus here).
6. **Verified empirically (2026-09-03, not from memory)**: calling `MaterialTheme {}` with no args does **not** follow system dark mode. Verified from the Google Maven BOM 2024.12.01 POM and material3-android 1.3.1 sources jar: the BOM maps material3 **1.3.1**; its `MaterialTheme(colorScheme = MaterialTheme.colorScheme, ...)` only inherits the parent theme, falling back to `LocalColorScheme = staticCompositionLocalOf { lightColorScheme() }` (`ColorScheme.kt:989`) with no parent, and `MaterialTheme.kt` contains **zero** `isSystemInDarkTheme` references in the whole file. **I.e. the current shipping APK is always on the light palette even under system dark mode.** Following the system requires an explicit `isSystemInDarkTheme()` (what this design does).
    - Sync chain: system dark toggle (quick tile / battery saver / schedule) → `Configuration.uiMode` change → Manifest declares no `configChanges` → **Activity recreated** → `isSystemInDarkTheme()` (= `LocalConfiguration.uiMode and UI_MODE_NIGHT_MASK == UI_MODE_NIGHT_YES`) recomposes with the new value.
    - Drive-by fix: `Theme.ZcodeProxy` currently hardcodes `android:Theme.Material.NoActionBar` (light window background), flashing white at launch under dark mode → add `values-night/themes.xml` (the framework `android:Theme.Material.NoActionBar` is already the dark variant). Status-bar icon contrast: `enableEdgeToEdge()`'s `SystemBarStyle.auto` re-applies automatically on config change (activity 1.9.3), with an explicit `SideEffect { isAppearanceLightStatusBars = !darkTheme }` fallback inside `ZcodeTheme`.

> The rest of this rule (SVG previews) renders one light token set + one dark token set per style, compared side by side.

## 4. Three candidate styles

### Option A — Material You · Native feel (Google-native direction)
- **Keywords**: Material 3 Expressive, tonal layered surfaces (surfaceContainer steps), large corners (26dp cards / full-round pills), optional dynamic color.
- **Colors**: indigo primary `#4C4FD8` (light purple `#C0C1FF` in dark); hero card uses a primaryContainer tonal surface.
- **Motion**: M3 elastic container transforms, breathing status dot, button ripples.
- **Fits**: matching the Android ecosystem exactly, lowest implementation cost, free wallpaper colors later.

### Option B — Aurora Glass (trendy, dark-first)
- **Keywords**: frosted translucent cards, aurora gradient background blobs, glowing status light, floating glass dock bottom bar, thin 1px highlight strokes.
- **Colors**: dark pine-black base `#060A09→#0D1210` + pine-green/rouge/teal blobs (real aurora: green-dominant with magenta edges); light is moon-white → lotus-pink pastel base + 80% white glass cards.
- **Motion**: slow blob drift (`withInfiniteAnimation`), glowing status pulse, card blur-in.
- **Fits**: a "wow at first sight" demo look; note Compose `Modifier.blur()`/RenderEffect glass has a perf budget — degrade on low-end devices.

### Option C — Terminal Console (developer-oriented, same brand language as the desktop TUI)
- **Keywords**: monospace data, tmux/vim-style top status line `● RUNNING │ 127.0.0.1:8080 │ ERR 0`, small-radius outlined panels, LED indicators, `[ ■ STOP ]` bracket buttons, log area as the hero (largest on screen, line numbers + level coloring); **the log terminal panel stays dark even in light mode** (same habit as a dark terminal inside a VS Code light theme).
- **Colors**: dark `#0B0D0F` base + terminal green `#3ECF8E` / cyan `#5CC8FF` / amber `#F5B657`; light paper white `#FAFAF7` + ink text.
- **Motion**: log typewriter append, LED blink, cursor blink.
- **Fits**: strong tool character, unified brand with the PC TUI (`src/tui/`); highest information density for log scenarios.

### Quick comparison

| Dimension | A Native | B Aurora Glass | C Terminal Console |
|------|-----------|-----------|-------------|
| First impression | Friendly, serious | Stunning, trendy | Hardcore, professional |
| Implementation cost | ★ lowest (pure M3 components) | ★★★ blur/RenderEffect + perf fallback | ★★ mostly custom components |
| Light/dark quality | Equal weight | Dark shines more | Equal weight (log area always dark) |
| Brand fit | Medium (Google flavor) | Low (generic trend) | High (echoes desktop TUI) |
| Information density | Medium | Medium-low | High |

## 5. Implementation split (after picking an option)

1. `ui/theme/{Color,Type,Shape,Theme}.kt`: two `ColorScheme` token sets + `ZcodeTheme(mode)` (follow system / DataStore override).
2. `ui/nav/`: `navigation-compose` bottom three tabs; MainActivity keeps only the skeleton + polling state fan-out.
3. Components: `StatusHeroCard` / `AccountCard` / `StatChipRow` / `LogConsole` (keep LazyColumn list virtualization) / `BottomNavBar`; toasts become SnackbarHost.
4. Replace the existing `AppScreen` implementation card by card; control protocol (`ControlClient`) untouched.
5. Acceptance: system dark toggle applies instantly; log page filter/copy works; `adb shell run-as com.zcode.proxy curl 127.0.0.1:<port>/status` integration (see anti-pattern #22).

## 6. Preview file list

```
Android-APP/design/
├── UI-REDESIGN-PLAN.md                    ← this file
└── previews/
    ├── option-a-material-you-light.svg    (1080×2400)
    ├── option-a-material-you-dark.svg
    ├── option-b-aurora-glass-light.svg
    ├── option-b-aurora-glass-dark.svg
    ├── option-c-terminal-light.svg
    └── option-c-terminal-dark.svg
```

Each preview shows the Home tab in the running state with identical content (run hero card / account card / stats / log preview / bottom nav) for side-by-side skin comparison.

## 7. Design quality calibration (v2, against Anthropic `frontend-design` skill)

One self-critical revision round using the anthropics/skills · frontend-design methodology: pin the subject first, then write a full token system per option (color/type/layout/signature element), and update all preview SVGs after clearing each "AI template default" item.

### 7.1 Subject grounding

- **Subject**: a local AI coding-agent reverse-proxy pipeline running on a phone (ZCode Proxy). **Audience**: the developer themselves. **This screen's only job**: confirm in 3 seconds that "the pipeline is alive and healthy", and see the traffic flowing through it.
- **Raw material of the subject's world**: ports and addresses, request streams (`#128 OAI glm-4.6 200 batch 1.0s` — reusing the desktop compact log vernacular verbatim), status-code semantic colors, terminals.
- **The sound of data is monospace**: unified across all three options — addresses/numbers/percentages/logs are all mono (JetBrains Mono, OFL-bundlable with the APK; CJK falls back to system fonts). This is the most on-subject font decision, not decoration.

### 7.2 Per-option token systems

> **Color source: traditional Chinese colors** (sky-blue, indigo, moon-white, crow-teal, lacquer-black, violet, stone-blue, rouge, pine-green, autumn-ochre, ochre-yellow, lotus-pink, frost-white, deep-black) — hues only, no pattern motifs; lightness tuned per WCAG, applied in a modern way. Semantic colors unified across options: **2xx = pine-green family, info = blue-cyan family, error/logout = rouge, 429/waiting = ochre**.

| | A Native | B Aurora Glass | C Terminal Console |
|---|---|---|---|
| Palette (traditional Chinese colors) | Surface frost-white `#F5F9FA` / Card moon-white `#E8F0F3` / indigo `#177CB0` / deep-teal `#123B4E` / crow-teal `#1F2A30` (dark: lacquer-black `#12181D`, crow-teal-black `#1C2429`, moonlight-blue `#7EC3DF`, deep-teal `#17475E`) | Pine-black `#060A09→#0D1210` / pine-green `#1E9E74` / rouge `#C2475E` / teal `#2E8F8A` (light: moon-white `#E9F3F5`→lotus `#F5E4ED`, deep pine `#0E8A5F`) | Deep-black `#0E1417` / crow-teal-black `#131C21` / pine-green `#2BC48A` / stone-blue `#56B8DC` / rouge `#E05561` (light: frost-white `#F4F7F6`, pine `#147A56`, indigo `#177CB0`, rouge `#A32E3C`) |
| Type roles | UI = system sans; data = JetBrains Mono | UI = system sans; data = JetBrains Mono; signature = Space Grotesk (wordmark/big numbers, OFL) | All mono (mono is the identity); CJK fallback |
| Layout in one line | Hero card = deep-teal tonal surface carrying "status + pulse", rest quiet | Blobs are the background hero, cards are glass floating on aurora | Log terminal is the hero (largest on screen), rest is its instrumentation |
| Signature element (the one bold move) | **Pipeline pulse**: ~60-minute request sparkline inside the hero card, breathing end dot | **Breathing aurora**: blobs pulse slowly with requests + glowing status light | **tail -f starring**: status line + LED + always-dark log terminal |
| One hero moment (motion) | Status light breathing + sparkline end-dot pulse, everything else follows M3 defaults | Blobs drift into place on entry, then only the status glow pulses | Log typewriter append + blinking cursor (the only motion) |

> SVG previews are typeset with approximate system fonts; real implementation bundles OFL fonts per the table above.

### 7.3 Clearing "AI default look" items

- Calibration reference default #2 "near-black + single acid green" was exactly the first-version risk for option C dark → **defense**: terminal language is pinned by the subject itself (same source as the desktop TUI); **differentiation**: green/cyan/red are semantic colors (2xx/info/error) running through the status line, stats top strip, and log coloring — not decorative accents; layout makes logs the hero instead of a number-card array; status line/LED/bracket buttons come from real TUI vocabulary.
- "Big numbers + small labels + gradient accent" template answer → option A's three stat cards demoted, hero card swapped to the subject-specific "pipeline pulse" sparkline; option B gradients reduced (quota bars, dock text, avatar halo changed to solids; gradients kept only at the three core spots: logo/main button/avatar).
- Decorative numbering → option C bottom bar's first-draft `[1][2][3]` F-key numbers had no real counterpart on phones, removed; Logs tab shows the real buffer line count (128) instead.
- Fake information → option C status line's right-side `x86_64` is the upstream spoofed identity (anti-pattern #34) and must not appear in our own UI; changed to the real runtime `NODE 26.4`.

### 7.4 Copy (design material, not decoration)

- Verbs say it directly, same names across the whole flow: "Stop proxy" button → "Proxy stopped" toast; "Start proxy" → "Proxy started · 127.0.0.1:8080".
- Name by user mental model: UI shows "Provider / Plan", not internal fields provider/plan (code layer keeps them).
- Empty states are guidance, not vibes: empty logs → "No requests yet — send a chat from your coding tool to try"; logged out → "Log in to start the proxy".
- Errors don't apologize and aren't vague: "Node not responding — check whether the service is running".
- Current UI copy is English; at implementation time pick one: full Chinese (recommended, previews are already Chinese) or provide an English mapping table.

### 7.5 Quality floor (done without announcing)

- Touch targets ≥ 48dp; status color contrast calibrated per WCAG AA (green/amber on dark brightened one step to `#6CD79E`/`#F2C063`); when the system "reduce motion" is on, blob drift/typewriter shut off and degrade to direct presentation; light/dark follows the system instantly (see §3).
- Font bundling: JetBrains Mono + Space Grotesk (B only), both OFL, shipped via `FontFamily(R.font...)` in the APK; CJK carried by system fonts.

### 7.6 Preview v2 changelog

- **A**: sparkline added to hero card (signature element), stats switched to mono, removed "today's requests" copy duplicating the stat cards.
- **B**: gradients reduced (-3 spots), stats switched to mono.
- **C**: decorative numbered bottom bar removed, status line right side changed to `NODE 26.4`, rest keeps discipline.
- **Brand**: all six previews' top-left corner replaced with the real app icon extracted from `ZCode.exe` (PE resource RT_ICON 256px PNG); master stored at `Android-APP/design/assets/zcode-app-icon.png`, usable directly as the Android mipmap source. Dark previews pad the icon with a faint glow stroke so it doesn't smear into black; implementation uses `Image` + `border` (dark theme).

### 7.7 v3 changes (traditional colors + feature placement)

- **Palette**: all boards source hues from traditional Chinese colors — A sky-blue/indigo/moon-white/crow-teal/lacquer-black, B pine-green/rouge/sky-teal/lotus/deep-black (v4 removes AI purple), C pine-green/stone-blue/rouge/autumn-ochre/deep-black/frost-white. Hues only, zero ethnic pattern motifs; semantic colors unified (2xx pine-green family, info blue-cyan family, error & logout = rouge, 429 = ochre).
- **Feature button placement**: **OAuth login/logout → right side of the Home account card** (logged in shows a "Log out" pill; logged out turns the whole card into a "Log in" CTA; proxy cannot start when logged out); **provider (Z.AI/Zhipu) and plan (coding-plan/start-plan) → new "Connection" card on Home**, two segmented rows, locked while the proxy runs with a "Running · switching locked" hint (keeping the existing `enabled = !proxyRunning` semantics); settings page keeps only port/appearance/about.
- **Stat number cards removed** (the "big numbers + small labels" template slot flagged by the skill): request volume merged into the sparkline, error count merged into the A/B log-header "0 errors" counter and option C status line `ERR 0`; freed space went to the connection card.

### 7.8 v4 changes (B drops "AI purple")

User feedback: option B's blue-purple gradient felt "too AI" — exactly the default-look residue flagged in §7.3. Fix direction: **aurora returns to its physical colors** (real aurora = oxygen 557.7nm green line dominant + nitrogen red/pink edges), not another crowd-pleasing gradient:

- Dark blobs: violet `#801DAE` → pine-green `#1E9E74`, stone-blue → bright rouge `#C2475E`, rouge → teal `#2E8F8A`; base changed from blue-black to pine-black.
- Main button: violet→stone-blue gradient changed to pure green gradient (`#1FA97A→#12A98F`) + green glow; top-line gradient changed to **green→magenta edge** (`#2BC48A→#E05561`, aurora signature); avatar uses the same green gradient.
- Light blobs: violet-pink/stone-blue-pink → pine-green pink `#A9D4BE` / sky-teal `#BFE0D4`, rouge pink kept; primary changed to deep pine `#0E8A5F`.
- Glass card base tuned from blue-purple-black `#10122A` to green-black `#0F1A17`; all purple values verified zero via grep.
- Unchanged: glass card structure, floating dock, glowing status light, stone-blue log tags (info semantic color).
