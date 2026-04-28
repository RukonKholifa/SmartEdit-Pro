/* ==========================================================================
   beatDetector.js - Web Audio API based onset detection for the
   "Beat Sync Cutter" panel.

   Approach (lightweight, runs entirely in the panel without external libs):
     1. Decode the audio file with OfflineAudioContext.
     2. Compute a short-time energy envelope (~10 ms hops on a downmixed mono).
     3. Run a peak-picker with a sliding average threshold.
     4. Map the panel's "Sensitivity" slider (1-100) to the threshold multiplier
        and the panel's "Min Audio Level (dB)" to a hard envelope floor.
     5. Return beat times in seconds plus a count.

   The detector is exposed on `window.SmartBeatDetector`.
   ========================================================================== */
(function (global) {
    "use strict";

    var HOP_MS = 10;          // analysis hop in ms
    var WIN_MS = 40;           // analysis window in ms
    var MIN_GAP_MS = 120;       // do not allow two beats closer than this
    var MEAN_WINDOW = 43;       // ~ 0.43s of context for adaptive threshold

    /**
     * Decode an AudioBuffer from a File, Blob, or ArrayBuffer.
     */
    function decode(input) {
        var ctx;
        try {
            ctx = new (global.OfflineAudioContext || global.webkitOfflineAudioContext)(
                1, 44100 * 1, 44100
            );
        } catch (e) {
            return Promise.reject(e);
        }
        var arrayBufferP;
        if (input instanceof ArrayBuffer) {
            arrayBufferP = Promise.resolve(input);
        } else if (input && typeof input.arrayBuffer === "function") {
            arrayBufferP = input.arrayBuffer();
        } else {
            return Promise.reject(new Error("beatDetector.decode: unsupported input"));
        }
        return arrayBufferP.then(function (ab) {
            return ctx.decodeAudioData(ab);
        });
    }

    /**
     * Compute the short-time energy envelope of an AudioBuffer (mono mix).
     */
    function envelope(audioBuffer) {
        var sr = audioBuffer.sampleRate;
        var numCh = audioBuffer.numberOfChannels;
        var len = audioBuffer.length;
        var hop = Math.floor(sr * HOP_MS / 1000);
        var win = Math.floor(sr * WIN_MS / 1000);
        var frames = Math.floor((len - win) / hop) + 1;
        if (frames <= 0) return { env: new Float32Array(0), hop: hop, sampleRate: sr };

        // Downmix to mono in a buffer.
        var mono = new Float32Array(len);
        for (var c = 0; c < numCh; c++) {
            var data = audioBuffer.getChannelData(c);
            for (var i = 0; i < len; i++) {
                mono[i] += data[i];
            }
        }
        if (numCh > 1) {
            for (var k = 0; k < len; k++) mono[k] /= numCh;
        }

        var env = new Float32Array(frames);
        for (var f = 0; f < frames; f++) {
            var start = f * hop;
            var sum = 0;
            for (var s = 0; s < win; s++) {
                var v = mono[start + s];
                sum += v * v;
            }
            env[f] = Math.sqrt(sum / win);
        }
        return { env: env, hop: hop, sampleRate: sr };
    }

    /**
     * Peak-pick the envelope with an adaptive moving-average threshold.
     * @param {Float32Array} env
     * @param {number} sensitivity  1-100 (UI slider)
     * @param {number} dbFloor      minimum allowed envelope level (linear)
     * @returns {number[]} indices of detected onsets in `env`
     */
    function pickPeaks(env, sensitivity, dbFloor) {
        var n = env.length;
        if (!n) return [];

        // Sensitivity: high (100) -> low multiplier, low (1) -> high multiplier.
        // Map 1..100 onto multiplier 2.5 .. 1.05 (smaller = more beats).
        var mult = 2.5 - ((Math.max(1, Math.min(100, sensitivity)) - 1) / 99) * 1.45;

        var halfW = Math.floor(MEAN_WINDOW / 2);
        var peaks = [];

        for (var i = 1; i < n - 1; i++) {
            var lo = Math.max(0, i - halfW);
            var hi = Math.min(n - 1, i + halfW);
            var sum = 0;
            for (var j = lo; j <= hi; j++) sum += env[j];
            var mean = sum / (hi - lo + 1);
            var threshold = mean * mult;

            if (env[i] < dbFloor) continue;
            if (env[i] < threshold) continue;
            if (env[i] <= env[i - 1] || env[i] < env[i + 1]) continue;
            peaks.push(i);
        }
        return peaks;
    }

    function dbToLinear(db) {
        return Math.pow(10, db / 20);
    }

    /**
     * Top-level beat detection.
     * @param {AudioBuffer|ArrayBuffer|Blob|File} input
     * @param {object} opts { sensitivity: number, dbThreshold: number, interval: number }
     * @returns {Promise<{beats: number[], count: number, durationSeconds: number}>}
     */
    function detectBeats(input, opts) {
        opts = opts || {};
        var sensitivity = (typeof opts.sensitivity === "number") ? opts.sensitivity : 50;
        var dbThreshold = (typeof opts.dbThreshold === "number") ? opts.dbThreshold : -30;
        var interval = Math.max(1, Math.floor(opts.interval || 1));

        var bufferP;
        if (input && typeof input.getChannelData === "function") {
            bufferP = Promise.resolve(input);
        } else {
            bufferP = decode(input);
        }

        return bufferP.then(function (audioBuffer) {
            var env = envelope(audioBuffer);
            var floor = dbToLinear(dbThreshold);
            var idxs = pickPeaks(env.env, sensitivity, floor);

            // Enforce minimum gap.
            var minGapFrames = Math.floor(MIN_GAP_MS / HOP_MS);
            var filtered = [];
            for (var i = 0; i < idxs.length; i++) {
                if (filtered.length === 0 || idxs[i] - filtered[filtered.length - 1] >= minGapFrames) {
                    filtered.push(idxs[i]);
                }
            }

            // Apply "every Nth beat" interval.
            var spaced = [];
            for (var k = 0; k < filtered.length; k += interval) {
                spaced.push(filtered[k]);
            }

            // Convert frame indices to seconds.
            var hopSec = HOP_MS / 1000;
            var beats = spaced.map(function (idx) { return idx * hopSec; });

            return {
                beats: beats,
                count: beats.length,
                durationSeconds: audioBuffer.duration,
                rawCount: filtered.length
            };
        });
    }

    /**
     * Synthetic / simulated beat times - used when the panel cannot read the real
     * audio (e.g. when running outside of CEP for development). Generates evenly
     * spaced beats at a default 120 BPM scaled by sensitivity.
     */
    function simulateBeats(durationSeconds, opts) {
        opts = opts || {};
        var bpm = 120;
        var sensitivity = (typeof opts.sensitivity === "number") ? opts.sensitivity : 50;
        // Higher sensitivity slightly increases tempo to mimic detecting more beats.
        bpm += (sensitivity - 50) * 0.4;
        var interval = Math.max(1, Math.floor(opts.interval || 1));
        var spacing = 60 / bpm * interval;
        var beats = [];
        for (var t = spacing; t < durationSeconds; t += spacing) {
            beats.push(+t.toFixed(3));
        }
        return { beats: beats, count: beats.length, durationSeconds: durationSeconds, rawCount: beats.length * interval };
    }

    global.SmartBeatDetector = {
        decode: decode,
        envelope: envelope,
        detectBeats: detectBeats,
        simulateBeats: simulateBeats
    };
})(typeof window !== "undefined" ? window : this);
