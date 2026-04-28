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

// Eagerly load the feature scripts so their namespaces (BeatSync, PodcastSwitch)
// are available regardless of how main.js bootstraps the host scripts.
try {
    var _here = File($.fileName).path;
    $.evalFile(_here + "/beatSync.jsx");
    $.evalFile(_here + "/podcastSwitch.jsx");
    $.evalFile(_here + "/keyframeFlow.jsx");
} catch (eLoad) {
    // Non-fatal: main.js also calls evalFile on these paths.
}
