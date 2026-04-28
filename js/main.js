/* ==========================================================================
   main.js - SmartEdit Pro panel logic.

   Wires the HTML controls to the ExtendScript backend via CSInterface and
   manages local UI state (detected beats, podcast EDL, status messages).
   ========================================================================== */
(function () {
    "use strict";

    var cs = new CSInterface();

    /* ---------- helpers ---------- */
    var $ = function (sel, root) { return (root || document).querySelector(sel); };
    var $$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };

    function setStatus(text, kind) {
        var bar = $("#status-bar");
        var dot = $("#status-dot");
        $("#status-text").textContent = text;
        bar.classList.remove("busy", "error");
        if (kind === "busy") bar.classList.add("busy");
        if (kind === "error") bar.classList.add("error");
        if (kind === "ok") {
            dot.style.background = "var(--ok)";
        } else if (kind === "error") {
            dot.style.background = "var(--danger)";
        } else {
            dot.style.background = "var(--ok)";
        }
    }

    /**
     * Run an ExtendScript function. The host script is expected to return a
     * JSON string that decodes to `{ok: boolean, ...}`. We always resolve with
     * the decoded object and never throw, so the UI can render error messages.
     */
    function jsx(fnCall) {
        return new Promise(function (resolve) {
            cs.evalScript(fnCall, function (raw) {
                if (!raw || raw === "undefined") {
                    resolve({ ok: false, error: "No response from host script." });
                    return;
                }
                if (raw === "EvalScript error.") {
                    resolve({ ok: false, error: "ExtendScript evaluation failed." });
                    return;
                }
                try {
                    var parsed = JSON.parse(raw);
                    if (parsed && typeof parsed === "object") {
                        resolve(parsed);
                    } else {
                        resolve({ ok: true, value: parsed });
                    }
                } catch (e) {
                    resolve({ ok: true, value: raw });
                }
            });
        });
    }

    /** JSON-encode any JS value for safe inlining into an ExtendScript call. */
    function arg(value) {
        return JSON.stringify(JSON.stringify(value));
    }

    /* ---------- state ---------- */
    var state = {
        cutTimes: [],          // array of seconds (beat or frame mode result)
        cutSource: null,       // "beats" | "frames"
        durationSeconds: 0,
        podcastEdl: [],        // array of {start, end, speakerIdx}
        podcastDuration: 0,
        speakerCount: 2,
        speakers: [],
        audioTracks: [],
        videoTracks: []
    };

    var SPEAKER_COLORS = ["var(--speaker-1)", "var(--speaker-2)", "var(--speaker-3)"];

    /* ---------- track loading ---------- */
    function loadTracks() {
        return jsx("SmartEditPro.getTracks();").then(function (res) {
            if (!res.ok) {
                state.audioTracks = [{ index: 0, label: "A1" }, { index: 1, label: "A2" }];
                state.videoTracks = [{ index: 0, label: "V1" }, { index: 1, label: "V2" }];
                if (res.error) setStatus(res.error, "error");
                return;
            }
            state.audioTracks = res.audio || [];
            state.videoTracks = res.video || [];
        }).catch(function () {
            state.audioTracks = [{ index: 0, label: "A1" }, { index: 1, label: "A2" }];
            state.videoTracks = [{ index: 0, label: "V1" }, { index: 1, label: "V2" }];
        });
    }

    function fillSelect(select, items, mapToOption) {
        select.innerHTML = "";
        items.forEach(function (item) {
            var opt = document.createElement("option");
            mapToOption(opt, item);
            select.appendChild(opt);
        });
    }

    function refreshTrackSelects() {
        fillSelect($("#bs-music-track"), state.audioTracks, function (opt, t) {
            opt.value = String(t.index);
            opt.textContent = t.label;
        });
        $$("[data-mic-select]").forEach(function (sel) {
            fillSelect(sel, state.audioTracks, function (opt, t) {
                opt.value = String(t.index);
                opt.textContent = t.label;
            });
        });
        $$("[data-cam-select]").forEach(function (sel) {
            fillSelect(sel, state.videoTracks, function (opt, t) {
                opt.value = String(t.index);
                opt.textContent = t.label;
            });
        });
    }

    /* ---------- speaker table ---------- */
    function renderSpeakerTable() {
        var table = $("#ps-speaker-table");
        table.innerHTML = "";
        var label = document.createElement("div");
        label.className = "speaker-row-label";
        label.textContent = "Name · Mic Track · Camera Track";
        table.appendChild(label);

        for (var i = 0; i < state.speakerCount; i++) {
            var existing = state.speakers[i] || {};
            var row = document.createElement("div");
            row.className = "speaker-row";

            var nameWrap = document.createElement("div");
            var dot = document.createElement("span");
            dot.className = "speaker-color";
            dot.style.background = SPEAKER_COLORS[i] || "#888";
            var nameInput = document.createElement("input");
            nameInput.type = "text";
            nameInput.placeholder = (i === 0 ? "Host" : "Guest " + i);
            nameInput.value = existing.name || nameInput.placeholder;
            nameInput.dataset.speakerIdx = String(i);
            nameInput.dataset.field = "name";
            nameWrap.appendChild(dot);
            nameWrap.appendChild(nameInput);
            row.appendChild(nameWrap);

            var micSel = document.createElement("select");
            micSel.dataset.micSelect = "1";
            micSel.dataset.speakerIdx = String(i);
            row.appendChild(micSel);

            var camSel = document.createElement("select");
            camSel.dataset.camSelect = "1";
            camSel.dataset.speakerIdx = String(i);
            row.appendChild(camSel);

            table.appendChild(row);
        }
        // Re-fill mic/cam dropdowns now that they exist.
        $$("[data-mic-select]").forEach(function (sel, idx) {
            fillSelect(sel, state.audioTracks, function (opt, t) {
                opt.value = String(t.index);
                opt.textContent = t.label;
            });
            if (state.audioTracks[idx]) sel.value = String(state.audioTracks[idx].index);
        });
        $$("[data-cam-select]").forEach(function (sel, idx) {
            fillSelect(sel, state.videoTracks, function (opt, t) {
                opt.value = String(t.index);
                opt.textContent = t.label;
            });
            if (state.videoTracks[idx]) sel.value = String(state.videoTracks[idx].index);
        });

        renderLegend();
    }

    function renderLegend() {
        var legend = $("#ps-legend");
        legend.innerHTML = "";
        for (var i = 0; i < state.speakerCount; i++) {
            var li = document.createElement("span");
            li.className = "li";
            var sw = document.createElement("span");
            sw.className = "swatch";
            sw.style.background = SPEAKER_COLORS[i] || "#888";
            var name = document.createElement("span");
            var input = document.querySelector('input[data-field="name"][data-speaker-idx="' + i + '"]');
            name.textContent = input ? input.value : ("Speaker " + (i + 1));
            li.appendChild(sw);
            li.appendChild(name);
            legend.appendChild(li);
        }
        var sil = document.createElement("span");
        sil.className = "li";
        var silSw = document.createElement("span");
        silSw.className = "swatch";
        silSw.style.background = "var(--silence)";
        var silText = document.createElement("span");
        silText.textContent = "Silence";
        sil.appendChild(silSw);
        sil.appendChild(silText);
        legend.appendChild(sil);
    }

    function getSpeakerConfig() {
        var rows = [];
        for (var i = 0; i < state.speakerCount; i++) {
            var name = document.querySelector('input[data-field="name"][data-speaker-idx="' + i + '"]');
            var mic = document.querySelector('select[data-mic-select][data-speaker-idx="' + i + '"]');
            var cam = document.querySelector('select[data-cam-select][data-speaker-idx="' + i + '"]');
            rows.push({
                name: name ? name.value : ("Speaker " + (i + 1)),
                micTrackIndex: mic ? parseInt(mic.value, 10) : i,
                camTrackIndex: cam ? parseInt(cam.value, 10) : i
            });
        }
        return rows;
    }

    /* ---------- Beat Sync Cutter wiring ---------- */
    function bindBeatSync() {
        var slider = $("#bs-interval-slider");
        var input = $("#bs-interval");
        slider.addEventListener("input", function () { input.value = slider.value; });
        input.addEventListener("input", function () {
            var v = Math.max(1, Math.min(8, parseInt(input.value, 10) || 1));
            slider.value = String(v);
        });

        var sens = $("#bs-sensitivity");
        var sensVal = $("#bs-sensitivity-val");
        sens.addEventListener("input", function () { sensVal.textContent = sens.value; });

        $$('input[name="bs-mode"]').forEach(function (radio) {
            radio.addEventListener("change", refreshBeatModeUI);
        });
        refreshBeatModeUI();

        $("#bs-detect").addEventListener("click", onDetectBeats);
        $("#bs-preview").addEventListener("click", onPreviewMarkers);
        $("#bs-apply").addEventListener("click", onApplyCuts);
        $("#bs-clear").addEventListener("click", onClearMarkers);
    }

    function getBeatMode() {
        var checked = document.querySelector('input[name="bs-mode"]:checked');
        return checked ? checked.value : "beat";
    }

    function refreshBeatModeUI() {
        var mode = getBeatMode();
        $$("#section-beat .mode-beat").forEach(function (el) {
            el.hidden = (mode !== "beat");
        });
        $$("#section-beat .mode-frames").forEach(function (el) {
            el.hidden = (mode !== "frames");
        });
        $("#bs-detect").disabled = (mode === "frames");
        $("#bs-detect").title = (mode === "frames")
            ? "Disabled in Fixed Frames mode \u2014 cuts are computed at fixed intervals"
            : "Analyze the music track and detect beats";
    }

    function getBeatSyncOpts() {
        return {
            mode: getBeatMode(),
            musicTrackIndex: parseInt($("#bs-music-track").value, 10) || 0,
            target: $("#bs-target-mode").value,
            interval: Math.max(1, parseInt($("#bs-interval").value, 10) || 1),
            framesEvery: Math.max(1, parseInt($("#bs-frames").value, 10) || 24),
            sensitivity: parseInt($("#bs-sensitivity").value, 10) || 50,
            dbThreshold: parseInt($("#bs-threshold").value, 10) || -30,
            range: (document.querySelector('input[name="bs-range"]:checked') || {}).value || "full"
        };
    }

    /**
     * Resolve cut points for the current Beat Sync configuration.
     * Returns a Promise that resolves to {times: number[], source: "beats"|"frames", durationSeconds: number}.
     * - In "frames" mode this skips beat detection and asks the host for the
     *   target range, then generates evenly spaced cut points every N frames.
     * - In "beat" mode it returns cached beats if available, otherwise it runs
     *   detection (so Preview / Apply work without an explicit Detect click).
     */
    function resolveCutTimes(opts, force) {
        if (opts.mode === "frames") {
            return computeFrameCuts(opts);
        }
        if (!force && state.cutSource === "beats" && state.cutTimes.length) {
            return Promise.resolve({
                times: state.cutTimes.slice(),
                source: "beats",
                durationSeconds: state.durationSeconds
            });
        }
        return runBeatDetection(opts);
    }

    function computeFrameCuts(opts) {
        return jsx("BeatSync.getCutRange(" + arg(opts) + ");").then(function (info) {
            var startSec = (info && typeof info.start === "number") ? info.start : 0;
            var endSec   = (info && typeof info.end   === "number") ? info.end   : 60;
            var fps      = (info && typeof info.fps   === "number" && info.fps > 0) ? info.fps : 30;
            if (!info || !info.ok) {
                // Soft fallback so the UI still produces output.
                startSec = 0; endSec = 60; fps = 30;
            }
            var step = opts.framesEvery / fps;
            var times = [];
            for (var t = startSec + step; t < endSec; t += step) {
                times.push(+t.toFixed(4));
            }
            return { times: times, source: "frames", durationSeconds: endSec - startSec };
        });
    }

    function runBeatDetection(opts) {
        return jsx("BeatSync.exportTrackAudio(" + arg(opts) + ");").then(function (res) {
            if (!res || !res.ok) {
                return useSimulatedBeats(opts);
            }
            return decodeFromPath(res.path).then(function (buffer) {
                return SmartBeatDetector.detectBeats(buffer, {
                    sensitivity: opts.sensitivity,
                    dbThreshold: opts.dbThreshold,
                    interval: opts.interval
                });
            }).then(function (result) {
                return { times: result.beats || [], source: "beats", durationSeconds: result.durationSeconds || 0 };
            }).catch(function () {
                return useSimulatedBeats(opts);
            });
        }).catch(function () {
            return useSimulatedBeats(opts);
        });
    }

    function onDetectBeats() {
        var opts = getBeatSyncOpts();
        if (opts.mode === "frames") {
            setStatus("Switch to Beat Based mode to detect beats.", "error");
            return;
        }
        setStatus("Exporting audio for analysis...", "busy");
        $("#bs-detect").disabled = true;
        runBeatDetection(opts).then(function (result) {
            applyCutResult(result);
        }).then(function () {
            $("#bs-detect").disabled = false;
        });
    }

    function decodeFromPath(filePath) {
        // CEP exposes Node fs via window.cep_node when --enable-nodejs is set in the manifest.
        try {
            var cepNode = (typeof window !== "undefined") ? window.cep_node : null;
            if (cepNode && cepNode.require) {
                var fs = cepNode.require("fs");
                var buf = fs.readFileSync(filePath);
                var ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
                return SmartBeatDetector.decode(ab);
            }
        } catch (e) {
            return Promise.reject(e);
        }
        return Promise.reject(new Error("Node fs is not available"));
    }

    function useSimulatedBeats(opts) {
        // When we can't read the actual WAV file (e.g. nodejs disabled, dev env)
        // fall back to a synthetic 120 BPM grid so the UI flow still works.
        return jsx("BeatSync.getSequenceDuration();").then(function (info) {
            var duration = (info && info.ok && info.duration) ? info.duration : 60;
            var sim = SmartBeatDetector.simulateBeats(duration, opts);
            setStatus("Used estimated beat grid (no real audio decode).", "ok");
            return { times: sim.beats || [], source: "beats", durationSeconds: sim.durationSeconds || duration };
        });
    }

    function applyCutResult(result) {
        state.cutTimes = result.times || [];
        state.cutSource = result.source;
        state.durationSeconds = result.durationSeconds || 0;
        var info = $("#bs-info");
        var label = (result.source === "frames") ? "frame interval" : "beat";
        var n = state.cutTimes.length;
        info.textContent = "Generated " + n + " " + label + " cut" + (n === 1 ? "" : "s")
            + " over " + (state.durationSeconds ? state.durationSeconds.toFixed(2) : "?") + "s.";
        info.classList.toggle("has-data", n > 0);
        if (!n) {
            setStatus("No cut points produced. Adjust settings and try again.", "error");
        } else if (result.source === "beats") {
            setStatus("Detected " + n + " beats.", "ok");
        } else {
            setStatus("Computed " + n + " frame-interval cut points.", "ok");
        }
        return result;
    }

    /**
     * Preview markers ONLY. Does not run razor cuts.
     * Auto-resolves cut points if none are cached so the action is independent
     * from "Detect Beats".
     */
    function onPreviewMarkers() {
        var opts = getBeatSyncOpts();
        setStatus("Resolving cut points...", "busy");
        resolveCutTimes(opts, false).then(function (result) {
            applyCutResult(result);
            if (!state.cutTimes.length) return;
            setStatus("Placing preview markers...", "busy");
            return jsx("BeatSync.previewMarkers(" + arg({ beats: state.cutTimes }) + ");").then(function (res) {
                if (!res || !res.ok) {
                    setStatus((res && res.error) || "Failed to place markers.", "error");
                    return;
                }
                setStatus("Placed " + (res.added || state.cutTimes.length) + " markers (no cuts made).", "ok");
            });
        });
    }

    /**
     * Apply razor cuts ONLY. Does not place markers.
     * Auto-resolves cut points if none are cached so the action is independent
     * from "Preview Markers".
     */
    function onApplyCuts() {
        var opts = getBeatSyncOpts();
        setStatus("Resolving cut points...", "busy");
        resolveCutTimes(opts, false).then(function (result) {
            applyCutResult(result);
            if (!state.cutTimes.length) return;
            setStatus("Applying razor cuts...", "busy");
            return jsx("BeatSync.applyCuts(" + arg({ beats: state.cutTimes, options: opts }) + ");").then(function (res) {
                if (!res || !res.ok) {
                    var err = (res && res.error) ? res.error : "Failed to apply cuts.";
                    setStatus(err + "  See debug log (C:\\SmartEditPro_debug.txt).", "error");
                    return;
                }
                var msg = "Applied " + (res.cuts || 0) + " cuts";
                if (res.skipped) msg += " (" + res.skipped + " skipped)";
                if (res.fps) msg += " at " + res.fps.toFixed(2) + " fps";
                msg += ".";
                if ((res.cuts || 0) === 0) {
                    setStatus(msg + "  See C:\\SmartEditPro_debug.txt for details.", "error");
                } else {
                    setStatus(msg, "ok");
                }
            });
        });
    }

    function onClearMarkers() {
        setStatus("Clearing preview markers...", "busy");
        jsx("BeatSync.clearMarkers();").then(function (res) {
            if (!res.ok) {
                setStatus(res.error || "Failed to clear markers.", "error");
                return;
            }
            setStatus("Cleared " + (res.removed || 0) + " markers.", "ok");
        });
    }

    /* ---------- Podcast Smart Switcher wiring ---------- */
    function bindPodcast() {
        $$('input[name="ps-speakers"]').forEach(function (radio) {
            radio.addEventListener("change", function () {
                state.speakerCount = parseInt(radio.value, 10) || 2;
                renderSpeakerTable();
            });
        });
        var slider = $("#ps-silence-slider");
        var input = $("#ps-silence");
        slider.addEventListener("input", function () { input.value = slider.value; });
        input.addEventListener("input", function () {
            var v = Math.max(-60, Math.min(0, parseInt(input.value, 10) || 0));
            slider.value = String(v);
        });

        $("#ps-analyze").addEventListener("click", onAnalyzePodcast);
        $("#ps-apply").addEventListener("click", onApplyPodcast);
        $("#ps-undo").addEventListener("click", onUndoPodcast);

        // Update legend when names change.
        $("#ps-speaker-table").addEventListener("input", renderLegend);
    }

    function getPodcastOpts() {
        return {
            speakers: getSpeakerConfig(),
            silenceDb: parseInt($("#ps-silence").value, 10) || -40,
            minSwitchMs: Math.max(0, parseInt($("#ps-min-duration").value, 10) || 500),
            bufferFrames: Math.max(0, parseInt($("#ps-buffer").value, 10) || 5)
        };
    }

    function onAnalyzePodcast() {
        var opts = getPodcastOpts();
        setStatus("Resolving mic clips...", "busy");
        analyzePodcastWithAudio(opts).then(function (res) {
            if (!res.ok) {
                setStatus(res.error || "Analyze failed.", "error");
                return;
            }
            state.podcastEdl = res.edl || [];
            state.podcastDuration = res.duration || 0;
            renderPodcastPreview(state.podcastEdl, state.podcastDuration);
            setStatus("Plan ready: " + state.podcastEdl.length + " segments (" +
                (res.source === "audio" ? "real audio" : "fallback") + ").", "ok");
        });
    }

    /**
     * Full podcast analysis pipeline:
     *   1. PodcastSwitch.resolveMicClips -> per-speaker {mediaPath, seqStart, ...}
     *   2. Web Audio API decode every mic file via Node.js fs.readFileSync
     *   3. RMS over 500ms windows across the sequence duration
     *   4. Pick loudest speaker per window, smooth with minSwitchMs
     *   5. Build EDL. If any stage fails, fall back to the ExtendScript analyze
     *      so the panel still produces a usable segmentation.
     */
    function analyzePodcastWithAudio(opts) {
        return jsx("PodcastSwitch.resolveMicClips(" + arg(opts) + ");").then(function (info) {
            if (!info.ok) return { ok: false, error: info.error || "Could not resolve mic clips." };
            var duration = info.duration || 0;
            var speakers = info.speakers || [];
            if (!duration || !speakers.length) {
                return fallbackAnalyze(opts);
            }

            setStatus("Decoding mic audio...", "busy");
            var windowSec = 0.5;
            var winCount = Math.max(1, Math.floor(duration / windowSec));
            var speakerRms = speakers.map(function () { return new Array(winCount); });
            for (var s = 0; s < speakerRms.length; s++) {
                for (var w = 0; w < winCount; w++) speakerRms[s][w] = -200;
            }

            var decodeJobs = [];
            speakers.forEach(function (sp, speakerIdx) {
                (sp.clips || []).forEach(function (clip) {
                    if (!clip.mediaPath) return;
                    decodeJobs.push(decodeAndFillRms(clip, speakerIdx, speakerRms, windowSec, duration));
                });
            });

            if (!decodeJobs.length) {
                return fallbackAnalyze(opts);
            }

            return Promise.all(decodeJobs).then(function (results) {
                var anyOk = results.some(function (r) { return r && r.ok; });
                if (!anyOk) {
                    return fallbackAnalyze(opts);
                }
                var edl = buildEdlFromRms(speakerRms, speakers, opts, duration, windowSec);
                return { ok: true, edl: edl, duration: duration, source: "audio" };
            });
        });
    }

    function fallbackAnalyze(opts) {
        return jsx("PodcastSwitch.analyze(" + arg(opts) + ");").then(function (res) {
            if (!res.ok) return res;
            return { ok: true, edl: res.edl || [], duration: res.duration || 0, source: "fallback" };
        });
    }

    /**
     * Decode one mic clip's media file off disk via Node's fs, hand it to the
     * browser AudioContext, compute RMS per windowSec, and merge into the
     * shared speakerRms[speakerIdx] buffer at the clip's sequence position.
     */
    function decodeAndFillRms(clip, speakerIdx, speakerRms, windowSec, duration) {
        return readFileAsArrayBuffer(clip.mediaPath).then(function (buf) {
            if (!buf) return { ok: false };
            var ctx = getAudioContext();
            if (!ctx) return { ok: false };
            return new Promise(function (resolve) {
                ctx.decodeAudioData(buf.slice(0), function (audioBuffer) {
                    mergeRmsIntoBuffer(audioBuffer, clip, speakerIdx, speakerRms, windowSec, duration);
                    resolve({ ok: true });
                }, function (err) {
                    logSafe("decodeAudioData failed for " + clip.mediaPath + ": " + err);
                    resolve({ ok: false });
                });
            });
        }, function () { return { ok: false }; });
    }

    function mergeRmsIntoBuffer(audioBuffer, clip, speakerIdx, speakerRms, windowSec, duration) {
        var sr = audioBuffer.sampleRate;
        var channels = audioBuffer.numberOfChannels;
        var samplesPerWindow = Math.max(1, Math.round(windowSec * sr));
        var windowsInClip = Math.floor(audioBuffer.length / samplesPerWindow);
        var inPointSamples = Math.round((clip.inPoint || 0) * sr);
        var target = speakerRms[speakerIdx];
        var totalWindows = target.length;

        // Read all channel data once (mix to mono via average).
        var chData = [];
        for (var ch = 0; ch < channels; ch++) {
            chData.push(audioBuffer.getChannelData(ch));
        }

        for (var w = 0; w < windowsInClip; w++) {
            var i0 = inPointSamples + w * samplesPerWindow;
            var i1 = Math.min(audioBuffer.length, i0 + samplesPerWindow);
            if (i0 >= audioBuffer.length) break;
            var sumSq = 0;
            var n = 0;
            for (var ch2 = 0; ch2 < channels; ch2++) {
                var data = chData[ch2];
                for (var i = i0; i < i1; i += 4) {
                    var v = data[i] || 0;
                    sumSq += v * v;
                    n++;
                }
            }
            var rms = Math.sqrt(sumSq / Math.max(1, n));
            var db = rms > 0 ? 20 * Math.log(rms) / Math.LN10 : -200;

            // Map this clip-relative window index to a sequence-relative window.
            var seqTime = (clip.seqStart || 0) + w * windowSec;
            var seqWin = Math.floor(seqTime / windowSec);
            if (seqWin < 0 || seqWin >= totalWindows) continue;
            if (db > target[seqWin]) target[seqWin] = db;
        }
    }

    function buildEdlFromRms(speakerRms, speakers, opts, duration, windowSec) {
        var totalWindows = (speakerRms[0] || []).length;
        var silenceDb = (typeof opts.silenceDb === "number") ? opts.silenceDb : -40;
        var minSwitchSec = Math.max(0, (opts.minSwitchMs || 500)) / 1000;
        var minSwitchWindows = Math.max(1, Math.round(minSwitchSec / windowSec));

        // 1) Per-window winner.
        var winners = new Array(totalWindows);
        for (var w = 0; w < totalWindows; w++) {
            var bestIdx = -1;
            var bestVal = silenceDb;
            for (var s = 0; s < speakerRms.length; s++) {
                var v = speakerRms[s][w];
                if (v > bestVal) {
                    bestVal = v;
                    bestIdx = s;
                }
            }
            winners[w] = bestIdx;
        }

        // 2) Fill silent windows with the previous speaker so there are no
        //    1-window gaps for a single cough or breath.
        var last = -1;
        for (var ww = 0; ww < winners.length; ww++) {
            if (winners[ww] >= 0) last = winners[ww];
            else if (last >= 0) winners[ww] = last;
        }

        // 3) Smooth runs shorter than minSwitchWindows into the preceding run.
        var smoothed = winners.slice();
        var runStart = 0;
        for (var k = 1; k <= smoothed.length; k++) {
            if (k === smoothed.length || smoothed[k] !== smoothed[runStart]) {
                if (k - runStart < minSwitchWindows && runStart > 0) {
                    for (var j = runStart; j < k; j++) smoothed[j] = smoothed[runStart - 1];
                }
                runStart = k;
            }
        }

        // 4) Emit segments.
        var edl = [];
        var segStart = 0;
        for (var p = 1; p <= smoothed.length; p++) {
            if (p === smoothed.length || smoothed[p] !== smoothed[segStart]) {
                var idx = smoothed[segStart];
                var name = (idx >= 0 && speakers[idx]) ? (speakers[idx].name || ("Speaker " + (idx + 1))) : "Silence";
                edl.push({
                    start: segStart * windowSec,
                    end: Math.min(duration, p * windowSec),
                    speakerIdx: idx,
                    speakerName: name
                });
                segStart = p;
            }
        }
        return edl;
    }

    /* ---- Node-backed file reader (CEP has --enable-nodejs) ---- */
    function readFileAsArrayBuffer(path) {
        return new Promise(function (resolve) {
            if (!path) { resolve(null); return; }
            try {
                var fs = requireNode("fs");
                if (!fs) { resolve(null); return; }
                fs.readFile(path, function (err, data) {
                    if (err) {
                        logSafe("fs.readFile failed for '" + path + "': " + err);
                        resolve(null);
                        return;
                    }
                    // Node Buffer -> ArrayBuffer
                    var ab = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
                    resolve(ab);
                });
            } catch (e) {
                logSafe("readFile threw: " + e);
                resolve(null);
            }
        });
    }

    function requireNode(mod) {
        try {
            if (typeof window !== "undefined" && typeof window.cep_node !== "undefined" && window.cep_node.require) {
                return window.cep_node.require(mod);
            }
            if (typeof require === "function") return require(mod);
        } catch (e) {}
        return null;
    }

    var _audioCtx = null;
    function getAudioContext() {
        if (_audioCtx) return _audioCtx;
        try {
            var Ctx = window.AudioContext || window.webkitAudioContext;
            if (!Ctx) return null;
            _audioCtx = new Ctx();
        } catch (e) {
            _audioCtx = null;
        }
        return _audioCtx;
    }

    function logSafe(msg) {
        try { jsx('PodcastSwitch.debugLog(' + JSON.stringify(String(msg)) + ');'); } catch (e) {}
    }

    function renderPodcastPreview(edl, duration) {
        var bar = $("#ps-preview");
        bar.innerHTML = "";
        if (!edl.length || !duration) return;

        edl.forEach(function (seg) {
            var s = document.createElement("span");
            s.className = "seg";
            var width = ((seg.end - seg.start) / duration) * 100;
            s.style.width = width + "%";
            if (seg.speakerIdx >= 0 && seg.speakerIdx < 3) {
                s.style.background = SPEAKER_COLORS[seg.speakerIdx];
            } else {
                s.style.background = "var(--silence)";
            }
            s.title = (seg.speakerName || ("Speaker " + (seg.speakerIdx + 1))) +
                "  " + seg.start.toFixed(2) + "s - " + seg.end.toFixed(2) + "s";
            bar.appendChild(s);
        });
    }

    function onApplyPodcast() {
        var opts = getPodcastOpts();
        setStatus("Preparing apply...", "busy");
        // Ensure we have an EDL. If the user never clicked Analyze first, run
        // the full audio pipeline inline so Apply is a one-shot action.
        var prep;
        if (state.podcastEdl.length) {
            prep = Promise.resolve({ ok: true, edl: state.podcastEdl, duration: state.podcastDuration, source: "cached" });
        } else {
            prep = analyzePodcastWithAudio(opts);
        }
        prep.then(function (a) {
            if (!a.ok) {
                setStatus(a.error || "Analyze failed.", "error");
                return;
            }
            state.podcastEdl = a.edl || [];
            state.podcastDuration = a.duration || state.podcastDuration || 0;
            renderPodcastPreview(state.podcastEdl, state.podcastDuration);
            if (!state.podcastEdl.length) {
                setStatus("No segments produced - check mic track mapping.", "error");
                return;
            }
            setStatus("Applying " + state.podcastEdl.length + " segments...", "busy");
            jsx("PodcastSwitch.applyEdit(" + arg({ edl: state.podcastEdl, options: opts }) + ");").then(function (res) {
                // Fallback path: some hosts return "undefined" when the script
                // throws silently. We re-query the debug file path either way.
                if (!res || !res.ok) {
                    var err = (res && res.error) ? res.error : "Apply failed.";
                    setStatus(err + "  See debug log (C:\\SmartEditPro_debug.txt).", "error");
                    return;
                }
                var msg = "Applied " + (res.cuts || 0) + " cuts across " +
                    (res.segments || 0) + " segments" +
                    (res.clipsTouched ? " (" + (res.clipsEnabled || 0) + " kept, " +
                        (res.clipsDisabled || 0) + " disabled)." : ".");
                setStatus(msg, "ok");
            });
        });
    }

    function onUndoPodcast() {
        setStatus("Undoing last edit...", "busy");
        jsx("SmartEditPro.undo();").then(function (res) {
            if (!res.ok) {
                setStatus(res.error || "Undo failed.", "error");
                return;
            }
            setStatus("Undid last edit.", "ok");
        });
    }

    /* ---------- bootstrap ---------- */
    function loadHostScripts() {
        // CSInterface auto-loads ScriptPath from manifest, but we also explicitly
        // include the per-feature .jsx files so the panel is robust to changes.
        var ext = cs.getSystemPath ? cs.getSystemPath(SystemPath.EXTENSION) : "";
        if (!ext) return;
        var includes = [
            "/jsx/hostscript.jsx",
            "/jsx/beatSync.jsx",
            "/jsx/podcastSwitch.jsx",
            "/jsx/keyframeFlow.jsx"
        ];
        includes.forEach(function (rel) {
            var path = (ext + rel).replace(/\\/g, "/");
            cs.evalScript('$.evalFile("' + path + '")');
        });
    }

    /* ==========================================================================
       Keyframe Flow - JerryFlow-style panel
       ========================================================================== */

    /**
     * Curve preset definitions.
     * Each preset defines:
     *   - id: unique slug used in state.flowPresetId
     *   - name: display label
     *   - easeType: "both" | "in" | "out" | "linear" | "hold" - maps to the JSX
     *               interpolation type and direction
     *   - influence: 0-100 default pull strength for bezier handles
     *   - path: "M0 H C cx1 cy1 cx2 cy2 W 0" SVG d-attribute drawn inside the
     *               card. Coordinates are 0..1 normalized; we scale at render.
     *
     * The SVG coordinate system used for the cards is (0,0) top-left =
     * (0 seconds, 100% value) and (1,1) bottom-right = (1 second, 0% value),
     * matching the JerryFlow visual reference.
     */
    var FLOW_PRESETS = [
        { id: "easein-slow",     name: "EaseIn Slow",      easeType: "in",    influence: 30, path: "M0 1 C 0.1 1, 0.6 1, 1 0" },
        { id: "easein-fast",     name: "EaseIn Fast",      easeType: "in",    influence: 85, path: "M0 1 C 0.5 1, 0.9 0.9, 1 0" },
        { id: "easeout-slow",    name: "EaseOut Slow",     easeType: "out",   influence: 30, path: "M0 1 C 0.4 0, 0.9 0, 1 0" },
        { id: "easeout-fast",    name: "EaseOut Fast",     easeType: "out",   influence: 85, path: "M0 1 C 0.1 0.1, 0.5 0, 1 0" },
        { id: "easeinout-smooth",name: "EaseInOut Smooth", easeType: "both",  influence: 55, path: "M0 1 C 0.3 1, 0.7 0, 1 0" },

        { id: "easein-linear",   name: "Linear In",        easeType: "in",    influence: 10, path: "M0 1 C 0.1 0.9, 0.8 0.2, 1 0" },
        { id: "easein-bounce",   name: "EaseIn Bounce",    easeType: "in",    influence: 95, path: "M0 1 C 0.2 1.15, 0.9 1.0, 1 0" },
        { id: "empty-1",         name: "",                 empty: true },
        { id: "empty-2",         name: "",                 empty: true },
        { id: "empty-3",         name: "",                 empty: true },

        { id: "easeout-linear",  name: "Linear Out",       easeType: "out",   influence: 10, path: "M0 1 C 0.2 0.8, 0.9 0.1, 1 0" },
        { id: "easeout-bounce",  name: "EaseOut Bounce",   easeType: "out",   influence: 95, path: "M0 1 C 0.1 -0.15, 0.8 0, 1 0" },
        { id: "empty-4",         name: "",                 empty: true },
        { id: "empty-5",         name: "",                 empty: true },
        { id: "easeinout-sharp", name: "EaseInOut Sharp",  easeType: "both",  influence: 90, path: "M0 1 C 0.5 1, 0.5 0, 1 0" },

        { id: "easeinout-soft",  name: "EaseInOut Soft",   easeType: "both",  influence: 25, path: "M0 1 C 0.3 0.75, 0.7 0.25, 1 0" },
        { id: "easeinout-bounce",name: "EaseInOut Bounce", easeType: "both",  influence: 95, path: "M0 1 C 0.2 1.2, 0.8 -0.2, 1 0" },
        { id: "empty-6",         name: "",                 empty: true },
        { id: "empty-7",         name: "",                 empty: true },
        { id: "easeinout-steep", name: "EaseInOut Steep",  easeType: "both",  influence: 75, path: "M0 1 C 0.15 1, 0.85 0, 1 0" },

        { id: "hold",            name: "Hold",             easeType: "hold",  influence: 0,  path: "M0 1 L 0.5 1 L 0.5 0 L 1 0" },
        { id: "ease-ramp",       name: "Ramp",             easeType: "both",  influence: 65, path: "M0 1 C 0.2 1, 0.5 0.5, 0.7 0.05 L 1 0" },
        { id: "ease-wave",       name: "Wave",             easeType: "both",  influence: 80, path: "M0 1 C 0.2 0.2, 0.5 1.2, 1 0" },
        { id: "ease-s-long",     name: "Long S",           easeType: "both",  influence: 40, path: "M0 1 C 0.4 1, 0.6 0, 1 0" },
        { id: "linear",          name: "Linear",           easeType: "linear",influence: 0,  path: "M0 1 L 1 0" }
    ];

    /* ---------- Bind ---------- */
    function bindKeyframeFlow() {
        bindFlowSidebar();
        renderCurveGrid();
        bindFlowPresetInitialSelection();

        var strength = $("#kf-strength");
        var strengthVal = $("#kf-strength-val");
        if (strength && strengthVal) {
            strength.addEventListener("input", function () {
                strengthVal.textContent = strength.value;
            });
        }
        var applyBtn = $("#kf-apply");
        var resetBtn = $("#kf-reset");
        if (applyBtn) applyBtn.addEventListener("click", onApplyFlow);
        if (resetBtn) resetBtn.addEventListener("click", onResetFlow);

        var refreshBtn = $("#kf-refresh-info");
        var reloadBtn = $("#kf-reload-scripts");
        if (refreshBtn) refreshBtn.addEventListener("click", refreshSequenceInfo);
        if (reloadBtn) reloadBtn.addEventListener("click", reloadJsxScripts);
    }

    function bindFlowSidebar() {
        var buttons = $$(".flow-side-btn");
        var panels = $$(".flow-sub");
        buttons.forEach(function (btn) {
            btn.addEventListener("click", function () {
                var name = btn.getAttribute("data-flow-side");
                buttons.forEach(function (b) {
                    b.classList.toggle("active", b === btn);
                    b.setAttribute("aria-selected", (b === btn) ? "true" : "false");
                });
                panels.forEach(function (p) {
                    var active = (p.getAttribute("data-flow-sub") === name);
                    p.classList.toggle("active", active);
                    p.hidden = !active;
                });
                if (name === "settings") refreshSequenceInfo();
            });
        });
    }

    function renderCurveGrid() {
        var grid = $("#curve-grid");
        if (!grid) return;
        grid.innerHTML = "";
        FLOW_PRESETS.forEach(function (preset) {
            var card = document.createElement("button");
            card.type = "button";
            card.className = "curve-card" + (preset.empty ? " empty" : "");
            card.setAttribute("data-flow-preset", preset.id);
            if (!preset.empty) card.title = preset.name;

            if (preset.empty) {
                var plus = document.createElement("span");
                plus.className = "plus";
                plus.textContent = "+";
                card.appendChild(plus);
            } else {
                card.innerHTML = buildCurveSvg(preset) +
                    '<span class="curve-label">' + escapeHtml(preset.name) + '</span>';
            }

            card.addEventListener("click", function () {
                if (preset.empty) {
                    setStatus("Custom preset slots coming soon.", "ok");
                    return;
                }
                selectFlowPreset(preset.id);
            });
            grid.appendChild(card);
        });
    }

    function buildCurveSvg(preset) {
        // Card SVG viewBox is 0..100 on both axes. We map normalized preset
        // path coords (0..1) to 8..92 so there's padding around the curve.
        var pad = 10, span = 100 - 2 * pad;
        function mapPath(d) {
            return d.replace(/(-?\d*\.?\d+)\s+(-?\d*\.?\d+)/g, function (_, x, y) {
                return (pad + parseFloat(x) * span).toFixed(2) + " " +
                       (pad + parseFloat(y) * span).toFixed(2);
            });
        }
        var mapped = mapPath(preset.path);
        // Endpoint circles (handles indicators).
        return '<svg class="curve-svg" viewBox="0 0 100 100" preserveAspectRatio="xMidYMid meet" aria-hidden="true">' +
            '<defs><linearGradient id="g-' + preset.id + '" x1="0" y1="1" x2="1" y2="0">' +
            '<stop offset="0" stop-color="#b388ff"/><stop offset="1" stop-color="#8b5cf6"/>' +
            '</linearGradient></defs>' +
            '<line x1="10" y1="90" x2="20" y2="90" stroke="#ffffff" stroke-width="1.5" stroke-linecap="round"/>' +
            '<line x1="80" y1="10" x2="90" y2="10" stroke="#ffffff" stroke-width="1.5" stroke-linecap="round"/>' +
            '<path d="' + mapped + '" fill="none" stroke="url(#g-' + preset.id + ')" stroke-width="3" stroke-linecap="round"/>' +
            '<circle cx="' + (pad).toFixed(2) + '" cy="' + (pad + span).toFixed(2) + '" r="3.2" fill="#ffffff"/>' +
            '<circle cx="' + (pad + span).toFixed(2) + '" cy="' + (pad).toFixed(2) + '" r="3.2" fill="#b388ff"/>' +
            '</svg>';
    }

    function bindFlowPresetInitialSelection() {
        selectFlowPreset("easeinout-smooth");
    }

    function selectFlowPreset(id) {
        var preset = FLOW_PRESETS.find ? FLOW_PRESETS.find(function (p) { return p.id === id; }) :
            (function () { for (var i = 0; i < FLOW_PRESETS.length; i++) if (FLOW_PRESETS[i].id === id) return FLOW_PRESETS[i]; return null; })();
        if (!preset || preset.empty) return;
        state.flowPresetId = id;
        state.flowPreset = preset;
        $$(".curve-card").forEach(function (c) {
            c.classList.toggle("active", c.getAttribute("data-flow-preset") === id);
        });
        var nameEl = $("#kf-preset-name");
        if (nameEl) nameEl.textContent = preset.name;
        var strength = $("#kf-strength");
        var strengthVal = $("#kf-strength-val");
        if (strength && preset.influence != null) {
            strength.value = String(preset.influence);
            if (strengthVal) strengthVal.textContent = String(preset.influence);
        }
    }

    function escapeHtml(s) {
        return String(s).replace(/[&<>"']/g, function (c) {
            return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
        });
    }

    /* ---------- Apply / Reset ---------- */
    function getFlowOpts(easeOverride) {
        var props = $$('input[name="kf-prop"]:checked').map(function (el) { return el.value; });
        var preset = state.flowPreset || FLOW_PRESETS[4];
        var easeType = easeOverride || preset.easeType || "both";
        // "hold" maps to linear on the JSX side (true step hold is a separate
        // feature in Premiere's keyframe model).
        if (easeType === "hold") easeType = "linear";
        return {
            properties: props,
            easeType: easeType,
            influence: parseInt($("#kf-strength").value, 10) || (preset.influence || 50),
            scope: (document.querySelector('input[name="kf-scope"]:checked') || {}).value || "selected"
        };
    }

    function onApplyFlow() {
        var opts = getFlowOpts();
        if (!opts.properties.length) {
            setStatus("Pick at least one property.", "error");
            return;
        }
        setStatus("Applying flow to keyframes...", "busy");
        jsx("applyFlow(" + arg(opts) + ");").then(function (res) {
            if (!res || !res.ok) {
                setStatus((res && res.error) || "Apply flow failed.", "error");
                return;
            }
            renderFlowInfo(res, opts.easeType);
            setStatus("Flow applied to " + (res.keyframes || 0) + " keyframe"
                + ((res.keyframes === 1) ? "" : "s") + ".", "ok");
        });
    }

    function onResetFlow() {
        var opts = getFlowOpts("linear");
        if (!opts.properties.length) {
            setStatus("Pick at least one property.", "error");
            return;
        }
        setStatus("Resetting keyframes to linear...", "busy");
        jsx("resetFlow(" + arg(opts) + ");").then(function (res) {
            if (!res || !res.ok) {
                setStatus((res && res.error) || "Reset failed.", "error");
                return;
            }
            renderFlowInfo(res, "linear");
            setStatus("Reset " + (res.keyframes || 0) + " keyframe"
                + ((res.keyframes === 1) ? "" : "s") + " to linear.", "ok");
        });
    }

    function renderFlowInfo(res, easeType) {
        var info = $("#kf-info");
        if (!info) return;
        var msg = "Touched " + (res.keyframes || 0) + " keyframes on "
            + (res.properties || 0) + " properties across "
            + (res.clips || 0) + " clip" + ((res.clips === 1) ? "" : "s")
            + " (" + (easeType || "linear") + ").";
        info.textContent = msg;
        info.classList.toggle("has-data", (res.keyframes || 0) > 0);
    }

    /* ---------- Settings: sequence info + Reload Scripts ---------- */
    function refreshSequenceInfo() {
        var nameEl = $("#kf-seq-name");
        var fpsEl = $("#kf-seq-fps");
        var durEl = $("#kf-seq-dur");
        var tbEl = $("#kf-seq-timebase");
        if (!nameEl) return;
        jsx("getActiveSequenceInfo();").then(function (res) {
            if (!res || !res.ok) {
                nameEl.textContent = "-";
                fpsEl.textContent = "-";
                durEl.textContent = "-";
                tbEl.textContent = "-";
                return;
            }
            nameEl.textContent = res.name || "-";
            fpsEl.textContent = res.fps ? res.fps.toFixed(3) : "-";
            durEl.textContent = res.endSeconds ? res.endSeconds.toFixed(2) + "s" : "-";
            tbEl.textContent = res.timebase ? String(res.timebase) : "-";
        });
    }

    function reloadJsxScripts() {
        var info = $("#kf-reload-info");
        if (info) info.textContent = "Reloading...";
        setStatus("Reloading scripts...", "busy");
        var ext = cs.getSystemPath ? cs.getSystemPath(SystemPath.EXTENSION) : "";
        var path = (ext || "").replace(/\\/g, "/");
        // Two-step: re-evaluate hostscript.jsx first (which re-includes the
        // feature files), then call reloadScripts() to verify everything is
        // present and surface any errors.
        var head = '$.evalFile("' + path + '/jsx/hostscript.jsx")';
        jsx(head + "; reloadScripts(" + JSON.stringify(path) + ");").then(function (res) {
            var text;
            if (!res || !res.ok) {
                text = "Reload failed: " + ((res && res.errors) ? res.errors.join(" | ") : ((res && res.error) || "unknown"));
                if (info) info.textContent = text;
                setStatus(text, "error");
                return;
            }
            var have = res.have || {};
            var missing = Object.keys(have).filter(function (k) { return !have[k]; });
            text = "Reloaded " + (res.loaded || []).length + " file"
                + ((res.loaded || []).length === 1 ? "" : "s")
                + " in " + (res.elapsedMs || 0) + "ms.";
            if (missing.length) text += " Missing: " + missing.join(", ");
            if (info) info.textContent = text;
            setStatus(text, missing.length ? "error" : "ok");
        });
    }

    function bindCreditLink() {
        var link = $("#credit-link");
        if (!link) return;
        link.addEventListener("click", function (e) {
            e.preventDefault();
            var url = link.getAttribute("data-url");
            if (cs && typeof cs.openURLInDefaultBrowser === "function") {
                cs.openURLInDefaultBrowser(url);
            } else if (typeof window !== "undefined") {
                window.open(url, "_blank");
            }
        });
    }

    function bindTabs() {
        $$(".tab-btn").forEach(function (btn) {
            btn.addEventListener("click", function () {
                var target = btn.getAttribute("data-tab");
                $$(".tab-btn").forEach(function (b) {
                    var active = (b.getAttribute("data-tab") === target);
                    b.classList.toggle("active", active);
                    b.setAttribute("aria-selected", active ? "true" : "false");
                });
                $$(".tab-panel").forEach(function (p) {
                    var active = (p.getAttribute("data-tab-panel") === target);
                    p.classList.toggle("active", active);
                    p.hidden = !active;
                });
            });
        });
    }

    function init() {
        loadHostScripts();
        bindTabs();
        bindBeatSync();
        bindPodcast();
        bindKeyframeFlow();
        bindCreditLink();
        loadTracks().then(function () {
            refreshTrackSelects();
            renderSpeakerTable();
            setStatus("Ready.", "ok");
        });
    }

    if (document.readyState === "complete" || document.readyState === "interactive") {
        init();
    } else {
        document.addEventListener("DOMContentLoaded", init);
    }
})();
