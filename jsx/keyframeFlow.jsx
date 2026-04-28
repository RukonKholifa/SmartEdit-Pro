/* ==========================================================================
   keyframeFlow.jsx - "Keyframe Flow" ExtendScript backend.

   Mimics the After Effects "Flow" plugin by smoothing temporal interpolation
   on clip effect-property keyframes inside Premiere Pro.

   Exposes KeyframeFlow namespace with:
     apply(optsJson)  - set temporal interpolation + ease influence on every
                        keyframe of every matching property on the target
                        clip(s). Wrapped in beginUndoGroup so Ctrl+Z reverts.
     reset(optsJson)  - same iteration, but forces LINEAR interpolation.

   Premiere Pro's property keyframe API:
     - component.properties  iterator of EffectProperty.
     - property.isTimeVarying()             -> boolean
     - property.getKeys()                    -> array of Time keyframe positions
     - property.getInterpolationTypeAtKey(t) / setInterpolationTypeAtKey(type, t)
     - property.setTemporalEaseAtKey(t, inEase, outEase)
         where inEase / outEase are arrays of KeyframeEase-like objects
         with { influence, speed }. We follow the prompt and pass speed=0.
   ========================================================================== */

if (typeof SmartEditPro === "undefined") {
    var SmartEditPro = {
        respond: function (o) { return '{"ok":false,"error":"hostscript.jsx not loaded"}'; },
        error:   function (m) { return '{"ok":false,"error":"' + String(m).replace(/"/g, "'") + '"}'; },
        getActiveSequence: function () { return null; },
        TICKS_PER_SECOND: 254016000000
    };
}

var KeyframeFlow = (function () {

    // Premiere's KeyframeInterpolationType constants. We hold our own mapping
    // so the script keeps working even if the constant names vary by host
    // version - we fall back to the documented numeric IDs.
    var INTERP = {
        LINEAR:  (typeof KeyframeInterpolationType !== "undefined" && KeyframeInterpolationType.LINEAR)  != null ? KeyframeInterpolationType.LINEAR  : 1,
        BEZIER:  (typeof KeyframeInterpolationType !== "undefined" && KeyframeInterpolationType.BEZIER)  != null ? KeyframeInterpolationType.BEZIER  : 2,
        EASE_IN: (typeof KeyframeInterpolationType !== "undefined" && KeyframeInterpolationType.EASE_IN) != null ? KeyframeInterpolationType.EASE_IN : 5,
        EASE_OUT:(typeof KeyframeInterpolationType !== "undefined" && KeyframeInterpolationType.EASE_OUT)!= null ? KeyframeInterpolationType.EASE_OUT: 6
    };

    function safeParse(json, fallback) {
        try { return json ? eval("(" + json + ")") : (fallback || {}); }
        catch (e) { return fallback || {}; }
    }

    /**
     * Collect target clips based on the "Apply To" scope.
     *   scope = "selected" -> every selected video clip on any V-track.
     *   scope = "v1all"    -> every clip on videoTracks[0].
     */
    function collectClips(seq, scope) {
        var clips = [];
        if (!seq || !seq.videoTracks) return clips;
        if (scope === "v1all") {
            var track = seq.videoTracks[0];
            if (track && track.clips) {
                for (var c = 0; c < track.clips.numItems; c++) {
                    if (track.clips[c]) clips.push(track.clips[c]);
                }
            }
            return clips;
        }
        // Default: selected clips anywhere.
        for (var v = 0; v < seq.videoTracks.numTracks; v++) {
            var t = seq.videoTracks[v];
            if (!t || !t.clips) continue;
            for (var i = 0; i < t.clips.numItems; i++) {
                var clip = t.clips[i];
                if (clip && clip.isSelected && clip.isSelected()) clips.push(clip);
            }
        }
        // Fallback - if nothing was selected, do V1 so the button still does
        // something useful instead of silently no-op.
        if (!clips.length && seq.videoTracks[0] && seq.videoTracks[0].clips) {
            for (var j = 0; j < seq.videoTracks[0].clips.numItems; j++) {
                if (seq.videoTracks[0].clips[j]) clips.push(seq.videoTracks[0].clips[j]);
            }
        }
        return clips;
    }

    /**
     * Find every property on the clip whose display name contains one of the
     * target property names (case-insensitive). Premiere stores standard
     * transform properties on the built-in "Motion" component and opacity on
     * the "Opacity" component; the display name is stable across locales
     * only in English, so callers should pass English names.
     */
    function collectProperties(clip, propNames) {
        var results = [];
        if (!clip || !clip.components) return results;
        var lowered = [];
        for (var n = 0; n < propNames.length; n++) {
            lowered.push(String(propNames[n]).toLowerCase());
        }
        for (var ci = 0; ci < clip.components.numItems; ci++) {
            var comp = clip.components[ci];
            if (!comp || !comp.properties) continue;
            for (var pi = 0; pi < comp.properties.numItems; pi++) {
                var prop = comp.properties[pi];
                if (!prop) continue;
                var name = "";
                try { name = prop.displayName || prop.name || ""; } catch (e) {}
                var low = String(name).toLowerCase();
                for (var k = 0; k < lowered.length; k++) {
                    if (low === lowered[k] || low.indexOf(lowered[k]) !== -1) {
                        results.push({ prop: prop, name: name });
                        break;
                    }
                }
            }
        }
        return results;
    }

    /**
     * Build a {influence, speed} ease object matching Premiere's
     * setTemporalEaseAtKey(time, inEase[], outEase[]) shape. Premiere expects
     * an array so multi-component properties (Position is x/y) all get the
     * same ease. We always pass speed = 0 per the panel's spec.
     */
    function makeEase(influence) {
        var clamped = Math.max(0.1, Math.min(100, influence));
        // Build 4 entries so 4D properties (Position, Scale xy, etc.) work too.
        return [
            { influence: clamped, speed: 0 },
            { influence: clamped, speed: 0 },
            { influence: clamped, speed: 0 },
            { influence: clamped, speed: 0 }
        ];
    }

    /**
     * Apply the configured interpolation type to every keyframe on the
     * property. Returns the number of keyframes touched.
     */
    function applyToProperty(prop, interpType, easeType, influence) {
        if (!prop) return 0;
        try {
            if (typeof prop.isTimeVarying === "function" && !prop.isTimeVarying()) return 0;
        } catch (eTv) {}
        var keys = [];
        try { keys = prop.getKeys ? prop.getKeys() : []; } catch (eK) { keys = []; }
        if (!keys || !keys.length) return 0;

        var easeIn = makeEase(influence);
        var easeOut = makeEase(influence);

        var touched = 0;
        for (var i = 0; i < keys.length; i++) {
            var t = keys[i];
            try {
                if (typeof prop.setInterpolationTypeAtKey === "function") {
                    prop.setInterpolationTypeAtKey(interpType, t);
                }
            } catch (eSet) {}
            if (easeType !== "linear") {
                try {
                    if (typeof prop.setTemporalEaseAtKey === "function") {
                        // Both sides get the same influence; for "in only" /
                        // "out only" the other side is reset to a minimal ease
                        // so only the requested side actually curves.
                        var inE = (easeType === "out") ? makeEase(1) : easeIn;
                        var outE = (easeType === "in") ? makeEase(1) : easeOut;
                        prop.setTemporalEaseAtKey(t, inE, outE);
                    }
                } catch (eEase) {}
            }
            touched++;
        }
        return touched;
    }

    function easeTypeToInterp(easeType) {
        switch (easeType) {
            case "linear": return INTERP.LINEAR;
            case "in":     return INTERP.EASE_IN;
            case "out":    return INTERP.EASE_OUT;
            case "both":
            default:       return INTERP.BEZIER;
        }
    }

    function runPass(opts, undoLabel) {
        var seq = SmartEditPro.getActiveSequence();
        if (!seq) return SmartEditPro.error("No active sequence.");
        var props = opts.properties || [];
        if (!props.length) return SmartEditPro.error("Pick at least one property.");

        var easeType = opts.easeType || "both";
        var influence = (typeof opts.influence === "number") ? opts.influence : 50;
        var interpType = easeTypeToInterp(easeType);
        var clips = collectClips(seq, opts.scope || "selected");
        if (!clips.length) return SmartEditPro.error("No target clips found.");

        var totalKeys = 0;
        var totalProps = 0;
        var totalClips = 0;

        var undoStarted = false;
        try {
            if (typeof app !== "undefined" && app && typeof app.beginUndoGroup === "function") {
                app.beginUndoGroup(undoLabel || "SmartEdit: Apply Flow");
                undoStarted = true;
            }
        } catch (eBegin) {}

        try {
            for (var ci = 0; ci < clips.length; ci++) {
                var clipProps = collectProperties(clips[ci], props);
                if (!clipProps.length) continue;
                totalClips++;
                for (var pi = 0; pi < clipProps.length; pi++) {
                    var touched = applyToProperty(clipProps[pi].prop, interpType, easeType, influence);
                    if (touched > 0) {
                        totalProps++;
                        totalKeys += touched;
                    }
                }
            }
        } catch (eApply) {
            try { if (undoStarted && app.endUndoGroup) app.endUndoGroup(); } catch (eE) {}
            return SmartEditPro.error("Apply failed: " + eApply);
        }

        try { if (undoStarted && app.endUndoGroup) app.endUndoGroup(); } catch (eEnd) {}

        return SmartEditPro.respond({
            ok: true,
            clips: totalClips,
            properties: totalProps,
            keyframes: totalKeys,
            easeType: easeType,
            influence: influence
        });
    }

    function apply(optsJson) {
        var opts = safeParse(optsJson, {});
        return runPass(opts, "SmartEdit: Apply Flow");
    }

    function reset(optsJson) {
        var opts = safeParse(optsJson, {});
        opts.easeType = "linear";
        return runPass(opts, "SmartEdit: Reset to Linear");
    }

    return {
        apply: apply,
        reset: reset
    };
})();
