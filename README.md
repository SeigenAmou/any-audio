<div align="center">

<img src="docs/assets/hero.png" alt="AnyAudio 项目抬头图" width="100%">

[![License: MIT](https://img.shields.io/badge/license-MIT-2ea44f.svg)](https://github.com/cloudoyx/any-audio/blob/main/LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A522.19-339933.svg)](https://nodejs.org)
[![DSH plugin](https://img.shields.io/badge/DeepSeek%20Harness-plugin-4b6bfb.svg)](#install)
[![Status](https://img.shields.io/badge/status-early%20release-orange.svg)](#known-limitations)

[Hear the difference](#hear-the-difference) · [The DAW](#the-daw) · [Install](#install) · [Sound sources](#sound-sources) · [Speech TTS](#speech-tts) · [Singing](#singing) · [中文说明](README.zh-CN.md)

</div>

> ### This is a fork
>
> Upstream: [cloudoyx/any-audio](https://github.com/cloudoyx/any-audio) · This fork: [SeigenAmou/any-audio](https://github.com/SeigenAmou/any-audio)
>
> Every change in this fork was made by an **LLM** — the coding agent running inside DeepSeek Harness — under a human's direction, and is recorded step by step in the commit history. The upstream project is in no way responsible for it.
>
> **It is still being worked on and may not run.** Treat it as a work in progress, not a release, and expect rough edges.
>
> What this fork adds on top of upstream:
>
> - **64-bit VST2 instruments render** through a second host (dawdreamer); VST3 keeps rendering through pedalboard. 32-bit plugins are listed but need a bridge.
> - **Hardware sound modules as score parts** — write `"hw": "<a MIDI port of your module>"` (SD-20, SC-88Pro, XV-5080, SD-90 and the like) and the part is sent out as MIDI and recorded back from a line input.
> - **Plugin presets** — import a `.vstpreset` / `.fxp` a person saved in their own host, or let the agent write an `.fxp` from named parameters when none exists.
> - **Manuals for every sound source**, plugins included — written by hand, or imported from a PDF or a folder of a manufacturer's web pages.
> - **Performance expression** — `score.expression` writes bends, vibrato, swells, sustain pedal and humanised timing onto a part.
> - **`anyaudio_music` takes a `.mid` file directly**, and a drum kit now warns when a key has no sample instead of rendering silence.
> - **A separate "Plugins & sources" page** in settings, with a per-plugin preset list.
> - **Hardware takes line themselves up** — every `hw` render starts with a measuring note, so the recording is cut where the sound actually began instead of trusting a hand-measured latency. A kit that lacks a key now slides that hit to the nearest key it does have and says so.
> - **Clear failures** — an input that delivers no frames, or a plugin that writes an empty take, is named as such instead of surfacing as `missing or empty data chunk`.

---


---

AnyAudio is an audio production toolkit for AI agents. It turns a sound idea into an actual audio project: write notes and render real instruments, write lines and generate speech, drop in sound effects, arrange the structure, mix the multitrack result, then open it in the DAW to audition and fine-tune it track by track. Video soundtracks are just one use — scenes, sound design, standalone music, audiobooks, podcasts and game audio all come out of the same pipeline.

The agent keeps the creative decisions. AnyAudio supplies the tools and execution needed to turn a sound idea into a finished audio file.

<div align="center">
  <img src="docs/assets/daw.png" alt="A real project inside the DAW" width="100%">
  <sub>A real project in the DAW: narration, glockenspiel, marimba, plucked bass, a warm pad and light percussion each on their own track — six tracks, eleven clips, voices and music on one timeline</sub>
</div>

## What it solves

Models can already write code that makes sound, but it rarely sounds like an instrument, a recording, or a finished mix. AnyAudio fills that gap:

- **Real instrument timbres** — rendered from local sample banks instead of hand-written oscillators.
- **Notes land directly on the timeline** — millisecond accuracy; music, narration and effects share one clock.
- **Automatic mix balance** — tracks are placed in order with per-track gain, pan and fades; declaring a track as `narration` makes the plugin duck the other buses under the voice, and the master is peak-normalised so the whole mix does not clip. Every change can be auditioned section by section, and changed again.
- **Effects and voices** — sound effects come from an installed sound library first (a pack of real recordings, searched by name), then from online CC0 when the library has nothing, and only then from the SoundFont banks or the procedural generators; speech goes through Edge TTS, MiMo-V2.5-TTS (currently free) or DeepSeek TTS (using the account DSH is signed in with).
- **Singing** — give the agent notes and lyrics and it synthesises a vocal locally, landing on its own track in the DAW; ask for a song or a sung line and the agent calls the singing tool on its own.

## Hear the difference

Both pairs contain identical material: one version made without the plugin, one with it. Listen first, read the numbers after.

> GitHub plays embedded videos muted by default — click the speaker icon in the player to hear the audio.

### "Fly Me to the Moon", bossa nova: arranged and adapted by the agent

The same 57-second bossa nova. Version A was produced the way an agent works without AnyAudio, writing NumPy synthesis directly; version B was rendered by AnyAudio from local sample banks. Same arrangement, only the sound source changed.

| | Version A — without AnyAudio | Version B — with AnyAudio |
| --- | --- | --- |
| Peak / average level | -1.5 dBFS / -19.9 dB | -1.5 dBFS / -20.8 dB |
| Crest factor | 18.4 dB | 19.3 dB |
| Spectral centroid | 1,356 Hz | 1,890 Hz |
| Energy above 4 kHz | 6.8% | 11.6% |

<table><tr><td width="50%" valign="top"><img src="https://raw.githubusercontent.com/cloudoyx/any-audio/main/samples/music-version-a-waveform.png" width="100%"><sub>Music version A — waveform and spectrogram</sub></td><td width="50%" valign="top"><img src="https://raw.githubusercontent.com/cloudoyx/any-audio/main/samples/music-version-b-waveform.png" width="100%"><sub>Music version B — waveform and spectrogram</sub></td></tr><tr><td>https://github.com/user-attachments/assets/9f496f67-0bd7-496e-96d9-4c2ccb4a28eb</td><td>https://github.com/user-attachments/assets/86ac18e0-f530-452b-9711-7f7471855b80</td></tr></table>

Version B uses sampled instruments: it sounds more like real players, with more high-frequency detail and more dynamic headroom.

### A rainy night in five lines: speech and sound effects

The same 24-second scene, five lines of dialogue, plus rain, footsteps and a door, produced twice. Lines and timing are identical.

| | Version A — without AnyAudio | Version B — with AnyAudio |
| --- | --- | --- |
| Peak / average level | -1.5 dBFS / -27.5 dB | -1.5 dBFS / -26.1 dB |
| Crest factor | 26.0 dB | 24.6 dB |
| Spectral centroid | 5,629 Hz | 4,401 Hz |
| Energy above 4 kHz | 55.3% | 44.0% |

<table><tr><td width="50%" valign="top"><img src="https://raw.githubusercontent.com/cloudoyx/any-audio/main/samples/tts-sfx-version-a-waveform.png" width="100%"><sub>Speech and effects version A — waveform and spectrogram</sub></td><td width="50%" valign="top"><img src="https://raw.githubusercontent.com/cloudoyx/any-audio/main/samples/tts-sfx-version-b-waveform.png" width="100%"><sub>Speech and effects version B — waveform and spectrogram</sub></td></tr><tr><td>https://github.com/user-attachments/assets/c4ae1a17-d7bc-4db1-b96a-be244fd75358</td><td>https://github.com/user-attachments/assets/4fca1c9e-b373-4ab7-b18b-afe3e81ad102</td></tr></table>

Version B's voices match the emotion and pacing of the scene more closely, and its effects are more realistic and more detailed.

## The DAW

A visual workbench. Once the agent's music, voices and effects land here you can see a waveform for every track, drag clips around, change clip gain, add fades, and listen to any part of it.

A traditional DAW is built for a person, with AI as an assistant. This one is the other way round: **the agent generates and makes bulk changes, while you direct the agent and can also audition and fine-tune by hand.** A line that lands half a second late, an effect that buries the voice — fixing it by hand is far quicker than regenerating.

Person and agent share one timeline. Select a range, press "Add to conversation", and that range becomes a reference; write what you want changed after it and the agent knows exactly where you mean. The reverse works too: adjust one clip yourself until it sounds right, then have the agent apply that to the rest.

## Install

Node.js 22.19+ (22.x) or 24+ (bundled with DSH); ffmpeg is only needed for speech and for muxing video.

```bash
dsh plugin --profile desktop add dsh-any-audio
```

To run **this fork** instead of the published package, install from the checkout:

```bash
dsh plugin --profile desktop add link:E:/path/to/any-audio
```

The profile records a link to the source directory, so later edits take effect after the plugin is reloaded (or DSH restarted) rather than after a reinstall.

If DSH boots a different profile, replace `desktop` with that profile name. Restart DSH once after installing so it picks up the plugin.

On a fresh install, opening a new conversation shows a six-step guide: welcome, install a sound source, install a sound pack, pick the narration engine, install the singing engine, meet the clip bay. Every step can be skipped, and **Settings → AnyAudio → Advanced → Replay the guide** brings it back.

The package bundles no audio resources; they are downloaded and installed on first use. Default suggestions:

- Sound source: GeneralUser GS (general-purpose instruments, about 32 MB)
- Sound pack: BaseSFX (237 real recordings, about 161 MB)
- TTS engine: Edge (MiMo-TTS is also available, currently free)
- Singing voicebank: Qixuan (sweet female voice, about 401 MB)

## Quick start

Describe the work as usual while generating a video; the agent calls the plugin to render audio on its own:

> Make a 30-second ink-wash animation: a seed in a rock crevice grows into a sapling. Add a little Chinese-style music and wind, no narration.

You can adjust musical detail and mixing behaviour as you go:

> Guzheng lead, strings bed, cello on the low end; pull the music down whenever a voice comes in.

For a song, state the brief and call it directly:

> Write me a Japanese RPG battle theme, loopable, 30 to 60 seconds. Drums, electric guitar and strings.

Or have the lyrics sung:

> Sing the chorus of "Blue and White Porcelain" with Qixuan — the "the sky is clear, the rain is fine" lines.

You can even build an audiobook from scratch:

> Turn Chapter 1 of Romance of the Three Kingdoms into an audiobook — deep, rich narration, distinguishable character voices, with simple background music and effects.

Then open the **DAW** tab at the top; the audio is already laid out by track:

> Move the third line half a second later, then take 2 dB off the whole narration track.

## Sound sources

The repository does not bundle SoundFonts. The plugin offers two **suggested** banks — GeneralUser GS as the default foundation and MuseScore General as an extra general-purpose orchestral bank — and it can also load compatible SoundFont files (`.sf2`, `.sf3`, `.dls`) placed in `~/.dsh/anyaudio/fonts`. That directory is one shared library for every project and agent session on the machine, so a bank installed once is available everywhere.

| Bank | Size | License | How to get it | Notes |
| --- | --- | --- | --- | --- |
| GeneralUser GS | 32 MB | GeneralUser GS License v2.0 | One click | **Suggested — default foundation and fallback**; the only bank guaranteed to include a drum kit |
| MuseScore General | 40 MB | MIT | One click | **Suggested — extra general-purpose orchestral bank**; 309 presets, fuller strings and ensembles |
| Upright Piano KW | 27 MB (7z) | CC0 1.0 | Manual | Single-instrument piano bank, used on piano tracks only |
| Electric Guitar Clean | 446 MB (unpacked) | CC0 1.0 | Manual | Single-instrument electric guitar bank |

Installing both suggested banks gives the widest coverage: GeneralUser GS stays the default, while MuseScore General joins the automatic ranking for orchestral families. Download links and extraction notes for the last two are in Settings and in [THIRD_PARTY_NOTICES.md](https://github.com/cloudoyx/any-audio/blob/main/THIRD_PARTY_NOTICES.md); keep the file names unchanged after extracting so the plugin can recognise them.

## Orchestration tables

Which source a piece actually used for each instrument is knowledge worth keeping — a person's own projects, a study of someone's arrangements, a studio inventory. AnyAudio reads those tables instead of asking the agent to guess.

- `anyaudio_sources {action:"orchestration_import", name:"studio", path:"C:\\…\\sources.xlsx"}` imports an `.xlsx` (every worksheet), a `.csv`/`.tsv`, or a Google Sheets link (`url:"…"`, plus `proxy:"http://127.0.0.1:7881"` when the machine needs one).
- `{action:"orchestrations"}` lists what has been imported; `{action:"orchestration", name:"studio", instrument:"Acoustic Piano"}` returns, for one instrument, the sources and presets that table recorded most often.
- A table is CSV-shaped: `Instrument | Source | Path/Bank | Preset | Notes`, with optional section-title rows and `BPM` / `Time` lines above them. A preset cell may read `001 000 St.Piano 1`, `001 St.Concert`, or a bare name.
- A blank cell means "not recorded". The agent should say so rather than invent a program number.

## Hardware modules

A part can leave the machine instead of being rendered locally. Write `"hw": "<the MIDI port of your module>"` (`SD-20`, `SC-88Pro`, `XV-5080`, `SD-90` and the like) and the notes are sent out as MIDI while the module's line output is recorded back in.

- **It is real time.** One part at a time; the MIDI has to arrive before the audio can come back.
- **The take lines itself up.** Every `hw` render starts with one short measuring note, and the recorder cuts the capture where that note actually began instead of trusting a hand-measured latency. `"align": false` turns it off.
- **Name the input, not its index.** Windows renumbers capture devices when a USB port is replugged, so an index that worked yesterday can point somewhere else today. The failure is explicit: `the input "…" delivered no frames`.
- **Voice count is the module's property.** `"voices": 128` makes the render warn when a part exceeds it; without it the plugin only remarks once past 64 simultaneous notes. Nothing is assumed about a particular model.
- **A registered rig fills in the rest.** Save port, input, latency and voice count once in Settings and write `"hw": "my rack"`.

## Sound effects

Effects come from the installed sound library; when a sound is not there the agent looks for CC0 online, and falls back to sampling a soundfont or synthesising it.

| Pack | Clips | Size | How to get it |
| --- | --- | --- | --- |
| BaseSFX | 237 | 161 MB | Manual download, local install |

Download the archive from the "Sound effects" tab in Settings or from the first-run guide, unpack it, and paste the full path of the extracted `BaseSFX` folder into "Install".

## Speech TTS

Three engines, one interface:

| Engine | Key | Notes |
| --- | --- | --- |
| **Edge TTS** (default) | Not required | Free, through Microsoft's public endpoint; needs ffmpeg to convert MP3 to WAV; may be rate-limited, in which case the plugin retries and reports a clear error. Supports rate, pitch and volume. |
| **MiMo-V2.5-TTS** (optional) | Normal Open Platform API key | More voices and styles; the key is stored in DSH credentials and only read on the host side. Currently free; register your own API key. Delivery is steered with `style`. |
| **DeepSeek TTS** (optional) | Nothing extra | Uses the DeepSeek account DSH is signed in with. Two voices only (`stella` female, `tide` male), and **no rate, pitch or volume control**; billed per character, so the account needs credit. |

MiMo and DeepSeek are both opt-in: saving a key or signing in does not switch the default engine, you choose it explicitly. MiMo's default voice `mimo_default` is resolved by the service cluster and may differ between regions; this version supports normal Open Platform keys only. DeepSeek's key is the one DSH itself signs in with — the plugin never writes or clears it, because removing it would break model access, not just narration.

## VST instruments

A part can name a plugin instead of a SoundFont instrument — a synth for a pad, a sampled piano library, a module the player already owns. The plugin renders in its own process, so a plugin that hangs waiting for a licence window costs one part instead of the whole render.

- **VST3** goes through pedalboard, **64-bit VST2** through dawdreamer. 32-bit plugins are listed but refused: a 64-bit host cannot load them, and bridging them is the player's choice.
- **Settings → AnyAudio → Sound sources** holds the folders to scan and lists what the scan found (name, VST2/VST3, synth or effect, vendor). A scan reads the PE header of a `.dll` instead of guessing from the extension.
- A track sets `"vst": {"plugin": "C:\\...\\Thing.vst3", "params": {"cutoff": 0.4}}`, or points at a registered preset with `"vst": {"preset": "warm-pad"}`.
- **A patch the plugin keeps to itself.** Plugins whose sound lives behind their own editor cannot be tuned parameter by parameter, so the player saves the patch in a DAW and hands over the file: `anyaudio_vst {action:"preset", presetAction:"import", name:"warm-pad", plugin:"…", presetFile:"C:\\Users\\me\\Documents\\VST3 Presets\\…\\warm-pad.vstpreset"}`, after which the score only says `"vst": {"preset": "warm-pad"}`. The file is handed to the plugin as it is, never parsed. `.vstpreset` belongs to VST3, `.fxp` and `.fxb` to VST2. `presetAction:"scan"` lists the patches already sitting under the usual preset folders.
- **The two bridges hear different things.** A VST2 part is rendered from a MIDI file, so `automation` controllers and the gestures in `expression` reach the plugin. A VST3 part is rendered from an audio buffer only: parameters and preset files are the ways in, and anything MIDI-shaped stays unheard.

## Performance expression

A note list is not a performance. `score.expression` writes the gestures a player would make, as MIDI that SoundFont, VST2 and hardware parts actually play:

| Type | What it writes |
| --- | --- |
| `pitchbend_line` / `pitchbend_curve` | a slide, or vibrato over a span |
| `velocity_line` | a swell or a fade across the notes |
| `sustain` | the pedal, down and up |
| `cc_line` / `cc_curve` | any controller, ramped or oscillating |
| `humanize` | repeatable timing and velocity variation, seeded so the same score gives the same take |

Times are seconds on the timeline, not bars. A VST3 part is rendered from an audio buffer and hears none of it — use parameters or a preset file for that side.

## Singing

The singing tool synthesises a real vocal on this machine from notes and lyrics and drops it onto its own vocal track in the clip bay — audition it, adjust its level, regenerate any line. The agent calls it automatically on singing requests; no need to name the tool.

### Installing the singing environment

1. **Install the runtime (Step 1).** Open "Settings → AnyAudio → Singing → Install singing environment" to install the runtime and vocoder.
2. **Download a voicebank archive (Step 2).** Get the official voicebank zip from GitHub, Baidu Drive or Quark Drive — all three serve the same archive.
3. **Install the voicebank (Step 3).** Back in Settings, paste the full path of the local zip and install it.

Nothing is bundled in the npm package; the first use needs a download and install.

### GPU acceleration (optional)

- Choosing the GPU asks for confirmation first, then downloads an extra ~216 MB of `onnxruntime-gpu` (CUDA/cuDNN included). The plugin measures several mirrors and picks the fastest.
- Synthesis stays on CPU while the download runs; closing Settings does not interrupt it.
- Once installed, both Auto and GPU use the graphics card, while CPU stays on the CPU. If the GPU setup is incompatible, reinstalling the singing environment restores the CPU setup.

Measured speed: a three-minute song takes about 247 s on CPU and about 28.5 s on GPU — roughly 8.7× faster.

## Known limitations

- **Project size caps** — a project is at most 15 minutes long and 20 tracks wide; going past either is an error.
- **Audio only, for now** — a video can sit in the project as a reference picture, but this version does not trim, join or transition it.
- **Tracks hold finished audio** — every clip on the timeline is an already-rendered wav/mp3 that can be auditioned on its own; MIDI, scores and parameters never go on the timeline.
- **SoundFont and hosted VST only** — VST3 and 64-bit VST2 can be rendered; SFZ and Kontakt libraries cannot, and converting other source formats is out of scope for this version.
- **32-bit plugins need a bridge** — they are listed (with the PE header read, not guessed) but a 64-bit host cannot load them. A bridge such as jBridge produces a 64-bit forwarding `.dll`; point the scan at that folder and it behaves like any other 64-bit VST2.
- **Multi-output plugins are read from their main output** — a plugin that declares several stereo outputs renders its first pair; routing individual outputs to separate tracks is not exposed yet.
- **No per-note envelope control** — attack and release come from the preset; use short notes with gaps for staccato and velocity plus expression for dynamics.
- **Chinese instruments are GM approximations** — `guzheng` maps to Koto, `dizi` to Flute, `erhu` to Fiddle; dedicated banks will do better.
- **Singing quality depends on the voicebank and tuning** — the plugin only provides the install channel, interface and usage.
- **Only the Qixuan voicebank is guaranteed** to work at a basic level; other banks are accepted through the open interface but loading and quality are not guaranteed, and need your own tuning.

## Support the project

AnyAudio is an independent open-source project. If it helps your work or your creation, you are welcome to buy me a coffee to support further development.

Any amount is appreciated.

<div align="center">
  <img src="https://raw.githubusercontent.com/cloudoyx/any-audio/main/docs/assets/wechat-donate.png" alt="WeChat Pay QR code" width="200">
  <p>WeChat Pay</p>
</div>

## License

Code is MIT, see [LICENSE](https://github.com/cloudoyx/any-audio/blob/main/LICENSE).

SoundFonts and third-party components keep their own licenses, see [THIRD_PARTY_NOTICES.md](https://github.com/cloudoyx/any-audio/blob/main/THIRD_PARTY_NOTICES.md). This repository distributes no sample banks.
