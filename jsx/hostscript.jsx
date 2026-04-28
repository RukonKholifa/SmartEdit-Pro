/* ==========================================================================
   hostscript.jsx - SmartEdit Pro main ExtendScript entry point.

   Provides:
     SmartEditPro.getTracks()  - returns audio/video track listing of active sequence
     SmartEditPro.undo()        - calls app.undo() inside Premiere Pro
     SmartEditPro._respond(obj) - JSON-encode helper used by all features
     SmartEditPro._error(msg)   - {ok:false, error:msg}
     SmartEditPro._tickRate     - ticks per second constant
   ========================================================================== */

#target premierepro

if (typeof JSON !== "object" || typeof JSON.stringify !== "function") {
    // Premiere's ExtendScript engine ships JSON, but include a small fallback to
    // be safe. (https://github.com/Adobe-CEP/Samples)
    $.evalFile(File($.fileName).path + "/json2.jsx");
}

var SmartEditPro = (function () {
    var TICKS_PER_SECOND = 254016000000;

    function respond(obj) {
        try {
            return JSON.stringify(obj);
        } catch (e) {
            return '{"ok":false,"error":"Failed to serialize host response"}';
        }
    }

    function error(msg) {
        return respond({ ok: false, error: String(msg) });
    }

    function getActiveSequence() {
        if (!app || !app.project) return null;
        return app.project.activeSequence || null;
    }

    function secondsToTicks(seconds) {
        return String(Math.round(Number(seconds) * TICKS_PER_SECOND));
    }

    function ticksToSeconds(ticksStr) {
        return Number(ticksStr) / TICKS_PER_SECOND;
    }

    function makeTime(seconds) {
        var t;
        try {
            t = new Time();
        } catch (eNew) {
            t = {};
        }
        try {
            t.ticks = secondsToTicks(seconds);
        } catch (eTicks) {
            try { t.seconds = Number(seconds); } catch (eSec) {}
        }
        return t;
    }

    function getTracks() {
        var seq = getActiveSequence();
        if (!seq) return error("No active sequence. Open a sequence in Premiere Pro and try again.");

        var audio = [];
        var video = [];
        try {
            for (var i = 0; i < seq.audioTracks.numTracks; i++) {
                audio.push({ index: i, label: "A" + (i + 1) });
            }
            for (var j = 0; j < seq.videoTracks.numTracks; j++) {
                video.push({ index: j, label: "V" + (j + 1) });
            }
        } catch (e) {
            return error("Could not enumerate tracks: " + e);
        }
        return respond({ ok: true, audio: audio, video: video });
    }

    function undo() {
        try {
            if (typeof app.undo === "function") {
                app.undo();
            } else if (typeof app.executeCommand === "function") {
                // 16 = Edit > Undo on most Premiere builds; fall back gracefully.
                try { app.executeCommand(16); } catch (eCmd) {}
            }
            return respond({ ok: true });
        } catch (e) {
            return error("Undo failed: " + e);
        }
    }

    return {
        TICKS_PER_SECOND: TICKS_PER_SECOND,
        respond: respond,
        error: error,
        getActiveSequence: getActiveSequence,
        secondsToTicks: secondsToTicks,
        ticksToSeconds: ticksToSeconds,
        makeTime: makeTime,
        getTracks: getTracks,
        undo: undo
    };
})();

// ==========================================================================
// Load feature scripts into the SAME ExtendScript evaluation context. The
// //@include preprocessor directive inlines the files at compile time so
// their namespaces and the global wrappers below are all part of one script.
// ==========================================================================
//@include "beatSync.jsx"
//@include "podcastSwitch.jsx"
//@include "keyframeFlow.jsx"

// Runtime evalFile fallback - keeps things working if the //@include
// directive is ignored by a particular host version.
try {
    var _here = File($.fileName).path;
    $.evalFile(_here + "/beatSync.jsx");
    $.evalFile(_here + "/podcastSwitch.jsx");
    $.evalFile(_here + "/keyframeFlow.jsx");
} catch (eLoad) {
    // Non-fatal.
}

/* --------------------------------------------------------------------------
   Global wrappers around the namespaced functions so evalScript() calls can
   invoke them directly (e.g. `applyCutsAtTimes([...])`). These thin proxies
   also make it easy for main.js to `typeof fnName !== "undefined"` and
   surface a clear "JSX not loaded" message when a script failed to register.
   -------------------------------------------------------------------------- */

function SE_safeCall(fn, args) {
    try {
        return fn.apply(null, args || []);
    } catch (e) {
        return SmartEditPro.error(String(e));
    }
}

// Beat Sync
function applyCutsAtTimes(arr, opts) {
    if (typeof BeatSync === "undefined") return SmartEditPro.error("BeatSync not loaded.");
    return BeatSync.applyCutsAtTimes(JSON.stringify(arr || []), JSON.stringify(opts || {}));
}
function previewMarkers(beatsArr) {
    if (typeof BeatSync === "undefined") return SmartEditPro.error("BeatSync not loaded.");
    return BeatSync.previewMarkers(JSON.stringify({ beats: beatsArr || [] }));
}
function clearMarkers() {
    if (typeof BeatSync === "undefined") return SmartEditPro.error("BeatSync not loaded.");
    return BeatSync.clearMarkers();
}

// Podcast Smart Switcher
function applyPodcastEdit(edl, opts) {
    if (typeof PodcastSwitch === "undefined") return SmartEditPro.error("PodcastSwitch not loaded.");
    return PodcastSwitch.applyEdit(JSON.stringify({ edl: edl || [], options: opts || {} }));
}
function resolveMicClips(opts) {
    if (typeof PodcastSwitch === "undefined") return SmartEditPro.error("PodcastSwitch not loaded.");
    return PodcastSwitch.resolveMicClips(JSON.stringify(opts || {}));
}

// Keyframe Flow
function applyFlow(opts) {
    if (typeof KeyframeFlow === "undefined") return SmartEditPro.error("KeyframeFlow not loaded.");
    return KeyframeFlow.apply(JSON.stringify(opts || {}));
}
function resetFlow(opts) {
    if (typeof KeyframeFlow === "undefined") return SmartEditPro.error("KeyframeFlow not loaded.");
    return KeyframeFlow.reset(JSON.stringify(opts || {}));
}

// Settings
function getActiveSequenceInfo() {
    var seq = SmartEditPro.getActiveSequence();
    if (!seq) return SmartEditPro.error("No active sequence.");
    var info = { ok: true };
    try { info.name = String(seq.name || ""); } catch (e) {}
    try {
        if (seq.timebase) {
            var tpf = Number(seq.timebase);
            info.timebase = seq.timebase;
            info.fps = (tpf > 0) ? SmartEditPro.TICKS_PER_SECOND / tpf : null;
        }
    } catch (e) {}
    try {
        info.endSeconds = (seq.end && seq.end.seconds) ? Number(seq.end.seconds) :
            (seq.end ? Number(seq.end) / SmartEditPro.TICKS_PER_SECOND : 0);
    } catch (e) {}
    return SmartEditPro.respond(info);
}

/**
 * Re-evaluate all feature scripts from the filesystem. Used by the panel's
 * Settings > Reload Scripts button so the user never has to restart Premiere
 * after editing a .jsx file.
 */
function reloadScripts(extensionPath) {
    var t0 = (new Date()).getTime();
    var loaded = [];
    var errors = [];
    var files = ["hostscript.jsx", "beatSync.jsx", "podcastSwitch.jsx", "keyframeFlow.jsx"];
    var base = "";
    try {
        if (extensionPath) {
            base = String(extensionPath).replace(/\\/g, "/");
            if (base.charAt(base.length - 1) === "/") base = base.substring(0, base.length - 1);
            base += "/jsx";
        } else {
            base = File($.fileName).path;
        }
    } catch (e) {
        base = "";
    }
    for (var i = 0; i < files.length; i++) {
        var p = base + "/" + files[i];
        try {
            var ok = $.evalFile(p);
            if (ok === false) errors.push(p + ": evalFile returned false");
            else loaded.push(files[i]);
        } catch (eF) {
            errors.push(p + ": " + eF);
        }
    }
    var elapsed = (new Date()).getTime() - t0;
    return SmartEditPro.respond({
        ok: (errors.length === 0),
        loaded: loaded,
        errors: errors,
        elapsedMs: elapsed,
        have: {
            BeatSync: (typeof BeatSync !== "undefined"),
            PodcastSwitch: (typeof PodcastSwitch !== "undefined"),
            KeyframeFlow: (typeof KeyframeFlow !== "undefined"),
            applyCutsAtTimes: (typeof applyCutsAtTimes !== "undefined"),
            applyFlow: (typeof applyFlow !== "undefined")
        }
    });
}
