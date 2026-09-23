<#
.SYNOPSIS
  Extracts text from a scanned/image-only PDF using Chrome's built-in on-device OCR,
  by driving a real Chrome window with genuine OS-level input (not the DevTools protocol).

.NOTES
  Uses the real default Chrome profile, NOT a throwaway one - Chrome's on-device PDF OCR
  is a downloaded model component tied to the profile, and a brand-new profile doesn't
  have it available yet (confirmed empirically: OCR never kicks in against a fresh
  --user-data-dir within a single run).

  This drives the actual visible desktop (real mouse/keyboard), not an isolated headless
  browser - the workaround exists because Playwright/CDP-driven Chrome cannot read files
  through the Y: (Egnyte virtual/CBFS) drive the same way a normal foreground process can,
  and separately, DevTools-protocol automation was blocked here by an org Chrome policy.

  Some files on Y: intermittently give Chrome ERR_FILE_NOT_FOUND even when a plain local
  read of the same file succeeds moments earlier (confirmed: not a quoting bug, not fixed
  by pre-warming via File.ReadAllBytes) - looks like a Chrome-sandbox/Egnyte-CBFS
  incompatibility for a subset of files. If the direct path errors out, this retries once
  against a local temp copy. If that ALSO errors out, it throws an error prefixed
  "PERSISTENT_ACCESS_FAILURE:" so the caller can mark the document as needing manual
  attention instead of retrying it forever.

  IMPORTANT: because every run shares the real default Chrome profile (required for OCR to
  work at all), a new invocation can hand off to an ALREADY-RUNNING Chrome process instead
  of spawning a fresh one - Start-Process's returned PID is then just a short-lived stub,
  not the process that actually owns the window. Closing "$proc.Id" in that case closes
  nothing, and the real window leaks. So: the actual owning PID is always resolved from the
  window handle itself (GetWindowThreadProcessId), the window is closed individually via
  WM_CLOSE (not by killing a process - that process may also own the user's own tabs), and
  closure is verified with IsWindow before moving on.
#>
param(
    [Parameter(Mandatory=$true)][string]$PdfPath,
    [Parameter(Mandatory=$true)][string]$OutFile,
    [int]$MaxOcrWaitSeconds = 150,
    [int]$PollIntervalSeconds = 3,
    [int]$MaxZeroPolls = 6
)

$ErrorActionPreference = "Stop"
$sw = [System.Diagnostics.Stopwatch]::StartNew()
function Mark([string]$label) { Write-Host ("[{0,6}ms] {1}" -f $sw.ElapsedMilliseconds, $label) }

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

Add-Type @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public struct RECT { public int Left, Top, Right, Bottom; }
public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
public class Win32Input {
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
    [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, UIntPtr dwExtraInfo);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
    [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr hWnd);
    [DllImport("user32.dll", CharSet = CharSet.Auto)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
    [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();

    public const uint WM_CLOSE = 0x0010;

    public static List<IntPtr> FindVisibleTopLevelWindowsForProcessName(string processName) {
        var handles = new List<IntPtr>();
        EnumWindows((hWnd, lParam) => {
            if (!IsWindowVisible(hWnd)) return true;
            if (GetWindowTextLength(hWnd) == 0) return true;
            uint pid;
            GetWindowThreadProcessId(hWnd, out pid);
            try {
                var p = System.Diagnostics.Process.GetProcessById((int)pid);
                if (string.Equals(p.ProcessName, processName, StringComparison.OrdinalIgnoreCase)) {
                    handles.Add(hWnd);
                }
            } catch { }
            return true;
        }, IntPtr.Zero);
        return handles;
    }
}
"@

function Click-InWindow([IntPtr]$hWnd) {
    $rect = New-Object RECT
    [Win32Input]::GetWindowRect($hWnd, [ref]$rect) | Out-Null
    $x = $rect.Left + [int](($rect.Right - $rect.Left) * 0.5)
    $y = $rect.Top + [int](($rect.Bottom - $rect.Top) * 0.6)  # below toolbar/tab bar
    [Win32Input]::SetCursorPos($x, $y) | Out-Null
    Start-Sleep -Milliseconds 80
    [Win32Input]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)  # left down
    Start-Sleep -Milliseconds 30
    [Win32Input]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)  # left up
}

function Get-RealOwningPid([IntPtr]$hWnd) {
    [uint32]$realPid = 0
    [Win32Input]::GetWindowThreadProcessId($hWnd, [ref]$realPid) | Out-Null
    return [int]$realPid
}

function Get-ChromeWindows() {
    return [Win32Input]::FindVisibleTopLevelWindowsForProcessName("chrome")
}

function Get-WindowTitle([IntPtr]$hWnd) {
    $len = [Win32Input]::GetWindowTextLength($hWnd)
    if ($len -eq 0) { return "" }
    $sb = New-Object System.Text.StringBuilder ($len + 1)
    [Win32Input]::GetWindowText($hWnd, $sb, $sb.Capacity) | Out-Null
    return $sb.ToString()
}

# Closes exactly this one window (WM_CLOSE, like clicking its X button) and verifies it's
# actually gone - never kills a process, since that process may also own the user's own
# Chrome tabs (every run shares the real default profile).
function Close-WindowAndVerify([IntPtr]$hWnd) {
    if (-not [Win32Input]::IsWindow($hWnd)) { return $true }
    [Win32Input]::PostMessage($hWnd, [Win32Input]::WM_CLOSE, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null
    $deadline = (Get-Date).AddSeconds(5)
    while ((Get-Date) -lt $deadline) {
        if (-not [Win32Input]::IsWindow($hWnd)) { return $true }
        Start-Sleep -Milliseconds 200
    }
    return -not [Win32Input]::IsWindow($hWnd)
}

$wshell = New-Object -ComObject WScript.Shell

# THE critical safety check. AppActivate-by-PID is ambiguous the moment more than one
# window shares that PID (which is always true here - every run hands off to the same
# long-lived Chrome process). Worse, even a "successful" activation doesn't guarantee the
# subsequent real OS click lands on the right window: the click fires at $hWnd's on-screen
# coordinates, and if a stale/leaked window happens to be sitting on top of that same
# screen position, the click focuses THAT window instead - and everything downstream
# (Ctrl+A, Ctrl+C) silently operates on the wrong document. This is confirmed as the actual
# cause of real cross-document text contamination in production data, not a theoretical risk.
#
# Fix: activate by the window's own resolved title (unique per document, unlike PID), then
# verify GetForegroundWindow() actually equals our exact tracked handle before proceeding.
# Retries a few times; if it never achieves the correct focus, returns $false rather than
# ever letting a click/copy proceed against an unverified window.
function Set-VerifiedFocus([IntPtr]$hWnd, [string]$title) {
    for ($attempt = 0; $attempt -lt 4; $attempt++) {
        $wshell.AppActivate($title) | Out-Null
        Start-Sleep -Milliseconds 200
        if ([Win32Input]::GetForegroundWindow() -eq $hWnd) { return $true }
        Start-Sleep -Milliseconds 300
    }
    return $false
}

# Returns @{ Text = <string>; Valid = <bool> }. Valid=$false means we could not positively
# verify the target window was actually focused before clicking/copying - the clipboard
# content, if any, must NOT be trusted in that case (this is exactly how earlier runs
# silently copied text from a different, still-open window instead of the intended one).
function Get-CopiedText([IntPtr]$hWnd, [string]$title) {
    [System.Windows.Forms.Clipboard]::Clear()
    $focused = Set-VerifiedFocus $hWnd $title
    if (-not $focused) {
        Write-Host "  (could not verify window focus - discarding this poll)"
        return @{ Text = ""; Valid = $false }
    }
    Click-InWindow $hWnd
    Start-Sleep -Milliseconds 150
    # Re-verify after the click too - the click itself is a real OS click at a screen
    # coordinate and could still focus something else if window stacking changed.
    if ([Win32Input]::GetForegroundWindow() -ne $hWnd) {
        Write-Host "  (focus changed after click - discarding this poll)"
        return @{ Text = ""; Valid = $false }
    }
    $wshell.SendKeys("^a")
    Start-Sleep -Milliseconds 150
    $wshell.SendKeys("^c")
    Start-Sleep -Milliseconds 300
    $clip = ""
    try { $clip = Get-Clipboard -Raw -ErrorAction Stop } catch {}
    if (-not $clip) { $clip = "" }
    return @{ Text = $clip; Valid = $true }
}

$ErrorPageSignatures = @("ERR_FILE_NOT_FOUND", "couldn’t be accessed", "couldn't be accessed", "ERR_ACCESS_DENIED", "This site can’t be reached", "This site can't be reached")

function Test-ErrorPageText([string]$text) {
    foreach ($sig in $ErrorPageSignatures) {
        if ($text -like "*$sig*") { return $true }
    }
    return $false
}

# Runs the full open-scroll-wait-copy cycle against $targetPath. Returns the extracted
# text. Throws "ERROR_PAGE: ..." specifically when Chrome showed an error page, so the
# caller can distinguish "try the local-copy fallback" from other failure types.
function Invoke-ChromeOcr([string]$targetPath) {
    [System.Windows.Forms.Clipboard]::Clear()
    # Never trust Start-Process's returned PID for window identification: when Chrome is
    # already running under this profile (very likely - it's the user's real profile),
    # --new-window hands off to that existing process and the launched process exits
    # immediately without ever owning a window. Instead, diff the set of visible Chrome
    # windows before/after launch to find whichever one is actually new.
    $windowsBefore = Get-ChromeWindows
    $argString = "--new-window --no-first-run --no-default-browser-check " +
        "--disable-session-crashed-bubble --disable-restore-session-state " +
        "`"$targetPath`""

    Mark "launching chrome (windows open before: $($windowsBefore.Count))"
    Start-Process -FilePath "C:\Program Files\Google\Chrome\Application\chrome.exe" -ArgumentList $argString | Out-Null

    $hWnd = [IntPtr]::Zero
    $deadline = (Get-Date).AddSeconds(15)
    while ($hWnd -eq [IntPtr]::Zero) {
        Start-Sleep -Milliseconds 150
        $current = Get-ChromeWindows
        $newOnes = $current | Where-Object { $windowsBefore -notcontains $_ }
        if ($newOnes -and $newOnes.Count -gt 0) { $hWnd = $newOnes[0] }
        if ($hWnd -eq [IntPtr]::Zero -and (Get-Date) -gt $deadline) { throw "Chrome window never appeared" }
    }
    $realPid = Get-RealOwningPid $hWnd
    Mark "new window found: $hWnd (real owning pid: $realPid)"

    # Poll title instead of a blind sleep - "Untitled - Google Chrome" until the PDF
    # finishes its initial load, then it flips to the filename.
    $deadline = (Get-Date).AddSeconds(15)
    while ((Get-WindowTitle $hWnd) -eq "" -or (Get-WindowTitle $hWnd) -eq "Untitled - Google Chrome") {
        Start-Sleep -Milliseconds 100
        if ((Get-Date) -gt $deadline) { break }
    }
    $title = Get-WindowTitle $hWnd
    Mark "PDF loaded, title: $title"
    if ($title -eq "" -or $title -eq "Untitled - Google Chrome") {
        throw "Chrome window never resolved a real title - can't safely target it for focus"
    }

    # Everything from here on must close/verify the window on the way out no matter how this
    # block exits (normal completion, OCR_NEVER_STARTED, window-closed-unexpectedly, etc.) -
    # a bare throw partway through the polling loop would otherwise skip cleanup entirely and
    # leak exactly the kind of open window this script exists to prevent.
    $clip = ""
    try {
        if (-not (Set-VerifiedFocus $hWnd $title)) {
            throw "Could not verify window focus before scrolling"
        }
        Click-InWindow $hWnd
        $wshell.SendKeys("^{END}")
        Mark "sent Ctrl+End to scroll to bottom"

        # Poll for OCR completion by repeatedly select-all + copy + checking clipboard,
        # instead of a fixed guessed wait - self-tunes per document instead of guessing a
        # duration. Stop once a poll returns a non-empty length equal to the previous one.
        #
        # Separately: Chrome's on-device OCR sometimes just never engages for a document at
        # all (observed directly - the PDF is visibly loaded, but nothing ever gets
        # selected). That looks identical to "still working" for the first few polls, but
        # unlike a real-but-slow extraction it never produces ANY text, not even a partial
        # amount - so a run of consecutive exact-zero polls bails out early ($MaxZeroPolls)
        # instead of always waiting out the full $MaxOcrWaitSeconds. This is a normal,
        # retryable outcome, not an error page.
        $prevLen = -1
        $stableCount = 0
        $zeroCount = 0
        $pollDeadline = (Get-Date).AddSeconds($MaxOcrWaitSeconds)
        while ((Get-Date) -lt $pollDeadline) {
            Start-Sleep -Seconds $PollIntervalSeconds

            if (-not [Win32Input]::IsWindow($hWnd)) { throw "Chrome window closed unexpectedly during OCR polling" }

            $result = Get-CopiedText $hWnd $title
            if (-not $result.Valid) {
                Mark "poll: SKIPPED (could not confirm Chrome window was active)"
                continue
            }
            $clip = $result.Text
            Mark "poll: clipboard length = $($clip.Length)"

            if ($clip.Length -eq 0) {
                $zeroCount++
                if ($zeroCount -ge $MaxZeroPolls) {
                    Mark "OCR never produced any text after $zeroCount polls - giving up early"
                    throw "OCR_NEVER_STARTED: Chrome's on-device OCR did not engage for this document"
                }
            } else {
                $zeroCount = 0
            }

            if ($clip.Length -gt 0 -and $clip.Length -eq $prevLen) {
                $stableCount++
                if ($stableCount -ge 1) { break }
            } else {
                $stableCount = 0
            }
            $prevLen = $clip.Length
        }
        Mark "OCR polling done, final length: $($clip.Length)"
    } finally {
        $closed = Close-WindowAndVerify $hWnd
        $windowsAfterCount = (Get-ChromeWindows).Count
        Mark "window close verified: $closed (windows open after: $windowsAfterCount)"
        if (-not $closed) {
            Write-Host "  *** WARNING: window did not close - it may be left open on screen ***"
        }
        if ($windowsAfterCount -gt $windowsBefore.Count) {
            Write-Host "  *** WARNING: chrome window count grew ($($windowsBefore.Count) -> $windowsAfterCount) - possible leak ***"
        }
    }

    # Reject Chrome's own error-page text (ERR_FILE_NOT_FOUND and friends) - it's short and
    # perfectly stable across polls, so it otherwise looks exactly like a finished, tiny
    # extraction (confirmed: this silently corrupted 66 documents before this check existed).
    if (Test-ErrorPageText $clip) {
        throw "ERROR_PAGE: Chrome showed an error page instead of the PDF (captured: $($clip.Substring(0, [Math]::Min(120, $clip.Length))))"
    }
    if (-not $clip) {
        throw "OCR produced no text within $MaxOcrWaitSeconds seconds"
    }
    return $clip
}

$clip = $null
try {
    $clip = Invoke-ChromeOcr $PdfPath
} catch {
    if ($_.Exception.Message -notlike "ERROR_PAGE:*") { throw }

    Write-Host "direct path failed with an error page - retrying against a local copy..."
    $localPath = Join-Path $env:TEMP ("chrome_ocr_src_" + [guid]::NewGuid().ToString() + ".pdf")
    try {
        Copy-Item -Path $PdfPath -Destination $localPath -Force
        $clip = Invoke-ChromeOcr $localPath
    } catch {
        if ($_.Exception.Message -like "ERROR_PAGE:*") {
            throw "PERSISTENT_ACCESS_FAILURE: Chrome could not open this file even from a local copy ($($_.Exception.Message))"
        }
        throw
    } finally {
        Remove-Item -Path $localPath -Force -ErrorAction SilentlyContinue
    }
}

Set-Content -Path $OutFile -Value $clip -Encoding UTF8 -NoNewline
Write-Host "done: $($clip.Length) chars"
