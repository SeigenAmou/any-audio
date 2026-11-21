"""Render a note list through an installed VST3 plugin, one JSON line per request.

Protocol (mirrors engine/worker.py, the singing worker):
  us -> worker  {"op":"info","plugin":"C:\\...\\JUNO-106(VST3 64bit).vst3"}
  worker -> us  {"ok":true,"instrument":true,"parameters":[{"name":"lfo_rate",...}]}
  us -> worker  {"op":"render","plugin":"...","notes":[[start,dur,key,vel],...],
                 "durationSec":8,"sampleRate":48000,"params":{"lfo_rate":0.5},"out":"..."}
  worker -> us  {"ok":true,"peak":0.44,"rms":0.05,"frames":384000,"durationSec":8}

stdout carries protocol lines only; anything else goes to stderr. A plugin that
hangs inside the loader (Steinberg's licence prompt does) hangs this process, so
the Node side always runs it under a timeout and kills the tree on expiry.
"""
import json
import sys


def emit(payload):
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def describe(plugin):
    parameters = []
    try:
        items = dict(plugin.parameters).items()
    except Exception:
        items = []
    for name, parameter in items:
        entry = {"name": name}
        try:
            entry["min"] = float(parameter.min_value)
            entry["max"] = float(parameter.max_value)
        except Exception:
            pass
        try:
            entry["value"] = float(parameter.raw_value)
        except Exception:
            pass
        parameters.append(entry)
    return parameters


def main():
    try:
        import numpy as np
        from pedalboard import load_plugin
        from pedalboard.io import AudioFile
    except Exception as error:  # pedalboard missing is an environment problem, not a bug
        emit({"ok": False, "kind": "env", "error": "pedalboard import failed: " + str(error)[:300]})
        return

    cache = {}

    def load(path):
        if path not in cache:
            cache[path] = load_plugin(path)
        return cache[path]

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
            import pedalboard
            emit({"ok": True, "python": sys.version.split()[0], "pedalboard": getattr(pedalboard, "__version__", "?")})
            continue
        path = request.get("plugin")
        if not path:
            emit({"ok": False, "kind": "param", "error": "plugin is required"})
            continue

        try:
            plugin = load(path)
        except Exception as error:
            emit({"ok": False, "kind": "load", "error": str(error)[:400]})
            continue

        if op == "info":
            emit({
                "ok": True,
                "instrument": bool(getattr(plugin, "is_instrument", False)),
                "parameters": describe(plugin),
            })
            continue

        if op == "probe":
            # What the settings page shows in the plugin list. Everything here is
            # an attribute of the loaded plugin, so it has to be asked rather
            # than read off the file.
            name = ""
            vendor = ""
            for attribute in ("name", "plugin_name"):
                try:
                    value = getattr(plugin, attribute)
                    if isinstance(value, str) and value:
                        name = value
                        break
                except Exception:
                    pass
            for attribute in ("manufacturer_name", "vendor", "manufacturer"):
                try:
                    value = getattr(plugin, attribute)
                    if isinstance(value, str) and value:
                        vendor = value
                        break
                except Exception:
                    pass
            instrument = bool(getattr(plugin, "is_instrument", False))
            emit({
                "ok": True,
                "name": name,
                "vendor": vendor,
                "instrument": instrument,
                "category": "instrument" if instrument else "effect",
            })
            continue

        out = request.get("out")
        if not out:
            emit({"ok": False, "kind": "param", "error": "out is required for render"})
            continue

        warnings = []
        try:
            plugin.reset()
        except Exception:
            pass
        for name, value in (request.get("params") or {}).items():
            try:
                plugin.parameters[name] = float(value)
            except Exception as error:
                warnings.append(name + ": " + str(error)[:120])

        try:
            duration = float(request.get("durationSec") or 4.0)
            sample_rate = int(request.get("sampleRate") or 48000)
            messages = []
            for note in request.get("notes") or []:
                start = float(note[0])
                length = float(note[1])
                key = int(note[2]) & 0x7F
                velocity = max(1, min(127, int(note[3]) if len(note) > 3 else 100))
                # Roland's TR drum machines only listen on channel 10 (0-based 9),
                # so the channel has to be per note rather than one per render.
                channel = int(note[4]) & 0x0F if len(note) > 4 and note[4] is not None else 0
                messages.append((bytes([0x90 | channel, key, velocity]), start))
                messages.append((bytes([0x80 | channel, key, 0]), start + length))
            for event in request.get("controls") or []:
                # [time, ccNumber, value] — the escape hatch for patches driven by CC.
                messages.append((bytes([0xB0, int(event[1]) & 0x7F, int(event[2]) & 0x7F]), float(event[0])))
            messages.sort(key=lambda item: item[1])
            audio = plugin(messages, duration=duration, sample_rate=sample_rate, num_channels=2)
            array = np.asarray(audio, dtype="float32")
            if array.ndim == 1:
                array = array.reshape(1, -1)
            peak = float(np.max(np.abs(array))) if array.size else 0.0
            rms = float(np.sqrt(np.mean(np.square(array, dtype="float64")))) if array.size else 0.0
            channels = int(array.shape[0])
            with AudioFile(out, "w", samplerate=sample_rate, num_channels=channels) as handle:
                handle.write(array)
            emit({
                "ok": True,
                "peak": round(peak, 6),
                "rms": round(rms, 6),
                "frames": int(array.shape[1]),
                "channels": channels,
                "durationSec": round(array.shape[1] / sample_rate, 3),
                "warnings": warnings,
            })
        except Exception as error:
            emit({"ok": False, "kind": "render", "error": str(error)[:400], "warnings": warnings})


if __name__ == "__main__":
    main()
