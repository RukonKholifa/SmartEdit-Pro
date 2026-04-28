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
        beats: [],            // array of seconds
        podcastEdl: [],       // array of {start, end, speakerIdx}
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

        $("#bs-detect").addEventListener("click", onDetectBeats);
        $("#bs-preview").addEventListener("click", onPreviewMarkers);
        $("#bs-apply").addEventListener("click", onApplyCuts);
        $("#bs-clear").addEventListener("click", onClearMarkers);
    }

    function getBeatSyncOpts() {
        return {
            musicTrackIndex: parseInt($("#bs-music-track").value, 10) || 0,
            target: $("#bs-target-mode").value,
            interval: Math.max(1, parseInt($("#bs-interval").value, 10) || 1),
            sensitivity: parseInt($("#bs-sensitivity").value, 10) || 50,
            dbThreshold: parseInt($("#bs-threshold").value, 10) || -30,
            range: (document.querySelector('input[name="bs-range"]:checked') || {}).value || "full"
        };
    }

    function onDetectBeats() {
        var opts = getBeatSyncOpts();
        setStatus("Exporting audio for analysis...", "busy");
        $("#bs-detect").disabled = true;

        jsx("BeatSync.exportTrackAudio(" + arg(opts) + ");").then(function (res) {
            if (!res.ok) {
                setStatus(res.error || "Could not export audio. Falling back to estimate.", "error");
                useSimulatedBeats(opts);
                return;
            }
            // res.path = absolute path to a wav file the JSX wrote.
            // res.duration = sequence/clip duration in seconds.
            setStatus("Analyzing audio for beats...", "busy");
            return decodeFromPath(res.path).then(function (buffer) {
                return SmartBeatDetector.detectBeats(buffer, {
                    sensitivity: opts.sensitivity,
                    dbThreshold: opts.dbThreshold,
                    interval: opts.interval
                });
            }).then(function (result) {
                applyBeatResult(result);
            }).catch(function (err) {
                setStatus("Audio decode failed: " + (err && err.message ? err.message : err), "error");
                useSimulatedBeats(opts);
            });
        }).catch(function (err) {
            setStatus("Beat detection failed: " + err, "error");
            useSimulatedBeats(opts);
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
            applyBeatResult(sim);
            setStatus("Used estimated beat grid (no real audio decode).", "ok");
        });
    }

    function applyBeatResult(result) {
        state.beats = result.beats || [];
        var info = $("#bs-info");
        info.textContent = "Detected " + state.beats.length + " beat" + (state.beats.length === 1 ? "" : "s")
            + " over " + (result.durationSeconds ? result.durationSeconds.toFixed(2) : "?") + "s.";
        info.classList.toggle("has-data", state.beats.length > 0);
        if (!state.beats.length) {
            setStatus("No beats found. Try increasing sensitivity.", "error");
        } else {
            setStatus("Detected " + state.beats.length + " beats.", "ok");
        }
    }

    function onPreviewMarkers() {
        if (!state.beats.length) {
            setStatus("Detect beats first.", "error");
            return;
        }
        setStatus("Placing preview markers...", "busy");
        jsx("BeatSync.previewMarkers(" + arg({ beats: state.beats }) + ");").then(function (res) {
            if (!res.ok) {
                setStatus(res.error || "Failed to place markers.", "error");
                return;
            }
            setStatus("Placed " + (res.added || state.beats.length) + " preview markers.", "ok");
        });
    }

    function onApplyCuts() {
        if (!state.beats.length) {
            setStatus("Detect beats first.", "error");
            return;
        }
        var opts = getBeatSyncOpts();
        setStatus("Applying razor cuts...", "busy");
        jsx("BeatSync.applyCuts(" + arg({ beats: state.beats, options: opts }) + ");").then(function (res) {
            if (!res.ok) {
                setStatus(res.error || "Failed to apply cuts.", "error");
                return;
            }
            setStatus("Applied " + (res.cuts || state.beats.length) + " cuts.", "ok");
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
            "/jsx/podcastSwitch.jsx"
        ];
        includes.forEach(function (rel) {
            var path = (ext + rel).replace(/\\/g, "/");
            cs.evalScript('$.evalFile("' + path + '")');
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

    function init() {
        loadHostScripts();
        bindBeatSync();
        bindPodcast();
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
