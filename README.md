Turn bare URLs into Apple-style rich link cards — in Reading view, Live Preview, and Canvas.

Inspired by the link previews in Apple Freeform, Notes, and Bear: clean cards with adaptive layouts, dominant-color tinting, and offline image caching.


## Features

### Three adaptive layouts (like Apple's LinkPresentation)

The card layout is chosen automatically from the fetched image:

- **Large card** — big images render on top (1.91:1, portrait images crop to square), title and domain below
- **Compact card** — small images and icons render as a square thumbnail on the right
- **Text card** — no image at all: a slim row with favicon, title, and domain. No broken-image placeholders, ever.

<img width="1498" height="1510" alt="Kapture 2026-06-12 at 21 31 01" src="https://github.com/user-attachments/assets/9dbb8459-5cca-445b-a196-e9e259bfd4b0" />

### Canvas support

Pasting a URL onto a Canvas no longer embeds a live web page. The native link node is kept intact in the `.canvas` file (fully portable — disable the plugin and the native behavior returns), but its rendering is replaced with a card:

- Large images fill the node, Freeform-style
- Icon-only sites get an **icon card**: the dominant color fills the whole node, the icon floats in the center, and text color adapts (white on dark colors, dark on light)
- Double-click a card to open the link; single click/drag keeps the native select-and-move behavior
- The bare-URL node label is hidden (the card already shows title and domain)

<img width="1104" height="752" alt="截圖 2026-06-12 晚上9 34 23" src="https://github.com/user-attachments/assets/01ce02ca-3483-4921-8b0b-0fd91696c4e1" />


### Live Preview support

Cards render in the editor too, with embed-like ergonomics:

- **Click** a card to open the link
- **Hover** shows a pencil button (always visible on mobile) that reveals and selects the raw URL for editing — `Cmd/Ctrl+click` does the same
- Moving the cursor onto the line also reveals the raw URL; moving away restores the card
- While drag-selecting text, revealed URLs stay as plain text — no layout jumping mid-selection

### Dominant-color tinting

Each card extracts the representative color of its image (near-white/near-black filtered out, saturation-weighted) and applies it as a subtle 12% tint to the card background and border — adapting automatically to light and dark themes.

### Robust metadata fetching

- Five-level image resolution: `og:image` → `twitter:image` → `link[rel=image_src]` → lazy-load-aware content image scan (`data-src`, `srcset`, …) → `apple-touch-icon`
- Two-pass User-Agent retry for JavaScript-heavy sites
- Hotlink-protected CDN images (Instagram/Facebook/Twitter) are downloaded and stored locally as base64 — cards keep working offline and after CDN URLs expire
- Images over 300 KB are downscaled before caching
- Metadata, image data, dimensions, and tint colors are cached persistently; each URL is fetched once

### Threads (threads.net / threads.com) extras

- Dedicated fetch chain: oEmbed → Open Graph → JSON-LD → CDN scan
- Post text is shown on the card (for Threads, the description *is* the content)
- Pasting a Threads link in the editor auto-inserts the post text on the next line

## Usage

Paste a URL on its own line (Reading view / Live Preview), or paste a URL onto a Canvas. That's it — the card renders automatically.

**Command:** `Clear link card cache` — wipes cached metadata and images (useful after a site changes its preview image).

## Settings

- **Auto-insert Threads post text** (default: on) — when pasting a Threads link in the editor, the post text is fetched and inserted on the line below the link. Turn this off if you prefer the bare link only.

## Network usage disclosure

To build a card, this plugin makes network requests to:

1. **The URL you paste** (and, for Threads links, the public Threads oEmbed endpoint) — to read page metadata and download the preview image
2. **Google's favicon service** (`www.google.com/s2/favicons`) — to display the site's favicon on the card

No data is sent anywhere else. No analytics, no telemetry. Fetched metadata and images are stored locally in the plugin's `data.json` inside your vault.

## Installation

### From the Community plugin directory

Search for "Link Card Preview" in Settings → Community plugins.

### Manual

Copy `main.js`, `manifest.json`, and `styles.css` into `<your vault>/.obsidian/plugins/link-card-preview/`, then enable the plugin in Settings.

## Notes & limitations

- Sites that render entirely client-side and expose no metadata in their HTML will fall back to a text card (the same limit applies to Apple's own link previews without a logged-in session)
- Inside fenced code blocks, a bare URL on its own line will currently still render as a card in Live Preview
- Dominant-color tinting on directly-linked (non-cached) images requires the host to allow cross-origin reads; otherwise the card stays untinted

## License

MIT
