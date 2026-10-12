// Probe 2: write the RAW OS format via Electron's osclipboard escape hatch
// vs. the Web-Custom-Format default, and compare bytes LyX would see.
import { app, clipboard, ClipboardItem } from 'electron';
import { execFileSync } from 'node:child_process';

const payload =
  '#LyX 2.5 test write\n\\lyxformat 643\n\\begin_document\n\\begin_header\n\\end_header\n\n\\begin_body\n\n\\begin_layout Standard\nRaw osclipboard probe works\n\\end_layout\n\n\\end_body\n\\end_document\n';

app.whenReady().then(async () => {
  const bytes = Buffer.from(payload, 'utf8');
  const osFormat = 'electron application/osclipboard;format="application/x-lyx"';
  try {
    await clipboard.write([
      new ClipboardItem({
        'text/plain': 'Raw osclipboard probe works',
        [osFormat]: new Blob([new Uint8Array(bytes)]),
      }),
    ]);
    console.log('write via osclipboard MIME: ok');
  } catch (e) {
    console.error('write failed:', e);
  }

  // Dump what a native app sees, via PowerShell (WinForms).
  try {
    const out = execFileSync(
      'powershell',
      [
        '-NoProfile', '-STA', '-Command',
        `Add-Type -AssemblyName System.Windows.Forms; ` +
        `$d=[System.Windows.Forms.Clipboard]::GetDataObject(); ` +
        `if ($d.GetData('application/x-lyx')) { $s=New-Object IO.StreamReader($d.GetData('application/x-lyx')); $s.BaseStream.Position=0; $s.ReadToEnd().Length } else { 'MISSING' }`,
      ],
      { encoding: 'utf8' },
    );
    console.log('native x-lyx byte length (expect ' + bytes.length + '):', out.trim());
  } catch (e) {
    console.error('native inspect failed:', e.message);
  }
  app.quit();
});