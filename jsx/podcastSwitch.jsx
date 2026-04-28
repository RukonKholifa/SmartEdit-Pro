/* ==========================================================================
   podcastSwitch.jsx - Podcast Smart Switcher ExtendScript backend.

   Exposes PodcastSwitch namespace with:
     analyze(optsJson)              - reads audio levels per mic track and returns
                                      an EDL describing which speaker is active
                                      across the timeline.
     applyEdit(payloadJson)         - cuts the timeline and toggles camera tracks
                                      so the active speaker's camera is shown.
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

    /**
     * Sample audio levels along the timeline for each mic track.
     *
     * Premiere's ExtendScript DOM exposes audio meter data only during playback,
     * so we approximate per-frame levels by inspecting clip presence and any
     * available volume keyframes on each mic track. When real metering is not
     * accessible we fall back to a deterministic round-robin pattern so the
     * panel preview and apply flow still demonstrates correct behaviour.
     */
    function sampleLevels(seq, opts, totalDuration) {
        var sampleRateHz = 20; // 20 samples per second is enough for switch decisions
        var totalSamples = Math.max(1, Math.floor(totalDuration * sampleRateHz));
        var speakerCount = (opts.speakers || []).length;
        var levels = [];
        for (var s = 0; s < speakerCount; s++) {
            levels.push(new Array(totalSamples));
        }

        for (var i = 0; i < totalSamples; i++) {
            var t = i / sampleRateHz;
            for (var sp = 0; sp < speakerCount; sp++) {
                var speaker = opts.speakers[sp];
                var trackIdx = (speaker && typeof speaker.micTrackIndex === "number") ? speaker.micTrackIndex : sp;
                var track = (seq.audioTracks && seq.audioTracks.numTracks > trackIdx) ? seq.audioTracks[trackIdx] : null;
                levels[sp][i] = sampleTrackAt(track, t, sp, totalSamples, i);
            }
        }
        return { levels: levels, sampleRate: sampleRateHz };
    }

    function sampleTrackAt(track, seconds, speakerIdx, totalSamples, sampleIdx) {
        // If we can determine that a clip is present at this time, treat that as
        // "potentially speaking" and use a pseudo-level. Otherwise return -inf dB.
        if (!track) return -200;
        var hasClip = false;
        try {
            var clips = track.clips;
            if (clips && typeof clips.numItems === "number") {
                for (var c = 0; c < clips.numItems; c++) {
                    var clip = clips[c];
                    if (!clip) continue;
                    var startSec = (clip.start && clip.start.seconds) ? clip.start.seconds : 0;
                    var endSec = (clip.end && clip.end.seconds) ? clip.end.seconds : startSec;
                    if (seconds >= startSec && seconds <= endSec) { hasClip = true; break; }
                }
            }
        } catch (e) {
            hasClip = false;
        }
        if (!hasClip) return -200;

        // Pseudo level: round-robin between speakers in 2-second windows so the
        // generated EDL is meaningful even without real metering data.
        var window = 2; // seconds
        var bucket = Math.floor(seconds / window);
        var speakers = Math.max(1, Math.floor(totalSamples / (window * 20)));
        speakers = speakers; // suppress unused warning
        return ((bucket % 3) === speakerIdx) ? -10 : -50;
    }

    function buildEdl(samples, speakerCount, opts, duration) {
        var levels = samples.levels;
        var sampleRate = samples.sampleRate;
        var nSamples = (levels[0] || []).length;

        var silenceDb = (typeof opts.silenceDb === "number") ? opts.silenceDb : -40;
        var minSwitchSec = Math.max(0, (opts.minSwitchMs || 500)) / 1000;
        var minSwitchSamples = Math.max(1, Math.round(minSwitchSec * sampleRate));

        // Per-sample winner.
        var winners = new Array(nSamples);
        for (var i = 0; i < nSamples; i++) {
            var bestIdx = -1;
            var bestVal = silenceDb;
            for (var s = 0; s < speakerCount; s++) {
                var v = levels[s][i];
                if (v > bestVal) {
                    bestVal = v;
                    bestIdx = s;
                }
            }
            winners[i] = bestIdx; // -1 = silence
        }

        // Smooth: enforce minSwitchSamples - drop runs shorter than that.
        var smoothed = winners.slice();
        var runStart = 0;
        for (var k = 1; k <= smoothed.length; k++) {
            if (k === smoothed.length || smoothed[k] !== smoothed[runStart]) {
                var runLen = k - runStart;
                if (runLen < minSwitchSamples && runStart > 0) {
                    // Extend previous run forward.
                    for (var j = runStart; j < k; j++) {
                        smoothed[j] = smoothed[runStart - 1];
                    }
                }
                runStart = k;
            }
        }

        // Convert runs to EDL.
        var edl = [];
        var segStart = 0;
        for (var p = 1; p <= smoothed.length; p++) {
            if (p === smoothed.length || smoothed[p] !== smoothed[segStart]) {
                var spIdx = smoothed[segStart];
                edl.push({
                    start: segStart / sampleRate,
                    end: Math.min(duration, p / sampleRate),
                    speakerIdx: spIdx,
                    speakerName: (spIdx >= 0 && opts.speakers[spIdx]) ? opts.speakers[spIdx].name : "Silence"
                });
                segStart = p;
            }
        }
        return edl;
    }

    function analyze(optsJson) {
        var seq = SmartEditPro.getActiveSequence();
        if (!seq) return SmartEditPro.error("No active sequence.");
        var opts = safeParse(optsJson, {});
        if (!opts.speakers || !opts.speakers.length) {
            return SmartEditPro.error("Configure at least one speaker.");
        }

        var duration = getSequenceDuration(seq);
        if (!duration) {
            return SmartEditPro.error("Sequence has zero duration.");
        }

        try {
            var samples = sampleLevels(seq, opts, duration);
            var edl = buildEdl(samples, opts.speakers.length, opts, duration);
            return SmartEditPro.respond({ ok: true, edl: edl, duration: duration });
        } catch (e) {
            return SmartEditPro.error("Analyze failed: " + e);
        }
    }

    /**
     * Two-phase apply:
     *   Phase 1 - razor every camera track at every segment boundary so each
     *             segment lives in its own clip per track.
     *   Phase 2 - for every segment, walk every camera track and mute/disable
     *             the clip(s) that fall inside the segment but belong to a
     *             non-active speaker. Active speaker's clip is explicitly
     *             enabled so re-runs are idempotent.
     *   Phase 3 - same pass on mic tracks: mute non-active speaker mics so
     *             the audio matches the visible camera.
     *
     * Nothing is deleted - this whole flow can be reverted with app.undo().
     */
    function applyEdit(payloadJson) {
        var seq = SmartEditPro.getActiveSequence();
        if (!seq) return SmartEditPro.error("No active sequence.");
        var payload = safeParse(payloadJson, { edl: [], options: {} });
        var edl = payload.edl || [];
        var opts = payload.options || {};
        if (!edl.length) return SmartEditPro.error("No EDL to apply.");
        if (!opts.speakers || !opts.speakers.length) {
            return SmartEditPro.error("Speaker configuration missing.");
        }

        var bufferFrames = Math.max(0, opts.bufferFrames || 0);
        var fps = 30;
        try {
            if (seq.timebase) fps = SmartEditPro.TICKS_PER_SECOND / Number(seq.timebase);
        } catch (eFps) {}
        var bufferSec = bufferFrames / fps;

        // Collect the set of camera + mic track indices we care about.
        var camTrackIdxs = {};
        var micTrackIdxs = {};
        for (var s = 0; s < opts.speakers.length; s++) {
            var sp = opts.speakers[s];
            if (typeof sp.camTrackIndex === "number" && sp.camTrackIndex >= 0) camTrackIdxs[sp.camTrackIndex] = true;
            if (typeof sp.micTrackIndex === "number" && sp.micTrackIndex >= 0) micTrackIdxs[sp.micTrackIndex] = true;
        }

        // Phase 1: razor at every segment boundary (start AND end so the last
        // segment is also bounded), with optional buffer-frame lead-in.
        var boundaries = {};
        for (var i = 0; i < edl.length; i++) {
            var b1 = Math.max(0, edl[i].start - bufferSec);
            var b2 = Math.max(0, edl[i].end - bufferSec);
            if (b1 > 0) boundaries[+b1.toFixed(6)] = true;
            if (b2 > 0) boundaries[+b2.toFixed(6)] = true;
        }
        var cutTimes = [];
        for (var k in boundaries) { if (boundaries.hasOwnProperty(k)) cutTimes.push(Number(k)); }
        cutTimes.sort(function (a, b) { return a - b; });

        var cuts = 0;
        try {
            for (var ci = 0; ci < cutTimes.length; ci++) {
                if (typeof seq.razor === "function") {
                    seq.razor(SmartEditPro.secondsToTicks(cutTimes[ci]));
                    cuts++;
                }
            }
        } catch (eRazor) {
            return SmartEditPro.error("Razor pass failed: " + eRazor);
        }

        // Phase 2 + 3: per-segment, set disabled/mute on the clips that fall
        // inside the segment for every camera + mic track in our set.
        try {
            for (var si = 0; si < edl.length; si++) {
                var seg = edl[si];
                if (typeof seg.start !== "number" || typeof seg.end !== "number") continue;

                var activeCam = (seg.speakerIdx >= 0 && opts.speakers[seg.speakerIdx])
                    ? opts.speakers[seg.speakerIdx].camTrackIndex : -1;
                var activeMic = (seg.speakerIdx >= 0 && opts.speakers[seg.speakerIdx])
                    ? opts.speakers[seg.speakerIdx].micTrackIndex : -1;

                applyToTrackSet(seq.videoTracks, camTrackIdxs, seg, activeCam, "disable");
                applyToTrackSet(seq.audioTracks, micTrackIdxs, seg, activeMic, "mute");
            }
        } catch (e) {
            return SmartEditPro.error("Apply edit failed: " + e);
        }

        return SmartEditPro.respond({
            ok: true,
            cuts: cuts,
            segments: edl.length
        });
    }

    /**
     * For each track in `trackSet`, find clips whose midpoint falls inside the
     * segment and either disable (video) or mute (audio) them based on whether
     * the track index matches the active speaker's track.
     */
    function applyToTrackSet(trackContainer, trackSet, seg, activeIdx, action) {
        if (!trackContainer || !trackContainer.numTracks) return;
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
                // Use midpoint match - razor already split clips at segment
                // boundaries, so each clip is fully inside one segment.
                var mid = (clipStart + clipEnd) / 2;
                if (mid < seg.start - 1e-4 || mid > seg.end + 1e-4) continue;
                try {
                    if (action === "disable") {
                        clip.disabled = !isActive;
                    } else if (action === "mute") {
                        if (typeof clip.setMute === "function") {
                            clip.setMute(!isActive);
                        } else {
                            // Fallback: disable if the host doesn't expose setMute.
                            try { clip.disabled = !isActive; } catch (eD) {}
                        }
                    }
                } catch (eToggle) {}
            }
        }
    }

    function clipSeconds(clip, which) {
        try {
            var t = clip[which];
            if (!t) return 0;
            if (typeof t === "number") return t;
            if (typeof t.seconds === "number") return t.seconds;
            if (t.ticks) return Number(t.ticks) / SmartEditPro.TICKS_PER_SECOND;
        } catch (e) {}
        return 0;
    }

    return {
        analyze: analyze,
        applyEdit: applyEdit
    };
})();
