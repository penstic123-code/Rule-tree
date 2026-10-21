# 截测试用 VS Code 的窗口（PrintWindow，窗口被挡住也能截）。
# 参数走环境变量（命令行参数里的中文路径会被代码页弄坏）：
#   RT_SHOT_OUT 输出 png；RT_CODE_DIR 测试用 VS Code 的目录。只截路径在 RT_CODE_DIR 下的 Code.exe，找不到就退出，绝不退回到别的窗口
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System; using System.Runtime.InteropServices;
public class RtWin {
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr dc, uint flags);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
}
"@
$out = $env:RT_SHOT_OUT; $dir = $env:RT_CODE_DIR
if (-not $out -or -not $dir -or $dir.Length -lt 10) { Write-Output "missing env"; exit 1 }
$p = Get-Process Code -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 -and $_.Path -and $_.Path.StartsWith($dir, [StringComparison]::OrdinalIgnoreCase) } | Select-Object -First 1
if (-not $p) { Write-Output "no test window"; exit 1 }
$r = New-Object RtWin+RECT
[void][RtWin]::GetWindowRect($p.MainWindowHandle, [ref]$r)
$w = $r.R - $r.L; $h = $r.B - $r.T
$bmp = New-Object System.Drawing.Bitmap $w, $h
$g = [System.Drawing.Graphics]::FromImage($bmp)
$dc = $g.GetHdc()
[void][RtWin]::PrintWindow($p.MainWindowHandle, $dc, 2)
$g.ReleaseHdc($dc); $g.Dispose()
$bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png); $bmp.Dispose()
Write-Output "ok ${w}x${h} pid=$($p.Id)"
