# 视频配乐（anyaudio-scoring）

你正在为一段已经存在或即将生成的视频配乐。目标不是"生成一首歌"，而是让成片的音频更好听、更贴画面、更听得清旁白。工具链已由 `dsh-any-audio` 插件提供，你只负责创作决策。

## 何时使用

默认给视频配音，除非用户明确要求无声、或画面本身已经带成品音频。出现以下任一情况时使用本技能：

- 你正在生成或编辑视频、动画、概念片、讲解片、宣传片、科普片；
- 项目里已有分镜表、旁白稿、字幕、时间轴、`timing.json` 之类的结构；
- 用户要求"配乐/背景音乐/音效/加 BGM/改善音频"；
- 你正准备用 numpy 手写合成器做音乐——先停一下，用 `anyaudio_music` 的真实音源通常更好听。

如果只是生成纯音频、与视频无关，这套工具同样可用，但不必强行走完整流程。

## 三步工作流

1. **建工程**：`anyaudio_project` 的 `mode:"create"`，名字用内容本身（主题、曲名、集数），不要用 `untitled` 或时间戳。拿到 `projectId`。
2. **生成素材**：`anyaudio_music` / `anyaudio_tts` / `anyaudio_sfx` 都要求传 `projectId`——它们会自动把产出登记进工程、建好轨道、放好片段。时间轴仍要先定好：优先读项目已有文件（分镜表、字幕、timing.json、narration.json），不要凭空猜时间。
3. **渲染成品**：`anyaudio_project` 的 `mode:"render"` 出 WAV/MP3/MP4。工程本身留在 `.anyaudio/projects/` 下，用户随时可以打开剪辑台审听和调整。

**交付物一律是工程，不是一条混音。** 一条压好的混音里，某个音效想挪 0.5 秒、某句旁白想重配，都得整条重跑；工程里改一个片段就行。

第一次使用若报"没有安装音源"，先征得用户同意，再用 `anyaudio_sources`（action `install`）装一套音源，再渲染。

## Score 格式

最小可用例子（单位：秒）：

```json
{
  "title": "炊烟",
  "tracks": [
    { "name": "lead", "source": "generaluser", "instrument": "koto", "gainDb": -2, "pan": 0.1, "reverb": 0.35,
      "notes": [[0, 2.0, "D4", 78], [2, 1.2, "F4", 84], [3.2, 2.4, "A4", 90]] },
    { "name": "pad", "source": "generaluser", "instrument": "slow-strings", "gainDb": -9,
      "notes": [[0, 8, ["D3", "A3"], 60]] },
    { "name": "bass", "source": "generaluser", "instrument": "cello", "gainDb": -6,
      "notes": [[0, 4, "D2", 70], [4, 4, "A1", 66]] }
  ]
}
```

`source` 是 `anyaudio_sources` list 里的音源 id（例子里用默认装的 `generaluser`）；VST3 音源另写 `preset` 选音色，例如 `{ "name": "lead", "source": "<list 里的 VST3 音源 id>", "preset": "<list 里的音色名>", "notes": [...] }`。

规则：

- 音符是 `[起始秒, 时值秒, 音高, 力度, 演奏法]`；力度 1–127，缺省 88；和弦把音高写成数组；第五项可选——写 `strum-down` / `strum-up` 让和弦按 18ms 依次起音（扫弦，任何音源都可用），VST3 音源还可写 `sus` / `pm` / `ls` / `hp`。也接受对象写法 `{t,d,p,v,art,expr}`。
- 音高可写 MIDI 号（60）或音名（`D3`、`F#4`、`Bb2`、`C5`）。
- 轨道字段：`source`（音源 id，取自 `anyaudio_sources` 的 list）、`instrument`（SF2 音色：GM 名、program 号，或对象 `{program, bank, name}`——bank 不为 0 的预设用对象写法，`presets` 会给出每条音色的准确写法）、`preset`（VST3 音色名，取自 list）、`gainDb`、`pan`（-1–1）、`reverb`/`chorus`（0–1 发送量）、`drums`（该轨用鼓组，音高按鼓件名如 `kick`/`snare` 解析）、`humanize:{timingMs,velocity}`（轻微时间/力度抖动，避免机械感）。
- **一个 score 最多 16 条轨道**（每条独占一个 MIDI 通道，鼓组固定占通道 9）；超过会直接报错。要更多声部就把同类乐器的音符合并到同一轨（同轨可变音高，和弦写成音高数组）。
- 谱子很长时不要把它整个内联进工具调用：把 score 写成项目里的 `.json` 文件，`score` 参数直接传这个文件的路径（也接受 JSON 文本），省上下文又不容易漏字段。
- 自动化：`automation:[{track:"pad", controller:"volume", points:[[0,90],[20,50]]}]`，控制器支持 volume/pan/expression/modulation/sustain/reverb-send/chorus-send/brightness。
- 表情（CC11）：音符写成对象时可加 `expr`，一个 0–127 的到达值——这个音**结束时**轨道压到该值，保持到下一个标记（两点之间是直线过渡；127=不压，64≈-12dB，0≈静音）。
  - 0 秒处轨道恒为 127，所以第一个标记之前是一段从 127 滑下来的斜坡。
  - 一句渐弱：只在句尾那个音写 `expr:60`。
  - 一句渐强：早段先写一个低值（如 `expr:60`），句尾再写 `127`——只写一个 `127` 是平线，不会渐强。
  - 先强后弱：中间一个 `127`、句尾一个 `60`。
  - 同一时刻两个标记取较小的；整首都没写 `expr` 就不发 CC11，和以前完全一样。
  - CC11 是通道级：同一条轨道同时响的音一起被压，要各自起伏就分轨。
- 时间从 0 开始、按视频时间轴写；`durationSec` 传视频总长，`tailSec` 留给尾音和混响。


## 演奏表情（让同一个音听起来是人拉的）

`notes` 只写了"哪个音、多轻多重"，`automation` 只画单条控制器曲线。同一个音从长弓拉到一半开始揉、一句旋律整体渐强、换和弦时踩一次踏板，这些是**曲式手势**，写在 `expression` 里：

```json
{
  "expression": [
    { "type": "velocity_line", "track": "lead", "start": 0, "end": 4, "from": 30, "to": 120 },
    { "type": "pitchbend_line", "track": "lead", "start": 3, "end": 4, "from": -2047, "to": 0 },
    { "type": "pitchbend_curve", "track": "pad", "start": 4, "end": 8, "depth": 300, "cycles": 4 },
    { "type": "cc_line", "track": "pad", "control": 11, "start": 2, "end": 6, "from": 40, "to": 110 },
    { "type": "cc_curve", "track": "pad", "control": 1, "start": 8, "end": 12, "min": 0, "max": 90, "pattern": "sine", "cycles": 3 },
    { "type": "sustain", "track": "piano", "start": 0, "end": 12 },
    { "type": "humanize", "amount": 12, "timing": 0.008, "seed": 7 }
  ]
}
```

- 时间是**秒**，和音符一样（不是拍）。`track` 省略就是所有轨。
- `pitchbend_line` 从 `from` 滑到 `to`，值域 -8192..8191（8192 = 半个半音的整数位，实际弯音幅度取决于音源）。`pitchbend_curve` 是在 `base` 上做 `depth × sin(cycles × 2π × 进度)` 的颤音/揉弦。
- `velocity_line` 改的是**音符本身**的力度（不是 CC），所以整段渐强会被所有音源听见。
- `sustain` 是开关：起点踩下 CC64=127、终点抬起 0，不是渐变的。
- `humanize` 是整段随机化：`amount` 是力度抖动幅度（1–127 的几分），`timing` 是起始秒的最大偏移；**同 seed 一定得到同一次抖动**，所以重渲染不会每次都变。
- 与轨道的 `humanize:{timingMs,velocity}` 分工：轨道那个是每个音的微量抖动，`expression` 的 `humanize` 是整段一起做的、可复现的一次"换把"。
- 能听见的声部：SoundFont 渲染（弯音走 `pitch` 事件、CC 走控制器）、VST2 声部（送的是 MIDI 文件，CC 和弯音都到插件）、硬件声部（同样走 MIDI）。**VST3 声部走 pedalboard 只收音频缓冲，收不到 MIDI**，给它写弯音不会有声音，改参数要用 `params` 或预设文件。
- `score.automation` 里的 `"controller":"expression"` 是 **CC11**，和这里的 `expression` 不是一回事：前者是一条音量表情线，后者是整组手势。
- 验收：同一段音符加与不加 `velocity_line`，整体 RMS 会按力度曲线变（实测 -23.6 → -26.1 dBFS）；`pitchbend_line` 让主频按弯音量整体偏移（实测 331 → 323 Hz）。

## 先查配器表，再决定用哪个音色

别人做过的曲子用什么音源、什么 preset 是有记录的，别凭印象挑。写曲前先 `anyaudio_sources {action:"orchestrations"}` 看有没有导入过配器表；有就 `{action:"orchestration", name:"<表名>"}` 读它（可加 `"instrument":"Acoustic Piano"` 只看一类乐器）。它按乐器列出「哪个 source / bank / preset、被多少首曲子用过」，第一行往往就是最常见的选择——照着它写，比随机挑一个 GM 音色更像这个风格。

表本身可以从 `.csv`、`.xlsx`（每个工作表一张表）或 Google Sheets 链接导入：`{action:"orchestration_import", name:"…", path:"…"}` 或 `{action:"orchestration_import", name:"…", url:"https://docs.google.com/spreadsheets/d/…"}`，走代理时加 `"proxy":"http://127.0.0.1:7881"`。导入后表存在 `~/.dsh/anyaudio/orchestrations/`，每台机器一份。

## 演奏法（音符第五项）

第五项 `art` 有两类，写法一样，来源不同：

**插件演奏法**（只有 VST3 音源有，依赖音源档案）：

- `sus` 长音 / 重音
- `pm` 手掌闷音
- `ls` 滑音连奏
- `hp` 击勾连奏

**扫弦**（工具级，任何音源都能用）：

- `strum-down` 下扫：和弦音从低到高依次起音
- `strum-up` 上扫：从高到低

扫弦必须写和弦（音高数组），单音写扫弦会报错。扫弦型靠音符的起音时间排布，例如流行歌最常用的「下 空 下上 空 上下上」（八分音符，C 大调 4536251 的第一个和弦 F）：

```json
[0.00, 1.7, ["F3","A3","C4","F4","A4"], 96, "strum-down"],
[0.50, 1.7, ["F3","A3","C4","F4","A4"], 82, "strum-down"],
[0.75, 1.7, ["F3","A3","C4","F4","A4"], 72, "strum-up"],
[1.25, 1.7, ["F3","A3","C4","F4","A4"], 74, "strum-up"],
[1.50, 1.7, ["F3","A3","C4","F4","A4"], 90, "strum-down"],
[1.75, 1.7, ["F3","A3","C4","F4","A4"], 76, "strum-up"]
```

扫弦要上下交替、有节奏型；只写下扫听起来不像人弹的。


## 乐器选择

- 民族/古风：`guzheng`(古筝)、`guqin`(古琴)、`pipa`(琵琶)、`erhu`(二胡)、`dizi`(笛)、`xiao`(箫)、`sheng`(笙)、`suona`(唢呐)、`bianzhong`(编钟)、`yangqin`(扬琴)、`taiko`(太鼓)。它们映射到最接近的 GM 音色，不是真采样，但比正弦合成有质感。
- 管弦：`strings`/`slow-strings`、`cello`、`violin`、`viola`、`harp`、`timpani`、`horn`、`trumpet`、`oboe`、`clarinet`、`flute`、`pizzicato`。
- 氛围：`choir`、`warm-pad`、`choir-pad`、`soundtrack`、`crystal`、`atmosphere`。
- 上面这些是 GM 别名，SF2 音色用它写 `instrument`；某个音源实际有哪些音色、叫什么，以 `anyaudio_sources` 的 list 为准，不要凭这份名单假设某条音色一定存在。
- 写谱前先调 `anyaudio_sources`（默认的 `list` 动作）拿清单：**全部已接入音源**（SF2 与 VST3 混排，带评分、实测音域与音色列表），每条音色都写明怎么写进谱里。要看某音源的全部音色再调 `presets`（`source` 传音源 id，SF2 与 VST3 都支持；`query` 可按名字过滤，例如 `query:"12-String"`）；`instruments` 只是 GM 别名表，不是可用音色清单。
- 需要新音源时先告诉用户去设置页装，或征得用户明确同意后再装——**不得自行下载音源**（下载是大流量动作，必须用户同意）。
- 换音源或音色要改谱里的 `source`/`preset` 再重新生成；只调平衡不要重新生成（见混音一节）。机器上接了哪些音源，以 `anyaudio_sources` 的 list 为准。
- 没有 DSH 也能渲染：`node scripts/anyaudio-cli.mjs render <score.json> <out.wav>`（可加 `--font`、`--duration`、`--peak`、`--rate`），等价于只调 `anyaudio_music` 的离线路径。适合先离线把谱子调好再进视频流程。

## 每条轨道选音源与音色（必填）

## 每条轨道选音源与音色（必填）

- **每条轨都要在谱里写明用哪个音源、哪个音色，写法照 `anyaudio_sources` list 里该条音色给出的字段**：
  - SF2 音源：`source` 写音源 id，`instrument` 写音色名（GM 名、program 号，或 bank 不为 0 时用对象 `{program, bank, name}`）。
  - VST3 音源：`source` 写音源 id，`preset` 写音色名。
  - 本仓库还支持把声部交给挂载的插件：`vst`（VST3 或 64 位 VST2 路径）或 `hw`（硬件音源），见后文。
- **为什么**：音源与音色的清单是唯一事实来源。乐器名千差万别、各音源组织音色的方式也不同，程序无法从一个乐器名猜出该用哪个音源、哪条音色；猜出来的不是你要的声音。所以选源是写谱人的职责，不是工具的。
- **不指定会报错**：轨道没写 `source`、或写了清单里不存在的 id，工具直接报错，并把可用音源与音色清单附在错误里——照着清单改，不要猜、不要反复试。`preset` 只对 VST3 音源有意义，只写 `preset` 不写 `source` 也会报错。
- 同一个 score 里不同轨可以用不同音源，SF2 与 VST3 可以混用；每条轨各自写自己的 `source`。写 `"auto"` 可以让插件按乐器族评分自动挑最好的已安装音源（1–10 分，`list` 里能看到各库分数）。
- 音源没有可选音色时，list 会显示"1 个音色（默认）"，此时不写 `preset`，用该音源的默认音色。
- **不要凭先验断言某类乐器的音色上限**——以清单里实际接入的音源与音色为准；逐轨报告会写明每条轨用了哪个音源、哪个音色。
- **鼓组的键不是随便一个都响**：sf2 的鼓组只映射它自己列出的键——GeneralUser-GS 覆盖 0–127，有些老机种的库只有十几个（例如只有 28、35、36、38、39、40、42、46、49、51、57）。拿 48–63 这类采样器键位喂这种库，整轨会静音。渲染器现在会提前说清楚：`"X" answers only 11 drum key(s) (…) and none of this track's keys (…) is among them`，或部分缺失时 `has no drum sample for key(s) 48`；缺的键会自动移到该库最近的键并列出移动（`moved 48→49 (Hi-Mid Tom→Crash Cymbal 1)`），看到这种提示要按耳朵确认那几下还像不像原来的鼓。
- 鼓组永远来自默认音源（第一套加载的库）；要换鼓就把带鼓的库作为 `font` 传进来。
- **鼓组永远来自默认音源**（第一套加载的库）：其它库的鼓组不会被使用。要换鼓就把带鼓的库作为 `font` 传进来；默认库没有鼓时鼓轨不会响。
- 装新音源：SF2 用 `anyaudio_sources` 的 `install`（按 id 下载）或 `fromPath`（本地文件）；VST3 在设置页音源区扫描添加。**装之前必须征得用户同意，不得自行下载。**音源装进整台机器共用的位置，所有项目与 Agent 会话共用，不用每个项目重装。想让某个库成为鼓组来源，用 `action: "use"`（会写入 `music.font` 配置）。许可证不允许再分发的音源由用户自备，不要下载来源不明的文件。

## 旁白（anyaudio_tts）

- 视频需要配音、但项目里没有现成录音时，**必须用 `anyaudio_tts`**：单条 `{text}`，或多条 `{items:[{text, voice}]}`。它要求 `projectId`，产出直接登记进工程并落轨——和音乐、音效走同一条路。
- 不要自己调 `edge-tts`、`ttsmaker` 或任何 Python/node 的 TTS 库：那样会绕过用户在 Settings → AnyAudio 里选的引擎和音色（例如 MiMo），用户改了默认引擎也不会生效。
- **三个引擎各有自己的音色，名字不能混用**（传了不属于该引擎的名字，服务端会报错或干脆不理你）：
  - `edge`：`zh-CN-XiaoxiaoNeural`、`zh-CN-YunxiNeural`、`zh-CN-YunjianNeural`、`zh-CN-XiaoyiNeural`、`zh-CN-YunyangNeural`、`zh-CN-liaoning-XiaobeiNeural`、`zh-CN-shaanxi-XiaoniNeural`、`en-US-AriaNeural`、`en-US-JennyNeural`、`en-US-GuyNeural`、`ja-JP-NanamiNeural`。**网络服务、不需要 key**，中文旁白常用的默认音色是 `zh-CN-YunjianNeural`。支持 `rate`/`pitch`/`volume`。
  - `mimo`：`mimo_default`、`冰糖`、`茉莉`、`苏打`、`白桦`、`Mia`、`Chloe`、`Milo`、`Dean`。`mimo_default` 由服务端集群决定，不同集群可能不同。**需要在 Settings → AnyAudio 里配好 MiMo API Key**；没配 key 就不要选它。情绪用 `style` 描述，不支持 `rate`/`pitch`/`volume`（传了会被折进 style）。
  - `deepseek`：只有两个音色，`stella`（女声）、`tide`（男声）。**不需要配 key**：它用的是本机 DSH 登录的 DeepSeek 账号，登录了就能用。**不支持调速、调音高、调音量**——这三项传过去会被忽略，并在 `warnings` 里告诉你；需要控制语气/快慢时改用 `edge` 或 `mimo`。按字数计费（汉字算 2 个字符），比另两个贵，但音质稳定。
- 不传 `provider` 就用用户配置的默认引擎（三个都可能），不传 `voice` 就用该引擎的默认音色——两者都不是固定值。**默认就是用户的设置：只有用户在这一轮明确要求某个引擎或音色时才传，其它情况一律不传。**「我觉得这个音色更好听」不是覆盖的理由——那会把用户自己在设置里选的引擎悄悄换掉（真实事故：用户设了 MiMo，Agent 为了"音色可控"传了 edge，用户听到的是完全不同的声音）。`anyaudio_project` 的 create 回包会写明当前默认引擎与音色，照着它判断。`voice`/`rate`/`pitch`/`provider` 写在顶层会应用到这一批的每一句，单个 item 写了就以 item 为准。`rate` 写 `-12%`，`pitch` 写 `-3Hz` 这类 Edge 语法，也接受数字；MiMo 用 `style` 描述情绪。
- Edge TTS 是网络服务（非官方接口），失败先查网络/代理再重试，必要时给 `proxy`；需要 ffmpeg 把 MP3 转成 WAV。连续试听过多会触发限流（429）：等一分钟重试，或传 `provider:"mimo"` 换引擎（前提是用户配了 key）。**批量中途失败时这一批已经落下的片段会被回滚**，工程保持原样，改好再整批重来即可——不要因为一次失败就另建工程。
- 长旁白按分句拆成多条**是为了对齐时间轴，不是为了分轨**：它们仍然落在同一条旁白轨上，只是各自有不同的 `startSec`。已有旁白音频时不要重复生成。

## 唱歌（anyaudio_sing）

用户要做**歌曲、演唱、把一段词唱出来、把旋律变成人声**时，用 `anyaudio_sing`——它会真的唱（DiffSinger 本地歌声合成），不是用乐器奏出旋律（`anyaudio_music`），也不是旁白（`anyaudio_tts`）。

**自动触发，不用点名**：判断的是意图，不是某个固定词。用户说「做首歌」「把这段词唱出来」「唱《送别》第一句」「给这段旋律配个人声」——只要是要人声歌唱的需求，就自己调 `anyaudio_sing`，像配乐、旁白一样接进自动链路；反过来随口说别的不要误触发。这里不列死规则，靠你判断用户到底想不想唱。

它要 `projectId`（没有就先 `anyaudio_project mode:"create"`），和音乐/旁白/音效走同一条入工程、落轨的路，产出落在单独一条人声轨上（`kind: "sing"`、与旁白同属 `tts` 混音类），可以打开试听、调增益、逐句重来。

### 唱已有的歌：先查真实曲谱，不要凭印象编旋律

音符的**音高和节奏必须来自真实曲谱**，不能用大脑对旋律的模糊印象现编—— casual 地"照着记忆写几个音"几乎必然跑调：音高差几个半音、拖腔和换气全丢，唱出来就不像那首歌了。这一步比格式写得对不对更决定成败。

- 用户点名了具体歌曲（如「唱《送别》」「唱国歌第一段」）：**先用搜索/网页工具查这首歌的真实简谱或五线谱**，确认调号、每个字的音高与拍数、哪里拖腔、哪里换气，再转成下面的四字段。不要跳过查谱直接写音符。
- **交唱时告诉用户曲谱来源**：交付时明确说清旋律用的是哪首歌、曲谱从哪查到的（给出处/链接）、调号与速度、哪里按谱面做了拖腔和换气。这样即使唱得不完全合意，用户也知道问题出在曲谱版本或查谱准确度和演唱上、而不是插件本身——质量取决于曲谱，不取决于插件。
- 用户只是给了一段自编的词、或明确说"随便配个旋律""把这段词唱出来"：没有现成曲谱可查，才由你按语义自编旋律，这种情况先跟用户说清旋律是你配的、不是某首现成的歌。
- 简谱转 MIDI：`1=C` 时 1=C4=60、5=G4=67；带点的数字是高/低八度（±12），下划线表示半拍，数字后的横线是延长一拍，附点 ×1.5，连音线表示一个字跨多个音（拖腔写法见下）。

### 音符四字段

每个音符是 `[startSec, durSec, midi|null, lyric]`，**按歌曲时间轴写绝对秒**：

- `startSec`：这一音在歌里的起始秒数（绝对位置，不是相对上一音）。
- `durSec`：时长秒数。
- `midi`：音高，MIDI 号（如 60）或 `null` 表示休止。
- `lyric`：这一音唱的歌词字/音节。

最小例子：

```json
{ "notes": [
    [0.0, 0.8, 64, "长"],
    [0.8, 0.6, 65, "亭"],
    [1.4, 1.2, 67, "外"],
    [2.6, 0.5, null, ""],
    [3.1, 1.0, 64, "古"]
  ],
  "projectId": "prj_ab12cd34" }
```

写法要点：

- **拖腔（一个字跨好几个音）**：写在**第一个音**上，后面延长的音 `lyric` 留空串 `""`。例如一个「长」字拖三拍，写成 `[[0,0.5,64,"长"],[0.5,0.5,64,""],[1.0,1.0,64,""]]`——不要把「长」重复写到每个音上。
- **休止**：`midi` 写 `null`（`lyric` 通常空串），它同时也是**分句点**。
- **按句分段、时间轴归零（唯一模式）**：工具会自动按休止把 notes 切成一句一句，把每句的时间轴归零后依次唱、拼成一个 WAV；没有「整首一次过」的开关。好处是每句的换气与起音都对，你照整首时间轴写绝对秒即可，归零由工具做。
- **多音字**：引擎按整句歌词纠正读音（例：`银行` → `h ang`），所以一句里的字要写全、按唱序排好，别打乱。

### 逐句重生成是这个插件的巨大优势

一首歌四句、第 3 句不满意，就**只重唱第 3 句**：把第 3 句的 notes 单独传给 `anyaudio_sing`（可换谱子、换 `voicebank`、换旋律），得到一条新素材，再用剪辑台的分割功能精准剪掉旧句、替换成新句——不必整首重来。把它当 Cubase / Reaper / Audition 那样精调，工具不需要专门的接口，你用剪辑台的分割 + 替换就能做到。详见 `anyaudio-clipbay` 技能。

### 唱歌常见错误

- 唱具体的歌却凭记忆现编旋律、不查真实曲谱 → 音高节奏全跑偏，听着"不对"；先查谱再写音符。
- 拖腔把同一个字写到每个音上 → 会被当成多个字反复唱；只写第一个音，后面留空串。
- 用 `anyaudio_music` 把旋律奏出来冒充唱歌 → 那是乐器，不是人声；要唱就用 `anyaudio_sing`。
- 自己写 Python/Node 合成歌声 → 绕过本地声库与引擎。
- 一句不满意就整首重新生成 → 贵且丢掉其它句；只重生成那一句再在剪辑台替换。

## 音符怎么发音（ADSR）

- 每个音符只有 `起始/时值/音高/力度` 四项；起音、衰减、延音、释放由**音源里的采样与预设**决定，插件不做 per-note 包络。钢琴是击弦后自然衰减，弦乐/铺底是渐入后持续，管乐起音更慢——同样是 5 秒长音，不同乐器峰值出现的位置完全不同。
- 想要颗粒感/断奏就写短时值、音符之间留缝；想要连奏就让时值与下一个音符接上。力度影响采样层与音量，不改变包络形状。
- 长乐句的整体强弱用 `automation` 的 `expression`（CC11）或 `volume`（CC7）画曲线，比逐个改力度自然。

## 编曲技巧菜单（按需选用，不是必做清单）

这些是可选手段，根据画面和情绪自行判断，不要机械套用：

- **厚度**：主旋律 + 低音支撑（低一个八度）+ 中声部和弦铺底；三轨通常就够，超过五轨先问是否真的需要。
- **音区分离**：低频（bass/cello）< 200Hz，中频铺底 200–800Hz，旋律 500Hz–2kHz，高频装饰（bell/glockenspiel）> 2kHz。避免所有乐器挤在同一个音区。
- **节奏层**：脉冲式低音、轻打击（`shaker`/`taiko`）、拨弦分解，用于动作段落；安静段落撤掉节奏层。
- **动态**：渐强用增加声部/提高力度/加入高八度实现；渐弱反向操作；不要只靠整体音量。
- **分轨平衡**：每条轨的 `gainDb` 决定这条分轨**生成出来**时多响（母带归一化不会重新平衡各轨），它是既成事实；`anyaudio_music` 每次调用都会顺便把每轨实测一遍，结果直接写在返回值和素材档案里，**不用再传 `analyze` 或 `stems` 去另测**。看完电平之后要调平衡，改**片段增益**（`anyaudio_project` 的 `target:"clip"`, `field:"gainDb"`），不要重新生成整首曲子——重新生成会换掉素材，代价是全部轨道重渲。旋律可以比铺底高 6–10dB，别把伴奏压到 15dB 以下（除非刻意留白）。
- **注意测量的代价**：逐轨测量等于每轨各合成一遍。实测 12 轨 64 秒的谱子，混音渲染 2.7 秒、逐轨十二遍 13.4 秒，一次调用总共约 16 秒（不测的话约 3 秒）。所以**别为了看一眼电平再调一次**，电平已经在返回值里了。
- **进出场**：新乐器在乐句边界进入；转场处留 0.2–0.5s 空隙或用一个 whoosh。
- **高潮**：叠加八度、加打击、提高力度，但峰值要给旁白留空间（混音阶段会 duck）。
- **休止**：该停就停。关键时刻的静音比连续铺满更有力量。

## 交给别的程序改（anyaudio_midi）

用户想自己改谱、想在 DAW 里换音色、或者手里已经有一首 .mid 想拿来当草稿时，用 `anyaudio_midi`：

- `action:"export"`：把 score 写成标准 MIDI 文件（默认落到 `.anyaudio/out/<标题>-<时间>.mid`）。也可以直接在 `anyaudio_music` 上写 `midi: true`，渲染音频的同时顺手把编排导出，省一次调用。
- **`.mid` 可以直接渲染，不必先转成 score**：`anyaudio_music {projectId, midiFile:"some.mid"}` 内部做的是和 `action:"import"` 一样的读入，然后照常渲染。别同时给 `score` 和 `midiFile`（会报错）；`midi` 是另一个开关，表示「顺便把这次编曲导出成 .mid」。
- `action:"import"`：读一个 .mid 回到 score（按 MIDI 通道并轨，通道 10 是鼓，音色名由 program 反查），再交给 `anyaudio_music` 渲染成音频。人手写的一段旋律、别人给的伴奏、旧工程留下的 .mid 都走这条路。
- `action:"analyze"`：只读地看一首 .mid——速度、拍点、音域、每个声部的音符密度与同时发声数（`maxPolyphony`）、以及对网格的比例。写之前先看，比照着印象猜可靠。

MIDI 不是音频：它不进工程、不参与混音、`anyaudio://timeline` 也引用不到它。它是给人改的稿子，改完导入回来才有声音。导出时整个文件只有一个速度（score 的时间轴本来就是秒），`midiBpm` 只决定一秒值多少 tick，不影响听感。

## 记住一种写法（anyaudio_style）

一类片子会反复要同一种音乐：同一部剧的下一集、同一系列的片头、同一个人的偏好。不要每集重新发明一次——把上一次的做法量下来，存成一张风格卡，下一集先读它。

- `action:"learn"`：拿一份 score（或它的路径）或一个 `.mid` 文件去量。它记下速度、拍号、调性（Krumhansl 相关，带置信度）、16 分网格对齐率与中位偏移、摇摆与切分比例、声部数与同时发声数、每个声部的音/秒·平均时值·音域·力度、同时发声的音程结构、力度走势，并据此写出一段可以直接照做的中文建议。
- `action:"list"` / `action:"show"`：看货架上有什么、读其中一张（`show` 返回完整的 markdown 页）。`action:"remove"` 删掉。
- 卡片存在整机共享的 `~/.dsh/anyaudio/styles`，跨项目、跨会话都在——一种写法属于作者，不属于某一个视频。

**顺序很重要**：写新曲子之前先 `show` 出上一张卡，照着它的速度、声部数、音域和密度写，再交给 `anyaudio_music`。卡片不会替你生成音符，它给的是约束和证据；把「92 BPM、小三度为主、鼓 3 音/秒、六个声部」变成旋律，仍然是你写谱。

外来的 `.mid`（别人给的编曲、旧工程的导出）也能学：`action:"learn", file:"x.mid"`。学完把卡片留在货架上，下次按它写。

**有人替你量过了**：如果工作区里有一份 `USER-STYLE-NOTES.md`（作者从自己多年的工程里量出来的一页纸），写曲子之前先读它——它比任何一张单曲卡都更能说明「这个人写的音乐是什么样」。里面通常写着调性偏好、声部数习惯、网格对齐、力度做法；照它写，再拿 `anyaudio_style learn` 给新曲子记一张卡，风格就接上了。

## 用本机的合成器（anyaudio_vst）

SoundFont 是通用音色库，胜在什么都有、随处能跑；但有些声音它给不了——Roland 的 JUNO/JUPITER、TB-303 的滑音、SRX 的采样乐器。本机装了 VST3 时，可以直接让这些插件出声。

先 `action:"status"`：它告诉你 Python 与 pedalboard 在不在（不在就告诉用户装一下，别自己 pip install）。然后 `action:"scan"` 列出能加载的插件（已经滤掉 3–6KB 的重定向桩和授权不明的替身文件）。扫描认得两种格式：**VST3** 与 **64 位 VST2**（`.dll`，靠读 PE 头与导出表判断，不是看扩展名）。**两种都能渲染**：VST3 走 pedalboard，64 位 VST2（`.dll`）走第二个宿主 dawdreamer（`pip install dawdreamer` 一次即可）。VST2 声部是把谱面写成 MIDI 文件再播进去的，所以 CC 与弯音随声部一起走。32 位 VST2 单独列成 `legacy32`，那是 64 位宿主加载不了的，要靠用户自己做桥接。扫描结果里的厂商与「合成器/效果器」两类信息多数要加载插件才能拿到（单文件 bundle 里没有 moduleinfo.json），所以设置页上那个「探测类型」按钮是一次性的、可能要等几秒。`action:"info"` 给出某个插件的参数名与原始取值范围，改音色就靠它。

`action:"render"` 一次渲染一个插件的若干个音：

```json
{"action":"render","plugin":"JUNO-106","notes":[[0,1.2,60,100],[1.2,1.2,67,96]],"params":{"lfo_rate":96},"durationSec":3}
```

`notes` 是 `[开始秒, 时长秒, MIDI 音高, 力度, 通道?]`，和弦就写成一串同起点的音；`params` 的键名来自 `action:"info"`，值是插件自己的原始范围（不是 0..1）。渲染结果是一条普通音频素材（`snapshotKind: "vst-render"`），进工程后和其它轨道一样可以加效果、调增益、被 duck。

**这台机器上量到的事实**（不是猜测，别重复排查）：

- 23 个 Roland 插件能出声：JUNO-106、JUNO-60、JUPITER-4/8、JV-1080、JX-3P、SH-101、PROMARS、SYSTEM-100/8、TB-303、全部 SRX 与 EARTH 系列。
- **TR-808/909/707/727/606 能加载、参数齐全，但渲染全程静音**，16 个通道、24–84 音域、program change 之后都是 0.0000——这些鼓机在本机未授权。要鼓就用 SoundFont 的鼓组，别在 TR 上耗时间。
- Padshop、Retrologue、ZENOLOGY、Galaxias **加载会一直挂着**（超时 25 秒被强制杀掉）。`TIMEOUT` 是结论，不是失败重试的信号。**根因多半是许可证失效**：这类插件带授权检查，许可证过期或没有授权时它会弹出激活窗口等人处理，headless 里没人点就一直等下去。本机 Padshop 的许可已到期；续上之后它大概率能用——遇到 `TIMEOUT` 先查许可状态，不要直接把这些插件写成「永久不可用」。
- NeuralNote、Chord Analyzer MIDI 加载不了；JC-120、RE-201 这类效果器没有可播放的音符。

所以：VST 用在「音色本身是主角」的地方——一段合成器主线、一个 303 低音、一个 SRX 钢琴。铺底、和声、鼓这些量大又不挑音色的部分继续用 `anyaudio_music` 的 SoundFont，速度快、可逐轨测量、能导出 .mid。一次单独的 `render` 只驱动一个插件；要多个插件就调多次，拿到几条音频再在工程里叠。

**让插件直接进乐谱**（不必先渲染再贴）：`anyaudio_music` 的 score 里，任何一条轨道都可以把 `instrument` 换成 `vst`——

```json
{"name":"synth","vst":"C:/Program Files/Roland Cloud/JUNO-106/JUNO-106(VST3 64bit).vst3","notes":[[0,4,"C3",100]]}
```

`vst` 可以只写插件路径，也可以写成 `{"plugin":"…","params":{"filter_cutoff":40},"controls":[[1.5,74,90]]}`（`params` 用插件自己的原始范围，`controls` 是 `[秒, CC 号, 值]`，也可以直接用 score 的 `automation` 写）。插件声部**不占 MIDI 通道**，能和 SoundFont 声部混在同一首里：渲染时插件在自己的进程里出声，回来与 SoundFont 那半边相加，最后只做**一次**母带归一化——两边的高低关系就是谱面写的关系，不会因为各自归一化而被打乱。`gainDb` 在两种声部上是同一个意思：SoundFont 声部拿它算 CC7，插件声部把等量的线性增益直接乘到样本上。每个声部仍会单独渲染一次用来测电平，`stems:true` 时也照样拿到插件声部自己的 stem。

某个插件没渲染出来不会带走整首：其余部分照常混音，回执的 `warnings` 里写明哪个声部、哪个插件、为什么。`TIMEOUT` 是结论，换插件，别重试。

同一插件的多个声部会**合到同一个进程里渲染**：插件只加载一次，三个声部只付一次加载的代价（实测三声部 8.0 秒，各自单开进程要 13.0 秒，样本逐点相同）。不同插件仍然各开一个进程——一个插件的加载器卡死，只影响用到它的声部。所以「一首曲子里同一个合成器写四条线」不会因为声部多而变慢多少。

**把调好的音色存成一个名字**：`params` 里那些数字，下次要用还得重新抄一遍。调好一次就存下来——

```json
{"action":"preset","presetAction":"save","name":"juno warm pad","plugin":"C:/Program Files/Roland Cloud/JUNO-106/JUNO-106(VST3 64bit).vst3","params":{"lfo_rate":96,"filter_cutoff":40},"note":"慢起音，不要混响"}
```

之后乐谱里只写 `{"name":"synth","vst":{"preset":"juno warm pad"},"notes":[[0,4,"C3",100]]}`，插件路径和整块参数都由这张卡补上；轨上再写的 `params` 只覆盖那一颗旋钮，其余仍来自卡。`presetAction:"list"` 看全部，`"show"` 看某一张的参数，`"remove"` 删掉。卡存在 `~/.dsh/anyaudio/vst-presets/`，跟风格卡一样是机器级的——换个项目、换个会话照样能用。名字里有中文不会出问题，重名会自动加 `-2`。

**插件里调好的音色，直接指向它自己的预设文件**。有些东西不在参数表里：Roland 的 SRX 换 patch、合成器的宏旋钮、插件窗格里才有的页面。这些只能由**人在插件自己的窗口里调好、存成文件**（`.vstpreset`、`.fxp`、`.fxb`），然后让 Agent 去加载——

```json
{"action":"preset","presetAction":"import","name":"srx piano 华丽","plugin":"C:/Program Files/Roland Cloud/SRX PIANO 1/SRX PIANO 1(VST2 64bit).dll","presetFile":"D:/Presets/srx-grand.vstpreset"}
```

登记之后，乐谱轨写 `{"name":"keys","vst":{"preset":"srx piano 华丽"}}` 就会把那个文件交给插件（先加载文件，再应用轨上显式写的 `params`，所以「预设 + 改一颗旋钮」是成立的）。也可以不登记、一次性用：`render` 时直接传 `presetFile`。

四条要点：①**文件原样交给插件，这边不解析**——它属于插件，改动它是插件的职责；②加载失败不会静音或崩掉，回执的 `warnings` 里写明 `state: …` 是哪一步失败，该声部照常用默认音色渲染；③`.vstpreset` 是 VST3 的格式，`.fxp`/`.fxb` 是 VST2 的，选错了插件会拒绝，报错会告诉你；④**文件从哪来**：让用户在任意能打开插件窗口的宿主里（FL Studio、Cubase、Maschine 都行）把音色调好，另存为预设——VST3 存成 `.vstpreset`、VST2 存成 `.fxp`（单个音色）或 `.fxb`（整个音色库），然后把路径发过来。不要替用户猜某个插件「应该」怎么调，那是只有窗口里才看得见的东西。

**没有用户预设时，可以自己写一个 `.fxp`**（只限 64 位 VST2）：`anyaudio_vst {action:"preset", presetAction:"write", plugin:"<dll>", name:"srx piano 夜里", params:{"MASTER LEVEL":0.25}}` 会读出插件当前全部参数、改掉你点名的几项、写成标准 `.fxp` 并登记成同名预设。参数名写错会报 `"X" is not a parameter of …; closest names: …`，照它给的最近名字改。也有限度：`write` 只能动**参数表里有的东西**，插件窗格里的宏、页签、patch 选择仍然属于用户——那部分只能等用户在窗口里存 `.vstpreset` 再 `presetAction:"import"`。**别给 VST3 写 `.fxp`**，格式不通用。

**已经存在的预设文件可以先找出来**：`anyaudio_vst {action:"preset", presetAction:"scan"}` 扫 `Documents/VST3 Presets`、`%APPDATA%/VST3 Presets`（可用 `ANYAUDIO_VST_PRESET_DIRS` 追加），按插件列名字；设置页「插件预设」把同一批文件**按插件分组**摆出来，每行给一个「导入」。同一插件下重名的文件导入时自动变成「名字 2」。文件名只是标签，真身是那个文件。

**两条通道的区别要说清，别混用**：VST2 声部送进去的是 MIDI 文件，所以谱面的 `automation`（CC 事件）真的会到达插件——插件若开了 MIDI Learn / 固定 CC 映射（例如 SRX 的 CC7 音量、CC91 混响发送），可以用 `{"track":"keys","controller":7,"points":[[0,127],[4,40]]}` 这样推它。VST3 声部走 pedalboard，插件只收到音频缓冲、收不到 MIDI，所以对 VST3 来说参数只有两条路：`params`（参数名，`action:"info"` 里能查到）和预设文件。

**一个插件里的多个模块（多音色插件）**：GM/多音色音源（Super Quartet、Hyper Canvas、Orchestral、XV-5080 这类）一个实例里放多个模块，每个模块吃一条 MIDI 通道、并靠 bank 选类别——谱面里给 `"vst"` 写 `"channel"` 指定通道，`"bank"`（CC0，MSB）与 `"bankLsb"`（CC32，LSB）在曲首发给插件，之后才发 `program`。同一个插件路径的多条轨道可以各走各的通道。

**先看手册里的表，再决定怎么写 bank**：乐器分类几乎都写在手册的 bank 表里——Orchestral 是 MSB 0 / LSB 0–6（0 弦乐组、1 独奏弦乐、2 铜管组、3 独奏铜管、4 木管、5 键盘打击乐、6 节奏组），Super Quartet 是 MSB 0–3（钢琴/吉他/贝斯/鼓）。所以读手册时要主动搜 `PC` `MSB` `LSB` `Bank` `CC#` `Controller` `Note#` 这些字眼，把「哪个 bank/program 是哪个音色」抄进说明书；不抄，写声部时就只能瞎猜。

**两个 bank 字节各管一件事**：数码钢琴/合成器常用的写法是 `MSB = 库`（0 出厂、1 用户）、`LSB = 模块或类别`，两个都发完之后再来一条 `program` 才算选定。Super Quartet 就是这样：`MSB 0 / LSB 0–3` 是出厂钢琴/吉他/贝斯/鼓，`MSB 1 / LSB 0–3` 是用户库的同一批模块（只改 LSB 才换模块，手册里 `MSB 2`、`MSB 3` 根本没有定义）。Orchestral 则是 `MSB 0 / LSB 0–6` 分七类（0 弦乐组、1 独奏弦乐、2 铜管组、3 独奏铜管、4 木管、5 键盘打击乐、6 节奏组）。

**桥接转发哪一字节要自己试**：本机 jBridge 版的 Super Quartet 只认 LSB（CC32），MSB 改成 1/2/3 时 rms 恒定——那其实是「MSB 是库、用户库为空」的正常表现，不是被吞。Orchestral 两个字节都通。判断办法：同一通道弹同一个音、只改一个字节，比较 rms 与频谱；完全一样就是这一个字节没起作用。手册还提醒 Emagic Logic 系列宿主可能收不到 CC32，那种宿主要把控制映射切成 “Logic” 模式才能用 MSB 选全部 bank。谱面上 `bank` 是 MSB、`bankLsb` 是 LSB。

## 线路输入与硬件音源（anyaudio_record / anyaudio_midiout）

有些声音既不在 SoundFont 里也不在插件里，而在机器外面：一台 EDIROL SD-20、一块机架音源、一支接在声卡上的麦克风。它们自己发声，宿主只能从线路输入把它听回来。

- `anyaudio_record`：`action:"devices"` 列出所有输入（每个物理口在 MME/DirectSound/WASAPI/WDM-KS 各出现一次，同名的会一起列出）；`action:"record"` 录指定秒数到素材。`device` 可以写序号也可以写名字的一部分，名字有歧义时它要求你给序号而不是瞎猜。
- `anyaudio_midiout`：`action:"ports"` 列出 MIDI 输出与输入；`action:"play"` 往某个端口发音符（`notes` 与 VST 同一套写法，`[开始秒, 时长秒, 音高, 力度, 通道?]`）；带上 `captureDevice` 就一边弹一边把音源的线路输出录下来，两者共用同一个时钟。
- `action:"calibrate"`：一次性的测量。它连发几个短 ping 同时录音，报出音频比 MIDI 晚多少毫秒。**换机器、换音源、换驱动之后都要重测**——这个数字决定硬件声部会不会听起来迟。

**为什么必须校准**：MIDI 消息是立刻离开的，音源内部的音源引擎要过几十毫秒才出声。不补这段，音源声部会比其它轨道整体晚一截，而且每台设备晚的量不一样。校准得到的 `latencyMs` 传回 `play` 的 `trimLatencyMs`，录制时把这段前置延迟裁掉，音头才会落在谱面写的时刻上。

**这台机器上量到的事实**：

- 音源是 SD-20，MIDI 输出里叫 `SD-20 PART A`（0–15 通道）与 `SD-20 PART B`（16–31 通道），用 `port:"SD-20 PART A"` 这种写法不必记序号。两个 part 可以同时工作，但复音是一起算的：**同时最多 64 个音符**，超出的那部分不发声，也不会报错。复音上限是**模块自己的属性，别推广到别的音源**——Roland XV-5080 与 SC-88 都是 128，有些老音源更少。不确定就问用户，问到之后写进 `hw` 的 `voices`。
- 音源的线路输出在系统里显示为 `麦克风 (3- USB Audio Device)`，不是名字里带 C-MEDIA 的那个；另有 `麦克风 (2- KT USB Audio)` 是别的设备。名字写错会录到一片静音，`anyaudio_record devices` 时看清 hostApi 是 WASAPI 的那一条。
- 实测 `latencyMs` 约 **66 ms**（多次 ping 的离散度 1.6 ms，很稳）。不同驱动、不同缓冲下这个数会变，别把它当常量抄进代码。
- 录音全程静音时先怀疑 ASIO4ALL：它会把输入口独占走，WASAPI 这边只拿到空数据。关掉 ASIO 宿主再录。

**顺序**：`anyaudio_record devices` 找到输入 → `anyaudio_midiout ports` 找到端口 → `calibrate` 测一次 → 之后每次 `play` 都带 `trimLatencyMs`。要留在工程里就带 `projectId`，录制结果作为一条普通音频素材（`snapshotKind: "hardware-capture"`）进轨道，之后的混音、duck、导出与别的素材完全一样。

### 让硬件音源直接进乐谱

音源和插件一样可以当一个声部写进 score，`anyaudio_music` 会把它弹一遍并录回来，与其它轨道一起混：

```json
{"tracks": [
  {"name": "pad", "instrument": "warm-pad", "notes": [[0, 8, "C3", 70]]},
  {"name": "lead", "hw": "SD-20 PART A",
   "captureDevice": "3- USB Audio Device", "latencyMs": 66,
   "program": 81, "notes": [[0, 1, "G4", 100], [2, 1, "A4", 96]]}
]}
```

- **登记过的外部音源可以直接写名字**：在 设置 → AnyAudio → 音源 → 外部音源 里登记过「名字 + MIDI 端口 + 音频输入」之后，`"hw": "SD-20"` 就等于同时写了 `port`、`captureDevice`、`latencyMs`、`voices`。轨上再写的字段会覆盖登记值（比如只改 `channel`）。名字没登记就照旧当端口名用，不会报错。
- **VST 插件也有说明书**：说明书不限于硬件音源，插件同样可以挂一篇——名字用插件显示名（如 `JUNO-106`）或文件名。设置页「插件与音源」选中一个插件就能写、也能从厂商 PDF 或网页文件夹导入；Agent 用 `anyaudio_sources {action:"manual", name:"JUNO-106"}` 读。合成器的音色号、必须打开的开关、哪些参数不响应 CC，都写在这里，别在写声部时凭插件名猜。
- **写声部前先看说明书**：`anyaudio_sources {action:"manuals"}` 列出已经写好的说明，`{action:"manual", name:"SD-20"}` 读某一篇。说明书记的是这台模块的真实用法（哪个音色号是什么、哪些控制器不起作用、有什么坑），比从型号或说明书 PDF 推更准。**没有说明书时不要凭型号猜音色号**——问用户，然后把答案用 `{action:"manual_set", name:"SD-20", text:"…"}` 存下来，别的会话下次也能直接用。设置页 音源 → 外部音源 每条右侧也有「说明书」按钮，用户自己也能写。
- **用户在对话里说的插件/设备知识，当场记下来**：他告诉你「这台模块的鼓在通道 10」「PC 4 才是贝斯」「要先关掉某个开关」，这不是闲聊，是下次还要用的知识。立刻 `anyaudio_sources {action:"manual_set", name:"<插件或设备>", text:"…"}` 写进说明书（已有就补一段），并在回复里说一句「已记进说明书」。不要等用户重复第二遍，也不要只在心里记着——会话结束就没了。
- **厂商手册是登记制，不是一进来就读**：`{action:"manual_import", name:"…", path:"…"}` 默认只把文件/文件夹的路径记进待读清单（几百页 PDF 立刻解析既慢又会截断）。所以动手替某个音源写声部之前，先 `{action:"manuals_pending"}` 看这个音源有没有待读的手册；有就 `{action:"manual_parse", name:"…"}` 现场解析并归档，再 `{action:"manual"}` 读它，把音色号、CC 支持、限制提炼成一篇同名说明。也可以在导入时直接加 `"parse": true` 立即解析。
- 短形式 `hw` 只写端口名；长形式还可给 `channel`（0–15，这个端口自己的通道号）、`program`（音色号）、`captureDevice`、`latencyMs`、`voices`（模块的复音数）。
- `captureDevice` 不写就找环境变量 `ANYAUDIO_CAPTURE_DEVICE`；两者都没有会直接报错——因为「弹了但没录」会得到一条静音，比报错更难查。
- **写设备名字，不要写索引**：`[26]` 这种序号会随 USB 重插或驱动更新重新排列，昨天的 29 今天可能变成「立体声混音」并录出 0 帧。`anyaudio_record {action:"devices"}` 给的是 `名字 — 主机 API, 声道, 采样率`，把名字原样填进 `captureDevice`。录到 0 帧时工具现在会直接说「delivered no frames」，而不是给一个空文件名。
- `latencyMs` 不写就找 `ANYAUDIO_MIDI_LATENCY_MS`，再没有就是 0，并给一条「跑 calibrate」的警告。

- **每次录硬件声部，起点是量出来的，不是填出来的**：渲染时会在音乐开始前 0.4 秒先发一个很短的测量音（力度 110、音高 84），它单独落在引子里；录音回来后在开头 1 秒内找到第一个声音的位置，按它把整条采集往前裁。所以 `latencyMs` 只是「测量音没回来时的兜底」，正常情况不用手填、也不用先跑 `calibrate`。回执里的 `alignMs` 是这次实际裁掉多少（含引子），拿它和 `latencyMs` 对一下就知道线有没有变。
- 测量音没回来时会警告 `the measuring note did not come back, so the take was trimmed by the latency setting`——这时要么模块静音/通道不对，要么 `latencyMs` 该重测。
- 想关掉自动对齐（比如你自己的宿主已经对齐过），写 `"hw": {"port": "…", "align": false}`。
- **为什么必须对齐**：MIDI 是立刻离开的，但「模块出声」到「录音流开始写」之间有一段固定滞后（实测 20–25 ms），它和 `latencyMs` 不是一回事。这段偏差在 120 BPM 下是 1/5 个十六分音符，硬件声部会整条听起来「拖」在人声或软件音源后面。
- 一个声部只能有一个音源：写了 `hw` 又写 `vst` 会被拒绝。
- **复音上限**：写进 `voices`（如 `"hw": {"port": "SD-20 PART A", "voices": 64}`），谱面同时发声数超过它时会给出警告——超出部分的音是静默消失的，不报错，所以这件事必须由消息说明，不能靠听。不写 `voices` 就只在同时超过 64 个音时提醒一次「上限未知」，别把 64 当成所有模块的常量。
- 硬件声部不占 SoundFont 的通道，也不会生成 bank/program 事件；全是硬件声部的谱子不需要装任何音色库。
- **实时代价**：插件和 SoundFont 是离线渲染（比实时快），硬件声部必须按谱面等它响完再录，所以一首 3 分钟、带硬件声部的曲子至少要多花 3 分钟，而且一次只能录一个硬件声部（多个硬件声部是顺序录的）。
- 设备不在线时的表现：端口找不到会报出候选列表；音源没开或 ASIO 独占时会录到静音并给出 `silent` 警告。

## 与画面对齐

- 音乐段落切换对齐分镜切换点，不要在小节中间硬切。
- 情绪转折处（角色决定、灾难、揭示）放重音或停止。
- 结尾留尾音自然收，不要突然截断（用 `tailSec` 或淡出）。
- 有旁白的段落音乐让位：旋律稀疏、音区避开人声中频（300Hz–3kHz），把厚度放在低音与高频。

## 混音（在工程里做）

平衡是在工程里调出来的：轨道音量、片段增益、淡入淡出都是工程数据，改完立刻能听。

- 音乐通常比旁白低 6–10dB，音效低 4–8dB，旁白 0dB。
- 看 `anyaudio_music` 返回的每个 score 轨道的 `rmsDb`：某条轨道比最响的低 12dB 以上会收到警告——**改那条轨上片段的增益**（一次 `update` 带多条 change 就能整轨一起动），不要去拉总线，也不要为了调平衡重新生成。
- 长片结尾留 2–3 秒淡出，用 `anyaudio_project mode:"update"` 改片段的 `fadeOutSec`。

**旁白压低音乐**：在音乐轨上加一个 `duck` 效果，`sourceTrackId` 指向旁白轨。工程渲染和剪辑台预览都会按它压低。

```json
{
  "tracks": [
    { "role": "narration", "path": ".anyaudio/out/narration.wav", "gainDb": 0 },
    { "role": "music", "path": ".anyaudio/out/score.wav", "gainDb": -6, "fadeInSec": 1.5, "fadeOutSec": 2.5 },
    { "role": "sfx", "path": ".anyaudio/out/sfx.wav", "gainDb": -4 }
  ],
  "durationSec": 84.5,
  "ducking": { "targetDb": -9, "thresholdDb": -42 },
  "video": "output/愚公移山.mp4",
  "videoOutput": "output/愚公移山-anyaudio.mp4"
}
```

要点：

- 任何 `role: "narration"` 的轨道会自动触发 ducking：旁白出现时其它轨道压低（默认最多 -9dB），旁白间隙恢复。没有旁白文件时可用 `videoAudio: "narration"` 从视频里提取。
- `durationSec` 必须等于视频时长，这是音频与画面同步的关键。
- 音乐通常 -6 到 -10dB，音效 -4 到 -8dB，旁白 0dB；峰值留给 master（默认 -1.5dBFS）。返回的 `tracks[].rmsDb` 是每轨实际电平：旁白与音乐的 RMS 差通常留 6–12dB；如果音乐太轻，先看是不是峰值归一（稀疏音乐峰值高、RMS 低），可以调高音乐增益或重渲染时传 `peakDb: null`。
- 淡入淡出用秒数，长片结尾至少 2–3s。
- 检查 `render` 返回的 `peakDb`；duck 压了多少，在剪辑台上听。
- 输出位置：`output` 只是额外的一份副本。真正被工程使用的那份永远在工程目录下，工具会把两个路径都报出来；不要假设插件会把文件写进 DSH 安装目录。

## 音效

`anyaudio_sfx` 有三级来源，**按顺序用，不要跳级**：

1. **本地音效库**（优先）：`{sound:"门-木门-敲门-三下-中等"}`
2. **线上 CC0**：本地没有时，`action:"search"` 会去 Freesound 找
3. **合成兜底**：`{preset:...}` 或 `{type:...}`，**必须在回复里说明「这是合成的」**

### ① 本地音效库（优先）

`anyaudio_sfx action:"catalog"` 列出优先包的全部名字，按动效 / 环境音 / 设计音效分组。普通包不展开，用 `action:"search"` 找。

**一个名字 = 一条录音，里面可能本来就含着几下。** `门-木门-敲门-三下-中等` 就是三下，不要当一下用。要更密更长就多摆几个片段错开，不是去库里找「五下」的素材。

**工具不会自己切分素材**，但你可以自己决定怎么用：

| 想做的事 | 怎么做 |
|---|---|
| 只用其中一下 | `inSec` / `outSec` 取那一段 |
| 让声音更厚 | 同一条素材错开几百毫秒叠两层 |
| 对齐画面 | 用 `inspect` 的 `peakPosSec`：`startSec = 动作时刻 − peakPosSec` |
| 调音量 | 片段的 `gainDb`，不是重新生成 |

`action:"inspect"` 会给出时长、主峰位置，动效与设计音效还附一张波形图——看它判断瞬态还是持续、单峰还是多峰、峰值在第几秒。**图只能佐证名字，不能推翻名字**：名字说「三下」而图上只有一个峰，说明这条素材有问题，报出来，不要将就。

### ② 线上 CC0

本地确实没有时，`action:"search"` 会去 Freesound 搜 CC0，返回 `freesound/<id>` 和 `previewUrl`。取用时把两个都传回去：

```json
{ "sound": "freesound/865364", "previewUrl": "https://cdn.freesound.org/...-hq.mp3", "startSec": 12.4 }
```

许可按筛选条件记 `CC0-1.0`，provenance 会写进素材档案。

### ③ 合成兜底（最后）

**① 默认库音效**：`{items:[{preset:"rain", startSec:0, durationSec:20, gainDb:-8}]}`。两套默认音源（GeneralUser GS、MuseScore General）里 GM 120–127 的音色就是音效库：鸟鸣、海岸、雨、雷、风、溪流、狗、马蹄、电话、门、风铃、汽车、警车、火车、飞机、掌声、笑声、尖叫、枪声、爆炸、脚步、心跳等，共 52 条。用 `anyaudio_sfx action:"catalog"` 看完整列表（带形态、起音、峰值）。要点：

- 一次性音效（枪声、爆炸、门、脚步、掌声短促版）不写 `durationSec`，会自然放完；持续床（雨、风、海岸、掌声、直升机）写 `durationSec` 决定铺多久，可以 `fadeInSec/fadeOutSec` 做进出。
- 峰值差很大（脚步 -29、爆炸 -17），不要默认全部 0dB，按画面主次给 `gainDb`；一般关键音效 -6~-10，床 -12~-20。
- 起音慢的音效（雨 3.1s、海岸 1.6s、直升机 3.9s）要提前进，别等画面切了才响。
- 需要变化时用 `note` 移调（C4=60 是原始音高），别把音效当乐器写旋律。
- 只认这两套默认库；用户自装的其他库里的音效不进入目录。缺音源时先 `anyaudio_sources` 安装。

目录速查（英文名即 `preset` 值；同一 program 下的中文名是别名）：

| 场景 | 音效 |
| --- | --- |
| 天气与水 | Seashore 海岸 · Rain 雨 · Thunder 雷 · Wind 风 · Stream 溪流 · Bubbles 气泡 · Howling Winds 呼啸风 · White Noise Wave 白噪浪 |
| 动物 | Birds 鸟鸣 · Bird 2 鸟叫 · Dog 狗吠 · Horse Gallop 马蹄 |
| 家居 | Telephone 1/2 电话 · Door 关门 · Door Creaking 门吱呀 · Scratch 刮擦 · Windchime 风铃 |
| 交通 | Helicopter 直升机 · Car-Engine 引擎 · Car-Stop 刹车 · Car-Pass 驶过 · Car-Crash 碰撞 · Siren 警笛 · Train 火车 · Jet Plane 飞机 · Starship 飞船 · Burst Noise 爆裂 |
| 人群与人声 | Applause 掌声 · Laughing 笑 · Scream 尖叫 · Punch 拳击 · Heart Beat 心跳 · Footsteps 脚步 |
| 武器与冲击 | Gun Shot 枪声 · Machine Gun 机枪 · Lasergun 激光 · Explosion 爆炸 · Interference 干扰 · Shooting Star 流星 |
| 拟音噪声 | Fret Noise 品丝摩擦 · Cut Noise 切断噪声 · String Slap 拍弦 · Breath Noise 气声 · Fl. Key Click 按键 · Filter Snap 滤波啪 |

MuseScore General 另有一组更响的版本（`sea-shore`、`bird-tweet`、`telephone`、`helicopter`、`applause`、`gun-shot`、`fret-noise`、`breath-noise`），需要在 `pan`/`gainDb` 上重新平衡。

**② 程序化音效**：`{type:"wind"}` 等 15 种（wind/rain/water/fire/birds/footsteps/stones/whoosh/impact/bell/gong/drum/riser/heartbeat/thunder），适合转场 whoosh、撞击、需要连续变化的氛围、以及目录里没有的声音（机械、魔法、卡通）。

- 音效服务画面事件：脚步跟脚步、落石跟落石、转场跟转场。
- 音效不要铺满；关键点之外保持干净。
- 环境底噪可以用低音量 `wind`/`rain` 或 `preset:"wind"` 轨道（role `ambience`），它同样会被 ducking 压低。

### 一种模式：每个音效都是一个片段

`anyaudio_sfx` 只产出素材：N 个 items 产出 **N 个各自从 t=0 开始的短文件**，外加一份 `manifest.json`（文件、类别、时长、峰值）。每个文件同时落成工程里的一个片段，位置由 items 的 `startSec` 决定；不写时间就依次排在同类别轨道的末尾。

它没有"把整段音效烤成一条"的模式了：那种产物里每个声音都没法单独挪动、单独调增益，正是剪辑台要避免的形状。需要更长的音床，就把同一段素材多摆几个片段——每个都能单独挪。

```json
{ "items": [
    { "preset": "rain", "startSec": 0, "durationSec": 30, "gainDb": -14 },
    { "type": "impact", "durationSec": 0.8, "params": { "weight": 0.8 }, "startSec": 12.4 }
  ],
  "output": ".anyaudio/out/sfx" }
```

要点：

- 每段必须有自己的 `durationSec`（程序化音效没有自然长度）；preset 的一次性音效不写就放完自然尾巴。
- 清单里的「类别」是 spec §5.2 的分轨依据：环境音 / 动效 / 其他。同类别时间重叠 → 另起一条轨；不重叠 → 合并到同一条。
- 每个文件的峰值单独报告，工具不会拿 `peakDb` 把各文件拉平——那样会改掉音效之间的相对关系。平衡在工程里用片段增益做。

## 验收清单

渲染/混音完成后自检，并把结果写进最终回复：

1. 文件时长与视频一致（误差 < 0.1s）。
2. `peakDb` 不超过 -1dBFS，没有削波；整体 RMS 大约 -20 到 -14dBFS。
3. 有旁白处音乐明显让位（看 `measuredDropDb`），旁白不被遮蔽。
4. 开头/结尾没有爆音或突然截断（淡入淡出、尾音）。
5. 至少试听开头、中段、高潮、结尾四个点（可用 ffmpeg 抽 5–10s 片段）。
6. 音频文件能被播放器打开（WAV 16bit PCM 48kHz 立体声）。

## 常见错误

- 只生成一条旋律轨，没有低音和铺底 → 单薄。
- 所有音符力度都是 90 → 没有强弱，像 MIDI 循环。
- 旁白段音乐不避让 → 听不清台词。
- 时长没对齐视频 → 结尾音画不同步。
- 用 numpy 手搓合成器代替真实音源 → 电子感。
- 自己写 Python/Node 调 edge-tts 生成旁白 → 绕过用户的 TTS 引擎与音色设置，MiMo 和 DeepSeek 永远用不上。
- 给 `deepseek` 传 `rate`/`pitch`/`volume` 想调语气 → 它没有这三个参数，传了只会换来一条 warning 和一段没变速的声音；要控节奏就换引擎。
- 只调 `anyaudio_music` 不看每轨电平 → 旋律把伴奏压没。电平每次调用都会返回，不用另测；看到不平衡就改片段增益。
- 扫弦只写下扫 → 不像人弹的；上下交替、有节奏型才是扫弦。
- **为了调音量把整首曲子重新生成** → 最贵也最常见的一个：音符一个没动、只改了一个数字，却把全部轨道重渲了一遍。改片段增益不重渲，改乐器音色才需要重新生成。
- 为了"专业"堆十几个轨道 → 浑浊，先做减法。
- 直接给一串文件路径当交付 → 用户拿到的是改不动的成品；先建工程再生成。

## 与视频整合

- 把画面交给工程：`anyaudio_project mode:"add_material"` 导入 MP4，它会抽出一条 `video-audio` 素材并自动落轨，工程从此有画面了。
- 插件不重编码视频：`anyaudio_project mode:"render"` 的 mux 用 `-c:v copy` 复制原视频流，只重编码音频为 AAC 192k。
- 没有 ffmpeg 时仍会输出 WAV，并提示手动 mux；也可以把 WAV 交给项目原有渲染流程（例如 imageio_ffmpeg）合并。
- 不要覆盖原视频；输出到新文件（例如 `<原名>-anyaudio.mp4`）。
