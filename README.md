# @pipeworx/iowa-code

Iowa Code — state statutes by citation, historical edition, amendment
history, and chapter/section topic search. Keyless.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1881+ live data sources. This is an independent, unofficial integration — not affiliated with, endorsed by, or published by the upstream provider.

## Tools

- `ia_code_section(section, year?)` — full text of an Iowa Code section by
  citation ("714.2" is degrees of theft; "321J.2" is OWI). Returns the
  statute text, its amendment `history` and `referred_to_in` cross-references
  as separate fields, and (via `year`) a historical edition back to 2000.
- `ia_code_titles()` — the 16 titles of the Code with official names and
  chapter-number ranges, for routing a subject to the right chapter range.
- `ia_code_search(query, limit?)` — topic/keyword search over the Code's
  own official chapter and section captions (not full statutory text — see
  below), returning matching citations.

## Auth

Keyless.

## The survey trap did not apply here

The August state-law survey's recorded trap was "published only as PDF" —
but legis.iowa.gov serves every chapter of the Iowa Code as a plain RTF
file, for every archived year (2000, then 2004 through the current year;
2001-2003 are genuinely missing from the site's own year picker):

```
https://www.legis.iowa.gov/docs/code/2026/714.rtf   (current edition)
https://www.legis.iowa.gov/docs/code/2015/714.rtf   (a historical edition)
```

A cleaner per-chapter XML export also exists
(`/docs/publications/ICC/2026/attachments/714_slim.xml`), but
verified live 2026-10-06 it 404s for every year except the current one —
even though the chapter-listing page for every past year keeps linking it.
That is a dead link on the Legislature's own site, not a probe mistake. RTF
is therefore the one path used here, for every year including the current
one, decoded by a small dependency-free RTF-to-text reader written for this
file shape (`shared/src/statute-rtf.ts`, verified against both the 2026 and
2015 editions of chapter 714).

(Note for anyone cross-referencing today's batch: Kentucky landed a
dependency-free PDF extractor the same day, `shared/src/pdf-text.ts`. Iowa
never needed it — RTF covers every year here — but it's the thing to reach
for if a future state really is PDF-only.)

## Citations

Iowa cites by chapter.section, e.g. "714.2" (degrees of theft) or "321J.2"
(OWI). The chapter is the part before the dot and may itself carry letters
("714A", "6B", "321J") — not every chapter is a bare number.

## Topic search is caption search, not full text

Iowa does not publish a general subject index of the Code (verified
2026-10-06: no `INDEX.pdf`/`index.pdf` under `/docs/code/2026/`), and the
Iowa Legislature's own publications search engine does not index Code
section text at all — its own facet tree covers bills, fiscal notes,
administrative bulletins and rules, but has no "Iowa Code" category.
`ia_code_search` instead matches a query against the official chapter and
section CAPTIONS every listing page already carries ("714 - THEFT, FRAUD,
AND RELATED OFFENSES", "714.1 - Theft defined.") — real, live, and
self-updating, but bounded by whatever words the Legislature chose for a
caption. A plain-language query that doesn't share vocabulary with the
official caption (e.g. "security deposit" vs. the statute's own "rental
deposits") can rank a false-positive chapter above the right one; the tool
description says so.

## Data sources

- `https://www.legis.iowa.gov/docs/code/2026/714.rtf` — the full text of
  one chapter (here, chapter 714, the current edition — swap the year and
  chapter number for any other). `ia_code_section` cuts one section out of
  this.
- `https://www.legis.iowa.gov/law/iowaCode/chapters?title=XVI&year=2026` —
  chapter captions for one of the Code's 16 titles (here, title XVI). `ia_code_search`'s
  first pass.
- `https://www.legis.iowa.gov/law/iowaCode/sections?codeChapter=714&year=2026`
  — section captions for one chapter. `ia_code_search`'s drill-down pass.

All three are plain, keyless, server-rendered HTML/RTF — no login, no JS,
no rate-limit observed during development.

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "iowa-code": {
      "url": "https://gateway.pipeworx.io/iowa-code/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/iowa-code/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1881+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## No MCP client? Call it over HTTP

```bash
curl -X POST https://gateway.pipeworx.io/v1/tools/ia_code_section \
  -H 'Content-Type: application/json' \
  -d '{"section":"714.2"}'
```

No account needed for the first calls. Inspect any tool: `GET https://gateway.pipeworx.io/v1/tools/ia_code_section`. Find one: `POST https://gateway.pipeworx.io/v1/tools/search_packs` with `{"query":"..."}`.

## Standalone (no gateway account)

This package also runs as a local stdio MCP server — no Pipeworx account, no
gateway round-trip:

```json
{
  "mcpServers": {
    "iowa-code": {
      "command": "npx",
      "args": ["-y", "@pipeworx/mcp-iowa-code"]
    }
  }
}
```

Or run it directly to confirm it starts:

```bash
npx -y @pipeworx/mcp-iowa-code
```

It speaks MCP over stdin/stdout and answers `initialize`/`tools/list`/`tools/call`
for **only** this pack's tools — none of the shared meta-tools the gateway
connection above adds. Same source, same tools, no ask_pipeworx routing.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Iowa Code data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
