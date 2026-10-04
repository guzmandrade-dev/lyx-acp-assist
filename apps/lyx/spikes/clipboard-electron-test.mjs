// Test Electron 43 async clipboard API for custom format writes.
import { app, clipboard, ClipboardItem } from 'electron';

app.whenReady().then(async () => {
  const payload = '#LyX 2.5 test write\n\\lyxformat 643\n\\begin_document\n\\begin_header\n\\end_header\n\n\\begin_body\n\n\\begin_layout Standard\nElectron clipboard write probe works\n\\end_layout\n\n\\end_body\n\\end_document\n';
  try {
    const entries = {
      'application/x-lyx': new Blob([new TextEncoder().encode(payload)]),
      'text/plain': 'Electron clipboard write probe works',
    };
    await clipboard.write([new ClipboardItem(entries)]);
    console.log('write: ok');

    // Read back through Electron.
    const has = await clipboard.has('application/x-lyx');
    console.log('has x-lyx:', has);
    const items = await clipboard.read();
    for (const item of items) {
      console.log('item types:', item.types.join(', '));
      for (const t of item.types) {
        const v = await item.getType(t);
        if (v instanceof Blob) {
          const buf = Buffer.from(await v.arrayBuffer());
          console.log(`  ${t}: <blob ${buf.length}b> ${buf.toString('utf8').slice(0, 60)}`);
        } else {
          console.log(`  ${t}: ${JSON.stringify(v).slice(0, 80)}`);
        }
      }
    }
  } catch (e) {
    console.error('write failed:', e);
  }
  app.quit();
});