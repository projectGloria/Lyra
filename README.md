# Lyra

A lightweight, high-performance desktop music player built with Electron and Vanilla JS.

## Core Philosophy
- **Zero Bloat:** No frontend frameworks. Pure Vanilla JS and CSS for maximum speed and minimal memory footprint.
- **Performance:** Optimized metadata scanning and lazy-loaded cover art via custom protocols.
- **Privacy:** No database. State lives in memory; settings persist to local configuration files.

## Features
- **Clean UI:** Responsive interface with spectrum visualizers and EQ status indicators.
- **Audio Engine:** HTML5 Audio with a BiquadFilter EQ chain.
- **Metadata:** Fast tag parsing via `music-metadata`.
- **System Integration:** Global media keys, tray management, and native window controls.
- **Organization:** Folder-based queue filtering and playlist management.

## Tech Stack
- **Runtime:** Electron 34
- **Frontend:** Vanilla JavaScript, CSS3, HTML5
- **Dependencies:** `music-metadata`

## Development

### Prerequisites
- Node.js (Latest LTS recommended)
- npm

### Setup
```bash
# Install dependencies
npm install

# Run the application
npm start
```

### Building
```bash
# Package for the current OS
npm run build
```

---

## Configuration (`Lyra.cfg`)

Lyra can be customized using a `Lyra.cfg` file. The app looks for this file in:
1. `%APPDATA%/Lyra/Lyra.cfg` (Windows)
2. `~/Lyra.cfg` (Home Directory)
3. The application directory.

### Keybindings
**Syntax:** `bind "key" action` or `bind "key" toggle action`

| Action | Description |
| :--- | :--- |
| `playpause` | Toggle between play and pause. |
| `stop` | Stop playback. |
| `next` | Skip to the next track. |
| `prev` | Return to the previous track. |
| `shuffle` | Toggle shuffle mode. |
| `repeat` | Cycle through repeat modes (Off, All, One). |
| `mute` | Toggle mute. |
| `seek_forward` | Seek forward 5 seconds. |
| `seek_backward`| Seek backward 5 seconds. |
| `volume_up` | Increase volume. |
| `volume_down` | Decrease volume. |
| `equalizer` | Toggle the Equalizer popup. |
| `toggle_eq` | Toggle the Equalizer on/off directly. |
| `settings` | Toggle the Settings panel. |
| `quit` | Close the application. |

#### Special Keys & Mouse
- `space`, `enter`, `escape`, `up`, `down`, `left`, `right`
- `mwheelup`, `mwheeldown` (Mouse wheel support)

**Example:**
```cfg
bind "space" playpause
bind "mwheelup" volume_up
bind "mwheeldown" volume_down
```

### Theme Customization
| Variable | Description |
| :--- | :--- |
| `theme_bg_color` | Main background color (Hex or RGB). |
| `theme_accent_color` | Accent color for progress, icons, and glow. |
| `theme_text_color` | Primary text color. |

### General Settings
| Setting | Type | Description |
| :--- | :--- | :--- |
| `startup_volume` | `float` | Volume level on startup (0.0 to 1.0). |
| `close_minimizes`| `boolean` | If true, closing the window hides it to the tray. |
| `performance_mode`| `boolean` | If true, disables all animations/visualizers. |
| `animation_style`| `string` | Visualizer mode: `default`, `cover`, `vinyl`, `off`. |

---

## Global Media Keys
Lyra supports global media keys even when the application is not in focus:
- **Play/Pause**
- **Next Track**
- **Previous Track**
- **Stop**
