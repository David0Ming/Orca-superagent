"""Narrow local Orca patch: only the OSA sidebar tab gets the paper-and-pen glyph.
Run without flags to check; --install backs up and patches; --restore rolls back.
The exact shipped fragments are checked so a different Orca build is never guessed.
"""
from pathlib import Path
import shutil
import sys

ROOT = Path('/Applications/Orca.app/Contents/Resources/app.asar.unpacked/out/renderer/assets')
BACKUP = Path.home() / 'orca/artifacts/osa-paper-pen-20261111'
icons = ROOT / 'plugin-declarative-icons-CUeq0Axo.js'
app = ROOT / 'App-DvqPjk23.js'
marker = 'osaPaperPen'
previous_icon_definition = '''var osaPaperPen=S(`file-pen`,[[`path`,{d:`M13 3H5a2 2 0 0 0-2 2v15a1 1 0 0 0 1 1h14a2 2 0 0 0 2-2v-7`,key:`paper`}],[`path`,{d:`m12 13 1-4 6-6a2.1 2.1 0 0 1 3 3l-6 6-4 1ZM18 4l3 3M7 16h3M7 18h7`,key:`pen`}]]);'''
icon_definition = '''var osaPaperPen=S(`file-pen`,[[`path`,{d:`m13.6 2.8-9.7 2 3.2 16.8 13.2-2.8-1.3-6.7M16.8 2.1l1.1 5.7M7.1 8.2l6-1.3M7.9 12l4.1-.9`,strokeWidth:1.65,key:`paper`}],[`path`,{d:`m12.5 17 1.7-4.5 6.2-7.6a1.3 1.3 0 0 1 2 1.7l-6.2 7.6-3.7 2.8ZM19.1 6.5l2 1.7`,strokeWidth:1.65,key:`pen`}]]);'''
patches = {
    icons: [('export{$ as n,ce as t};', icon_definition + 'export{$ as n,ce as t,osaPaperPen as p};')],
    app: [('import{n as _ie,t as vie}from"./plugin-declarative-icons-CUeq0Axo.js"', 'import{n as _ie,t as vie,p as osaPaperPen}from"./plugin-declarative-icons-CUeq0Axo.js"'),
          ('icon:YBe(e.icon),title:e.title', 'icon:e.pluginKey===`local.osa-tasks`?osaPaperPen:YBe(e.icon),title:e.title')],
}
if '--restore' in sys.argv:
    for path in patches:
        original = BACKUP / path.name
        if not original.exists():
            raise SystemExit('Missing backup: ' + str(original))
    for path in patches:
        shutil.copy2(BACKUP / path.name, path)
    print('Restored both renderer files; reload Orca UI to apply.')
    raise SystemExit()

prepared = {}
for path, replacements in patches.items():
    source = path.read_text()
    if marker in source:
        if path == icons and previous_icon_definition in source:
            prepared[path] = source.replace(previous_icon_definition, icon_definition)
            continue
        if path == icons and icon_definition not in source:
            raise SystemExit('Unrecognized OSA icon definition; refusing to replace')
        print(path.name + ': already patched')
        continue
    for old, new in replacements:
        if source.count(old) != 1:
            raise SystemExit('Orca version differs; refusing to patch ' + str(path))
        source = source.replace(old, new)
    prepared[path] = source
assert all(marker in source for source in prepared.values())
if '--install' in sys.argv:
    BACKUP.mkdir(parents=True, exist_ok=True)
    for path, source in prepared.items():
        original = BACKUP / path.name
        if not original.exists():
            shutil.copy2(path, original)
        path.write_text(source)
    print('Installed OSA-only sidebar glyph. Backups: ' + str(BACKUP))
    print('The running renderer keeps its old modules until its next reload.')
else:
    print('Patch matches this Orca build. Files to change: ' + str(len(prepared)))
