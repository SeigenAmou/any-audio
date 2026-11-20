"""MIDI output sidecar — drive a hardware sound module, and measure the lag.

One JSON object per line in, one per line out, same protocol as the other
engines.  Three jobs live here:

  ports      list MIDI outputs and inputs
  play       send notes on a timeline, optionally recording the line input
  calibrate  play short pings while recording, then report how far the audio
             lags the MIDI send

The timing here is the part that is easy to get wrong. `sd.rec()` returns
immediately but the device keeps filling its buffer for a while before the
first sample you asked for, so sample 0 of the file is *not* the moment the
call was made — on this machine that skew was 141 ms, which looked like a
sound module answering before it was asked. A stream callback carries the real
capture time of every buffer (`inputBufferAdcTime`), and `stream.time[0]` is
the same clock, so both sides of the measurement share one timeline.
"""
import json
import sys
import time

sys.stdout.reconfigure(encoding="utf-8")
sys.stderr.reconfigure(encoding="utf-8")


def reply(payload):
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def fail(op, code, message, **extra):
    payload = {"type": "result", "op": op, "ok": False, "code": code, "error": message}
    payload.update(extra)
    reply(payload)


def load_rtmidi():
    import rtmidi
    return rtmidi


# ---------------------------------------------------------------- MIDI output

def open_output(rtmidi, wanted):
    outputs = rtmidi.MidiOut()
    ports = outputs.get_ports()
    if not ports:
        raise ValueError("this machine exposes no MIDI output port")
    if isinstance(wanted, int):
        if wanted < 0 or wanted >= len(ports):
            raise ValueError(f"no MIDI output with index {wanted}; ports: {', '.join(ports)}")
        index = wanted
    else:
        needle = str(wanted or "").lower()
        matches = [i for i, name in enumerate(ports) if needle and needle in name.lower()]
        if len(matches) == 1:
            index = matches[0]
        elif not matches:
            raise ValueError(f"no MIDI output matches {wanted!r}; ports: {', '.join(ports)}")
        else:
            names = ", ".join(ports[i] for i in matches)
            raise ValueError(f"{wanted!r} matches {len(matches)} ports ({names}); pass the index instead")
    outputs.open_port(index)
    return outputs, ports[index], ports


def midi_messages(notes, channel_default=0):
    """[start, dur, key, vel, channel?] -> [(time, bytes), ...] sorted."""
    messages = []
    for index, note in enumerate(notes):
        if not isinstance(note, list) or len(note) < 3:
            raise ValueError(f"notes[{index}] must be [startSec, durSec, midi, velocity, channel?]")
        start = float(note[0])
        duration = float(note[1])
        key = int(note[2])
        velocity = int(note[3] if len(note) > 3 and note[3] is not None else 100)
        channel = int(note[4] if len(note) > 4 and note[4] is not None else channel_default)
        if start < 0 or duration <= 0:
            raise ValueError(f"notes[{index}]: startSec >= 0 and durSec > 0")
        if not 0 <= key <= 127:
            raise ValueError(f"notes[{index}]: midi must be 0..127")
        if not 1 <= velocity <= 127:
            raise ValueError(f"notes[{index}]: velocity must be 1..127")
        if not 0 <= channel <= 15:
            raise ValueError(f"notes[{index}]: channel must be 0..15")
        messages.append((start, bytes([0x90 | channel, key, velocity])))
        messages.append((start + duration, bytes([0x80 | channel, key, 0])))
    messages.sort(key=lambda item: (item[0], item[1][0] & 0xF0))
    return messages


# --------------------------------------------------------------- MIDI capture

def resolve_input(sd, wanted):
    """Find the capture device by index or by a piece of its name.

    One physical input shows up once per host API (MME, DirectSound, WASAPI,
    WDM-KS), so a bare name matches several entries. WASAPI wins when present:
    it is the only path that does not resample through a legacy layer.
    """
    apis = sd.query_hostapis()
    inputs = [(index, info, apis[info["hostapi"]]["name"]) for index, info in enumerate(sd.query_devices())
              if info["max_input_channels"] > 0]
    if isinstance(wanted, int):
        for index, info, _ in inputs:
            if index == wanted:
                return index, info
        raise ValueError(f"no input with index {wanted}")
    needle = str(wanted or "").lower()
    if not needle:
        raise ValueError("capture needs a device")
    exact = [(index, info) for index, info, _ in inputs if info["name"].lower() == needle]
    partial = [(index, info, api) for index, info, api in inputs if needle in info["name"].lower()]
    candidates = exact or partial
    if not candidates:
        raise ValueError(f"no input matches {wanted!r}; run anyaudio_record devices to see the inputs")
    wasapi = [item for item in candidates if "WASAPI" in item[2].upper()]
    if len(wasapi) == 1:
        return wasapi[0][0], wasapi[0][1]
    if len(candidates) == 1:
        return candidates[0][0], candidates[0][1]
    listed = ", ".join(f"[{index}] {info['name']} ({api})" for index, info, api in candidates)
    raise ValueError(f"{wanted!r} matches {len(candidates)} inputs ({listed}); pass the index instead")


def open_capture(sd, device, channels=None, samplerate=None):
    """Start a stream callback and keep every buffer with its real capture time."""
    index, info = resolve_input(sd, device)
    channel_count = max(1, min(int(channels or min(2, info["max_input_channels"])), info["max_input_channels"]))
    rate = int(samplerate or info["default_samplerate"] or 48000)
    extra = None
    if "WASAPI" in sd.query_hostapis(info["hostapi"])["name"].upper():
        try:
            extra = sd.WasapiSettings(auto_convert=True)
        except Exception:  # noqa: BLE001 - older PortAudio has no such class
            extra = None

    chunks = []

    def callback(indata, frames, time_info, status):  # noqa: ARG001
        chunks.append((float(time_info.inputBufferAdcTime), indata.copy()))

    stream = sd.InputStream(samplerate=rate, channels=channel_count, dtype="float32",
                            device=index, callback=callback, extra_settings=extra)
    stream.start()
    return {"stream": stream, "chunks": chunks, "index": index, "info": info,
            "channels": channel_count, "sampleRate": rate}


def close_capture(capture):
    stream = capture["stream"]
    try:
        stream.stop()
    finally:
        stream.close()


def capture_audio(capture):
    """Concatenate buffers; also return the stream time of every buffer start."""
    import numpy as np
    chunks = capture["chunks"]
    if not chunks:
        return np.zeros(0, dtype="float32"), [], []
    starts = [chunk[0] for chunk in chunks]
    offsets = []
    total = 0
    for _, data in chunks:
        offsets.append(total)
        total += data.shape[0]
    audio = np.concatenate([data for _, data in chunks], axis=0)
    return audio, starts, offsets


def sample_of(starts, offsets, samplerate, stream_time):
    """Global sample index for a stream time (clamped to the captured range)."""
    lo, hi = 0, len(starts)
    while lo < hi:
        mid = (lo + hi) // 2
        if starts[mid] <= stream_time:
            lo = mid + 1
        else:
            hi = mid
    k = max(0, lo - 1)
    return offsets[k] + int(round((stream_time - starts[k]) * samplerate))


def stream_time(stream):
    """Current stream time in seconds.

    sounddevice exposes `Stream.time` as a float on some builds and as a tuple
    of PortAudio times on others, so accept both shapes.
    """
    value = stream.time
    if isinstance(value, (tuple, list)):
        return float(value[0])
    return float(value)


def find_onset(samples, threshold):
    for index, value in enumerate(samples):
        if abs(float(value)) >= threshold:
            return index
    return None


def write_wav(path, samples, samplerate):
    import wave
    import numpy as np
    clipped = np.clip(samples, -1.0, 1.0)
    as_int = np.round(clipped * 32767.0).astype("<i2")
    with wave.open(path, "wb") as handle:
        handle.setnchannels(as_int.shape[1] if as_int.ndim > 1 else 1)
        handle.setsampwidth(2)
        handle.setframerate(int(samplerate))
        handle.writeframes(as_int.tobytes())


# ----------------------------------------------------------------- operations

def do_play(rtmidi, request):
    """Send notes; with a `capture` block, record the module's line output on
    the same clock and report how much of the file precedes notes time 0."""
    notes = request.get("notes") or []
    if not notes:
        raise ValueError("play needs notes: [[startSec, durSec, midi, velocity, channel?], …]")
    channel = int(request.get("channel") or 0)
    messages = midi_messages(notes, channel)
    port = request.get("port")
    capture_request = request.get("capture")
    last_end = max((when for when, _ in messages), default=0)

    output, name, ports = open_output(rtmidi, port if port is not None else 0)

    capture = None
    if capture_request:
        import sounddevice as sd
        capture = open_capture(sd, capture_request.get("device"),
                               capture_request.get("channels"), capture_request.get("sampleRate"))
        # Let the stream settle before taking the zero point: the first buffers
        # arrive with whatever was already in the pipe.
        time.sleep(0.5)

    sent = 0
    midi_zero = None
    started = time.perf_counter()
    try:
        program = request.get("program")
        if program is not None:
            output.send_message([0xC0 | channel, int(program)])
        for when, message in messages:
            delay = when - (time.perf_counter() - started)
            if delay > 0:
                time.sleep(delay)
            if midi_zero is None and capture is not None:
                midi_zero = float(stream_time(capture["stream"]))
            output.send_message(list(message))
            sent += 1
        time.sleep(0.05)
        if capture is not None:
            want = float(capture_request.get("durationSec") or (last_end + 2))
            remaining = want - (time.perf_counter() - started)
            if remaining > 0:
                time.sleep(remaining)
    finally:
        output.close_port()

    result = {
        "ok": True,
        "port": name,
        "ports": ports,
        "sent": sent,
        "notes": len(notes),
        "durationSec": round(time.perf_counter() - started, 4),
    }

    if capture is not None:
        close_capture(capture)
        import numpy as np
        audio, starts, offsets = capture_audio(capture)
        rate = capture["sampleRate"]
        # Cut everything before MIDI time 0, so the file starts where the notes do.
        lead_samples = 0
        if midi_zero is not None and starts:
            lead_samples = max(0, sample_of(starts, offsets, rate, midi_zero))
        # The module answers a few tens of milliseconds after the note leaves.
        # `trimLatencyMs` is the number `calibrate` measured; dropping it here
        # puts the sound where the notes are instead of keeping the hardware
        # delay inside the take.
        trim_ms = float(capture_request.get("trimLatencyMs") or 0)
        if trim_ms > 0:
            lead_samples += int(round(trim_ms / 1000.0 * rate))
        lead_samples = min(lead_samples, audio.shape[0])
        trimmed = audio[lead_samples:] if lead_samples else audio
        peak = float(np.max(np.abs(trimmed))) if trimmed.size else 0.0
        rms = float(np.sqrt(np.mean(trimmed ** 2))) if trimmed.size else 0.0
        out = capture_request.get("out")
        if out:
            write_wav(out, trimmed, rate)
        result["capture"] = {
            "device": capture["info"]["name"],
            "peak": round(peak, 6),
            "rms": round(rms, 6),
            "silent": peak <= 1e-5,
            "frames": int(trimmed.shape[0]),
            "channels": int(trimmed.shape[1]) if trimmed.ndim > 1 else 1,
            "sampleRate": rate,
            "durationSec": round(trimmed.shape[0] / rate, 4),
            "trimmedMs": round(lead_samples / rate * 1000.0, 2),
            "file": out or None,
        }

    return result


def do_calibrate(rtmidi, request):
    import numpy as np
    import sounddevice as sd

    duration = float(request.get("durationSec") or 8)
    if duration <= 0 or duration > 120:
        raise ValueError("calibrate durationSec must be between 0 and 120 seconds")
    interval = float(request.get("intervalSec") or 0.9)
    count = max(3, min(12, int(request.get("count") or 6)))
    hold = float(request.get("holdSec") or 0.12)
    key = int(request.get("midi") or 72)
    velocity = int(request.get("velocity") or 110)
    channel = int(request.get("channel") or 0)
    program = request.get("program")
    device = request.get("device")
    if device is None or device == "":
        raise ValueError("calibrate needs device: the input that hears the module")

    capture = open_capture(sd, device, request.get("channels"), request.get("sampleRate"))
    rate = capture["sampleRate"]
    time.sleep(0.6)

    output, name, ports = open_output(rtmidi, request.get("port") if request.get("port") is not None else 0)
    sends = []
    try:
        if program is not None:
            output.send_message([0xC0 | channel, int(program)])
        began = time.perf_counter()
        for step in range(count):
            target = step * interval
            delay = target - (time.perf_counter() - began)
            if delay > 0:
                time.sleep(delay)
            sends.append(float(stream_time(capture["stream"])))
            output.send_message([0x90 | channel, key, velocity])
            time.sleep(hold)
            output.send_message([0x80 | channel, key, 0])
        time.sleep(min(0.6, max(0.3, interval)))
    finally:
        output.close_port()
        close_capture(capture)

    audio, starts, offsets = capture_audio(capture)
    mono = np.mean(audio, axis=1) if audio.ndim > 1 else audio
    peak = float(np.max(np.abs(mono))) if mono.size else 0.0

    base = {
        "ok": True,
        "port": name,
        "device": capture["info"]["name"],
        "peak": round(peak, 6),
        "notesSent": len(sends),
        "sampleRate": rate,
        "ports": ports,
    }
    if peak <= 1e-5 or not starts:
        base["latencyMs"] = None
        base["offsetsMs"] = []
        base["warning"] = "the capture carried no signal, so no offset could be measured"
        return base

    threshold = max(peak * 0.25, 1e-4)
    offsets_ms = []
    for send in sends:
        # A ping cannot be heard before it is sent, but the send call itself
        # costs a few hundred microseconds, so allow 5 ms of slack — not 150,
        # which would let the tail of the previous ping count as this onset.
        from_sample = max(0, sample_of(starts, offsets, rate, send - 0.005))
        to_sample = min(len(mono), sample_of(starts, offsets, rate, send + 0.6))
        if to_sample <= from_sample:
            continue
        found = find_onset(mono[from_sample:to_sample], threshold)
        if found is None:
            continue
        heard_sample = from_sample + found
        offsets_ms.append((heard_sample - sample_of(starts, offsets, rate, send)) / rate * 1000.0)

    offsets_ms = [round(value, 2) for value in offsets_ms if -5 < value < 600]
    if not offsets_ms:
        base["latencyMs"] = None
        base["offsetsMs"] = []
        base["warning"] = "the notes played but no transient was found in the capture"
        return base

    offsets_ms.sort()
    base["latencyMs"] = round(offsets_ms[len(offsets_ms) // 2], 2)
    base["offsetsMs"] = offsets_ms
    base["spreadMs"] = round(offsets_ms[-1] - offsets_ms[0], 2)
    base["notesHeard"] = len(offsets_ms)
    return base


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
            try:
                rtmidi = load_rtmidi()
            except Exception as error:  # noqa: BLE001
                fail(op, "NO_RTMIDI", f"python-rtmidi is not importable: {error}"
                     " — install it with: python -m pip install --user python-rtmidi")
                continue

            if op == "ping":
                reply({"type": "result", "op": "ping", "ok": True, "python": sys.version.split()[0],
                       "rtmidi": getattr(rtmidi, "__version__", "?"),
                       "ports": rtmidi.MidiOut().get_ports()})
                continue

            if op == "ports":
                reply({"type": "result", "op": "ports", "ok": True,
                       "outputs": rtmidi.MidiOut().get_ports(),
                       "inputs": rtmidi.MidiIn().get_ports()})
                continue

            if op == "play":
                reply({"type": "result", "op": "play", **do_play(rtmidi, request)})
                continue

            if op == "calibrate":
                reply({"type": "result", "op": "calibrate", **do_calibrate(rtmidi, request)})
                continue

            fail(op, "UNKNOWN_OP", f"unknown op {op!r}; try ping, ports, play or calibrate")
        except Exception as error:  # noqa: BLE001
            fail(op, "MIDI_FAILED", str(error))


if __name__ == "__main__":
    main()
