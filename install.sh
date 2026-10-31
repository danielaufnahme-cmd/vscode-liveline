#!/usr/bin/env bash
# Packages this folder as a .vsix and installs it into VSCodium (both the normal
# VSCodium and "ESP32 Camera IDE (VSCodium)" use the same extensions folder).
# Re-run after editing, then reload VSCodium (Ctrl+Shift+P > "Reload Window").
set -euo pipefail
SRC="$(cd "$(dirname "$0")" && pwd)"
OUT="$SRC/liveline.vsix"
python3 - "$SRC" "$OUT" <<'PY'
import json, sys, zipfile
from pathlib import Path
src, out = Path(sys.argv[1]), Path(sys.argv[2])
pkg = json.loads((src / "package.json").read_text())
manifest = f'''<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011">
  <Metadata>
    <Identity Language="en-US" Id="{pkg["name"]}" Version="{pkg["version"]}" Publisher="{pkg["publisher"]}"/>
    <DisplayName>{pkg["displayName"]}</DisplayName>
    <Description xml:space="preserve">{pkg["description"]}</Description>
    <Properties>
      <Property Id="Microsoft.VisualStudio.Code.Engine" Value="{pkg["engines"]["vscode"]}"/>
    </Properties>
  </Metadata>
  <Installation><InstallationTarget Id="Microsoft.VisualStudio.Code"/></Installation>
  <Dependencies/>
  <Assets><Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true"/></Assets>
</PackageManifest>'''
types = '''<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension=".json" ContentType="application/json"/>
  <Default Extension=".js" ContentType="application/javascript"/>
  <Default Extension=".py" ContentType="text/x-python"/>
  <Default Extension=".svg" ContentType="image/svg+xml"/>
  <Default Extension=".md" ContentType="text/markdown"/>
  <Default Extension=".vsixmanifest" ContentType="text/xml"/>
</Types>'''
files = ["package.json", "extension.js", "README.md"] + \
    [str(p.relative_to(src)) for d in ("python", "media") for p in sorted((src / d).iterdir())
     if p.is_file() and p.suffix in (".py", ".svg")]
with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
    z.writestr("[Content_Types].xml", types)
    z.writestr("extension.vsixmanifest", manifest)
    for f in files:
        z.write(src / f, "extension/" + f)
print("built", out, files)
PY
codium --install-extension "$OUT" --force 2>&1 | grep -v "^Warning: '"
