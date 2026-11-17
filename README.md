# dsh-ra2-csf

A [DeepSeek Harness](https://github.com/deepseek-ai) Host plugin for Red Alert 2 /
Yuri's Revenge **CSF string tables** (the format written by RA2CStrEditor).

## Tools

Agent tools, prefixed `csf_`:

| Tool | Purpose |
| --- | --- |
| `csf_info` | Header, language, entry counts, sample labels |
| `csf_get` | Decoded entries by exact label |
| `csf_search` | Substring search over labels and decoded text, paginated |
| `csf_set` | Update main / extra values or names, create entries, save (`.bak` backup) |
| `csf_remove` | Remove entries and save (`.bak` backup) |
| `csf_launch_editor` | Launch `RA2CStrEditor.exe` with the CSF file |

## Install

Requires DeepSeek Harness 0.2 or newer.

```bash
plugin_manager install_bundle target=github:AmahaHanasaki/dsh-ra2-csf
# or: plugin_manager install_bundle target=<path-to-this-repo>
```

## File format notes

- Header: `" FSC"` + version 3 + label count + string count + unused + language.
- Each entry: a `" LBL"` chunk (count, length, ASCII label) followed by exactly one of
  `" RTS"` (length + UTF-16LE value) or `"WRTS"` (length + UTF-16LE value + name length +
  ASCII name).
- Stored text uses the RA2 complement encoding: every UTF-16 unit is `0xFFFF -` the
  displayed Unicode code point. The plugin decodes on read and encodes on write, so the
  tools deal with plain readable text (Chinese included).

## Configuration

Edit the plugin row config in the profile:

| Key | Meaning |
| --- | --- |
| `csfPath` | Default CSF file used when a tool call omits `file` |
| `editorPath` | Default `RA2CStrEditor.exe` path used by `csf_launch_editor` |

Both are empty by default: pass absolute paths per tool call, or set them here once.
The external editor is optional; every read/write tool works without it.

## License

MIT
