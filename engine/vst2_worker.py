"""Render a note list through an installed VST2 plugin, one JSON line per request.

pedalboard (engine/vst_worker.py) only loads VST3 bundles, so 64-bit VST2 .dlls —
Roland's SRX line and Steinberg's Padshop/Retrologue among them — have no way to
sound. dawdreamer is a real VST2 host on Windows, so this worker is the second
half of the plugin path: same protocol, different backend.

Protocol (one request per line, one reply per line):
  us -> worker  {"op":"ping"}
  worker -> us  {"ok":true,"dawdreamer":"0.9.0","python":"3.12.0"}
  us -> worker  {"op":"probe","plugin":"C:\\...\\SRX PIANO 1(VST2 64bit).dll"}
  worker -> us  {"ok":true,"name":"SRX PIANO 1","parameters":[{"name":...}]}
  us -> worker  {"op":"render","plugin":"...","midi":"C:\\...\\part.mid",
                 "durationSec":8,"sampleRate":48000,"params":{"Cutoff":0.5},"out":"..."}
  worker -> us  {"ok":true,"peak":0.44,"rms":0.05,"frames":384000,"durationSec":8}

MIDI arrives as a file rather than a note list because dawdreamer has no
per-controller API: `load_midi` plays the whole track, which also carries the CC
and pitch-bend events a patch may depend on. The Node side already writes SMF.

stdout carries protocol lines only; anything else goes to stderr.
"""
import json
import sys
import wave


def emit(payload):
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def write_wav(path, array, sample_rate):
    """16-bit PCM. dawdreamer hands back float32 in [-1, 1]; clipping is left to
    the mixer, but the integer cast has to happen here or wave refuses it."""
    channels, frames = array.shape
    clipped = array.clip(-1.0, 1.0)
    interleaved = (clipped.T * 32767.0).astype("<i2").tobytes()
    with wave.open(path, "wb") as handle:
        handle.setnchannels(channels)
        handle.setsampwidth(2)
        handle.setframerate(sample_rate)
        handle.writeframes(interleaved)


def describe(processor):
    entries = []
    try:
        items = processor.get_parameters_description() or []
    except Exception:
        items = []
    for item in items:
        try:
            name = item.get("name") or ""
            entry = {"name": name}
            if "min" in item:
                entry["min"] = float(item["min"])
            if "max" in item:
                entry["max"] = float(item["max"])
            if "value" in item:
                entry["value"] = float(item["value"])
            entries.append(entry)
        except Exception:
            continue
    return entries


def main():
    try:
        import dawdreamer as daw
        import numpy as np
    except Exception as error:  # a missing backend is an environment problem, not a bug
        emit({"ok": False, "kind": "env", "error": "dawdreamer import failed: " + str(error)[:300]})
        return

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
        except json.JSONDecodeError as error:
            emit({"ok": False, "kind": "param", "error": "bad request json: " + str(error)[:200]})
            continue

        op = request.get("op") or "render"
        if op == "ping":
            emit({"ok": True, "dawdreamer": getattr(daw, "__version__", "?"), "python": sys.version.split()[0]})
            continue

        path = request.get("plugin")
        if not path:
            emit({"ok": False, "kind": "param", "error": "plugin is required"})
            continue

        sample_rate = int(request.get("sampleRate") or 48000)
        engine = daw.RenderEngine(sample_rate, 512)
        try:
            processor = engine.make_plugin_processor("part", path)
        except Exception as error:
            emit({"ok": False, "kind": "load", "error": str(error)[:400]})
            continue

        if op == "probe":
            name = ""
            for getter in ("get_plugin_name", "get_name"):
                try:
                    value = getattr(processor, getter)()
                    if isinstance(value, str) and value and getter != "get_name":
                        name = value
                        break
                except Exception:
                    pass
            emit({"ok": True, "name": name, "parameters": describe(processor)})
            continue

        if op == "patch":
            # The plugin's own current values, as the list a .fxp carries. A
            # caller that wants to write a preset starts from this and changes
            # only the knobs it means to change.
            try:
                raw = processor.get_patch() or []
                patch = [[int(index), float(value)] for index, value in raw]
            except Exception as error:
                emit({"ok": False, "kind": "patch", "error": str(error)[:300]})
                continue
            emit({"ok": True, "patch": patch, "count": len(patch)})
            continue

        out = request.get("out")
        if not out:
            emit({"ok": False, "kind": "param", "error": "out is required for render"})
            continue
        midi_path = request.get("midi")
        if not midi_path:
            emit({"ok": False, "kind": "param", "error": "midi is required for render"})
            continue

        warnings = []
        # State first, then parameters: a .fxp or .vstpreset carries the knobs
        # the plugin's own window exposes, which are exactly the ones a score
        # cannot reach by name. Anything the caller then sets by name overrides
        # the file, so one value can be changed on top of a saved patch.
        state = request.get("state")
        if state:
            state_path = state.get("path") if isinstance(state, dict) else str(state)
            fmt = (state.get("format") if isinstance(state, dict) else "") or ""
            if state_path:
                try:
                    if fmt == "fxp":
                        accepted = processor.load_preset(state_path)
                    elif fmt == "vstpreset":
                        accepted = processor.load_vst3_preset(state_path)
                    else:
                        processor.load_state(state_path)
                        accepted = True
                    if accepted is False:
                        warnings.append("state: the plugin refused " + state_path)
                except Exception as error:
                    warnings.append("state: " + str(error)[:160])
        # Parameters are addressed by name because a plugin's index order is not
        # documented anywhere; a name this plugin does not have is reported, not
        # silently skipped.
        try:
            table = processor.get_parameters_description() or []
            index_of = {}
            for index, item in enumerate(table):
                label = item.get("name")
                if isinstance(label, str):
                    index_of.setdefault(label, index)
            for name, value in (request.get("params") or {}).items():
                index = index_of.get(name)
                if index is None:
                    warnings.append(name + ": no parameter with that name")
                    continue
                try:
                    processor.set_parameter(index, float(value))
                except Exception as error:
                    warnings.append(name + ": " + str(error)[:120])
        except Exception as error:
            warnings.append("parameters: " + str(error)[:120])

        try:
            duration = float(request.get("durationSec") or 4.0)
            processor.load_midi(midi_path)
            engine.load_graph([(processor, [])])
            engine.render(duration)
            audio = np.asarray(engine.get_audio(), dtype="float32")
            if audio.ndim == 1:
                audio = audio.reshape(1, -1)
            peak = float(np.max(np.abs(audio))) if audio.size else 0.0
            rms = float(np.sqrt(np.mean(np.square(audio, dtype="float64")))) if audio.size else 0.0
            channels = int(audio.shape[0])
            write_wav(out, audio, sample_rate)
            emit({
                "ok": True,
                "peak": round(peak, 6),
                "rms": round(rms, 6),
                "frames": int(audio.shape[1]),
                "channels": channels,
                "durationSec": round(audio.shape[1] / sample_rate, 3),
                "warnings": warnings,
            })
        except Exception as error:
            emit({"ok": False, "kind": "render", "error": str(error)[:400], "warnings": warnings})


if __name__ == "__main__":
    main()
