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

    function applyCuts(payloadJson) {
        var seq = SmartEditPro.getActiveSequence();
        if (!seq) return SmartEditPro.error("No active sequence.");
        var payload = safeParse(payloadJson, { beats: [], options: {} });
        var beats = payload.beats || [];
        var opts = payload.options || {};
        if (!beats.length) return SmartEditPro.error("No beats provided.");

        var cuts = 0;
        var errors = [];
        try {
            for (var i = 0; i < beats.length; i++) {
                var seconds = beats[i];
                try {
                    if (typeof seq.razor === "function") {
                        seq.razor(SmartEditPro.secondsToTicks(seconds));
                        cuts++;
                    } else if (seq.videoTracks && seq.videoTracks.numTracks > 0) {
                        // Fallback: razor each video track explicitly.
                        for (var v = 0; v < seq.videoTracks.numTracks; v++) {
                            var vt = seq.videoTracks[v];
                            if (vt && typeof vt.razor === "function") {
                                vt.razor(SmartEditPro.secondsToTicks(seconds));
                            }
                        }
                        cuts++;
                    }
                } catch (eRazor) {
                    errors.push("@" + seconds.toFixed(3) + ": " + eRazor);
                }
            }
        } catch (e) {
            return SmartEditPro.error("Apply cuts failed: " + e);
        }

        return SmartEditPro.respond({
            ok: true,
            cuts: cuts,
            target: opts.target || "selected",
            errors: errors
        });
    }

    return {
        getSequenceDuration: getSequenceDuration,
        exportTrackAudio: exportTrackAudio,
        previewMarkers: previewMarkers,
        applyCuts: applyCuts,
        clearMarkers: clearMarkers
    };
})();
