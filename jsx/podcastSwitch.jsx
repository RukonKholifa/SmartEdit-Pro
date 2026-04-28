/* ==========================================================================
   podcastSwitch.jsx - Podcast Smart Switcher ExtendScript backend.

   Exposes PodcastSwitch namespace with:
     debugReset(msg)           - truncate the debug file and write a header.
     debugLog(msg)             - append a timestamped line to the debug file.
     resolveMicClips(optsJson) - returns per-speaker mic clip info (mediaPath,
                                 seqStart, seqEnd, inPoint, outPoint) so the
                                 JS side can decode the audio with Web Audio
                                 API and compute real RMS levels.
     analyze(optsJson)         - legacy fallback: reads timeline-clip presence
                                 and returns a round-robin EDL so the panel
                                 preview works even without real audio levels.
     applyEdit(payloadJson)    - cuts the timeline at every EDL boundary and
                                 toggles clip.disabled / clip.setMute per
                                 segment. Writes diagnostics at every phase
                                 to C:\SmartEditPro_debug.txt (Windows) or
                                 ~/SmartEditPro_debug.txt (macOS/Linux).
   ========================================================================== */

if (typeof SmartEditPro === "undefined") {
    var SmartEditPro = {
        respond: function (o) { return '{"ok":false,"error":"hostscript.jsx not loaded"}'; },
        error:   function (m) { return '{"ok":false,"error":"' + String(m).replace(/"/g, "'") + '"}'; },
        getActiveSequence: function () { return null; },
        makeTime: function (s) { return null; },
        secondsToTicks: function (s) { return String(Math.round(Number(s) * 254016000000)); },
        TICKS_PER_SECOND: 254016000000
    };
}

var PodcastSwitch = (function () {

    /* ------------------------------------------------------------------ */
    /* Debug file                                                          */
    /* ------------------------------------------------------------------ */

    var DEBUG_FILE_PATH = (function () {
        var os = "";
        try { os = String($.os || "").toLowerCase(); } catch (e) {}
        if (os.indexOf("windows") !== -1) return "C:\\SmartEditPro_debug.txt";
        return "~/SmartEditPro_debug.txt";
    })();

    function openDebugFile(mode) {
        try {
            var f = new File(DEBUG_FILE_PATH);
            f.encoding = "UTF-8";
            if (f.open(mode)) return f;
        } catch (e) {}
        return null;
    }

    function debugReset(header) {
        var f = openDebugFile("w");
        if (!f) return SmartEditPro.respond({ ok: false, error: "Could not open debug file at " + DEBUG_FILE_PATH });
        try {
            f.writeln("=== SmartEditPro debug ===");
            f.writeln("path : " + DEBUG_FILE_PATH);
            f.writeln("time : " + (new Date()).toString());
            if (header) f.writeln("note : " + header);
            f.writeln("");
        } catch (e) {}
        try { f.close(); } catch (e2) {}
        return SmartEditPro.respond({ ok: true, path: DEBUG_FILE_PATH });
    }

    function debugLog(msg) {
        try {
            var f = new File(DEBUG_FILE_PATH);
            f.encoding = "UTF-8";
            // "e" = open for edit; seek to end. Fall back to append via "a".
            var opened = false;
            try { opened = f.open("e"); } catch (eE) { opened = false; }
            if (opened) {
                try { f.seek(0, 2); } catch (eS) {}
            } else {
                try { opened = f.open("a"); } catch (eA) { opened = false; }
                if (!opened) opened = f.open("w");
            }
            if (!opened) return;
            f.writeln("[" + (new Date()).toLocaleTimeString() + "] " + msg);
            f.close();
        } catch (e) {}
    }

    /* ------------------------------------------------------------------ */
    /* Helpers                                                             */
    /* ------------------------------------------------------------------ */

    function safeParse(json, fallback) {
        try { return json ? eval("(" + json + ")") : (fallback || {}); }
        catch (e) { return fallback || {}; }
    }

    function getSequenceDuration(seq) {
        try {
            if (seq.end) return Number(seq.end) / SmartEditPro.TICKS_PER_SECOND;
            if (seq.duration && seq.duration.seconds) return Number(seq.duration.seconds);
        } catch (e) {}
        return 0;
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

    function getMediaPath(clip) {
        try {
            if (clip.projectItem) {
                if (typeof clip.projectItem.getMediaPath === "function") {
                    return String(clip.projectItem.getMediaPath() || "");
                }
                if (clip.projectItem.canProxy && clip.projectItem.getProxyPath) {
                    return String(clip.projectItem.getProxyPath() || "");
                }
            }
        } catch (e) {}
        return "";
    }

    /* ------------------------------------------------------------------ */
    /* resolveMicClips - expose mic clip info to the JS layer              */
    /* ------------------------------------------------------------------ */

    function resolveMicClips(optsJson) {
        var seq = SmartEditPro.getActiveSequence();
        if (!seq) return SmartEditPro.error("No active sequence.");
        var opts = safeParse(optsJson, {});
        debugReset("resolveMicClips");

        var duration = getSequenceDuration(seq);
        debugLog("Active sequence duration: " + duration.toFixed(3) + "s");
        debugLog("videoTracks: " + (seq.videoTracks ? seq.videoTracks.numTracks : "?") +
                 "  audioTracks: " + (seq.audioTracks ? seq.audioTracks.numTracks : "?"));

        var speakers = opts.speakers || [];
        debugLog("Speaker count: " + speakers.length);

        var out = [];
        for (var s = 0; s < speakers.length; s++) {
            var sp = speakers[s];
            var micIdx = (sp && typeof sp.micTrackIndex === "number") ? sp.micTrackIndex : s;
            var info = {
                name: (sp && sp.name) ? sp.name : ("Speaker " + (s + 1)),
                micTrackIndex: micIdx,
                camTrackIndex: (sp && typeof sp.camTrackIndex === "number") ? sp.camTrackIndex : s,
                clips: []
            };
            var track = (seq.audioTracks && seq.audioTracks.numTracks > micIdx)
                ? seq.audioTracks[micIdx] : null;
            if (!track || !track.clips) {
                debugLog("  speaker[" + s + "] name='" + info.name + "' mic=A" + (micIdx + 1) +
                         " -> no track/clips");
                out.push(info);
                continue;
            }
            for (var c = 0; c < track.clips.numItems; c++) {
                var clip = track.clips[c];
                if (!clip) continue;
                var mediaPath = getMediaPath(clip);
                var clipInfo = {
                    mediaPath: mediaPath,
                    seqStart: clipSeconds(clip, "start"),
                    seqEnd: clipSeconds(clip, "end"),
                    inPoint: clipSeconds(clip, "inPoint"),
                    outPoint: clipSeconds(clip, "outPoint"),
                    name: (function () { try { return String(clip.name || ""); } catch (e) { return ""; } })()
                };
                info.clips.push(clipInfo);
            }
            debugLog("  speaker[" + s + "] name='" + info.name + "' mic=A" + (micIdx + 1) +
                     " cam=V" + (info.camTrackIndex + 1) + " clips=" + info.clips.length);
            for (var ci = 0; ci < info.clips.length; ci++) {
                var cc = info.clips[ci];
                debugLog("    clip[" + ci + "] seq=" + cc.seqStart.toFixed(2) + "-" + cc.seqEnd.toFixed(2) +
                         "s  in=" + cc.inPoint.toFixed(2) + "  out=" + cc.outPoint.toFixed(2) +
                         "  path='" + cc.mediaPath + "'");
            }
            out.push(info);
        }

        return SmartEditPro.respond({
            ok: true,
            duration: duration,
            speakers: out,
            debugFile: DEBUG_FILE_PATH
        });
    }

    /* ------------------------------------------------------------------ */
    /* Legacy analyze - used only when JS audio decoding fails             */
    /* ------------------------------------------------------------------ */

    function analyze(optsJson) {
        var seq = SmartEditPro.getActiveSequence();
        if (!seq) return SmartEditPro.error("No active sequence.");
        var opts = safeParse(optsJson, {});
        if (!opts.speakers || !opts.speakers.length) {
            return SmartEditPro.error("Configure at least one speaker.");
        }
        var duration = getSequenceDuration(seq);
        if (!duration) return SmartEditPro.error("Sequence has zero duration.");

        debugLog("Legacy analyze fallback: duration=" + duration.toFixed(2) + "s");

        var sampleRate = 20;
        var total = Math.max(1, Math.floor(duration * sampleRate));
        var minSwitchSec = Math.max(0, (opts.minSwitchMs || 500)) / 1000;
        var minSwitchSamples = Math.max(1, Math.round(minSwitchSec * sampleRate));

        var winners = new Array(total);
        for (var i = 0; i < total; i++) {
            var t = i / sampleRate;
            var bucket = Math.floor(t / 2);
            winners[i] = bucket % opts.speakers.length;
        }
        // Smooth min-switch.
        var smoothed = winners.slice();
        var runStart = 0;
        for (var k = 1; k <= smoothed.length; k++) {
            if (k === smoothed.length || smoothed[k] !== smoothed[runStart]) {
                if (k - runStart < minSwitchSamples && runStart > 0) {
                    for (var j = runStart; j < k; j++) smoothed[j] = smoothed[runStart - 1];
                }
                runStart = k;
            }
        }
        var edl = [];
        var segStart = 0;
        for (var p = 1; p <= smoothed.length; p++) {
            if (p === smoothed.length || smoothed[p] !== smoothed[segStart]) {
                var idx = smoothed[segStart];
                edl.push({
                    start: segStart / sampleRate,
                    end: Math.min(duration, p / sampleRate),
                    speakerIdx: idx,
                    speakerName: (idx >= 0 && opts.speakers[idx]) ? opts.speakers[idx].name : "Silence"
                });
                segStart = p;
            }
        }
        debugLog("Legacy analyze produced " + edl.length + " segments");
        return SmartEditPro.respond({ ok: true, edl: edl, duration: duration });
    }

    /* ------------------------------------------------------------------ */
    /* applyEdit - razor + disable per segment, with full diagnostics      */
    /* ------------------------------------------------------------------ */

    function applyEdit(payloadJson) {
        var seq = SmartEditPro.getActiveSequence();
        if (!seq) return SmartEditPro.error("No active sequence.");
        var payload = safeParse(payloadJson, { edl: [], options: {} });
        var edl = payload.edl || [];
        var opts = payload.options || {};

        debugLog("applyEdit: edl segments=" + edl.length +
                 ", speakers=" + ((opts.speakers || []).length));

        if (!edl.length) {
            debugLog("applyEdit: ABORT - empty EDL");
            return SmartEditPro.error("No EDL to apply.");
        }
        if (!opts.speakers || !opts.speakers.length) {
            debugLog("applyEdit: ABORT - no speaker configuration");
            return SmartEditPro.error("Speaker configuration missing.");
        }

        var bufferFrames = Math.max(0, opts.bufferFrames || 0);
        var fps = 30;
        try {
            if (seq.timebase) fps = SmartEditPro.TICKS_PER_SECOND / Number(seq.timebase);
        } catch (eFps) {}
        var bufferSec = bufferFrames / fps;
        debugLog("applyEdit: fps=" + fps.toFixed(3) + " bufferFrames=" + bufferFrames +
                 " bufferSec=" + bufferSec.toFixed(4));

        var duration = getSequenceDuration(seq);

        // Which camera / mic track indices do we care about?
        var camTrackIdxs = {};
        var micTrackIdxs = {};
        for (var s = 0; s < opts.speakers.length; s++) {
            var sp = opts.speakers[s];
            if (typeof sp.camTrackIndex === "number" && sp.camTrackIndex >= 0) camTrackIdxs[sp.camTrackIndex] = true;
            if (typeof sp.micTrackIndex === "number" && sp.micTrackIndex >= 0) micTrackIdxs[sp.micTrackIndex] = true;
        }
        var camList = []; for (var ck in camTrackIdxs) camList.push(ck);
        var micList = []; for (var mk in micTrackIdxs) micList.push(mk);
        debugLog("applyEdit: camera tracks=[" + camList.join(",") + "] mic tracks=[" + micList.join(",") + "]");

        /* ---- Phase 1: razor every boundary on the sequence ---- */
        var boundaries = {};
        for (var i = 0; i < edl.length; i++) {
            var b1 = Math.max(0, edl[i].start - bufferSec);
            var b2 = Math.min(duration, edl[i].end - bufferSec);
            if (b1 > 0.001) boundaries[b1.toFixed(6)] = b1;
            if (b2 > 0.001 && b2 < duration - 0.001) boundaries[b2.toFixed(6)] = b2;
        }
        var cutTimes = [];
        for (var key in boundaries) { if (boundaries.hasOwnProperty(key)) cutTimes.push(boundaries[key]); }
        cutTimes.sort(function (a, b) { return a - b; });
        debugLog("applyEdit: boundary times (" + cutTimes.length + "): " + cutTimes.slice(0, 20).map(function (x) { return x.toFixed(3); }).join(",") +
                 (cutTimes.length > 20 ? ", ..." : ""));

        var cuts = 0;
        var razorFailures = 0;
        try {
            for (var ci = 0; ci < cutTimes.length; ci++) {
                var ok = false;
                var ticks = SmartEditPro.secondsToTicks(cutTimes[ci]);
                try {
                    if (typeof seq.razor === "function") {
                        seq.razor(ticks);
                        ok = true;
                    }
                } catch (eR1) {
                    debugLog("applyEdit: seq.razor(" + cutTimes[ci].toFixed(3) + ") threw: " + eR1);
                }
                if (ok) {
                    cuts++;
                } else {
                    razorFailures++;
                    // Fallback: razor each video track individually.
                    try {
                        if (seq.videoTracks && seq.videoTracks.numTracks) {
                            for (var vi = 0; vi < seq.videoTracks.numTracks; vi++) {
                                var vt = seq.videoTracks[vi];
                                if (vt && typeof vt.razor === "function") {
                                    try { vt.razor(ticks); } catch (eVi) {}
                                }
                            }
                        }
                    } catch (eVT) {}
                }
            }
        } catch (eRazor) {
            debugLog("applyEdit: razor pass aborted: " + eRazor);
            return SmartEditPro.error("Razor pass failed: " + eRazor);
        }
        debugLog("applyEdit: razor pass complete. cuts=" + cuts +
                 " razorFailures=" + razorFailures);

        /* ---- Phase 2+3: disable/mute per segment ---- */
        var clipsTouched = 0;
        var clipsEnabled = 0;
        var clipsDisabled = 0;
        try {
            for (var si = 0; si < edl.length; si++) {
                var seg = edl[si];
                if (typeof seg.start !== "number" || typeof seg.end !== "number") continue;

                var activeCam = (seg.speakerIdx >= 0 && opts.speakers[seg.speakerIdx])
                    ? opts.speakers[seg.speakerIdx].camTrackIndex : -1;
                var activeMic = (seg.speakerIdx >= 0 && opts.speakers[seg.speakerIdx])
                    ? opts.speakers[seg.speakerIdx].micTrackIndex : -1;

                var r1 = applyToTrackSet(seq.videoTracks, camTrackIdxs, seg, activeCam, "disable");
                var r2 = applyToTrackSet(seq.audioTracks, micTrackIdxs, seg, activeMic, "mute");
                clipsTouched += r1.touched + r2.touched;
                clipsEnabled += r1.enabled + r2.enabled;
                clipsDisabled += r1.disabled + r2.disabled;
                debugLog("  seg[" + si + "] " + seg.start.toFixed(2) + "-" + seg.end.toFixed(2) +
                         "s speaker=" + seg.speakerIdx + " activeCam=V" + (activeCam + 1) +
                         " activeMic=A" + (activeMic + 1) +
                         " vClips:" + r1.touched + "(on=" + r1.enabled + "/off=" + r1.disabled + ")" +
                         " aClips:" + r2.touched + "(on=" + r2.enabled + "/off=" + r2.disabled + ")");
            }
        } catch (e) {
            debugLog("applyEdit: disable/mute phase failed: " + e);
            return SmartEditPro.error("Apply edit failed: " + e);
        }
        debugLog("applyEdit: done. cuts=" + cuts + " segments=" + edl.length +
                 " clipsTouched=" + clipsTouched + " enabled=" + clipsEnabled +
                 " disabled=" + clipsDisabled);

        return SmartEditPro.respond({
            ok: true,
            cuts: cuts,
            segments: edl.length,
            clipsTouched: clipsTouched,
            clipsEnabled: clipsEnabled,
            clipsDisabled: clipsDisabled,
            razorFailures: razorFailures,
            debugFile: DEBUG_FILE_PATH
        });
    }

    function applyToTrackSet(trackContainer, trackSet, seg, activeIdx, action) {
        var result = { touched: 0, enabled: 0, disabled: 0 };
        if (!trackContainer || !trackContainer.numTracks) return result;
        for (var t in trackSet) {
            if (!trackSet.hasOwnProperty(t)) continue;
            var trackIdx = parseInt(t, 10);
            if (trackIdx >= trackContainer.numTracks) continue;
            var track = trackContainer[trackIdx];
            if (!track || !track.clips) continue;
            var clips = track.clips;
            var isActive = (trackIdx === activeIdx);

            for (var c = 0; c < clips.numItems; c++) {
                var clip = clips[c];
                if (!clip) continue;
                var clipStart = clipSeconds(clip, "start");
                var clipEnd = clipSeconds(clip, "end");
                if (clipEnd <= clipStart) continue;
                var mid = (clipStart + clipEnd) / 2;
                if (mid < seg.start - 1e-4 || mid > seg.end + 1e-4) continue;
                try {
                    if (action === "disable") {
                        clip.disabled = !isActive;
                    } else if (action === "mute") {
                        if (typeof clip.setMute === "function") {
                            clip.setMute(!isActive);
                        } else {
                            try { clip.disabled = !isActive; } catch (eD) {}
                        }
                    }
                    result.touched++;
                    if (isActive) result.enabled++; else result.disabled++;
                } catch (eToggle) {}
            }
        }
        return result;
    }

    return {
        resolveMicClips: resolveMicClips,
        analyze: analyze,
        applyEdit: applyEdit,
        debugReset: debugReset,
        debugLog: function (msg) { debugLog(String(msg || "")); return SmartEditPro.respond({ ok: true }); },
        debugFilePath: function () { return SmartEditPro.respond({ ok: true, path: DEBUG_FILE_PATH }); }
    };
})();
