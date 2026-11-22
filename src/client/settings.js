/**
 * AnyAudio settings page.
 *
 * Registered into `settings.section`; every value is read from and written to
 * the plugin's own same-origin routes (/api/dsh-any-audio/*), which are backed by
 * one machine-wide config file — DSH's settings service is profile-scoped, so it
 * cannot be the source of truth.
 */
import { h, Fragment, useState, useEffect, useCallback, useMemo, C, S, bytes, Btn, Field, TextInput, NumberInput, Select, Switch, Notice, Card, HelpTip } from './ui.js'
import { t, jobFailure, detectLanguage, setLanguage, setLanguagePreference, language } from './i18n.js'
import { api } from './api.js'
import { BASE_PACK, DownloadLinks, VoicebankDownloadLinks, useVoicebankSources, installVoicebankZip } from './base-pack.js'

const GITHUB_URL = 'https://github.com/cloudoyx/any-audio'

function FontsTab({ state, reload, notify }) {
  const [job, setJob] = useState(null)
  const [busy, setBusy] = useState('')
  const [preview, setPreview] = useState(null)
  const [picker, setPicker] = useState(null)
  const [customPath, setCustomPath] = useState('')
  const [openDetails, setOpenDetails] = useState({})
  const [showRecommended, setShowRecommended] = useState(false)
  const toggleDetails = (key) => setOpenDetails(current => ({ ...current, [key]: !current[key] }))

  // The job lives on the host, not in this component: reopening the settings
  // page must pick up an install that is still running.
  useEffect(() => {
    let cancelled = false
    api('/jobs/active?kind=install')
      .then((data) => {
        if (!cancelled && data.job) setJob(data.job)
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    if (!job || job.status !== 'running') return undefined
    const timer = setInterval(async () => {
      try {
        const data = await api(`/jobs?id=${encodeURIComponent(job.id)}`)
        setJob(data.job)
        if (data.job.status === 'done') {
          notify(t('音源已安装'))
          await reload()
        }
        if (data.job.status === 'error') notify(jobFailure(data.job), 'error')
      } catch (error) {
        notify(error.message, 'error')
        setJob(null)
      }
    }, 700)
    return () => clearInterval(timer)
  }, [job, reload, notify])

  async function install(body) {
    setBusy(`install:${body.id || body.fromPath || 'custom'}`)
    try {
      const data = await api('/sources/install', { method: 'POST', body })
      setJob(data.job)
      notify(data.reused ? t('已有一个下载任务在进行') : t('开始下载，关掉设置页后仍会继续'))
    } catch (error) {
      notify(error.message, 'error')
    } finally {
      setBusy('')
    }
  }

  async function act(kind, body) {
    setBusy(`${kind}:${body.path}`)
    try {
      const data = await api(`/sources/${kind}`, { method: 'POST', body })
      if (kind === 'preview') setPreview(data)
      else {
        notify(kind === 'verify' ? (data.ok ? t('校验通过') : t('校验失败：文件与记录不一致')) : t('已处理'))
        await reload()
      }
    } catch (error) {
      notify(error.message, 'error')
    } finally {
      setBusy('')
    }
  }

  // Choosing the default bank had no control at all: the page only showed the
  // path a render would use, which is the fallback when nothing is configured —
  // so a person could read "默认音源：GeneralUser" and believe they had chosen it
  // while every tool still reported "not set" (improvement plan 04).
  async function setDefault(font) {
    const value = font.recommendedId || font.path
    setBusy(`default:${font.path}`)
    try {
      await api('/config', { method: 'POST', body: { patch: { music: { font: value } } } })
      notify(t('已设为默认音源'))
      await reload()
    } catch (error) {
      notify(error.message, 'error')
    } finally {
      setBusy('')
    }
  }

  // The bank a render actually lands on, not the one that was chosen: with
  // nothing chosen the host picks one, and the page has to say which. Comparing
  // against `configured` left every row unmarked until someone pressed the
  // button, which is exactly the question "which one is the default?".
  const isDefault = (font) => Boolean(fonts.defaultPath) && fonts.defaultPath === font.path

  async function runPreview(path, program) {
    setBusy(`preview:${path}:${program}`)
    try {
      const data = await api('/sources/preview', { method: 'POST', body: { path, program } })
      setPreview(data)
    } catch (error) {
      notify(error.message, 'error')
    } finally {
      setBusy('')
    }
  }

  async function openPreview(path) {
    setBusy(`presets:${path}`)
    try {
      const data = await api(`/sources/presets?path=${encodeURIComponent(path)}`)
      const list = data.presets || []
      if (list.length === 0) {
        notify(t('这个音源没有可试听的旋律预设'), 'error')
        return
      }
      setPicker({ path, presets: list, program: list[0].program })
      await runPreview(path, list[0].program)
    } catch (error) {
      notify(error.message, 'error')
    } finally {
      setBusy('')
    }
  }

  function selectProgram(program) {
    if (!picker) return
    setPicker({ ...picker, program })
    void runPreview(picker.path, program)
  }

  const fonts = state.fonts
  // A single-instrument bank (e.g. Electric Guitar Clean) is published only as
  // a 7z archive, so there is no URL the installer could fetch: point the
  // button at the release page instead of offering a download that always fails.
  const libraryDir = fonts.libraryDir || fonts.directories?.[0] || ''
  const percent = job && job.total ? (job.received / job.total) * 100 : 0
  const installing = Boolean(job && job.status === 'running')
  // A recommendation is an offer, not a catalogue: once the bank is installed it
  // belongs in the list below, and leaving it here only pushes the ones the
  // person can still add further down the page.
  const missingRecommended = fonts.available.filter(font => !fonts.rows.some(row => row.recommendedId === font.id))
  const allRecommendedInstalled = fonts.available.length > 0 && missingRecommended.length === 0
  const recommendedShown = showRecommended ? fonts.available : missingRecommended

  return h(Fragment, null,
    h(Card, {
      title: t('推荐音源'),
      desc: t('作者精选。既有通用音源，也有专攻一种乐器的特色音源。'),
      right: h(Btn, { onClick: reload }, t('刷新')),
    },
      job ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
        h('div', { style: { ...S.row, justifyContent: 'space-between' } },
          h('span', { style: S.label }, job.status === 'running' ? `${t('正在安装')}${job.label ? ` ${job.label}` : ''}${job.total ? ` ${Math.round(percent)}%` : ''}` : job.status === 'done' ? t('完成：{0}', job.message || t('已安装')) : t('失败：{0}', jobFailure(job))),
          job.total ? h('span', { style: S.mono }, `${bytes(job.received)} / ${bytes(job.total)}`) : null,
        ),
        h('div', { style: S.bar }, h('div', { style: S.barFill(percent) })),
      ) : null,
      allRecommendedInstalled && !showRecommended
        ? h('div', { style: S.row },
          h('span', { style: S.desc }, t('推荐音源已全部安装')),
          h(Btn, { onClick: () => setShowRecommended(true) }, t('查看')),
        )
        : h('div', { style: S.list },
          recommendedShown.map(font => {
            const installed = fonts.rows.find(row => row.recommendedId === font.id)
            const key = `rec:${font.id}`
            const open = Boolean(openDetails[key])
            return h('div', { key: font.id, style: S.item },
              h('div', { style: S.itemHead },
                h('span', { style: { fontWeight: 600 } }, font.name),
                h('span', { style: S.mono }, bytes(font.bytes)),
                h('span', { style: S.chip }, installed ? t('已安装') : t('未安装')),
                font.default ? h('span', { style: S.chip }, t('默认')) : null,
                h('span', { style: { flex: 1 } }),
                installed ? null : font.url
                  ? h(Btn, { kind: 'primary', disabled: installing || busy === `install:${font.id}`, onClick: () => install({ id: font.id }) }, t('下载安装'))
                  : font.manual
                    ? h(Btn, { kind: 'primary', onClick: () => window.open(font.manual, '_blank', 'noopener,noreferrer') }, t('下载'))
                    : null,
                h(Btn, { onClick: () => toggleDetails(key) }, open ? t('收起') : t('详情')),
              ),
              font.tagline ? h('div', { style: S.desc }, t(font.tagline)) : null,
              open ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 2 } },
                h('div', { style: S.mono }, t('许可证：{0}', font.license)),
                font.manual ? h('div', { style: S.mono }, t('手动下载：{0}', font.manual)) : null,
                font.manual ? h('div', { style: S.mono }, t('安装说明：解压后把 .sf2 放到 {0}，文件名保持 {1}', libraryDir || t('未设置'), font.file)) : null,
                installed?.sha256 ? h('div', { style: S.mono }, t('SHA-256：{0}…（{1}）', installed.sha256.slice(0, 24), installed.status === 'ok' ? t('记录一致') : t('与记录不一致'))) : null,
              ) : null,
            )
          }),
        ),
    ),
    h(Card, { title: t('已安装'), desc: t('这些音源已经在这台机器上，可以直接用。') },
      preview ? h('div', { style: { ...S.item } },
        h('div', { style: S.itemHead }, h('span', null, t('试听：{0}', preview.label)), h('span', { style: S.mono }, `${preview.durationSec}s · ${preview.peakDb} dBFS`)),
        picker && picker.presets.length > 1
          ? h('div', { style: S.row },
            h('span', { style: S.label }, t('预设')),
            h(Select, {
              value: String(picker.program),
              onChange: value => selectProgram(Number(value)),
              options: picker.presets.map(preset => ({
                value: String(preset.program),
                label: `${preset.program} · ${preset.name} (${preset.family})`,
              })),
            }),
          )
          : null,
        h('audio', { controls: true, autoPlay: true, src: preview.url, style: S.audio }),
      ) : null,
      fonts.rows.length === 0
        ? h('p', { style: S.desc }, t('还没有安装任何音源。从上面的推荐里挑一套，或在下面按文件安装。'))
        : h('div', { style: S.list }, fonts.rows.map(row => {
          const recommended = fonts.available.find(font => font.id === row.recommendedId)
          const label = recommended?.name ?? row.name
          const open = Boolean(openDetails[row.path])
          return h('div', { key: row.path, style: S.item },
            h('div', { style: S.itemHead },
              h('span', { style: { fontWeight: 600 } }, label),
              h('span', { style: S.mono }, bytes(row.bytes)),
              isDefault(row) ? h('span', { style: S.chip }, t('当前默认')) : null,
              row.status === 'ok' ? null : h('span', { style: S.chip }, row.status === 'modified' ? t('文件被修改') : t('已安装（未登记）')),
              h('span', { style: { flex: 1 } }),
              h(Btn, { onClick: () => openPreview(row.path) }, t('试听')),
              // No button on the row that already is the default: a control that
              // does nothing is worse than no control.
              isDefault(row) ? null : h(Btn, { onClick: () => setDefault(row) }, t('设为默认')),
              h(Btn, { onClick: () => { if (window.confirm(t('删除 {0} 的文件？\n\n之后需要重新下载才能使用。', label))) act('remove', { path: row.path, removeFile: true }) } }, t('删除')),
              h(Btn, { onClick: () => toggleDetails(row.path) }, open ? t('收起') : t('详情')),
            ),
            recommended?.tagline ? h('div', { style: S.desc }, t(recommended.tagline)) : null,
            open ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
              h('div', { style: S.mono }, row.path),
              row.sha256 ? h('div', { style: S.mono }, t('SHA-256：{0}…（{1}）', row.sha256.slice(0, 24), row.status === 'ok' ? t('记录一致') : t('与记录不一致'))) : null,
              h('div', { style: S.row }, h(Btn, { onClick: () => act('verify', { path: row.path }) }, t('校验'))),
            ) : null,
          )
        })),
    ),
    h(Card, { title: t('安装音源'), desc: t('填一个 .sf2 / .sf3 / .dls 文件的路径。7z / zip 请先解压。') },
      h('div', { style: S.row },
        h(TextInput, { value: customPath, onChange: setCustomPath, placeholder: t('粘贴文件路径') }),
        h(Btn, { disabled: !customPath.trim() || installing || busy.startsWith('install:'), onClick: () => install({ fromPath: customPath.trim() }) }, t('安装')),
      ),
    ),
    h(Card, { title: t('音源目录'), desc: t('整台机器共用这一个音源库；环境变量 ANYAUDIO_FONTS 可以追加目录。') },
      h('div', { style: S.mono }, fonts.directories.join('\n')),
      // "默认音源" used to show the path a render would land on, which is the
      // fallback when nothing was chosen. Naming both makes "did I set one?"
      // answerable from this page (improvement plan 04).
      h('div', { style: S.desc }, fonts.configured
        ? t('你选的默认音源：{0}', fonts.configured)
        : t('默认音源：{0}（自动选择）', fonts.defaultPath || t('未安装音源'))),
    ),
    h('div', { style: S.desc }, t('插件目录、插件预设、外部音源都搬到了「插件与音源」这一页；这一页只剩 SoundFont 音源。')),
  )
}

/**
 * Extra VST3 folders. The standard folders are always searched, so this card only
 * holds the person's own trees - a portable install on another drive, a plugin
 * that unpacks somewhere unusual. Empty means "just the standard folders".
 */
function VstDirsCard({ state, reload, notify }) {
  const dirs = state?.config?.sources?.vstDirs ?? []
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [library, setLibrary] = useState(null)
  const [probing, setProbing] = useState(false)
  const [probed, setProbed] = useState({})

  const loadLibrary = useCallback(async () => {
    try {
      setLibrary(await api('/vst/plugins'))
    } catch (error) {
      notify(error.message, 'error')
    }
  }, [notify])

  useEffect(() => { void loadLibrary() }, [loadLibrary, dirs.join('|')])

  async function save(next) {
    setBusy(true)
    try {
      await api('/config', { method: 'POST', body: { patch: { sources: { vstDirs: next } } } })
      notify(t('VST 目录已保存'))
      await reload()
    } catch (error) {
      notify(error.message, 'error')
    } finally {
      setBusy(false)
    }
  }

  const add = () => {
    const value = draft.trim()
    if (!value) return
    if (dirs.some(dir => dir.toLowerCase() === value.toLowerCase())) {
      notify(t('这个目录已经在列表里了'), 'error')
      return
    }
    setDraft('')
    void save([...dirs, value])
  }

  // Loading the plugin is the only way to learn who made it and whether it is
  // an instrument, so this is a deliberate button rather than part of the scan:
  // a plugin that opens a licence window costs one timeout each.
  const probe = async () => {
    const paths = (library?.plugins ?? []).map(entry => entry.path)
    if (!paths.length) return
    setProbing(true)
    try {
      const reply = await api('/vst/probe', { method: 'POST', body: { paths } })
      const next = {}
      for (const row of reply.plugins ?? []) next[row.path] = row
      setProbed(next)
      const failed = (reply.plugins ?? []).filter(row => !row.ok).length
      notify(failed ? t('已探测 {0} 个，{1} 个没有应答', paths.length, failed) : t('已探测 {0} 个插件', paths.length))
    } catch (error) {
      notify(error.message, 'error')
    } finally {
      setProbing(false)
    }
  }

  const rows = library?.plugins ?? []
  const legacy = library?.legacy32 ?? []
  const formatLabel = (plugin) => {
    const probedRow = probed[plugin.path]
    const kind = probedRow?.ok
      ? (probedRow.instrument ? t('合成器') : t('效果器'))
      : (plugin.category === 'instrument' ? t('合成器') : plugin.category === 'effect' ? t('效果器') : '')
    const vendor = probedRow?.ok ? probedRow.vendor : plugin.vendor
    const format = plugin.format === 'vst2' ? 'VST2' : 'VST3'
    return [format, kind, vendor].filter(Boolean).join(' · ')
  }

  return h(Card, {
    title: t('VST 插件目录'),
    desc: t('除了标准目录，还要去哪里找 VST3 与 64 位 VST2 乐器。可以加多条；每条会在扫描时和标准目录一起看。'),
    right: h(Btn, { disabled: probing || !rows.length, onClick: () => void probe() }, probing ? t('探测中…') : t('探测类型')),
  },
    dirs.length
      ? h('div', { style: S.list }, dirs.map((dir, index) => h('div', { style: { ...S.row, justifyContent: 'space-between' } },
        h('span', { style: S.mono }, dir),
        h(Btn, { disabled: busy, onClick: () => void save(dirs.filter((_, i) => i !== index)) }, t('删除')),
      )))
      : h('div', { style: S.desc }, t('还没有额外的目录。')),
    h('div', { style: S.row },
      h(TextInput, { value: draft, onChange: setDraft, placeholder: t('例如 D:\\\\VST3') }),
      h(Btn, { disabled: busy || !draft.trim(), onClick: add }, t('添加')),
    ),
    h('div', { style: { ...S.label, marginTop: 12 } }, t('扫到的插件（{0}）', rows.length)),
    rows.length
      ? h('div', { style: S.list }, rows.map(plugin => h('div', { style: { ...S.row, justifyContent: 'space-between' } },
        h('div', { style: { minWidth: 0 } },
          h('div', { style: { ...S.mono, overflow: 'hidden', textOverflow: 'ellipsis' } }, plugin.name),
          h('div', { style: S.desc }, formatLabel(plugin)),
        ),
        h('span', { style: S.desc }, plugin.bytes ? bytes(plugin.bytes) : ''),
      )))
      : h('div', { style: S.desc }, library ? t('这些目录里还没有插件。') : t('正在扫描…')),
    legacy.length
      ? h('div', { style: { ...S.desc, marginTop: 8 } },
        t('另有 {0} 个 32 位 VST2 插件：64 位宿主无法加载，需要桥接后才能用。', legacy.length),
        ' ',
        h('span', { style: S.mono }, legacy.slice(0, 6).map(row => row.name).join('、')),
      )
      : null,
  )
}

/**
 * Named hardware rigs: a MIDI port paired with the audio input that hears the
 * module. Once named here, a score can say hw: "SD-20" and the port, the input
 * and the measured latency arrive together. `voices` is the module's polyphony,
 * which the renderer uses to warn when a chord asks for more notes than it has.
 */
/**
 * Presets the plugin's own window saved. An agent cannot turn a knob that a
 * plugin keeps to itself, so the person tunes the sound in their host, saves
 * it, and a score names that file instead. Grouped by plugin on purpose: two
 * plugins both offer "Bright Piano", and a flat list would blur them together.
 */
function PresetLibraryCard({ notify }) {
  const [data, setData] = useState(null)
  const [busy, setBusy] = useState('')

  const load = useCallback(async () => {
    try {
      setData(await api('/vst/presets'))
    } catch (error) {
      notify(error.message, 'error')
    }
  }, [notify])

  useEffect(() => { void load() }, [load])

  const registered = data?.registered?.presets ?? []
  const scanned = data?.scanned?.files ?? []
  const taken = new Set(registered.filter(row => row.state?.path).map(row => String(row.state.path).toLowerCase()))

  const groups = useMemo(() => {
    const out = new Map()
    const push = (key, row) => {
      if (!out.has(key)) out.set(key, [])
      out.get(key).push(row)
    }
    for (const row of registered) push(row.pluginName || t('未标明插件'), { kind: 'registered', row })
    for (const row of scanned) {
      if (taken.has(String(row.file).toLowerCase())) continue
      const label = row.plugin || t('未标明插件')
      push(row.vendor ? `${label} · ${row.vendor}` : label, { kind: 'scanned', row })
    }
    return [...out.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  }, [registered, scanned, data])

  // A file the plugin window saved is already a sound; importing it only names
  // it so a score can point at it. Two files called "Bright Piano" under the
  // same plugin need distinct names, so the second becomes "Bright Piano 2".
  const doImport = async (row) => {
    const base = row.name || 'preset'
    const used = registered.filter(other => String(other.name).toLowerCase().startsWith(base.toLowerCase())).length
    const name = used ? `${base} ${used + 1}` : base
    setBusy(row.file)
    try {
      await api('/vst/presets/import', {
        method: 'POST',
        body: { name, file: row.file, plugin: row.plugin || '', note: t('从宿主留下的预设文件导入') },
      })
      notify(t('已登记预设「{0}」', name))
      await load()
    } catch (error) {
      notify(error.message, 'error')
    } finally {
      setBusy('')
    }
  }

  const describe = (entry) => {
    if (entry.kind === 'registered') {
      const format = entry.row.state?.format ? String(entry.row.state.format).toUpperCase() : t('参数')
      return [format, entry.row.note].filter(Boolean).join(' · ')
    }
    return `${String(entry.row.format ?? '').toUpperCase()} · ${t('未登记')}`
  }

  return h(Card, {
    title: t('插件预设'),
    desc: t('插件窗口里调好、另存出来的音色文件。按插件分组；Agent 写谱时只写预设名字，文件原样交给插件。'),
    right: h(Btn, { onClick: () => void load() }, t('重新扫描')),
  },
    !data
      ? h('div', { style: S.desc }, t('正在扫描…'))
      : groups.length === 0
        ? h('div', { style: S.desc }, t('没有找到预设文件。在宿主里另存一个 .vstpreset 或 .fxp 即可。'))
        : h('div', { style: S.list }, groups.map(([label, rows]) => h('div', { key: label, style: { marginBottom: 10 } },
          h('div', { style: S.label }, t('{0}（{1}）', label, rows.length)),
          rows.map((entry, index) => h('div', { key: `${label}-${index}`, style: { ...S.row, justifyContent: 'space-between' } },
            h('div', { style: { minWidth: 0 } },
              h('div', { style: { ...S.mono, overflow: 'hidden', textOverflow: 'ellipsis' } }, entry.row.name),
              h('div', { style: S.desc }, describe(entry)),
            ),
            entry.kind === 'registered'
              ? h('span', { style: S.desc }, t('可用'))
              : h(Btn, { disabled: busy === entry.row.file, onClick: () => void doImport(entry.row) }, busy === entry.row.file ? t('导入中…') : t('导入')),
          )),
        ))),
    data?.scanned?.truncated
      ? h('div', { style: { ...S.desc, marginTop: 6 } }, t('文件太多，只列出了前面一部分。'))
      : null,
  )
}

function ExternalRigsCard({ state, reload, notify }) {
  const rigs = state?.config?.sources?.external ?? []
  const [draft, setDraft] = useState({ name: '', port: '', device: '', latencyMs: '', voices: '' })
  const [busy, setBusy] = useState(false)
  const [manual, setManual] = useState(null)
  const [savingManual, setSavingManual] = useState(false)
  const [manualImportPath, setManualImportPath] = useState('')
  const [importingManual, setImportingManual] = useState(false)

  async function save(next) {
    setBusy(true)
    try {
      await api('/config', { method: 'POST', body: { patch: { sources: { external: next } } } })
      notify(t('外部音源已保存'))
      await reload()
    } catch (error) {
      notify(error.message, 'error')
    } finally {
      setBusy('')
    }
  }

  const set = (key, value) => setDraft(current => ({ ...current, [key]: value }))

  // Notes about the module, so an agent composing for it does not have to guess
  // which program is the Rhodes or which controller this one ignores.
  const openManual = async (name) => {
    try {
      const reply = await api(`/manuals/read?name=${encodeURIComponent(name)}`)
      setManual({ name, text: reply.text ?? '', exists: reply.text !== null })
    } catch (error) {
      notify(error.message, 'error')
    }
  }

  const saveManualText = async () => {
    setSavingManual(true)
    try {
      await api('/manuals/save', { method: 'POST', body: { name: manual.name, text: manual.text } })
      notify(t('说明书已保存'))
      setManual(current => ({ ...current, exists: true }))
    } catch (error) {
      notify(error.message, 'error')
    } finally {
      setSavingManual(false)
    }
  }

  // A manual usually arrives as a PDF, or as a folder of one-page HTML files
  // from a manufacturer site. Read it in one go instead of asking the person to
  // paste pages one by one.
  const importManual = async () => {
    const source = manualImportPath.trim()
    if (!source) return
    setImportingManual(true)
    try {
      const reply = await api('/manuals/import', { method: 'POST', body: { name: manual.name, path: source } })
      setManual(current => ({ ...current, text: reply.text ?? '', exists: true }))
      setManualImportPath('')
      const notes = []
      if (reply.read !== reply.files) notes.push(t('读到 {0} / {1} 个文件', reply.read, reply.files))
      if (reply.truncated) notes.push(t('内容过长，已截断'))
      notify(t('已导入说明书（{0} 字符）{1}', reply.chars ?? 0, notes.length ? '；' + notes.join('；') : ''))
    } catch (error) {
      notify(error.message, 'error')
    } finally {
      setImportingManual(false)
    }
  }

  const add = () => {
    const name = draft.name.trim()
    const port = draft.port.trim()
    if (!name || !port) {
      notify(t('名字和 MIDI 端口都要填'), 'error')
      return
    }
    if (rigs.some(rig => rig.name.toLowerCase() === name.toLowerCase())) {
      notify(t('已经有同名的外部音源了'), 'error')
      return
    }
    const latency = Number(draft.latencyMs)
    const voices = Number(draft.voices)
    setDraft({ name: '', port: '', device: '', latencyMs: '', voices: '' })
    void save([...rigs, {
      name,
      port,
      ...(draft.device.trim() ? { device: draft.device.trim() } : {}),
      ...(Number.isFinite(latency) && latency >= 0 ? { latencyMs: latency } : {}),
      ...(Number.isFinite(voices) && voices > 0 ? { voices: Math.round(voices) } : {}),
    }])
  }

  return h(Card, {
    title: t('外部音源'),
    desc: t('一台硬件音源：音符从哪个 MIDI 端口出去，声音从哪个音频输入回来。登记后，乐谱里可以直接写 hw: "名字"。'),
  },
    rigs.length
      ? h('div', { style: S.list }, rigs.map((rig, index) => h('div', { style: { ...S.row, justifyContent: 'space-between' } },
        h('div', { style: { display: 'flex', flexDirection: 'column', gap: 2 } },
          h('span', { style: S.label }, rig.name),
          h('span', { style: S.mono }, [
            t('端口 {0}', rig.port),
            rig.device ? t('输入 {0}', rig.device) : t('未填输入'),
            Number.isFinite(rig.latencyMs) ? `${rig.latencyMs} ms` : t('未标延迟'),
            Number.isFinite(rig.voices) ? t('{0} 复音', rig.voices) : t('未标复音'),
          ].join(' · ')),
        ),
        h(Btn, { disabled: Boolean(busy), onClick: () => void openManual(rig.name) }, t('说明书')),
        h(Btn, { disabled: Boolean(busy), onClick: () => void save(rigs.filter((_, i) => i !== index)) }, t('删除')),
      )))
      : h('div', { style: S.desc }, t('还没有登记外部音源。填一个名字、端口和输入就能用。')),
    h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
      h('div', { style: S.row },
        h(TextInput, { value: draft.name, onChange: value => set('name', value), placeholder: t('名字，例如 SD-20') }),
        h(TextInput, { value: draft.port, onChange: value => set('port', value), placeholder: t('MIDI 端口，例如 SD-20 PART A') }),
      ),
      h('div', { style: S.row },
        h(TextInput, { value: draft.device, onChange: value => set('device', value), placeholder: t('音频输入（可留空）') }),
        h(TextInput, { value: draft.latencyMs, onChange: value => set('latencyMs', value), placeholder: t('延迟 ms（可留空）') }),
        h(TextInput, { value: draft.voices, onChange: value => set('voices', value), placeholder: t('复音数（可留空）') }),
      ),
      h('div', { style: S.row }, h(Btn, { disabled: Boolean(busy), onClick: add }, t('添加外部音源'))),
    ),
    manual
      ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6, marginTop: 12 } },
        h('div', { style: S.label }, t('{0} 的说明书', manual.name)),
        h('div', { style: S.desc }, t('这台音源怎么用：音色号是什么、哪些控制器有效、有什么雷区。Agent 给这个音源写声部前会先读它。')),
        h('div', { style: S.row },
          h(TextInput, {
            value: manualImportPath,
            placeholder: t('说明书文件或文件夹，如 D:\\manuals\\SD-20.pdf'),
            onChange: value => setManualImportPath(value),
            style: { flex: 1 },
          }),
          h(Btn, { disabled: importingManual || !manualImportPath.trim(), onClick: () => void importManual() },
            importingManual ? t('读取中…') : t('从文件/文件夹导入')),
        ),
        h('div', { style: S.desc }, t('支持 .txt .md .pdf .docx .html .mhtml；给一个文件夹会把里面的手册合并成一篇。')),
        h('textarea', {
          value: manual.text,
          onChange: event => setManual(current => ({ ...current, text: event.target.value })),
          placeholder: t('例如：PART A 的 program 0 是 Concert Piano，44 是 Strings；不响应 CC64 延音踏板；复音 64。'),
          style: { minHeight: 150, width: '100%', boxSizing: 'border-box', fontFamily: 'inherit', fontSize: 13, padding: 8 },
        }),
        h('div', { style: S.row },
          h(Btn, { disabled: savingManual || !manual.text.trim(), onClick: () => void saveManualText() }, savingManual ? t('保存中…') : t('保存说明书')),
          h(Btn, { disabled: savingManual, onClick: () => setManual(null) }, t('关闭')),
        ),
      )
      : null,
  )
}

/**
 * The notes a plugin or a module needs before an agent can write for it: which
 * program is the Rhodes, which controller is ignored, where the licence window
 * appears. One editor, two owners.
 */
function ManualEditor({ name, notify, onClose }) {
  const [text, setText] = useState('')
  const [exists, setExists] = useState(false)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [importing, setImporting] = useState(false)
  const [source, setSource] = useState('')

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    api(`/manuals/read?name=${encodeURIComponent(name)}`)
      .then((reply) => {
        if (cancelled) return
        setText(reply.text ?? '')
        setExists(Boolean(reply.exists))
      })
      .catch((error) => notify(error.message, 'error'))
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [name, notify])

  const save = async () => {
    setSaving(true)
    try {
      await api('/manuals/save', { method: 'POST', body: { name, text } })
      setExists(true)
      notify(t('说明书已保存'))
    } catch (error) {
      notify(error.message, 'error')
    } finally {
      setSaving(false)
    }
  }

  const importFrom = async () => {
    const path = source.trim()
    if (!path) return
    setImporting(true)
    try {
      const reply = await api('/manuals/import', { method: 'POST', body: { name, path } })
      setText(reply.text ?? '')
      setExists(true)
      setSource('')
      const notes = []
      if (reply.read !== reply.files) notes.push(t('读到 {0} / {1} 个文件', reply.read, reply.files))
      if (reply.truncated) notes.push(t('内容过长，已截断'))
      notify(t('已导入说明书（{0} 字符）{1}', reply.chars ?? 0, notes.length ? '；' + notes.join('；') : ''))
    } catch (error) {
      notify(error.message, 'error')
    } finally {
      setImporting(false)
    }
  }

  const remove = async () => {
    if (!window.confirm(t('删除「{0}」的说明书？', name))) return
    try {
      await api('/manuals/remove', { method: 'POST', body: { name } })
      setText('')
      setExists(false)
      notify(t('说明书已删除'))
    } catch (error) {
      notify(error.message, 'error')
    }
  }

  return h(Card, {
    title: t('{0} 的说明书', name),
    desc: t('这个音源怎么用：音色号、控制器、雷区。Agent 写声部之前会先读它。'),
    right: onClose ? h(Btn, { onClick: onClose }, t('关闭')) : null,
  },
    h('div', { style: S.row },
      h(TextInput, {
        value: source,
        placeholder: t('说明书文件或文件夹，如 D:\\manuals\\SD-20.pdf'),
        onChange: value => setSource(value),
        style: { flex: 1 },
      }),
      h(Btn, { disabled: importing || !source.trim(), onClick: () => void importFrom() }, importing ? t('读取中…') : t('从文件/文件夹导入')),
    ),
    h('div', { style: S.desc }, t('支持 .txt .md .pdf .docx .html .mhtml；给一个文件夹会把里面的手册合并成一篇。')),
    loading
      ? h('div', { style: S.desc }, t('正在读取…'))
      : h('textarea', {
        value: text,
        onChange: event => setText(event.target.value),
        placeholder: t('例如：program 0 是 Concert Piano，44 是 Strings；不响应 CC64；复音 64。'),
        style: { minHeight: 180, width: '100%', boxSizing: 'border-box', fontFamily: 'inherit', fontSize: 13, padding: 8 },
      }),
    h('div', { style: S.row },
      h(Btn, { disabled: saving || loading || !text.trim(), onClick: () => void save() }, saving ? t('保存中…') : t('保存说明书')),
      exists ? h(Btn, { disabled: saving, onClick: () => void remove() }, t('删除')) : null,
    ),
  )
}

/**
 * One plugin at a time. The list of sixty instruments is a directory, not a
 * form: pick one and everything that belongs to it — the presets its window
 * saved, the notes someone wrote about it — appears underneath. A flat list of
 * every preset on the machine was the reason this page got long.
 */
function PluginWorkbench({ notify }) {
  const [library, setLibrary] = useState(null)
  const [presets, setPresets] = useState(null)
  const [chosen, setChosen] = useState('')
  const [busy, setBusy] = useState('')
  const [manual, setManual] = useState(null)
  const [importPath, setImportPath] = useState('')

  const load = useCallback(async () => {
    try {
      const [lib, pre] = await Promise.all([api('/vst/plugins'), api('/vst/presets')])
      setLibrary(lib)
      setPresets(pre)
    } catch (error) {
      notify(error.message, 'error')
    }
  }, [notify])

  useEffect(() => { void load() }, [load])

  const plugins = useMemo(() => {
    const rows = [...(library?.plugins ?? [])]
    rows.sort((a, b) => String(a.name).localeCompare(String(b.name)))
    return rows
  }, [library])
  const chosenRow = plugins.find(row => row.path === chosen) || null

  const registered = useMemo(() => {
    const rows = presets?.registered?.presets ?? []
    if (!chosenRow) return rows
    return rows.filter(row => row.plugin === chosenRow.path || (chosenRow.name && String(row.pluginName || '').startsWith(chosenRow.name)))
  }, [presets, chosenRow])

  const scanned = useMemo(() => {
    if (!chosenRow) return []
    const name = String(chosenRow.name || '').toLowerCase()
    const taken = new Set(registered.filter(row => row.state?.path).map(row => String(row.state.path).toLowerCase()))
    return (presets?.scanned?.files ?? []).filter(row => {
      if (taken.has(String(row.file).toLowerCase())) return false
      const plugin = String(row.plugin || '').toLowerCase()
      return plugin && name && (plugin === name || plugin.includes(name) || name.includes(plugin))
    })
  }, [presets, chosenRow, registered])

  const doImport = async (row) => {
    const base = row.name || 'preset'
    const used = registered.filter(other => String(other.name).toLowerCase().startsWith(base.toLowerCase())).length
    const name = used ? `${base} ${used + 1}` : base
    setBusy(row.file)
    try {
      await api('/vst/presets/import', {
        method: 'POST',
        body: { name, file: row.file, plugin: chosenRow.path, note: t('从宿主留下的预设文件导入') },
      })
      notify(t('已登记预设「{0}」', name))
      await load()
    } catch (error) {
      notify(error.message, 'error')
    } finally {
      setBusy('')
    }
  }

  // A preset the plugin's own window saved (or a .fxp from another install) is
  // a file somewhere on disk; the list above only shows what the scan found.
  const importFile = async () => {
    const file = importPath.trim()
    if (!file || !chosenRow) return
    const base = (file.split(/[\\/]/).pop() || 'preset').replace(/\.[^.]+$/, '')
    setBusy('file')
    try {
      await api('/vst/presets/import', {
        method: 'POST',
        body: { name: base, file, plugin: chosenRow.path, note: t('从文件导入') },
      })
      notify(t('已登记预设「{0}」', base))
      setImportPath('')
      await load()
    } catch (error) {
      notify(error.message, 'error')
    } finally {
      setBusy('')
    }
  }

  if (!library) return h(Card, { title: t('插件') }, h('div', { style: S.desc }, t('正在扫描插件…')))

  return [
    h(Card, {
      title: t('插件'),
      desc: t('{0} 个插件。选一个，看它的预设与说明书；VST3 与 64 位 VST2 都能渲染。', plugins.length),
      right: h(Btn, { onClick: () => void load() }, t('重新扫描')),
    },
      plugins.length === 0
        ? h('div', { style: S.desc }, t('没有扫到插件。在「VST 目录」里加一条，标准目录也会自动搜索。'))
        : h('select', {
          value: chosen,
          onChange: event => { setChosen(event.target.value); setManual(null) },
          style: { width: '100%', padding: '6px 8px', fontFamily: 'inherit', fontSize: 13 },
        },
          h('option', { value: '' }, t('选择插件…')),
          plugins.map(row => h('option', { key: row.path, value: row.path },
            `${row.name} · ${String(row.format || '').toUpperCase()}${row.category ? ` · ${row.category === 'instrument' ? t('合成器') : t('效果器')}` : ''}${row.vendor ? ` · ${row.vendor}` : ''}`)),
        ),
      library?.legacy32?.length
        ? h('div', { style: { ...S.desc, marginTop: 6 } }, t('另有 {0} 个 32 位插件，64 位宿主加载不了，需要用桥接。', library.legacy32.length))
        : null,
    ),
    chosenRow
      ? h(Card, {
        title: t('{0} 的预设', chosenRow.name),
        desc: t('Agent 在乐谱里只写预设名字，插件自己按文件加载音色。'),
        right: h(Btn, { onClick: () => setManual(chosenRow.name) }, t('说明书')),
      },
        registered.length || scanned.length
          ? h('div', { style: S.list },
            registered.map(row => h('div', { key: `r-${row.id}`, style: { ...S.row, justifyContent: 'space-between' } },
              h('div', { style: { minWidth: 0 } },
                h('div', { style: { ...S.mono, overflow: 'hidden', textOverflow: 'ellipsis' } }, row.name),
                h('div', { style: S.desc }, [row.state?.format ? String(row.state.format).toUpperCase() : t('参数卡'), row.note].filter(Boolean).join(' · ')),
              ),
              h('span', { style: S.desc }, 'vst: {preset:"' + row.name + '"}'),
            )),
            scanned.map(row => h('div', { key: `s-${row.file}`, style: { ...S.row, justifyContent: 'space-between' } },
              h('div', { style: { minWidth: 0 } },
                h('div', { style: { ...S.mono, overflow: 'hidden', textOverflow: 'ellipsis' } }, row.name),
                h('div', { style: S.desc }, `${String(row.format || '').toUpperCase()} · ${t('未登记')}`),
              ),
              h(Btn, { disabled: busy === row.file, onClick: () => void doImport(row) }, busy === row.file ? t('导入中…') : t('导入')),
            )),
          )
          : h('div', { style: S.desc }, t('这个插件还没有预设。在它的窗口里调好音色另存一份，这里就能扫到。')),
        h('div', { style: { ...S.row, marginTop: 10 } },
          h(TextInput, {
            value: importPath,
            placeholder: t('预设文件路径，如 C:\\…\\MyStrings.vstpreset 或 .fxp'),
            onChange: value => setImportPath(value),
            style: { flex: 1 },
          }),
          h(Btn, { disabled: busy === 'file' || !importPath.trim(), onClick: () => void importFile() },
            busy === 'file' ? t('导入中…') : t('从文件导入')),
        ),
        h('div', { style: S.desc }, t('在插件窗口里调好音色，用宿主「另存预设」导出 .vstpreset（VST3）或 .fxp（VST2），把路径贴在这里。')),
      )
      : null,
    manual ? h(ManualEditor, { name: manual, notify, onClose: () => setManual(null) }) : null,
  ]
}

function OrchestrationCard({ notify }) {
  const [tables, setTables] = useState([])
  const [name, setName] = useState('')
  const [path, setPath] = useState('')
  const [url, setUrl] = useState('')
  const [proxy, setProxy] = useState('')
  const [busy, setBusy] = useState('')

  const load = useCallback(async () => {
    try {
      const data = await api('/orchestrations')
      setTables(data.tables ?? [])
    } catch (error) {
      notify(error.message, 'error')
    }
  }, [notify])

  useEffect(() => { void load() }, [load])

  const runImport = async () => {
    const label = name.trim()
    if (!label) {
      notify(t('给这张表起个名字'), 'error')
      return
    }
    if (!path.trim() && !url.trim()) {
      notify(t('填一个文件路径或一个 Google Sheets 链接'), 'error')
      return
    }
    setBusy('import')
    try {
      const saved = await api('/orchestrations/import', {
        method: 'POST',
        body: {
          name: label,
          path: path.trim() || null,
          url: url.trim() || null,
          proxy: proxy.trim() || null,
        },
      })
      notify(t('已导入「{0}」：{1} 行，{2} 首', label, saved.rows ?? 0, saved.sections ?? 0))
      setName('')
      setPath('')
      setUrl('')
      await load()
    } catch (error) {
      notify(error.message, 'error')
    } finally {
      setBusy('')
    }
  }

  const drop = async (table) => {
    if (!window.confirm(t('删除配器表「{0}」？', table.name ?? table.id))) return
    try {
      await api('/orchestrations/remove', { method: 'POST', body: { name: table.name ?? table.id } })
      await load()
      notify(t('已删除'))
    } catch (error) {
      notify(error.message, 'error')
    }
  }

  return h(Card, {
    title: t('配器表'),
    desc: t('别人写同类曲子时，每件乐器用的是哪个音源、哪个 bank、哪个 preset——写曲前先查它，比自己猜音色有依据。支持 .csv、.xlsx（每个工作表一张表）或 Google Sheets 链接。'),
  }, [
    tables.length
      ? h('div', { style: S.list }, tables.map(table => h('div', { style: S.row, key: table.id }, [
          h('span', { style: S.mono }, table.name ?? table.id),
          h('span', { style: S.desc }, t('{0} 行 · {1} 首', table.rowCount ?? 0, table.sections ?? 0)),
          h('span', { style: { flex: 1 } }),
          h(Btn, { onClick: () => void drop(table) }, t('删除')),
        ])))
      : h('div', { style: S.desc }, t('还没有配器表。下面导入一张试试。')),
    h('div', { style: S.row }, [
      h(TextInput, {
        value: name,
        placeholder: t('表名，例如 Touhou Sound Sources'),
        onChange: value => setName(value),
        style: { flex: 1 },
      }),
    ]),
    h('div', { style: S.row }, [
      h(TextInput, {
        value: path,
        placeholder: t('本地文件：D:\…\配器表.xlsx'),
        onChange: value => setPath(value),
        style: { flex: 1 },
      }),
    ]),
    h('div', { style: S.row }, [
      h(TextInput, {
        value: url,
        placeholder: t('或 Google Sheets 链接 https://docs.google.com/spreadsheets/d/…'),
        onChange: value => setUrl(value),
        style: { flex: 1 },
      }),
      h(TextInput, {
        value: proxy,
        placeholder: t('代理（可选）http://127.0.0.1:7881'),
        onChange: value => setProxy(value),
        style: { width: '230px' },
      }),
    ]),
    h('div', { style: S.row }, [
      h('span', { style: { flex: 1 } }),
      h(Btn, { disabled: busy === 'import', onClick: () => void runImport() },
        busy === 'import' ? t('导入中…') : t('导入')),
    ]),
  ])
}

function InstrumentsTab({ state, reload, notify }) {
  return [
    h(VstDirsCard, { state, reload, notify }),
    h(PluginWorkbench, { notify }),
    h(ExternalRigsCard, { state, reload, notify }),
    h(OrchestrationCard, { notify }),
  ]
}

function TtsTab({ state, reload, notify }) {
  const [form, setForm] = useState(() => (state?.config?.tts ? JSON.parse(JSON.stringify(state.config.tts)) : null))
  const [keyInput, setKeyInput] = useState('')
  const [busy, setBusy] = useState('')
  const [previewText, setPreviewText] = useState(() => state?.config?.tts?.previewText ?? '')
  const [preview, setPreview] = useState(null)
  const [showKey, setShowKey] = useState(false)

  useEffect(() => {
    if (!form && state?.config) {
      setForm(JSON.parse(JSON.stringify(state.config.tts)))
      setPreviewText(state.config.tts.previewText)
    }
  }, [state, form])

  if (!form) return null
  const provider = form.provider
  const set = (path, value) => setForm(current => {
    const next = JSON.parse(JSON.stringify(current))
    const keys = path.split('.')
    let cursor = next
    for (let index = 0; index < keys.length - 1; index++) cursor = cursor[keys[index]] = cursor[keys[index]] || {}
    cursor[keys[keys.length - 1]] = value
    return next
  })

  async function save() {
    setBusy('save')
    try {
      await api('/config', { method: 'POST', body: { patch: { tts: form } } })
      notify(t('已保存为默认值（新任务生效，正在运行的任务不受影响）'))
      await reload()
    } catch (error) {
      notify(error.message, 'error')
    } finally {
      setBusy('')
    }
  }

  async function saveKey() {
    setBusy('key')
    try {
      await api('/credentials/set', { method: 'POST', body: { provider, value: keyInput } })
      setKeyInput('')
      notify(t('Key 已保存到 DSH 凭据库'))
      await reload()
    } catch (error) {
      notify(error.message, 'error')
    } finally {
      setBusy('')
    }
  }

  async function clearKey() {
    setBusy('key')
    try {
      await api('/credentials/unset', { method: 'POST', body: { provider } })
      notify(t('Key 已删除'))
      await reload()
    } catch (error) {
      notify(error.message, 'error')
    } finally {
      setBusy('')
    }
  }

  async function test() {
    setBusy('preview')
    try {
      const data = await api('/tts/preview', { method: 'POST', body: { provider, voice: form[provider]?.voice ?? '', text: previewText } })
      setPreview(data)
      notify(t('试听已生成'))
    } catch (error) {
      notify(error.message, 'error')
    } finally {
      setBusy('')
    }
  }

  const engines = state.tts.providers
  const engine = engines.find(item => item.id === provider) ?? engines[0]
  const voices = engine?.voices ?? []
  const savedProvider = state.config.tts.provider
  const savedEngine = engines.find(item => item.id === savedProvider)
  const savedVoice = state.config.tts[savedProvider]?.voice ?? ''
  // Which engines the person can actually reach right now. MiMo needs a saved
  // key; DeepSeek needs the DSH sign-in. Edge needs neither, so it never shows
  // a readiness line.
  const keyReady = {
    mimo: Boolean(state.tts.mimoConfigured),
    deepseek: Boolean(state.tts.deepseekConfigured),
  }

  return h(Card, { title: t('配音（TTS）'), desc: t('给视频配旁白。') },
    h('div', { style: S.row },
      h(Field, { label: t('引擎') },
        h(Select, {
          value: provider,
          onChange: value => set('provider', value),
          options: engines.map(item => ({ value: item.id, label: item.label })),
        }),
      ),
    ),
    h('div', { style: S.row },
      h(Field, { label: t('音色') },
        h(Select, {
          value: form[provider]?.voice ?? voices[0] ?? '',
          onChange: value => set(`${provider}.voice`, value),
          options: voices.map(voice => ({ value: voice, label: voice })),
        }),
      ),
    ),
    provider === 'deepseek'
      ? h('div', { style: S.row },
        h('span', { style: S.label }, state.tts.deepseekConfigured ? t('使用本机 DeepSeek 账号，无需配置') : t('未检测到 DeepSeek 账号，请先在 DSH 里登录')),
      )
      : provider === 'mimo'
        ? h('div', { style: S.row },
          h('span', { style: S.label }, state.tts.mimoConfigured ? t('Key 已配置') : t('Key 未配置')),
          state.tts.mimoConfigured && !showKey
            ? h(Btn, { onClick: () => setShowKey(true) }, t('更换'))
            : h(Fragment, null,
              h(TextInput, { value: keyInput, onChange: setKeyInput, type: 'password', placeholder: t('粘贴 Open Platform API Key') }),
              h(Btn, { kind: 'primary', disabled: !keyInput.trim() || busy === 'key', onClick: saveKey }, t('保存')),
            ),
          state.tts.mimoConfigured ? h(Btn, { disabled: busy === 'key', onClick: clearKey }, t('删除')) : null,
        )
        : null,
    h('div', { style: S.grid2 },
      provider === 'edge'
        ? h(Fragment, null,
          h(Field, { label: t('语速'), hint: t('例如 -12%（负数更慢）') }, h(TextInput, { value: form.edge.rate, onChange: value => set('edge.rate', value) })),
          h(Field, { label: t('音高'), hint: t('例如 -3Hz') }, h(TextInput, { value: form.edge.pitch, onChange: value => set('edge.pitch', value) })),
          h(Field, { label: t('音量'), hint: t('通常保持 +0%') }, h(TextInput, { value: form.edge.volume, onChange: value => set('edge.volume', value) })),
          h(Field, { label: t('代理（可选）'), hint: t('国内网络必要时填 http://127.0.0.1:7890') }, h(TextInput, { value: form.edge.proxy, onChange: value => set('edge.proxy', value) })),
        )
        : provider === 'deepseek'
          ? h(Fragment, null,
            h(Field, { label: t('API 地址'), hint: t('一般不需要修改') }, h(TextInput, { value: form.deepseek.baseUrl, onChange: value => set('deepseek.baseUrl', value) })),
            h(Field, { label: t('代理（可选）'), hint: t('默认直连') }, h(TextInput, { value: form.deepseek.proxy, onChange: value => set('deepseek.proxy', value) })),
          )
          : h(Fragment, null,
            h(Field, { label: t('模型'), hint: t('默认 mimo-v2.5-tts') }, h(TextInput, { value: form.mimo.model, onChange: value => set('mimo.model', value) })),
            h(Field, { label: t('API 地址'), hint: t('一般不需要修改') }, h(TextInput, { value: form.mimo.baseUrl, onChange: value => set('mimo.baseUrl', value) })),
            h(Field, { label: t('代理（可选）'), hint: t('默认直连；系统代理会改写 MiMo 请求时再填') }, h(TextInput, { value: form.mimo.proxy, onChange: value => set('mimo.proxy', value) })),
          ),
    ),
    h('div', { style: { borderTop: `1px solid ${C.border}`, paddingTop: 10, display: 'flex', flexDirection: 'column', gap: 8 } },
      h('textarea', {
        value: previewText,
        onChange: event => setPreviewText(event.target.value),
        rows: 3,
        style: { ...S.input, resize: 'vertical' },
      }),
      h('div', { style: S.row },
        h(Btn, { kind: 'primary', disabled: busy === 'preview' || !previewText.trim(), onClick: test }, busy === 'preview' ? t('生成中…') : t('生成试听')),
        provider === 'deepseek' && !keyReady.deepseek ? h('span', { style: S.desc }, t('先登录 DSH 才能试听 DeepSeek')) : null,
        provider === 'mimo' && !keyReady.mimo ? h('span', { style: S.desc }, t('先保存 Key 才能试听 MiMo')) : null,
      ),
      preview ? h('div', { style: S.item },
        h('div', { style: S.itemHead }, h('span', null, preview.label), h('span', { style: S.mono }, `${preview.durationSec}s · ${preview.peakDb} dBFS`)),
        h('audio', { controls: true, autoPlay: true, src: preview.url, style: S.audio }),
      ) : null,
    ),
    h('div', { style: { borderTop: `1px solid ${C.border}`, paddingTop: 10, ...S.row, justifyContent: 'space-between' } },
      h('span', { style: S.desc }, t('当前默认：{0} · {1}', savedEngine?.label ?? savedProvider, savedVoice)),
      h(Btn, { disabled: busy === 'save', onClick: save }, t('保存为默认配置')),
    ),
  )
}

/**
 * Singing engine settings. Four controls only — engine status, install
 * progress, voicebank and device. There is deliberately no "synthesis mode"
 * switch: the tool sings one way (split at rests into phrases), and a toggle
 * that never changes the outcome is worse than no toggle.
 */
function SingingTab({ state, reload, notify }) {
  const [form, setForm] = useState(() => (state?.config?.singing ? JSON.parse(JSON.stringify(state.config.singing)) : null))
  const [status, setStatus] = useState(null)
  const [voices, setVoices] = useState([])
  const [job, setJob] = useState(null)
  const [gpuStatus, setGpuStatus] = useState(null)
  const [gpuJob, setGpuJob] = useState(null)
  const [busy, setBusy] = useState('')
  const [zipPath, setZipPath] = useState('')
  const voicebankSources = useVoicebankSources()

  const loadStatus = useCallback(async () => {
    try {
      setStatus(await api('/singing/status'))
    } catch (error) {
      setStatus({ ok: false, error: error.message })
    }
  }, [])
  const loadVoices = useCallback(async () => {
    try {
      const data = await api('/singing/voices')
      setVoices(data.voices ?? [])
    } catch {
      setVoices([])
    }
  }, [])
  const loadGpuStatus = useCallback(async () => {
    try {
      setGpuStatus(await api('/singing/gpu-status'))
    } catch (error) {
      setGpuStatus({ ok: false, error: error.message })
    }
  }, [])

  useEffect(() => { void loadStatus(); void loadVoices(); void loadGpuStatus() }, [loadStatus, loadVoices, loadGpuStatus])
  useEffect(() => {
    if (!form && state?.config?.singing) setForm(JSON.parse(JSON.stringify(state.config.singing)))
  }, [state, form])

  // Like the font installer, the job lives on the host: reopening settings must
  // pick up an install that is still running.
  useEffect(() => {
    let cancelled = false
    api('/jobs/active?kind=singing-install')
      .then((data) => { if (!cancelled && data.job) setJob(data.job) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [])
  useEffect(() => {
    if (!job || job.status !== 'running') return undefined
    const timer = setInterval(async () => {
      try {
        const data = await api(`/jobs?id=${encodeURIComponent(job.id)}`)
        setJob(data.job)
        if (data.job.status === 'done') {
          notify(t('唱歌环境已安装'))
          await loadStatus()
          await loadVoices()
          await reload()
        }
        if (data.job.status === 'error') notify(jobFailure(data.job), 'error')
      } catch (error) {
        notify(error.message, 'error')
        setJob(null)
      }
    }, 700)
    return () => clearInterval(timer)
  }, [job, loadStatus, loadVoices, reload, notify])

  // The GPU install is its own host job: it survives closing this page, so the
  // running job has to be rediscovered when settings opens again.
  useEffect(() => {
    let cancelled = false
    api('/jobs/active?kind=singing-gpu-install')
      .then((data) => { if (!cancelled && data.job) setGpuJob(data.job) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [])
  useEffect(() => {
    if (!gpuJob || gpuJob.status !== 'running') return undefined
    const timer = setInterval(async () => {
      try {
        const data = await api(`/jobs?id=${encodeURIComponent(gpuJob.id)}`)
        setGpuJob(data.job)
        if (data.job.status === 'done') {
          notify(t('显卡组件已安装'))
          await loadGpuStatus()
        }
        if (data.job.status === 'error') notify(jobFailure(data.job), 'error')
      } catch (error) {
        notify(error.message, 'error')
        setGpuJob(null)
      }
    }, 700)
    return () => clearInterval(timer)
  }, [gpuJob, loadGpuStatus, notify])

  if (!form) return null

  async function save(patch) {
    setBusy('save')
    try {
      const singing = { ...form, ...patch }
      await api('/config', { method: 'POST', body: { patch: { singing } } })
      setForm(singing)
      notify(t('已保存为默认值（新任务生效，正在运行的任务不受影响）'))
      await reload()
    } catch (error) {
      notify(error.message, 'error')
    } finally {
      setBusy('')
    }
  }

  async function install() {
    setBusy('install')
    try {
      const data = await api('/singing/install', { method: 'POST', body: {} })
      setJob(data.job)
      notify(data.reused ? t('已有一个下载任务在进行') : t('安装已开始，关掉设置页后仍会继续'))
    } catch (error) {
      notify(error.message, 'error')
    } finally {
      setBusy('')
    }
  }

  // Choosing the GPU is a commitment: the component is a ~216 MB download and
  // takes a while. Ask first, and say plainly that until it finishes every
  // request still runs on CPU and that closing this page will not stop it.
  async function chooseDevice(value) {
    if (value === 'cuda' && !gpuInstalled && !gpuInstalling) {
      const ok = window.confirm(t('选显卡需要先下载显卡组件（约 216 MB），耗时较久。下载期间仍按 CPU 运行；现在关闭设置页也会在后台继续。现在开始下载？'))
      if (!ok) return
      setBusy('gpu-install')
      try {
        const data = await api('/singing/gpu-install', { method: 'POST', body: {} })
        setGpuJob(data.job)
        notify(data.reused ? t('已有一个下载任务在进行') : t('显卡组件下载已开始，关掉设置页后仍会继续'))
      } catch (error) {
        notify(error.message, 'error')
      } finally {
        setBusy('')
      }
    }
    await save({ device: value })
  }

  // Install the same official zip the three links serve, from a local copy.
  // zipPath must be absolute: the browser's file input hides the full path, so
  // the person pastes it, exactly like the sound-pack install field.
  async function installZip() {
    const path = zipPath.trim()
    if (!path) return
    setBusy('zip')
    try {
      const result = await installVoicebankZip(path)
      notify(t('声库已安装，刷新后即可选用'))
      setZipPath('')
      await loadStatus()
      await loadVoices()
      await reload()
    } catch (error) {
      notify(t('声库 zip 安装失败：{0}', error.message), 'error')
    } finally {
      setBusy('')
    }
  }

  const installing = Boolean(job && job.status === 'running')
  const percent = job && job.total ? (job.received / job.total) * 100 : 0
  const ready = Boolean(status?.ready)
  // The environment install installs only the runtime now; the voicebank is a
  // separate step. The button state here must follow the runtime alone, or a
  // machine with a runtime but no voicebank still looks like "not installed".
  const runtimeInstalled = Boolean(status?.runtime?.installed)
  const parts = status?.ok
    ? [
      { label: t('运行环境'), ok: Boolean(status.runtime?.installed), detail: status.runtime?.version ? t('版本：{0}', status.runtime.version) : '' },
      { label: t('声库'), ok: Boolean(status.voicebank?.installed), detail: status.voicebank?.name ?? '' },
      { label: t('声码器'), ok: Boolean(status.vocoder?.installed), detail: '' },
    ]
    : []
  // The configured bank must remain selectable even before it is installed, so
  // the dropdown never silently jumps to a different value on first render.
  const voiceOptions = [...new Set([form.voicebank, ...voices.map((voice) => voice.name)].filter(Boolean))]
  const gpuInstalled = Boolean(gpuStatus?.ok && gpuStatus.installed)
  const gpuInstalling = Boolean(gpuJob && gpuJob.status === 'running')
  const gpuPercent = gpuJob && gpuJob.total ? (gpuJob.received / gpuJob.total) * 100 : 0
  const devices = [
    { value: 'auto', label: t('自动') },
    { value: 'cpu', label: 'CPU' },
    { value: 'cuda', label: t('显卡（CUDA）') },
  ]

  return h(Fragment, null,
    h(Card, { title: t('引擎状态'), desc: t('本地歌声合成需要先装好运行环境、声库和声码器。') },
      status?.ok
        ? h(Fragment, null,
          h('div', { style: S.row },
            ...parts.map((part) => h('span', { key: part.label, style: S.chip },
              `${part.label}：${part.ok ? t('已安装') : t('未安装')}${part.detail ? ` ${part.detail}` : ''}`,
            )),
          ),
          h('div', { style: S.desc }, ready ? t('唱歌环境已就绪') : t('唱歌环境尚未就绪')),
        )
        : h('p', { style: S.desc }, status?.error ? t('状态检测失败：{0}', status.error) : t('正在检测…')),
    ),
    h(Card, { title: t('第一步：安装唱歌环境'), desc: t('安装运行环境与依赖；声库请在下一步自行下载并安装。') },
      h('div', { style: S.row },
        h(Btn, {
          kind: 'primary',
          disabled: runtimeInstalled || installing || busy === 'install',
          onClick: install,
        }, runtimeInstalled ? t('运行环境已安装') : t('安装')),
      ),
      job ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
        h('div', { style: { ...S.row, justifyContent: 'space-between' } },
          h('span', { style: S.label }, job.status === 'running'
            ? `${t('正在安装')}${job.total ? ` ${Math.round(percent)}%` : ''}${job.message ? ` · ${job.message}` : ''}`
            : job.status === 'done' ? t('完成：{0}', job.message || t('已安装')) : t('失败：{0}', jobFailure(job))),
          job.total ? h('span', { style: S.mono }, `${bytes(job.received)} / ${bytes(job.total)}`) : null,
        ),
        h('div', { style: S.bar }, h('div', { style: S.barFill(percent) })),
      ) : null,
    ),
    h(Card, { title: t('第二步：下载声库包'), desc: t('国外用 GitHub，国内用百度网盘或夸克网盘。三处都是同一个官方原包：下好后到第三步选本地文件安装。') },
      h(VoicebankDownloadLinks, { sources: voicebankSources }),
    ),
    h(Card, { title: t('第三步：安装声库包'), desc: t('填一个下载好的官方 .zip 文件的完整路径（绝对路径）。') },
      h('div', { style: S.row },
        h(TextInput, { value: zipPath, onChange: setZipPath, placeholder: t('粘贴声库 zip 的完整路径') }),
        h(Btn, {
          kind: 'primary',
          disabled: !zipPath.trim() || busy === 'zip' || installing,
          onClick: installZip,
        }, busy === 'zip' ? t('正在安装声库…') : t('安装 zip')),
      ),
    ),
    h(Card, { title: t('选声库'), desc: t('列出这台机器上已装的声库；工具调用里显式写的声库优先。') },
      h('div', { style: S.row },
        h(Field, { label: t('声库') },
          h(Select, {
            value: form.voicebank,
            onChange: value => void save({ voicebank: value }),
            options: voiceOptions.map(name => ({ value: name, label: name })),
          }),
        ),
      ),
    ),
    h(Card, { title: t('选设备'), desc: t('装好显卡组件后，「自动」和「显卡」都走显卡，只有「CPU」走 CPU；设备变更会重启唱歌进程。') },
      h('div', { style: S.row },
        h(Field, { label: t('推理设备') },
          h(Select, {
            value: form.device,
            onChange: value => void chooseDevice(value),
            options: devices,
          }),
        ),
      ),
      h('div', { style: S.row },
        h('span', { style: S.label }, t('显卡组件')),
        h('span', { style: S.chip }, gpuInstalling ? t('安装中') : gpuInstalled ? t('已安装') : t('未安装')),
        gpuStatus?.ok && gpuStatus.version ? h('span', { style: S.mono }, t('版本：{0}', gpuStatus.version)) : null,
      ),
      gpuInstalled
        ? h('div', { style: S.desc }, t('「自动」和「显卡」都走显卡，「CPU」仍走 CPU。'))
        : h('div', { style: S.desc }, t('未装显卡组件时，无论选什么，实际都按 CPU 运行。')),
      gpuInstalling
        ? h(Fragment, null,
          h('div', { style: S.desc }, t('显卡组件安装中，当前按 CPU 运行。')),
          h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
            h('div', { style: { ...S.row, justifyContent: 'space-between' } },
              h('span', { style: S.label }, `${t('正在安装')}${gpuJob.total ? ` ${Math.round(gpuPercent)}%` : ''}${gpuJob.message ? ` · ${gpuJob.message}` : ''}`),
              gpuJob.total ? h('span', { style: S.mono }, `${bytes(gpuJob.received)} / ${bytes(gpuJob.total)}`) : null,
            ),
            h('div', { style: S.bar }, h('div', { style: S.barFill(gpuPercent) })),
          ),
        )
        : null,
    ),
  )
}

function MixTab({ state, reload, notify }) {
  const [form, setForm] = useState(null)
  const [busy, setBusy] = useState('')
  useEffect(() => {
    if (!form && state?.config) setForm(JSON.parse(JSON.stringify(state.config)))
  }, [state, form])
  if (!form) return null
  const set = (path, value) => setForm(current => {
    const next = JSON.parse(JSON.stringify(current))
    const keys = path.split('.')
    let cursor = next
    for (let index = 0; index < keys.length - 1; index++) cursor = cursor[keys[index]] = cursor[keys[index]] || {}
    cursor[keys[keys.length - 1]] = value
    return next
  })
  async function save() {
    setBusy('save')
    try {
      await api('/config', { method: 'POST', body: { patch: { music: form.music, output: form.output } } })
      notify(t('已保存。显式参数仍然优先于这些默认值'))
      await reload()
    } catch (error) {
      notify(error.message, 'error')
    } finally {
      setBusy('')
    }
  }
  return h(Card, { title: t('混音与输出'), desc: t('这些是工具没写参数时采用的默认值；工具调用里显式写的参数永远优先。') },
    h('div', { style: S.grid2 },
      h(Field, { label: t('音乐峰值 (dBFS)'), hint: t('渲染音乐时默认归一到的峰值') }, h(NumberInput, { value: form.music.peakDb, onChange: value => set('music.peakDb', value === '' ? null : value) })),
      h(Field, { label: t('音乐尾音 (秒)'), hint: t('最后一个音符结束后额外渲染的释放与混响') }, h(NumberInput, { value: form.music.tailSec, onChange: value => set('music.tailSec', Number(value) || 0) })),
      h(Field, { label: t('输出目录'), hint: t('留空 = 项目下 .anyaudio/out；也可以填绝对路径') }, h(TextInput, { value: form.output.dir, onChange: value => set('output.dir', value) })),
    ),
    h('div', { style: { ...S.row, justifyContent: 'flex-end' } }, h(Btn, { kind: 'primary', disabled: busy === 'save', onClick: save }, t('保存为默认值'))),
  )
}

/**
 * Sound packs: what is installed, and which packs `catalog` expands.
 *
 * There is no browser and no audition here on purpose. A sound is judged by
 * putting it on a timeline and listening to it there, which is what the clip
 * bay is for; a second player in the settings page would be a worse copy of it.
 */
function FxLibTab({ state, reload, notify }) {
  const [packs, setPacks] = useState(null)
  const [root, setRoot] = useState('')
  const [busy, setBusy] = useState('')
  const [installPath, setInstallPath] = useState('')
  const [error, setError] = useState('')
  const [showDownloads, setShowDownloads] = useState(false)
  const [showRecommended, setShowRecommended] = useState(false)
  const [openDetails, setOpenDetails] = useState({})
  const [job, setJob] = useState(null)
  const toggleDetails = (key) => setOpenDetails(current => ({ ...current, [key]: !current[key] }))

  const load = useCallback(async () => {
    try {
      const data = await api('/sfx/packs')
      setPacks(data.packs ?? [])
      setRoot(data.root ?? '')
      setError('')
    } catch (caught) {
      setError(caught.message)
    }
  }, [])

  useEffect(() => { load() }, [load])

  // The install runs on the host: a folder without a manifest has to be measured
  // first, which takes a moment on a large pack. The page only watches it.
  useEffect(() => {
    if (!job || job.status !== 'running') return undefined
    const timer = setInterval(async () => {
      try {
        const data = await api(`/jobs?id=${encodeURIComponent(job.id)}`)
        setJob(data.job)
        if (data.job.status === 'done') {
          const result = data.job.result ?? {}
          notify(t('已安装 {0}（{1} 条）', result.id ?? '', result.count ?? ''))
          setInstallPath('')
          await load()
        }
        if (data.job.status === 'error') notify(jobFailure(data.job), 'error')
      } catch (caught) {
        notify(caught.message, 'error')
        setJob(null)
      }
    }, 500)
    return () => clearInterval(timer)
  }, [job, load, notify])

  async function toggle(pack) {
    setBusy(pack.id)
    try {
      await api('/sfx/packs/toggle', { method: 'POST', body: { id: pack.id, priority: !pack.priority } })
      await load()
      await reload()
    } catch (caught) {
      notify(caught.message, 'error')
    } finally {
      setBusy('')
    }
  }

  async function install() {
    const fromPath = installPath.trim()
    if (!fromPath) return
    setBusy('install')
    try {
      const data = await api('/sfx/packs/install', { method: 'POST', body: { fromPath } })
      setJob(data.job)
    } catch (caught) {
      notify(caught.message, 'error')
    } finally {
      setBusy('')
    }
  }

  async function remove(pack) {
    if (!window.confirm(t('删除音效包「{0}」？已经放进工程的素材不受影响。', pack.name))) return
    setBusy(pack.id)
    try {
      await api('/sfx/packs/remove', { method: 'POST', body: { id: pack.id } })
      await load()
      await reload()
    } catch (caught) {
      notify(caught.message, 'error')
    } finally {
      setBusy('')
    }
  }

  const installed = Boolean(packs?.some(pack => pack.id === BASE_PACK.id))

  return h(Fragment, null,
    h(Card, { title: t('推荐音效包'), desc: t('作者精选。装一次，所有工程共用。') },
      installed && !showRecommended
        ? h('div', { style: S.row },
          h('span', { style: S.desc }, t('推荐音效包已安装')),
          h(Btn, { onClick: () => setShowRecommended(true) }, t('查看')),
        )
        : h('div', { style: S.list },
          h('div', { style: S.item },
            h('div', { style: S.itemHead },
              h('span', { style: { fontWeight: 600 } }, BASE_PACK.name),
              h('span', { style: S.chip }, `${BASE_PACK.count} ${t('条')}`),
              h('span', { style: S.chip }, BASE_PACK.size),
              h('span', { style: S.chip }, BASE_PACK.license),
              installed ? h('span', { style: S.chip }, t('已安装')) : null,
              h('span', { style: { flex: 1 } }),
              h(Btn, { onClick: () => setShowDownloads(value => !value) }, t('去下载')),
            ),
            h('div', { style: S.desc }, t(BASE_PACK.summary)),
            h('div', { style: S.desc }, t('压缩包，下载后解压，把解压出来的 BaseSFX 目录路径填到下面「安装」。')),
            showDownloads ? h(DownloadLinks, null) : null,
          ),
        ),
    ),
    h(Card, { title: t('已安装'), desc: t('打开「优先」的包，名字会直接列在 catalog 里；其余包用 search 检索。') },
      error ? h(Notice, { tone: 'error' }, error)
        : !packs ? h('p', { style: S.desc }, t('正在读取音效包…'))
        : packs.length === 0 ? h('p', { style: S.desc }, t('还没有安装任何音效包。把包目录的路径填在下面安装。'))
        : h('div', { style: S.list }, packs.map(pack => {
          const open = Boolean(openDetails[pack.id])
          return h('div', { key: pack.id, style: S.item },
            h('div', { style: S.itemHead },
              h('span', { style: { fontWeight: 600 } }, pack.name),
              h('span', { style: S.chip }, `${pack.count} ${t('条')}`),
              pack.license ? h('span', { style: S.chip }, pack.license) : null,
              h('span', { style: { flex: 1 } }),
              h(Switch, {
                checked: pack.priority,
                disabled: busy === pack.id,
                onChange: () => toggle(pack),
                label: pack.priority ? t('优先') : t('普通'),
              }),
              h(Btn, { kind: 'ghost', disabled: busy === pack.id, onClick: () => remove(pack) }, t('删除')),
              h(Btn, { onClick: () => toggleDetails(pack.id) }, open ? t('收起') : t('详情')),
            ),
            open ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 2 } },
              h('div', { style: S.mono }, pack.dir),
              pack.tokens ? h('div', { style: S.desc }, t('优先时约占用 {0}K tokens 上下文', pack.tokens)) : null,
            ) : null,
          )
        })),
      h('p', { style: { ...S.desc, marginTop: 10 } }, t('打开「优先」会占用更多上下文，建议只对常用的音效包使用。')),
    ),
    h(Card, {
      title: t('安装音效包'),
      desc: t('填一个音效包文件夹的路径。'),
      right: h(HelpTip, { text: t('文件夹里按 FOL（动效）/ AMB（环境音）/ DSN（设计音效）分三个子目录，音频文件直接放进去就行。\n\n三个子目录可以只有一部分。如果一个都没有，文件夹里的音频会全部当作动效。\n\n不需要准备任何清单文件，安装时会自动识别。') }),
    },
      h('div', { style: S.row },
        h(TextInput, { value: installPath, placeholder: t('把音效包文件夹的路径粘贴到这里'), onChange: setInstallPath }),
        h(Btn, { kind: 'primary', disabled: busy === 'install' || !installPath.trim() || job?.status === 'running', onClick: install }, t('安装')),
      ),
      job ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
        h('div', { style: { ...S.row, justifyContent: 'space-between' } },
          h('span', { style: S.label }, job.status === 'running'
            ? (job.total ? t('正在识别 {0} / {1}', job.received, job.total) : t('正在识别…'))
            : job.status === 'done' ? t('完成：{0}', job.message || t('已安装')) : t('失败：{0}', jobFailure(job))),
          job.total ? h('span', { style: S.mono }, `${job.received} / ${job.total}`) : null,
        ),
        h('div', { style: S.bar }, h('div', { style: S.barFill(job.total ? (job.received / job.total) * 100 : 0) })),
      ) : null,
    ),
    h(Card, { title: t('音效包目录'), desc: t('整台机器共用这一个音效库；装一次，所有工程共用。') },
      h('div', { style: S.mono }, root || t('正在读取…')),
    ),
  )
}

function AdvancedTab({ state, reload, notify }) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState('')
  useEffect(() => {
    if (state?.config) setText(JSON.stringify(state.config, null, 2))
  }, [state?.config])
  async function save() {
    setBusy('save')
    try {
      const parsed = JSON.parse(text)
      await api('/config', { method: 'POST', body: { patch: parsed } })
      notify(t('已保存'))
      await reload()
    } catch (error) {
      notify(error.message, 'error')
    } finally {
      setBusy('')
    }
  }
  async function reset() {
    if (!window.confirm(t('把 AnyAudio 的所有设置恢复为默认值？（音源文件不会删除，API Key 也不会删除）'))) return
    setBusy('reset')
    try {
      await api('/config/reset', { method: 'POST', body: {} })
      notify(t('设置已恢复默认'))
      await reload()
    } catch (error) {
      notify(error.message, 'error')
    } finally {
      setBusy('')
    }
  }
  // The guide's "seen" flag is the plugin's own number, not the shell's: the
  // shell forgets as soon as the person types, so replaying means clearing this.
  // The event reaches a guide that is already mounted, so replaying does not
  // need a page reload.
  async function replayGuide() {
    setBusy('guide')
    try {
      await api('/config', { method: 'POST', body: { patch: { ui: { onboardedVersion: 0 } } } })
      window.dispatchEvent(new CustomEvent('anyaudio:onboarding-reset'))
      notify(t('已重置。打开一个新对话即可看到引导。'))
      await reload()
    } catch (error) {
      notify(error.message, 'error')
    } finally {
      setBusy('')
    }
  }
  return h(Fragment, null,
    h(Card, { title: t('高级：原始配置'), desc: t('整个配置文件就是这一份 JSON，机器上所有 profile 共用。未知字段会在保存时被丢弃。') },
      h('textarea', { value: text, onChange: event => setText(event.target.value), rows: 18, style: { ...S.input, resize: 'vertical', fontFamily: 'ui-monospace, Consolas, monospace', fontSize: 12 } }),
      h('div', { style: S.row },
        h(Btn, { kind: 'primary', disabled: busy === 'save', onClick: save }, t('保存')),
        h(Btn, { onClick: () => setText(JSON.stringify(state.config, null, 2)) }, t('重新载入')),
      ),
    ),
    h(Card, { title: t('音源搜索目录') },
      h('div', { style: S.mono }, state.fonts.directories.join('\n')),
    ),
    h(Card, { title: t('首次安装引导'), desc: t('装音源、装音效包、认识剪辑台。已经看过的话，这里可以重放。') },
      h('div', { style: S.row },
        h(Btn, { disabled: busy === 'guide', onClick: replayGuide }, t('重新播放引导')),
        h('span', { style: S.desc }, t('重置后打开一个新对话即可看到。')),
      ),
    ),
    h(Card, { title: t('恢复默认设置'), desc: t('音源文件不会删除，API Key 也不会删除。') },
      h('div', { style: S.row },
        h(Btn, { disabled: busy === 'reset', onClick: reset }, t('恢复默认设置')),
      ),
    ),
  )
}

function Page() {
  const [state, setState] = useState(null)
  const [error, setError] = useState('')
  const [toast, setToast] = useState(null)
  const [tab, setTab] = useState('sources')

  const notify = useCallback((message, tone) => {
    setToast({ message, tone })
    window.clearTimeout(notify.timer)
    notify.timer = window.setTimeout(() => setToast(null), tone === 'error' ? 9000 : 4000)
  }, [])

  const reload = useCallback(async () => {
    try {
      const data = await api('/state')
      setState(data)
      setError('')
    } catch (caught) {
      setError(caught.message)
    }
  }, [])

  useEffect(() => { reload() }, [reload])

  const tabs = useMemo(() => ([
    { id: 'sources', label: t('音源'), render: () => h(FontsTab, { state, reload, notify }) },
    { id: 'instruments', label: t('插件与音源'), render: () => h(InstrumentsTab, { state, reload, notify }) },
    { id: 'fxlib', label: t('音效'), render: () => h(FxLibTab, { state, reload, notify }) },
    { id: 'tts', label: t('配音'), render: () => h(TtsTab, { state, reload, notify }) },
    { id: 'singing', label: t('唱歌'), render: () => h(SingingTab, { state, reload, notify }) },
    { id: 'mix', label: t('混音'), render: () => h(MixTab, { state, reload, notify }) },
    { id: 'advanced', label: t('高级'), render: () => h(AdvancedTab, { state, reload, notify }) },
  ]), [state, reload, notify])

  if (error) {
    return h('div', { style: S.page },
      h('h2', { style: S.title }, 'AnyAudio'),
      h(Notice, { tone: 'error' }, t('无法读取设置：{0}。确认插件已启用，并重启一次 DSH。', error)),
      h('div', null, h(Btn, { onClick: reload }, t('重试'))),
    )
  }
  if (!state) return h('div', { style: S.page }, h('p', { style: S.desc }, t('正在读取 AnyAudio 设置…')))

  // Record the preference as well as adopting it: the clip bay's tab label is
  // translated outside any component, so it resolves the language on every read
  // and needs to know whether a language is pinned or left on "auto".
  setLanguagePreference(state.config?.ui?.language || 'auto')
  setLanguage(detectLanguage(state.config))
  if (language() === 'en') document.documentElement.lang = 'en'

  async function saveLanguage(value) {
    try {
      await api('/config', { method: 'POST', body: { patch: { ui: { language: value } } } })
      notify(t('语言已保存'))
      await reload()
    } catch (caught) {
      notify(caught.message, 'error')
    }
  }

  const active = tabs.find(item => item.id === tab) || tabs[0]
  return h('div', { style: S.page },
    h('div', { style: { ...S.header, alignItems: 'center' } },
      h('h2', { style: S.title }, 'AnyAudio'),
      h('span', { style: { flex: 1 } }),
      h(Select, {
        value: state.config.ui?.language ?? 'auto',
        onChange: value => void saveLanguage(value),
        title: t('界面语言'),
        style: { width: 'auto', minWidth: 110, fontSize: 12 },
        options: [
          { value: 'auto', label: t('跟随系统') },
          { value: 'zh', label: t('中文') },
          { value: 'en', label: 'English' },
        ],
      }),
      h(Btn, { onClick: reload }, t('刷新')),
    ),
    h('div', { style: { ...S.row, gap: 8 } },
      h(Btn, { onClick: () => window.open(GITHUB_URL, '_blank', 'noopener,noreferrer') }, 'GitHub'),
      h('span', { style: S.desc }, t('喜欢的话给个 Star ⭐')),
    ),
    h('div', { style: S.tabs }, tabs.map(item => h('button', { key: item.id, type: 'button', onClick: () => setTab(item.id), style: S.tab(item.id === tab) }, item.label))),
    active.render(),
    toast ? h('div', { style: { position: 'sticky', bottom: 8, zIndex: 5 } }, h(Notice, { tone: toast.tone === 'error' ? 'error' : 'info' }, toast.message)) : null,
  )
}

export { Page, FontsTab, FxLibTab, TtsTab, SingingTab }
