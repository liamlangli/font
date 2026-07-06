# @liamlangli/font

`@liamlangli/font` provides the `ufont` CLI for generating BMFont-compatible single-image WebP bitmap font atlases from `ttf`, `otf`, or `woff` files using signed distance fields.

## Install

Install dependencies first:

```bash
npm install
```

Run the CLI locally with Node:

```bash
node cli.js ./path/to/font.ttf
```

Or install/link the package so the `ufont` command is available on your machine:

```bash
npm install --global .
```

Then run:

```bash
ufont ./path/to/font.ttf
```

## Basic Usage

```bash
ufont [options] <font-file>
```

Example:

```bash
ufont ./public/font/Lato.ttf
```

This generates:

- A single lossless WebP bitmap atlas, such as `Lato.webp`
- A font metadata file, such as `Lato.json` or `Lato.fnt`
- An optional config file when `--reuse` is enabled
- Optional SVG debug output when `--vector` is enabled

## Common Examples

Generate JSON output:

```bash
ufont -f json ./public/font/Lato.ttf
```

Write output under a custom base filename:

```bash
ufont -o ./dist/LatoAtlas ./public/font/Lato.ttf
```

Use a custom charset file:

```bash
ufont -i ./charset.txt ./public/font/Lato.ttf
```

Use the built-in Simplified Chinese charset:

```bash
ufont --charset zh_cn ./public/font/Lato.ttf
```

Generate an atlas with custom glyph size, target texture shape, and padding:

```bash
ufont -s 64 -m 1024,1024 -p 2 -b 4 ./public/font/Lato.ttf
```

Save reusable settings to a config file:

```bash
ufont -u ./lato.cfg ./public/font/Lato.ttf
```

## CLI Options

| Option | Description | Default |
| --- | --- | --- |
| `-f, --output-type <format>` | Output metadata format: `xml`, `json`, or `txt` | `json` in CLI parsing, internal fallback is `xml` |
| `--image-type <format>` | Texture image format: `webp` or `png` | `webp` |
| `-o, --filename <atlas_path>` | Output base filename for atlas images; font filename is derived from the font face name | font file directory + font face |
| `-s, --font-size <fontSize>` | Glyph render size | `42` |
| `-c, --charset <preset>` | Built-in charset preset. Currently supports `zh_cn` (`en_common` + `zh_cn_3500`) | ASCII fallback |
| `-i, --charset-file <charset>` | Text file containing characters to include | ASCII fallback |
| `-m, --texture-size <w,h>` | Preferred atlas shape as `width,height`; the generator may resize to keep one efficient image | `2048,2048` from CLI |
| `-p, --texture-padding <n>` | Padding between glyphs | `1` |
| `-b, --border <n>` | Space between atlas edge and packed glyphs | `0` |
| `-r, --distance-range <n>` | SDF pixel range | `4` |
| `-t, --field-type <type>` | Distance field type: `msdf`, `sdf`, or `psdf` | `msdf` |
| `-d, --round-decimal <digit>` | Round numeric values in output metadata | `0` |
| `-v, --vector` | Write SVG debug files for atlas pages | `false` |
| `-u, --reuse [file.cfg]` | Save or reuse generation settings from a config file | `false` |
| `--smart-size` | Auto-size the single atlas for better pixel usage | `true` |
| `--pot` | Force atlas dimensions to powers of two after packing; generally unnecessary | `false` |
| `--square` | Force atlas dimensions to be square | `false` |
| `--rot` | Allow 90-degree glyph rotation while packing | `false` |
| `--rtl` | Enable RTL character fixes | `false` |

## Output Behavior

- The output metadata file is written as `<font-face>.json` when `-f json` is used.
- Non-JSON formats are written as `<font-face>.fnt`.
- The texture is written beside the source font by default unless `-o` points elsewhere.
- The generator always packs into one texture. It scans non-power-of-two atlas sizes, prefers a near-square compact result, and writes lossless WebP by default.

## Charset Files

When `-c/--charset zh_cn` is provided, the CLI uses `charset/en_common.txt` plus `charset/zh_cn_3500.txt` as the glyph set. When `-i/--charset-file` is provided, the file contents are used as the glyph set. If no charset option is supplied, the CLI falls back to printable ASCII characters.

Example `charset.txt`:

```text
ABCDEFGHIJKLMNOPQRSTUVWXYZ
abcdefghijklmnopqrstuvwxyz
0123456789
!?.,:;+-=*/()[]{}<>
```

## Notes

- The CLI shells out to the bundled `msdfgen` binary under `bin/`, so generation is platform-dependent.
- This workspace currently does not have installed Node dependencies, so `node cli.js -h` will fail until `npm install` is run.
