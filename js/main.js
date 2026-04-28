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
                    setStatus((res && res.error) || "Failed to apply cuts.", "error");
                    return;
                }
                setStatus("Applied " + (res.cuts || state.cutTimes.length) + " cuts (no markers placed).", "ok");
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
        setStatus("Analyzing mic tracks...", "busy");
        jsx("PodcastSwitch.analyze(" + arg(opts) + ");").then(function (res) {
            if (!res.ok) {
                setStatus(res.error || "Analyze failed.", "error");
                return;
            }
            state.podcastEdl = res.edl || [];
            renderPodcastPreview(state.podcastEdl, res.duration || 0);
            setStatus("Plan ready: " + state.podcastEdl.length + " segments.", "ok");
        });
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
        if (!state.podcastEdl.length) {
            setStatus("Analyze first.", "error");
            return;
        }
        var opts = getPodcastOpts();
        setStatus("Applying podcast edit...", "busy");
        jsx("PodcastSwitch.applyEdit(" + arg({ edl: state.podcastEdl, options: opts }) + ");").then(function (res) {
            if (!res.ok) {
                setStatus(res.error || "Apply failed.", "error");
                return;
            }
            setStatus("Edit applied (" + (res.cuts || 0) + " cuts).", "ok");
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

    /* ---------- Keyframe Flow wiring ---------- */
    function bindKeyframeFlow() {
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
    }

    function getFlowOpts() {
        var props = $$('input[name="kf-prop"]:checked').map(function (el) { return el.value; });
        return {
            properties: props,
            easeType: (document.querySelector('input[name="kf-ease"]:checked') || {}).value || "both",
            influence: parseInt($("#kf-strength").value, 10) || 50,
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
        jsx("KeyframeFlow.apply(" + arg(opts) + ");").then(function (res) {
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
        var opts = getFlowOpts();
        if (!opts.properties.length) {
            setStatus("Pick at least one property.", "error");
            return;
        }
        setStatus("Resetting keyframes to linear...", "busy");
        jsx("KeyframeFlow.reset(" + arg(opts) + ");").then(function (res) {
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
