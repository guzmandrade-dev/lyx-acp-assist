/**
 * Curated LyX markup knowledge attached to agent prompts.
 *
 * LLMs know LaTeX well but NOT the .lyx internal format. This cheat-sheet
 * closes that gap (the "specialize the agent" piece, in the spirit of
 * domain-focused tools like WordPress Studio): every construct here was
 * verified against LyX 2.5 output. Keep it short — it ships with every
 * Insert/Rewrite prompt.
 */

export const LYX_MARKUP_KNOWLEDGE = `LyX internal markup (.lyx) cheat-sheet — you MUST follow these conventions:

STRUCTURE
- Paragraphs are: \\begin_layout <Name>\\n...content...\\n\\end_layout
- Common layout names: Standard, Section, Subsection, Itemize, Enumerate, Description, Quote.
- Lists: wrap items in \\begin_deeper ... \\end_deeper inside the list layout.
- Escape a literal backslash in text as \\backslash on its own line.

EMPHASIS (token format, NEVER LaTeX \\emph{...})
  \\emph on
  emphasized text
  \\emph default
   normal text continues
Similarly: \\series bold on ... \\series default; \\shape italic on ... \\shape default.

MATH (inline)
  \\begin_inset Formula $x^2 + y^2$
  \\end_inset

FOOTNOTE
  \\begin_inset Foot
  status collapsed

  \\begin_layout Plain Layout
  The footnote text.
  \\end_layout

  \\end_inset

NOTE (the yellow inset)
  \\begin_inset Note Note
  status open

  \\begin_layout Plain Layout
  The note text.
  \\end_layout

  \\end_inset

URL / HYPERLINK
  \\begin_layout Standard
  See
  \\begin_inset Flex URL
  status collapsed

  \\begin_layout Plain Layout
  https://example.org
  \\end_layout

  \\end_inset
   for details.
  \\end_layout

CITATION (bibliography reference — use the keys in \\bibliography or cite insets already in the document)
  \\begin_inset CommandInset citation
  LatexCommand citep
  key "author2024"

  \\end_inset

  (Other LatexCommand values: citet, citeauthor, citeyear. Use a real key
  from the document; never invent one.)

NAMED REFERENCE TO A LABEL
  \\begin_inset CommandInset ref
  LatexCommand formatted
  reference "sec:method"

  \\end_inset

EVERY \\begin_inset with a body (Note, Foot, URL, ...) MUST contain a
\\begin_layout Plain Layout ... \\end_layout block inside it — an inset
without its inner layout renders EMPTY in LyX.`;

/** Full knowledge base for Chat context (includes addressing rules). */
export const CHAT_KNOWLEDGE = `${LYX_MARKUP_KNOWLEDGE}

ADDRESSING
- The document outline lists paragraphs as [pN] ids with layouts.
- To suggest an edit, quote the [pN] id and show the replacement in a
  \`\`\`lyx fenced block.`;