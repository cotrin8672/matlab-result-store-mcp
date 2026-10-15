$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
$inputData = ConvertFrom-Json -InputObject ([Console]::In.ReadToEnd())
$svgStream = $pngStream = $image = $bitmap = $null
try {
    $svgStream = [System.IO.MemoryStream]::new([System.Text.Encoding]::UTF8.GetBytes($inputData.svg))
    $pngStream = [System.IO.MemoryStream]::new([System.Convert]::FromBase64String($inputData.png))
    $image = [System.Drawing.Image]::FromStream($pngStream)
    $bitmap = [System.Drawing.Bitmap]::new($image)
    $pngStream.Position = 0
    $data = [System.Windows.Forms.DataObject]::new()
    $data.SetData('image/svg+xml', $false, $svgStream)
    $data.SetData('PNG', $false, $pngStream)
    $data.SetData([System.Windows.Forms.DataFormats]::Bitmap, $true, $bitmap)
    [System.Windows.Forms.Clipboard]::SetDataObject($data, $true)
} catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 1
} finally {
    foreach ($item in @($bitmap, $image, $pngStream, $svgStream)) {
        if ($null -ne $item) { $item.Dispose() }
    }
}
