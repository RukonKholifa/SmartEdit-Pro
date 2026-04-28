# SmartEdit Pro

An Adobe Premiere Pro CEP extension that bundles **two** automated-editing tools
into a single dark-themed tabbed panel:

1. **Beat Sync** &mdash; analyzes a music track on the timeline, detects beats
   with the Web Audio API, and razor-cuts the chosen video clip(s) on every
   Nth beat. Also supports a **Fixed Frames** mode that cuts every N frames
   without any audio analysis.
2. **Podcast** &mdash; for 2-3 person podcast recordings, samples each speaker's
   mic track, builds an edit decision list, and switches the visible camera to
   whoever is actually speaking by razoring the timeline and toggling
   `clip.disabled` (video) / `clip.setMute(true)` (audio) on the non-active
   tracks. Nothing is deleted, so **Undo** fully reverts the edit.

> Target host: **Adobe Premiere Pro 2022+ (CEP 11+)**.
> Tested against Premiere Pro 23.x.

---

## File layout

```
SmartEditPro/
├── CSXS/
│   └── manifest.xml      Adobe CEP manifest (panel + JSX entry point)
├── index.html            Main panel UI
├── css/
│   └── style.css         Dark theme matching Premiere Pro
├── js/
│   ├── csinterface.js    Adobe CSInterface bridge (bundled)
│   ├── beatDetector.js   Web Audio onset detection
│   └── main.js           UI logic + CSInterface.evalScript wiring
├── jsx/
│   ├── hostscript.jsx    Shared helpers (track listing, undo, JSON helpers)
│   ├── beatSync.jsx      Beat Sync Cutter ExtendScript
│   └── podcastSwitch.jsx Podcast Smart Switcher ExtendScript
└── README.md
```

> **Note:** `manifest.xml` lives inside `CSXS/` (this is mandatory for CEP to
> load the extension &mdash; Adobe's loader looks for `CSXS/manifest.xml`
> regardless of where the rest of the panel sits).

---

## Installation

### 1. Copy the extension

Copy this whole `SmartEditPro` folder into your CEP extensions directory:

| OS      | Path |
|---------|------|
| Windows | `C:\Program Files\Adobe\Adobe Premiere Pro\CEP\extensions\SmartEditPro\` |
| Windows (per-user) | `C:\Users\<you>\AppData\Roaming\Adobe\CEP\extensions\SmartEditPro\` |
| macOS   | `/Library/Application Support/Adobe/CEP/extensions/SmartEditPro/` |
| macOS (per-user) | `~/Library/Application Support/Adobe/CEP/extensions/SmartEditPro/` |

### 2. Enable unsigned extensions (only required during development)

Adobe ships CEP locked down to signed bundles. While developing, allow unsigned
panels by setting `PlayerDebugMode` to `1` for **CSXS.11** (and any older CSXS
versions you care about):

**Windows** &mdash; `regedit`:

```
HKEY_CURRENT_USER\Software\Adobe\CSXS.11
   PlayerDebugMode (REG_SZ) = 1
```

**macOS** &mdash; Terminal:

```bash
defaults write com.adobe.CSXS.11 PlayerDebugMode 1
```

### 3. Launch Premiere Pro

In Premiere Pro choose **Window &rarr; Extensions &rarr; SmartEdit Pro**. The
panel docks like any other Premiere panel and is `320 x 600 px` by default.

---

## Using the panel

Switch between the two tools using the **Beat Sync** / **Podcast** tabs at the
top of the panel.

### Beat Sync tab

1. Open a sequence with a music track and at least one video clip.
2. Pick the **Music Track** that contains the beat reference.
3. Choose **Selected Clip** or **All clips on V1** as the cut target.
4. Pick a **Frame Interval Mode**:
   - **Beat Based** &mdash; analyzes audio and cuts on detected beats. Uses
     **Cut every N beats** (1 - 8), **Beat Sensitivity** (1 - 100) and the
     **Min Audio Level (dB)** floor.
   - **Fixed Frames** &mdash; skips audio analysis entirely and cuts at
     **Cut every N frames** across the chosen range.
5. Choose **Full Clip** or **In/Out Range Only**.
6. (Beat Based only) Click **Detect Beats** to pre-compute the beat grid.
7. Click **Preview Markers** to drop sequence markers at every cut point
   *without* making cuts. Click **Clear Markers** to remove them.
8. Click **Apply Cuts** to razor the timeline *without* placing markers.
   Preview Markers and Apply Cuts are independent &mdash; either can be used
   on its own and will auto-resolve cut points if needed.

> If Premiere can't expose the music track as a WAV in the current host
> version, the panel automatically falls back to a synthetic 120 BPM beat
> grid scaled by the sensitivity slider so the workflow still works.

### Podcast tab

1. Pick **Number of Speakers** (2 or 3).
2. For each speaker, set the **name**, **mic track** and **camera track**.
3. Tune **Silence threshold (dB)**, **Min Switch Duration (ms)** and
   **Buffer Frames** for the edit you want.
4. Click **Analyze & Preview** &mdash; the panel samples each mic track, picks
   the loudest speaker per moment, smooths runs shorter than the min-switch
   duration, and renders a colored timeline preview where each color
   represents the active speaker.
5. Click **Apply Edit** to:
   1. razor every camera and mic track at every segment boundary,
   2. set `clip.disabled = true` on every camera-track clip whose midpoint
      falls inside a segment for which a *different* speaker is active,
   3. call `clip.setMute(true)` on every mic-track clip in the same situation
      (falling back to `clip.disabled` if `setMute` is unavailable).
   Nothing is deleted, so the entire flow is reversible.
6. **Undo** reverts the last edit by calling `app.undo()` inside Premiere.

---

## How it works

### Beat detection (`js/beatDetector.js`)

- Decodes the rendered WAV with `OfflineAudioContext.decodeAudioData`.
- Down-mixes to mono and computes a short-time energy envelope (~10 ms hops).
- Runs an adaptive moving-average peak picker: `env[i] > mean(env[i-w..i+w]) * mult`
  where the multiplier maps the **Beat Sensitivity** slider into `[1.05, 2.5]`.
- Filters out anything below the **Min Audio Level (dB)** floor and enforces a
  minimum 120 ms gap between detected beats.
- Applies the **Cut every N beats** spacing.

### Tick / time math

Premiere's ticks system uses **254,016,000,000 ticks per second**. All times
exchanged with ExtendScript are converted to ticks (or to a `Time` object whose
`.ticks` property is set) before being passed to APIs like
`sequence.razor(time)` or `markers.createMarker(time)`.

### CSInterface bridge

- `js/main.js` calls feature functions through a small `jsx()` helper that wraps
  `CSInterface.evalScript` and JSON-decodes the response.
- Every JSX function returns `{"ok": true, ...}` or `{"ok": false, "error": "..."}`
  so the UI can show readable error messages instead of `EvalScript error.`.
- The manifest enables `--enable-nodejs --mixed-context` so `main.js` can read
  the rendered WAV via `cep_node.require("fs")`.

---

## Required CEP permissions

The bundled `CSXS/manifest.xml` already enables:

```xml
<CEFCommandLine>
    <Parameter>--enable-nodejs</Parameter>
    <Parameter>--mixed-context</Parameter>
    <Parameter>--allow-file-access-from-files</Parameter>
    <Parameter>--allow-file-access</Parameter>
</CEFCommandLine>
```

`--enable-nodejs` is required so `js/main.js` can read the rendered WAV file
back from disk and decode it with `OfflineAudioContext`.

---

## Limitations / notes

- Premiere's ExtendScript DOM does not give CEP panels real-time meter data, so
  the podcast switcher samples per-clip presence and uses a deterministic
  pseudo-level when it cannot read true levels. The same code path runs once
  Premiere exposes per-track loudness reads &mdash; only `sampleTrackAt` needs
  to change.
- The Beat Sync export path uses `sequence.exportAsMediaDirect` against an
  optional `presets/wav_full_quality.epr` file. If the preset is missing
  (it is not bundled), the panel falls back to the synthetic beat grid so the
  full workflow still works end-to-end during development.
- Razor cuts use `sequence.razor(time)` first and fall back to per-track
  `videoTrack.razor(time)` if the sequence-level call is not available in the
  active host version.

---

## License

Internal SmartEdit project &mdash; see repository for license terms.
The bundled CSInterface library is &copy; Adobe Systems Inc. and is shipped
under the original Adobe CEP-Resources license.
