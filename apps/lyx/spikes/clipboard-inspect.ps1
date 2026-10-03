Add-Type -AssemblyName System.Windows.Forms
$do = [System.Windows.Forms.Clipboard]::GetDataObject()
"=== formats ==="
$do.GetFormats() | ForEach-Object { $_ }
"=== content ==="
foreach ($f in $do.GetFormats()) {
  $d = $do.GetData($f, $true)
  if ($d -is [string]) {
    "--- $f (string) ---"
    $d
  } elseif ($d -is [System.IO.MemoryStream]) {
    "--- $f (stream, $($d.Length) bytes) ---"
    $r = New-Object System.IO.StreamReader($d)
    $r.BaseStream.Position = 0
    $txt = $r.ReadToEnd()
    if ($txt.Length -gt 4000) { $txt = $txt.Substring(0, 4000) + ' ...<truncated>' }
    $txt
  } elseif ($d -is [System.IO.Stream]) {
    "--- $f (stream, $($d.Length) bytes) ---"
    $r = New-Object System.IO.StreamReader($d)
    $r.BaseStream.Position = 0
    $txt = $r.ReadToEnd()
    if ($txt.Length -gt 3000) { $txt = $txt.Substring(0, 3000) + ' ...<truncated>' }
    $txt
  } else {
    "--- $f ($($d.GetType().Name)) ---"
    $d
  }
}