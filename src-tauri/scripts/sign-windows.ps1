param(
    [Parameter(Mandatory = $true)]
    [string]$BinaryPath
)

$thumbprint = $env:WINDOWS_CERTIFICATE_THUMBPRINT
if ([string]::IsNullOrWhiteSpace($thumbprint)) {
    Write-Host "Windows signing certificate not configured; leaving $BinaryPath unsigned."
    exit 0
}

$digestAlgorithm = if ([string]::IsNullOrWhiteSpace($env:WINDOWS_SIGN_DIGEST_ALGORITHM)) {
    "sha256"
} else {
    $env:WINDOWS_SIGN_DIGEST_ALGORITHM
}

$timestampUrl = if ([string]::IsNullOrWhiteSpace($env:WINDOWS_SIGN_TIMESTAMP_URL)) {
    "http://timestamp.digicert.com"
} else {
    $env:WINDOWS_SIGN_TIMESTAMP_URL
}

$signTool = $env:TAURI_WINDOWS_SIGNTOOL_PATH
if ([string]::IsNullOrWhiteSpace($signTool)) {
    $command = Get-Command signtool.exe -ErrorAction SilentlyContinue
    if ($command) {
        $signTool = $command.Source
    } else {
        $kitsRoot = Join-Path ${env:ProgramFiles(x86)} "Windows Kits\10\bin"
        $candidate = Get-ChildItem -Path $kitsRoot -Recurse -Filter signtool.exe -ErrorAction SilentlyContinue |
            Where-Object { $_.FullName -like "*\\x64\\signtool.exe" } |
            Sort-Object FullName -Descending |
            Select-Object -First 1

        if ($candidate) {
            $signTool = $candidate.FullName
        }
    }
}

if ([string]::IsNullOrWhiteSpace($signTool) -or -not (Test-Path $signTool)) {
    Write-Error "Unable to locate signtool.exe for Windows signing."
    exit 1
}

$arguments = @(
    "sign",
    "/sha1", $thumbprint,
    "/fd", $digestAlgorithm
)

if (-not [string]::IsNullOrWhiteSpace($timestampUrl)) {
    $arguments += @("/tr", $timestampUrl, "/td", $digestAlgorithm)
}

$arguments += $BinaryPath

& $signTool @arguments
if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
}
