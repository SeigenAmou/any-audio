"""Audio capture sidecar.

One JSON object per line on stdin, one per line on stdout, exactly like the
singing engine: requests in, results out, diagnostics on stderr.  The parent
process (src/audio/record-host.js) owns timeouts, so this file only has to be
honest about what it did.

Ops
  {"op":"ping"}
  {"op":"devices"}
  {"op":"record","device":26,"durationSec":4,"sampleRate":48000,"channels":2,"out":"x.wav","warmupSec":0}

`device` is a sounddevice index or a case-insensitive piece of the device name.
Recording is WASAPI first (shared mode, auto-convert on) and falls back to
whatever host API the device really belongs to.
"""
import json
import sys
import wave

sys.stdout.reconfigure(encoding="utf-8")
sys.stderr.reconfigure(encoding="utf-8")


def reply(payload):
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def fail(op, code, message, **extra):
    payload = {"type": "result", "op": op, "ok": False, "code": code, "error": message}
    payload.update(extra)
    reply(payload)


def load_audio():
    import sounddevice as sd
    import numpy as np
    return sd, np


def wasapi_index(sd):
    for index, api in enumerate(sd.query_hostapis()):
        if "WASAPI" in api["name"].upper():
            return index
    return None


def describe_inputs(sd):
    devices = sd.query_devices()
    apis = sd.query_hostapis()
    inputs = []
    for index, device in enumerate(devices):
        if device["max_input_channels"] <= 0:
            continue
        api_index = device["hostapi"]
        inputs.append({
            "index": index,
            "name": device["name"],
            "hostApi": apis[api_index]["name"],
            "channels": device["max_input_channels"],
            "sampleRate": int(device["default_samplerate"]),
            "default": apis[api_index]["default_input_device"] == index,
            "latencySec": round(device["default_low_input_latency"], 4),
        })
    return inputs


def pick_device(sd, wanted):
    """One physical input appears once per host API, so a bare name is ambiguous.
    WASAPI is the one worth capturing from: MME and DirectSound resample through
    a legacy path. Prefer it whenever a name matches several entries."""
    inputs = describe_inputs(sd)
    if isinstance(wanted, int):
        for item in inputs:
            if item["index"] == wanted:
                return item
        raise ValueError(f"no input with index {wanted}; ask for the device list first")

    needle = str(wanted or "").lower()
    if not needle:
        raise ValueError("recording needs a device: pass a name or an index from the devices list")

    exact = [item for item in inputs if item["name"].lower() == needle]
    partial = [item for item in inputs if needle in item["name"].lower()]
    candidates = exact or partial
    if not candidates:
        names = ", ".join(f"[{item['index']}] {item['name']} ({item['hostApi']})" for item in inputs[:12])
        raise ValueError(f"no input matches {wanted!r}; inputs: {names}")
    wasapi = [item for item in candidates if "WASAPI" in item["hostApi"].upper()]
    if len(wasapi) == 1:
        return wasapi[0]
    if len(candidates) == 1:
        return candidates[0]
    listed = ", ".join(f"[{item['index']}] {item['name']} ({item['hostApi']})" for item in candidates)
    raise ValueError(f"{wanted!r} matches {len(candidates)} inputs ({listed}); pass the index instead")


def write_wav(path, samples, samplerate):
    """float32 [-1,1] frames -> 16-bit PCM, which every player reads."""
    import numpy as np
    clipped = np.clip(samples, -1.0, 1.0)
    as_int = np.round(clipped * 32767.0).astype("<i2")
    with wave.open(path, "wb") as handle:
        handle.setnchannels(as_int.shape[1])
        handle.setsampwidth(2)
        handle.setframerate(int(samplerate))
        handle.writeframes(as_int.tobytes())


def do_record(sd, np, request):
    device = pick_device(sd, request.get("device"))
    duration = float(request.get("durationSec") or 0)
    if duration <= 0:
        raise ValueError("durationSec must be positive")
    if duration > 900:
        raise ValueError("a single recording is capped at 900 seconds")

    channels = int(request.get("channels") or min(2, device["channels"]))
    channels = max(1, min(channels, device["channels"]))
    samplerate = int(request.get("sampleRate") or device["sampleRate"] or 48000)
    warmup = max(0.0, float(request.get("warmupSec") or 0))

    extra = None
    if device["hostApi"].upper() == "WINDOWS WASAPI":
        try:
            extra = sd.WasapiSettings(auto_convert=True)
        except Exception:  # noqa: BLE001 - an old PortAudio has no such class
            extra = None

    frames = int(samplerate * (duration + warmup))
    recording = sd.rec(frames, samplerate=samplerate, channels=channels, dtype="float32",
                       device=device["index"], extra_settings=extra)
    sd.wait()

    if warmup:
        recording = recording[int(samplerate * warmup):]
    peak = float(np.max(np.abs(recording))) if recording.size else 0.0
    rms = float(np.sqrt(np.mean(recording ** 2))) if recording.size else 0.0

    out = request.get("out")
    if out:
        write_wav(out, recording, samplerate)

    return {
        "ok": True,
        "device": device["name"],
        "index": device["index"],
        "hostApi": device["hostApi"],
        "peak": round(peak, 6),
        "rms": round(rms, 6),
        "silent": peak <= 1e-5,
        "frames": int(recording.shape[0]),
        "channels": int(recording.shape[1]),
        "sampleRate": samplerate,
        "durationSec": round(recording.shape[0] / samplerate, 4),
        "file": out or None,
    }


def main():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
        except json.JSONDecodeError as error:
            fail("unknown", "BAD_REQUEST", f"not JSON: {error}")
            continue

        op = request.get("op") or "ping"
        try:
            if op == "ping":
                try:
                    sd, np = load_audio()
                except Exception as error:  # noqa: BLE001
                    reply({"type": "result", "op": "ping", "ok": False, "code": "NO_SOUNDDEVICE",
                           "error": f"sounddevice is not importable: {error}"})
                    continue
                reply({"type": "result", "op": "ping", "ok": True, "python": sys.version.split()[0],
                       "sounddevice": getattr(sd, "__version__", "?"), "numpy": np.__version__})
                continue

            try:
                sd, np = load_audio()
            except Exception as error:  # noqa: BLE001
                fail(op, "NO_SOUNDDEVICE", f"sounddevice is not importable: {error}"
                     " — install it with: python -m pip install --user sounddevice")
                continue

            if op == "devices":
                api = wasapi_index(sd)
                reply({"type": "result", "op": "devices", "ok": True,
                       "hostApis": [item["name"] for item in sd.query_hostapis()],
                       "wasapi": api,
                       "inputs": describe_inputs(sd)})
                continue

            if op == "record":
                reply({"type": "result", "op": "record", **do_record(sd, np, request)})
                continue

            fail(op, "UNKNOWN_OP", f"unknown op {op!r}; try ping, devices or record")
        except Exception as error:  # noqa: BLE001
            fail(op, "RECORD_FAILED", str(error))


if __name__ == "__main__":
    main()
