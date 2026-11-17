/**
 * RA2 CSF string-table tools.
 *
 * Parses, edits, and saves Red Alert 2 / Yuri's Revenge CSF files
 * (the format written by RA2CStrEditor), and can launch the
 * RA2CStrEditor.exe GUI for manual editing.
 *
 * CSF layout (verified against a real ra2md.csf):
 *   header (24 bytes): " FSC" | version(3) | numLabels | numStrings | unused(0) | language
 *   per entry:
 *     " LBL" | count(1) | labelLen | label (ASCII)
 *     exactly one of:
 *       " RTS" | len | len UTF-16LE units          (main value)
 *       "WRTS" | len | len UTF-16LE units | nameLen | name (extra value, ASCII name)
 *
 * Text encoding: every stored UTF-16 unit is the bitwise complement of the
 * displayed Unicode code point (stored = 0xFFFF - code). This module decodes
 * on read and encodes on write, so tools work with plain readable text.
 */
import { readFile, writeFile, rename, copyFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { spawn } from 'node:child_process'

export const inject = ['tools']

const MAGIC_HEADER = ' FSC'
const MAGIC_LABEL = ' LBL'
const MAGIC_VALUE = ' RTS'
const MAGIC_EXTRA = 'WRTS'

const LANGUAGES = {
  0: 'English (US)',
  1: 'German',
  2: 'French',
  3: 'Spanish',
  4: 'Italian',
  5: 'Japanese',
  6: 'Korean',
  7: 'Chinese',
  8: 'Russian',
}

// ---- CSF codec ---------------------------------------------------------

/** Decode stored (complemented) UTF-16 units into display text, unit by unit. */
function decodeText(raw) {
  const out = new Array(raw.length)
  for (let i = 0; i < raw.length; i++) out[i] = String.fromCharCode(0xFFFF - raw.charCodeAt(i))
  return out.join('')
}

/** Encode display text into stored (complemented) UTF-16 units, unit by unit. */
function encodeText(text) {
  const out = new Array(text.length)
  for (let i = 0; i < text.length; i++) out[i] = String.fromCharCode(0xFFFF - text.charCodeAt(i))
  return out.join('')
}

function parseCsf(buffer) {
  const header = {
    version: buffer.readUInt32LE(4),
    numLabels: buffer.readUInt32LE(8),
    numStrings: buffer.readUInt32LE(12),
    unused: buffer.readUInt32LE(16),
    language: buffer.readUInt32LE(20),
  }
  if (buffer.toString('latin1', 0, 4) !== MAGIC_HEADER) throw new Error('not a CSF file: bad magic (expected " FSC")')
  let o = 24
  const entries = []
  const queue = []
  while (o < buffer.length) {
    const magic = buffer.toString('latin1', o, o + 4)
    o += 4
    if (magic === MAGIC_LABEL) {
      const count = buffer.readUInt32LE(o); o += 4
      for (let i = 0; i < count; i++) {
        const len = buffer.readUInt32LE(o); o += 4
        if (o + len > buffer.length) throw new Error(`corrupt CSF: label overruns file at ${o}`)
        const entry = { label: buffer.toString('latin1', o, o + len), value: null, extra: null, extraName: null }
        o += len
        entries.push(entry)
        queue.push(entry)
      }
    } else if (magic === MAGIC_VALUE) {
      const len = buffer.readUInt32LE(o); o += 4
      if (o + len * 2 > buffer.length) throw new Error(`corrupt CSF: value overruns file at ${o}`)
      const raw = buffer.toString('utf16le', o, o + len * 2)
      o += len * 2
      const entry = queue.shift()
      if (!entry) throw new Error(`corrupt CSF: " RTS" chunk without a label at ${o}`)
      entry.value = decodeText(raw)
    } else if (magic === MAGIC_EXTRA) {
      const len = buffer.readUInt32LE(o); o += 4
      if (o + len * 2 + 4 > buffer.length) throw new Error(`corrupt CSF: extra value overruns file at ${o}`)
      const raw = buffer.toString('utf16le', o, o + len * 2)
      o += len * 2
      const nameLen = buffer.readUInt32LE(o); o += 4
      if (o + nameLen > buffer.length) throw new Error(`corrupt CSF: extra name overruns file at ${o}`)
      const name = buffer.toString('latin1', o, o + nameLen)
      o += nameLen
      const entry = queue.shift()
      if (!entry) throw new Error(`corrupt CSF: WRTS chunk without a label at ${o}`)
      entry.extra = decodeText(raw)
      entry.extraName = name
    } else {
      throw new Error(`unknown CSF chunk ${JSON.stringify(magic)} at offset ${o - 4}`)
    }
  }
  if (queue.length !== 0) throw new Error(`corrupt CSF: ${queue.length} label(s) without a value chunk`)
  return { header, entries }
}

function serializeCsf(header, entries) {
  const head = Buffer.alloc(20)
  head.writeUInt32LE(header.version ?? 3, 0)
  head.writeUInt32LE(entries.length, 4)
  let stringCount = 0
  const body = []
  for (const entry of entries) {
    const label = Buffer.from(entry.label, 'latin1')
    const count = Buffer.alloc(4)
    count.writeUInt32LE(1, 0)
    const labelLen = Buffer.alloc(4)
    labelLen.writeUInt32LE(label.length, 0)
    body.push(Buffer.from(MAGIC_LABEL, 'latin1'), count, labelLen, label)
    if (entry.value !== null) {
      stringCount++
      const raw = encodeText(entry.value)
      const value = Buffer.from(raw, 'utf16le')
      const len = Buffer.alloc(4)
      len.writeUInt32LE(raw.length, 0)
      body.push(Buffer.from(MAGIC_VALUE, 'latin1'), len, value)
    }
    if (entry.extra !== null) {
      stringCount++
      const raw = encodeText(entry.extra)
      const value = Buffer.from(raw, 'utf16le')
      const name = Buffer.from(entry.extraName ?? '', 'latin1')
      const len = Buffer.alloc(4)
      len.writeUInt32LE(raw.length, 0)
      const nameLen = Buffer.alloc(4)
      nameLen.writeUInt32LE(name.length, 0)
      body.push(Buffer.from(MAGIC_EXTRA, 'latin1'), len, value, nameLen, name)
    }
  }
  head.writeUInt32LE(stringCount, 8)
  head.writeUInt32LE(header.unused ?? 0, 12)
  head.writeUInt32LE(header.language ?? 0, 16)
  return Buffer.concat([Buffer.from(MAGIC_HEADER, 'latin1'), head, ...body])
}

async function loadCsf(file) {
  if (!existsSync(file)) throw new Error(`CSF file not found: ${file}`)
  return parseCsf(await readFile(file))
}

async function saveCsf(file, header, entries, backup) {
  if (backup !== false && existsSync(file)) await copyFile(file, `${file}.bak`)
  const data = serializeCsf(header, entries)
  const tmp = `${file}.tmp`
  await writeFile(tmp, data)
  await rename(tmp, file)
}

function validateLabel(label) {
  if (typeof label !== 'string' || label.length === 0) throw new Error('label must be a non-empty string')
  if (label.length > 255) throw new Error(`label too long: ${label}`)
  for (const ch of label) {
    const c = ch.charCodeAt(0)
    if (c < 0x20 || c > 0x7E) throw new Error(`label must be printable ASCII: ${JSON.stringify(label)}`)
  }
}

function entryView(entry) {
  return { label: entry.label, value: entry.value, extra: entry.extra, extraName: entry.extraName }
}

const textRender = (_args, value) => [{ type: 'text', text: value }]

// ---- plugin ------------------------------------------------------------

export function apply(ctx, config = {}) {
  const defaults = {
    csfPath: typeof config.csfPath === 'string' ? config.csfPath : '',
    editorPath: typeof config.editorPath === 'string' ? config.editorPath : '',
  }

  const resolveFile = (args) => {
    const file = typeof args.file === 'string' && args.file !== '' ? args.file : defaults.csfPath
    if (!file) throw new Error('no file given and no csfPath configured for this plugin')
    return file
  }

  ctx.effect(() => ctx.tools.register({
    name: 'csf_info',
    description: 'Read a Red Alert 2 CSF string table and return its header (version, language, entry counts) plus a few sample labels. Use this to inspect a .csf file before searching or editing it.',
    parameters: {
      file: { type: 'string', description: 'CSF file path; defaults to the configured ra2md.csf' },
    },
    output: { schema: { type: 'string' }, render: textRender },
    async execute(args) {
      const file = resolveFile(args)
      const { header, entries } = await loadCsf(file)
      return JSON.stringify({
        file,
        header: {
          version: header.version,
          language: header.language,
          languageName: LANGUAGES[header.language] ?? `code ${header.language}`,
        },
        entries: entries.length,
        withValue: entries.filter((e) => e.value !== null).length,
        withExtra: entries.filter((e) => e.extra !== null).length,
        firstLabels: entries.slice(0, 5).map((e) => e.label),
        lastLabels: entries.slice(-5).map((e) => e.label),
      }, null, 2)
    },
    presentCall: (args) => ({ card: 'generic', title: 'Read CSF table info', kind: 'read', rawInput: args }),
  }))

  ctx.effect(() => ctx.tools.register({
    name: 'csf_get',
    description: 'Get decoded entries (label, main value, extra value, extra name) from a CSF file by exact label name. Labels are ASCII names like "Name:BoomingCommander" or "MSG:PingInfo". Missing labels are reported separately, not an error.',
    parameters: {
      file: { type: 'string', description: 'CSF file path; defaults to the configured ra2md.csf' },
      labels: { type: 'array', items: { type: 'string' }, description: 'Exact label names to look up' },
    },
    output: { schema: { type: 'string' }, render: textRender },
    async execute(args) {
      if (!Array.isArray(args.labels) || args.labels.length === 0) throw new Error('labels array is required')
      const file = resolveFile(args)
      const { entries } = await loadCsf(file)
      const map = new Map(entries.map((e) => [e.label.toLowerCase(), e]))
      const found = []
      const missing = []
      for (const label of args.labels) {
        const entry = map.get(String(label).toLowerCase())
        if (entry) found.push(entryView(entry))
        else missing.push(String(label))
      }
      return JSON.stringify({ found, missing }, null, 2)
    },
    presentCall: (args) => ({ card: 'generic', title: 'Get CSF entries', kind: 'read', rawInput: args }),
  }))

  ctx.effect(() => ctx.tools.register({
    name: 'csf_search',
    description: 'Search a CSF string table. Query matches substrings of labels and/or decoded text (Chinese works because values are decoded automatically). Set exact: true to match a label exactly; leave query empty to page through all entries. Paginate with offset and limit (max 500).',
    parameters: {
      file: { type: 'string', description: 'CSF file path; defaults to the configured ra2md.csf' },
      query: { type: 'string', description: 'Substring to find, case-insensitive for ASCII. Empty lists entries' },
      field: { type: 'string', enum: ['label', 'value', 'extra', 'all'], description: 'Where to search; default all' },
      exact: { type: 'boolean', description: 'Match the label exactly instead of as a substring' },
      limit: { type: 'number', description: 'Max results per page; default 20, max 500' },
      offset: { type: 'number', description: 'Skip this many matches first' },
    },
    output: { schema: { type: 'string' }, render: textRender },
    async execute(args) {
      const file = resolveFile(args)
      const query = String(args.query ?? '').toLowerCase()
      const field = args.field ?? 'all'
      const limit = Math.min(500, Math.max(1, Math.trunc(args.limit ?? 20)))
      const offset = Math.max(0, Math.trunc(args.offset ?? 0))
      const { entries } = await loadCsf(file)
      const matches = []
      for (const entry of entries) {
        let hit = false
        if (args.exact === true) {
          if ((field === 'label' || field === 'all') && entry.label.toLowerCase() === String(args.query ?? '').toLowerCase()) hit = true
        } else if (query === '') {
          hit = true
        } else {
          if (!hit && (field === 'label' || field === 'all') && entry.label.toLowerCase().includes(query)) hit = true
          if (!hit && (field === 'value' || field === 'all') && entry.value !== null && entry.value.toLowerCase().includes(query)) hit = true
          if (!hit && (field === 'extra' || field === 'all') && entry.extra !== null && entry.extra.toLowerCase().includes(query)) hit = true
        }
        if (hit) matches.push(entryView(entry))
      }
      const page = matches.slice(offset, offset + limit)
      return JSON.stringify({
        total: matches.length,
        truncated: offset + limit < matches.length,
        offset,
        matches: page,
      }, null, 2)
    },
    presentCall: (args) => ({ card: 'generic', title: 'Search CSF strings', kind: 'read', rawInput: args }),
  }))

  ctx.effect(() => ctx.tools.register({
    name: 'csf_set',
    description: 'Set main values, extra values, or extra names of CSF entries and save the file immediately (a .bak copy of the previous file is written by default). Text is decoded game text; the RA2 complement encoding is applied automatically. Omit value/extra to keep them unchanged, or pass an empty string to clear them. Set create: true to add missing labels as new entries.',
    parameters: {
      file: { type: 'string', description: 'CSF file path; defaults to the configured ra2md.csf' },
      backup: { type: 'boolean', description: 'Write a .bak copy of the previous file before saving; default true' },
      create: { type: 'boolean', description: 'Create labels that do not exist yet instead of failing; default false' },
      entries: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            label: { type: 'string', required: true, description: 'Exact entry label, e.g. Name:BoomingCommander' },
            value: { type: 'string', description: 'New decoded text for the main value; omit to keep, empty string to clear' },
            extra: { type: 'string', description: 'New decoded text for the extra value (WRTS); omit to keep, empty string to clear' },
            extraName: { type: 'string', description: 'Extra value name, only meaningful when extra is set; omit to keep' },
          },
        },
        description: 'One object per entry to change',
      },
    },
    output: { schema: { type: 'string' }, render: textRender },
    async execute(args) {
      const patches = args.entries
      if (!Array.isArray(patches) || patches.length === 0) throw new Error('entries array is required')
      const file = resolveFile(args)
      const { header, entries } = await loadCsf(file)
      const map = new Map(entries.map((e, i) => [e.label.toLowerCase(), i]))
      const changed = []
      for (const patch of patches) {
        if (typeof patch?.label !== 'string') throw new Error('each entry needs a string label')
        validateLabel(patch.label)
        const key = patch.label.toLowerCase()
        let entry = map.has(key) ? entries[map.get(key)] : null
        if (!entry) {
          if (args.create !== true) throw new Error(`label not found: ${patch.label} (pass create: true to add it)`)
          entry = { label: patch.label, value: null, extra: null, extraName: null }
          entries.push(entry)
          map.set(key, entries.length - 1)
        }
        if (patch.value !== undefined) entry.value = patch.value === '' ? null : String(patch.value)
        if (patch.extra !== undefined) {
          entry.extra = patch.extra === '' ? null : String(patch.extra)
          if (entry.extra === null) entry.extraName = null
        }
        if (patch.extraName !== undefined && entry.extra !== null) entry.extraName = String(patch.extraName)
        changed.push(entryView(entry))
      }
      await saveCsf(file, header, entries, args.backup)
      return JSON.stringify({ saved: file, changed: changed.length, entries: changed }, null, 2)
    },
    presentCall: (args) => ({ card: 'generic', title: 'Edit CSF strings', kind: 'edit', rawInput: args }),
  }))

  ctx.effect(() => ctx.tools.register({
    name: 'csf_remove',
    description: 'Remove entries from a CSF file by exact label and save the file immediately (a .bak copy of the previous file is written by default). Labels that were not found are reported, not an error.',
    parameters: {
      file: { type: 'string', description: 'CSF file path; defaults to the configured ra2md.csf' },
      backup: { type: 'boolean', description: 'Write a .bak copy of the previous file before saving; default true' },
      labels: { type: 'array', items: { type: 'string' }, description: 'Exact label names to remove' },
    },
    output: { schema: { type: 'string' }, render: textRender },
    async execute(args) {
      if (!Array.isArray(args.labels) || args.labels.length === 0) throw new Error('labels array is required')
      const file = resolveFile(args)
      const { header, entries } = await loadCsf(file)
      const remove = new Set(args.labels.map(String))
      const kept = entries.filter((e) => !remove.has(e.label))
      const removed = entries.length - kept.length
      const missing = [...remove].filter((label) => !entries.some((e) => e.label === label))
      await saveCsf(file, header, kept, args.backup)
      return JSON.stringify({ saved: file, removed, missing }, null, 2)
    },
    presentCall: (args) => ({ card: 'generic', title: 'Remove CSF entries', kind: 'edit', rawInput: args }),
  }))

  ctx.effect(() => ctx.tools.register({
    name: 'csf_launch_editor',
    description: 'Launch RA2CStrEditor.exe, the GUI editor for RA2 CSF files, passing the CSF file path on its command line. The editor is a standalone Windows GUI app: this tool only starts it and reports the process id; it cannot read back what the user does in the GUI. Use it when the user wants to edit strings by hand.',
    parameters: {
      file: { type: 'string', description: 'CSF file path to open; defaults to the configured ra2md.csf' },
      editor: { type: 'string', description: 'Editor executable path; defaults to the configured RA2CStrEditor.exe' },
    },
    output: { schema: { type: 'string' }, render: textRender },
    async execute(args) {
      const editor = typeof args.editor === 'string' && args.editor !== '' ? args.editor : defaults.editorPath
      if (!editor) throw new Error('no editor configured and no editor given')
      if (!existsSync(editor)) throw new Error(`editor not found: ${editor}`)
      const file = resolveFile(args)
      if (!existsSync(file)) throw new Error(`CSF file not found: ${file}`)
      const child = spawn(editor, [file], { detached: true, stdio: 'ignore', windowsHide: false })
      child.unref()
      return JSON.stringify({
        launched: true,
        pid: child.pid,
        editor,
        file,
        note: 'The editor is a GUI app. If it does not open the file automatically, use its file dialog to open it manually.',
      }, null, 2)
    },
    presentCall: (args) => ({ card: 'generic', title: 'Open CSF in RA2CStrEditor', kind: 'execute', rawInput: args }),
  }))
}

export { parseCsf, serializeCsf, decodeText, encodeText }
