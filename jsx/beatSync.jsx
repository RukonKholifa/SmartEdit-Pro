/* ==========================================================================
   beatSync.jsx - Beat Sync Cutter ExtendScript backend.

   Exposes BeatSync namespace with:
     exportTrackAudio(optsJson)  - render the chosen music track to a WAV the
                                   panel can decode. Returns {ok, path, duration}.
     getSequenceDuration()       - returns the active sequence duration in seconds.
     previewMarkers(payloadJson) - place sequence markers at every beat.
     applyCuts(payloadJson)      - razor-cut target clip(s) at every beat.
     clearMarkers()              - removes preview markers we added.
   ========================================================================== */

if (typeof SmartEditPro === "undefined") {
    // Loaded standalone; basic shim so error paths still return JSON.
    var SmartEditPro = {
        respond: function (o) { return '{"ok":false,"error":"hostscript.jsx not loaded"}'; },
        error:   function (m) { return '{"ok":false,"error":"' + String(m).replace(/"/g, "'") + '"}'; },
        getActiveSequence: function () { return null; },
        makeTime: function (s) { return null; },
        secondsToTicks: function (s) { return String(Math.round(Number(s) * 254016000000)); },
        TICKS_PER_SECOND: 254016000000
    };
}

var BeatSync = (function () {
    var PREVIEW_MARKER_COMMENT = "[SmartEditPro:beat]";

    function safeParse(json, fallback) {
        try { return json ? eval("(" + json + ")") : (fallback || {}); }
        catch (e) { return fallback || {}; }
    }

    function getSequenceDuration() {
        var seq = SmartEditPro.getActiveSequence();
        if (!seq) return SmartEditPro.error("No active sequence.");
        try {
            var endTicks = seq.end || (seq.zeroPoint && seq.getOutPoint && seq.getOutPoint().ticks);
            var duration = 0;
            if (endTicks) {
                duration = Number(endTicks) / SmartEditPro.TICKS_PER_SECOND;
            } else if (seq.duration) {
                duration = (typeof seq.duration === "object") ? seq.duration.seconds : Number(seq.duration);
            }
            return SmartEditPro.respond({ ok: true, duration: duration });
        } catch (e) {
            return SmartEditPro.error("Could not read sequence duration: " + e);
        }
    }

    /**
     * Resolve the active cut range for the current beat-sync options.
     * Honours the Range Mode radio (Full Clip / In-Out Range Only) and resolves
     * In/Out by reading sequence.getInPoint / getOutPoint when available.
     * Returns: { ok, start, end, fps, duration }.
     */
    function getCutRange(optsJson) {
        var seq = SmartEditPro.getActiveSequence();
        if (!seq) return SmartEditPro.error("No active sequence.");
        var opts = safeParse(optsJson, {});
        var start = 0;
        var end = 0;
        var fps = 30;
        try {
            if (seq.timebase) {
                fps = SmartEditPro.TICKS_PER_SECOND / Number(seq.timebase);
            }
            if (seq.end) {
                end = Number(seq.end) / SmartEditPro.TICKS_PER_SECOND;
            }
            if (opts.range === "inout") {
                try {
                    var inP = (typeof seq.getInPoint === "function") ? seq.getInPoint() : null;
                    var outP = (typeof seq.getOutPoint === "function") ? seq.getOutPoint() : null;
                    if (inP && typeof inP === "string") start = Number(inP) / SmartEditPro.TICKS_PER_SECOND;
                    else if (inP && inP.ticks) start = Number(inP.ticks) / SmartEditPro.TICKS_PER_SECOND;
                    else if (inP && typeof inP === "number") start = inP;
                    if (outP && typeof outP === "string") end = Number(outP) / SmartEditPro.TICKS_PER_SECOND;
                    else if (outP && outP.ticks) end = Number(outP.ticks) / SmartEditPro.TICKS_PER_SECOND;
                    else if (outP && typeof outP === "number") end = outP;
                } catch (eIO) {
                    // Stick with full-range fallback.
                }
            }
        } catch (e) {
            return SmartEditPro.error("Could not read cut range: " + e);
        }
        if (!end || end <= start) end = start + 60;
        return SmartEditPro.respond({
            ok: true,
            start: start,
            end: end,
            fps: fps,
            duration: end - start
        });
    }

    /**
     * Tries to render the chosen audio track to a WAV in the OS temp folder
     * using Premiere's exportAsMediaDirect API.  When that API is unavailable
     * we still return a useful response so main.js can fall back to a synthetic
     * beat grid.
     */
    function exportTrackAudio(optsJson) {
        var seq = SmartEditPro.getActiveSequence();
        if (!seq) return SmartEditPro.error("No active sequence.");
        var opts = safeParse(optsJson, {});
        var tempPath;
        try {
            var tmp = Folder.temp.fsName.replace(/\\/g, "/");
            tempPath = tmp + "/smarteditpro_beatsync_" + Date.now() + ".wav";
        } catch (e) {
            return SmartEditPro.error("Could not resolve temp folder: " + e);
        }

        try {
            // Best-effort export: this preset path is not bundled, so this is
            // attempted but failure is non-fatal - main.js handles fallback.
            if (typeof seq.exportAsMediaDirect === "function") {
                var presetPath = (File($.fileName).path) + "/presets/wav_full_quality.epr";
                var ok = false;
                try {
                    ok = seq.exportAsMediaDirect(tempPath, presetPath, app.encoder.ENCODE_ENTIRE);
                } catch (eExport) {
                    ok = false;
                }
                if (ok) {
                    var dur = 0;
                    try {
                        dur = (typeof seq.end === "string" ? Number(seq.end) : seq.end) / SmartEditPro.TICKS_PER_SECOND;
                    } catch (e2) {}
                    return SmartEditPro.respond({ ok: true, path: tempPath, duration: dur });
                }
            }
        } catch (e) {
            // fall through to fallback response
        }

        // Could not produce a real WAV. Tell the panel so it can use the
        // synthetic beat grid as a fallback.
        return SmartEditPro.respond({
            ok: false,
            error: "Track export not available - using estimated beats."
        });
    }

    function previewMarkers(payloadJson) {
        var seq = SmartEditPro.getActiveSequence();
        if (!seq) return SmartEditPro.error("No active sequence.");
        var payload = safeParse(payloadJson, { beats: [] });
        var beats = payload.beats || [];
        if (!beats.length) return SmartEditPro.error("No beats provided.");
        var added = 0;
        try {
            var markers = seq.markers;
            for (var i = 0; i < beats.length; i++) {
                var t = SmartEditPro.makeTime(beats[i]);
                var m = null;
                try {
                    m = markers.createMarker(beats[i]);
                } catch (eC1) {
                    try { m = markers.createMarker(t); } catch (eC2) { m = null; }
                }
                if (m) {
                    try { m.name = "Beat " + (i + 1); } catch (eN) {}
                    try { m.comments = PREVIEW_MARKER_COMMENT; } catch (eCm) {}
                    try { m.setColorByIndex && m.setColorByIndex(1); } catch (eCo) {}
                    added++;
                }
            }
        } catch (e) {
            return SmartEditPro.error("Could not place markers: " + e);
        }
        return SmartEditPro.respond({ ok: true, added: added });
    }

    function clearMarkers() {
        var seq = SmartEditPro.getActiveSequence();
        if (!seq) return SmartEditPro.error("No active sequence.");
        var removed = 0;
        try {
            var markers = seq.markers;
            var m = (typeof markers.getFirstMarker === "function") ? markers.getFirstMarker() : null;
            // Build a list first, then delete - mutating during traversal can
            // skip nodes in some Premiere versions.
            var toDelete = [];
            while (m) {
                if (m.comments && m.comments.indexOf(PREVIEW_MARKER_COMMENT) !== -1) {
                    toDelete.push(m);
                }
                m = (typeof markers.getNextMarker === "function") ? markers.getNextMarker(m) : null;
            }
            for (var i = 0; i < toDelete.length; i++) {
                try { markers.deleteMarker(toDelete[i]); removed++; } catch (eD) {}
            }
        } catch (e) {
            return SmartEditPro.error("Could not clear markers: " + e);
        }
        return SmartEditPro.respond({ ok: true, removed: removed });
    }

    /* ------------------------------------------------------------------ */
    /* Debug log (shared with PodcastSwitch: C:\SmartEditPro_debug.txt or  */
    /* ~/SmartEditPro_debug.txt). Appends entries so we don't clobber the  */
    /* Podcast log while the user is iterating.                             */
    /* ------------------------------------------------------------------ */

    // Pick a debug path the user is guaranteed to be able to write to. The
    // root of C:\ frequently needs admin, so we prefer the user's Documents
    // folder (%USERPROFILE%\Documents on Windows, ~/Documents on macOS/Linux)
    // and fall back to Folder.temp if that's still unwritable.
    var DEBUG_FILE_PATH = (function () {
        try {
            var docs = Folder.myDocuments && Folder.myDocuments.fsName;
            if (docs) {
                var p = docs + ((String(docs).indexOf("\\") !== -1) ? "\\" : "/") + "SmartEditPro_debug.txt";
                var probe = new File(p);
                // Open in append mode; if that fails we'll fall through.
                var ok = false;
                try { ok = probe.open("a"); } catch (e1) {}
                if (ok) { try { probe.close(); } catch (e2) {} return p; }
            }
        } catch (eDocs) {}
        try {
            var tmp = Folder.temp && Folder.temp.fsName;
            if (tmp) {
                var sep = (String(tmp).indexOf("\\") !== -1) ? "\\" : "/";
                return tmp + sep + "SmartEditPro_debug.txt";
            }
        } catch (eTmp) {}
        var os = "";
        try { os = String($.os || "").toLowerCase(); } catch (eOs) {}
        if (os.indexOf("windows") !== -1) return "C:\\SmartEditPro_debug.txt";
        return "~/SmartEditPro_debug.txt";
    })();

    function debugLog(msg) {
        try {
            var f = new File(DEBUG_FILE_PATH);
            f.encoding = "UTF-8";
            var opened = false;
            try { opened = f.open("e"); } catch (eE) { opened = false; }
            if (opened) { try { f.seek(0, 2); } catch (eS) {} }
            else {
                try { opened = f.open("a"); } catch (eA) { opened = false; }
                if (!opened) opened = f.open("w");
            }
            if (!opened) return;
            f.writeln("[" + (new Date()).toLocaleTimeString() + "] [BeatSync] " + msg);
            f.close();
        } catch (e) {}
    }

    function debugReset(header) {
        try {
            var f = new File(DEBUG_FILE_PATH);
            f.encoding = "UTF-8";
            if (!f.open("w")) return;
            f.writeln("=== SmartEditPro BeatSync debug ===");
            f.writeln("path : " + DEBUG_FILE_PATH);
            f.writeln("time : " + (new Date()).toString());
            if (header) f.writeln("note : " + header);
            f.writeln("");
            f.close();
        } catch (e) {}
    }

    /* ------------------------------------------------------------------ */
    /* Selected clip resolution                                             */
    /* ------------------------------------------------------------------ */

    function firstSelectedVideoClip(seq) {
        try {
            if (!seq.videoTracks) return null;
            for (var v = 0; v < seq.videoTracks.numTracks; v++) {
                var t = seq.videoTracks[v];
                if (!t || !t.clips) continue;
                for (var c = 0; c < t.clips.numItems; c++) {
                    var clip = t.clips[c];
                    if (!clip) continue;
                    if (clip.isSelected && clip.isSelected()) return clip;
                }
            }
        } catch (e) {}
        return null;
    }

    function clipSeconds(clip, which) {
        try {
            var t = clip[which];
            if (!t && t !== 0) return 0;
            if (typeof t === "number") return t;
            if (typeof t.seconds === "number") return t.seconds;
            if (t.ticks) return Number(t.ticks) / SmartEditPro.TICKS_PER_SECOND;
        } catch (e) {}
        return 0;
    }

    /* ------------------------------------------------------------------ */
    /* Core razor: accepts a pre-computed seconds array.                    */
    /* ------------------------------------------------------------------ */

    /**
     * Razor the active sequence at each time in `cutTimesInSeconds`.
     * Uses `new Time()` + `t.seconds = ...` (Premiere's documented Time input
     * for razor) which works more reliably than a ticks string across host
     * versions.
     *
     * `opts`:
     *   target = "selected" | "v1all"  (selected-clip = filter to that clip's
     *                                   sequence range)
     *   range  = "full" | "inout"      (informational, already applied upstream)
     */
    function applyCutsAtTimes(cutTimesInSeconds, opts) {
        opts = opts || {};
        var seq = SmartEditPro.getActiveSequence();
        if (!seq) return { ok: false, error: "No active sequence." };

        var times = (cutTimesInSeconds || []).slice();
        times.sort(function (a, b) { return a - b; });

        var seqName = "";
        try { seqName = String(seq.name || ""); } catch (e) {}
        var seqEndSec = 0;
        try { seqEndSec = (seq.end && seq.end.seconds) ? Number(seq.end.seconds) : (Number(seq.end) / SmartEditPro.TICKS_PER_SECOND); } catch (e) {}
        if (!seqEndSec) {
            try { seqEndSec = (seq.duration && seq.duration.seconds) ? Number(seq.duration.seconds) : 0; } catch (e) {}
        }
        var fps = 30;
        try {
            if (seq.timebase) {
                var ticksPerFrame = Number(seq.timebase);
                if (ticksPerFrame > 0) fps = SmartEditPro.TICKS_PER_SECOND / ticksPerFrame;
            }
        } catch (e) {}

        debugLog("applyCutsAtTimes: sequence='" + seqName + "' end=" + seqEndSec.toFixed(3) +
                 "s fps=" + fps.toFixed(3) + " target=" + (opts.target || "selected") +
                 " incomingTimes=" + times.length);
        var preview = times.slice(0, 5).map(function (x) { return Number(x).toFixed(3); }).join(", ");
        debugLog("  first 5 cut times: [" + preview + "]");

        // Selected-clip mode: filter cuts to the selected clip's sequence range.
        var clipLo = 0, clipHi = seqEndSec;
        if ((opts.target || "selected") === "selected") {
            var sel = firstSelectedVideoClip(seq);
            if (sel) {
                clipLo = clipSeconds(sel, "start");
                clipHi = clipSeconds(sel, "end");
                debugLog("  selected clip range: " + clipLo.toFixed(3) + "s - " + clipHi.toFixed(3) + "s");
            } else {
                debugLog("  selected clip: NONE found - falling back to full sequence");
            }
        }

        var applied = 0;
        var skipped = 0;
        var razorErrors = [];
        var razorOk = 0;
        var razorFalsy = 0;

        for (var i = 0; i < times.length; i++) {
            var sec = Number(times[i]);
            if (!(sec > 0)) { skipped++; continue; }
            if (sec >= seqEndSec - 0.001) { skipped++; continue; }
            if (sec < clipLo + 0.001 || sec > clipHi - 0.001) { skipped++; continue; }

            var t;
            try { t = new Time(); t.seconds = sec; } catch (eT) { t = null; }
            if (!t) { skipped++; continue; }

            try {
                var ret = seq.razor(t);
                if (ret === false) {
                    razorFalsy++;
                    // Fallback: per-track razor.
                    for (var v = 0; v < (seq.videoTracks ? seq.videoTracks.numTracks : 0); v++) {
                        var vt = seq.videoTracks[v];
                        if (vt && typeof vt.razor === "function") {
                            try { vt.razor(t); } catch (eVt) {}
                        }
                    }
                } else {
                    razorOk++;
                }
                applied++;
                if (i < 5) debugLog("  razor(" + sec.toFixed(3) + "s) -> " + String(ret));
            } catch (eR) {
                razorErrors.push("@" + sec.toFixed(3) + ": " + eR);
                if (i < 5) debugLog("  razor(" + sec.toFixed(3) + "s) THREW: " + eR);
                // Per-track fallback on exception too.
                try {
                    for (var v2 = 0; v2 < (seq.videoTracks ? seq.videoTracks.numTracks : 0); v2++) {
                        var vt2 = seq.videoTracks[v2];
                        if (vt2 && typeof vt2.razor === "function") {
                            try { vt2.razor(t); applied++; razorOk++; break; } catch (eVt2) {}
                        }
                    }
                } catch (eFb) {}
            }
        }

        debugLog("applyCutsAtTimes: done. applied=" + applied + " skipped=" + skipped +
                 " razorOk=" + razorOk + " razorFalsy=" + razorFalsy +
                 " exceptions=" + razorErrors.length);

        return {
            ok: true,
            cuts: applied,
            skipped: skipped,
            razorOk: razorOk,
            razorFalsy: razorFalsy,
            sequenceEnd: seqEndSec,
            fps: fps,
            target: opts.target || "selected",
            errors: razorErrors,
            debugFile: DEBUG_FILE_PATH
        };
    }

    function applyCuts(payloadJson) {
        var payload = safeParse(payloadJson, { beats: [], options: {} });
        var beats = payload.beats || [];
        var opts = payload.options || {};
        var mode = opts.mode || "beats";

        debugReset("applyCuts mode=" + mode);

        // Fixed-frames mode: generate the cuts from FPS here so the JS side
        // stays agnostic of the sequence's timebase (only if main.js didn't
        // already provide the array).
        if (mode === "frames" && (!beats || !beats.length)) {
            var seq = SmartEditPro.getActiveSequence();
            if (!seq) return SmartEditPro.error("No active sequence.");
            var frameInterval = Math.max(1, parseInt(opts.frameInterval, 10) || 1);
            var fps = 30;
            try {
                if (seq.timebase) {
                    var tpf = Number(seq.timebase);
                    if (tpf > 0) fps = SmartEditPro.TICKS_PER_SECOND / tpf;
                }
            } catch (eF) {}
            var startSec = Math.max(0, Number(opts.startSec) || 0);
            var endSec = Number(opts.endSec);
            if (!endSec || !(endSec > 0)) {
                try {
                    endSec = (seq.end && seq.end.seconds) ? Number(seq.end.seconds) : Number(seq.end) / SmartEditPro.TICKS_PER_SECOND;
                } catch (eE) {}
            }
            if (!(endSec > startSec)) return SmartEditPro.error("Bad cut range (end<=start).");

            var step = frameInterval / fps;
            var times = [];
            for (var s = startSec + step; s < endSec; s += step) times.push(s);
            debugLog("FixedFrames: fps=" + fps.toFixed(3) + " interval=" + frameInterval +
                     " step=" + step.toFixed(4) + "s range=" + startSec.toFixed(3) +
                     "-" + endSec.toFixed(3) + "s -> " + times.length + " cut times");
            beats = times;
        }

        if (!beats.length) return SmartEditPro.error("No beats provided.");

        var res = applyCutsAtTimes(beats, opts);
        if (!res.ok) return SmartEditPro.error(res.error || "Apply cuts failed.");
        return SmartEditPro.respond(res);
    }

    return {
        getSequenceDuration: getSequenceDuration,
        getCutRange: getCutRange,
        exportTrackAudio: exportTrackAudio,
        previewMarkers: previewMarkers,
        applyCuts: applyCuts,
        applyCutsAtTimes: function (arrJson, optsJson) {
            var arr = safeParse(arrJson, []);
            var opts = safeParse(optsJson, {});
            debugReset("applyCutsAtTimes");
            var r = applyCutsAtTimes(arr, opts);
            if (!r.ok) return SmartEditPro.error(r.error || "Apply failed.");
            return SmartEditPro.respond(r);
        },
        clearMarkers: clearMarkers,
        debugLog: function (msg) { debugLog(String(msg || "")); return SmartEditPro.respond({ ok: true }); }
    };
})();

// Top-level convenience wrappers live in hostscript.jsx so they are defined
// even when this file is re-evaluated in isolation.
