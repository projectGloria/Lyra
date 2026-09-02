# Lyra Configuration Guide (`Lyra.cfg`)

Lyra uses a manual configuration file named `Lyra.cfg` (or `lyra.cfg`) for keybindings, theme customization, and general app behavior.

## File Locations
Lyra looks for the configuration file in the following locations (the first one found wins):
1. **User Data Directory:** `%APPDATA%/Lyra/Lyra.cfg` (Windows)
2. **Home Directory:** `~/Lyra.cfg`
3. **App Directory:** The directory where `main.js` resides.

---

## 1. Keybindings
**Syntax:** `bind "key" [toggle] action`

### Available Actions
| Action | Description | Aliases |
| :--- | :--- | :--- |
| `playpause` | Toggle between play and pause. | `play`, `pause`, `playpause` |
| `stop` | Stop playback. | `stop` |
| `next` | Skip to the next track. | `next` |
| `prev` | Return to the previous track. | `prev`, `previous` |
| `shuffle` | Toggle shuffle mode. | `shuffle` |
| `repeat` | Cycle through repeat modes (Off, All, One). | `repeat` |
| `mute` | Toggle mute. | `mute` |
| `seek_forward` | Seek forward 5 seconds. | `seek_forward`, `seekforward` |
| `seek_backward`| Seek backward 5 seconds. | `seek_backward`, `seekbackward` |
| `volume_up` | Increase volume. | `volume_up`, `volumeup` |
| `volume_down` | Decrease volume. | `volume_down`, `volumedown` |
| `equalizer` | Toggle the Equalizer popup. | `equalizer`, `eq` |
| `toggle_eq` | Toggle the Equalizer on/off directly without opening the popup. | `toggle_eq`, `toggleeq` |
| `settings` | Toggle the Settings panel. | `settings` |
| `quit` | Close the application. | `quit`, `exit` |

### Special Key Names
Most keys are used by their character (e.g., `"p"`, `"n"`, `"1"`). For special keys, use:
- `"space"`
- `"enter"` or `"return"`
- `"escape"` or `"esc"`
- `"up"`, `"down"`, `"left"`, `"right"`
- `"tab"`, `"backspace"`
- `"delete"` or `"del"`
- `"home"`, `"end"`
- `"pageup"`, `"pagedown"`
- `","`, `"."`, `"/"`, `";"`, `"["`, `"]"`, `"-"`, `"="`

**Example:**
```cfg
bind "space" toggle play
bind "ctrl+n" next
bind "m" mute
bind "v" volume_up
```

---

## 2. Theme Customization
Custom colors can be defined using Hex or RGB values.

| Variable | Description | Target CSS Variable |
| :--- | :--- | :--- |
| `theme_bg_color` | Main background color. | `--bg` |
| `theme_accent_color` | Accent color for progress, icons, and glow. | `--accent` |
| `theme_text_color` | Primary text color. | `--text` |

**Aliases:** `theme_bg`, `theme_accent`, `theme_text` are also supported.

**Example:**
```cfg
theme_bg #0d0d0f
theme_accent rgb(201, 169, 74)
theme_text #e8e4dc
```

---

## 3. General Settings
General app settings can be overridden in the config file.

| Setting | Type | Description |
| :--- | :--- | :--- |
| `startup_volume` | `float` | Volume level on startup (0.0 to 1.0). |
| `close_minimizes`| `boolean` | If true, closing the window hides it to the tray instead. |
| `performance_mode`| `boolean` | If true, disables all animations/visualizers. |
| `animation_style`| `string` | Visualizer mode: `default`, `cover`, `vinyl`, `off`. |

**Example:**
```cfg
startup_volume 0.5
close_minimizes true
performance_mode false
animation_style vinyl
```

---

## Full Example `Lyra.cfg`
```cfg
# --- Keybindings ---
bind "p" toggle play
bind "n" next
bind "b" previous
bind "s" shuffle
bind "r" repeat
bind "m" toggle mute
bind "up" volume_up
bind "down" volume_down
bind "right" seek_forward
bind "left" seek_backward
bind "e" eq
bind "q" quit

# --- Theme ---
theme_bg #101012
theme_accent #ff5555
theme_text #ffffff

# --- Settings ---
startup_volume 0.8
close_minimizes true
performance_mode false
animation_style cover
```
