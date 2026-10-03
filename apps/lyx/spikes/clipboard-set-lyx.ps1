# Spike 2 (reverse): put application/x-lyx content on the clipboard,
# then LyX pastes it as rich, structured content.
param([string]$Body = @'
\begin_layout Standard
\emph on
Structured
\emph default
 clipboard paste works with rich content
\end_layout
'@)

$header = @'
#LyX 2.5 created this file. For more info see https://www.lyx.org/
\lyxformat 643
\begin_document
\begin_header
\save_transient_properties true
\origin unavailable
\textclass article
\use_default_options true
\maintain_unincluded_children no
\language american
\language_package default
\inputencoding utf8
\fontencoding auto
\font_roman "default" "default"
\font_sans "default" "default"
\font_typewriter "default" "default"
\font_math "auto" "auto"
\font_default_family default
\use_non_tex_fonts false
\use_microtype false
\use_dash_ligatures true
\graphics default
\default_output_format default
\output_sync 0
\papersize default
\use_geometry false
\use_package amsmath 1
\use_package amssymb 1
\cite_engine basic
\use_bibtopic false
\use_indices false
\paperorientation portrait
\secnumdepth 3
\tocdepth 3
\paragraph_separation indent
\paragraph_indentation default
\is_math_indent 0
\math_numbering_side default
\quotes_style english
\dynamic_quotes 0
\papercolumns 1
\papersides 1
\paperpagestyle default
\tablestyle default
\tracking_changes false
\output_changes false
\change_bars false
\end_header

\begin_body

'@

$footer = @'

\end_body
\end_document
'@

$doc = $header + $Body + $footer

Add-Type -AssemblyName System.Windows.Forms
$data = New-Object System.Windows.Forms.DataObject
# LyX expects raw UTF-8 bytes for this format (it exposes it as a stream).
$bytes = [System.Text.Encoding]::UTF8.GetBytes($doc)
$stream = New-Object System.IO.MemoryStream
$stream.Write($bytes, 0, $bytes.Length)
$stream.Position = 0
$data.SetData('application/x-lyx', $stream)
# Also offer plain text so anything can fall back.
$data.SetText('Structured clipboard paste works with rich content')
[System.Windows.Forms.Clipboard]::SetDataObject($data, $true)
Write-Host 'clipboard set with application/x-lyx payload (UTF-8 stream)'