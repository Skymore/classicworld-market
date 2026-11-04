"""Build the unified release from a pinned scanner checkout and collector sources."""
import argparse
import ast
import json
import hashlib
import shutil
import subprocess
import sys
import time
import zipfile
from pathlib import Path


def modules(root, initial):
    found, pending = set(), list(initial)
    while pending:
        name = pending.pop()
        path = root / (name.replace('.', '/') + '.py')
        if name in found or not path.is_file():
            continue
        found.add(name)
        for node in ast.walk(ast.parse(path.read_text(encoding='utf-8-sig'))):
            if isinstance(node, ast.Import): pending.extend(a.name for a in node.names)
            if isinstance(node, ast.ImportFrom) and node.module: pending.append(node.module)
    return found


def stage_web(root, destination):
    # Vite lists CSS and other assets on their importing entries, not as
    # separate manifest rows. Keep the whole current build, not just JS files.
    web = root / 'web'
    vite = json.loads((web / 'react/.vite/manifest.json').read_text(encoding='utf-8'))
    files = {row['file'] for row in vite.values()}
    files.update(name for row in vite.values() for field in ('css', 'assets') for name in row.get(field, []))
    for name in files:
        path = (web / 'react' / name).resolve()
        if not path.is_relative_to((web / 'react').resolve()) or not path.is_file():
            raise ValueError('Missing or invalid frontend build asset: ' + name)
    chunks = {Path(name).name for name in files if name.startswith('chunks/')}
    def ignore_web(folder, names):
        ignored = set(shutil.ignore_patterns('images', 'releases', 'tests', '*.map')(folder, names))
        if Path(folder) == web / 'react/chunks':
            ignored.update(name for name in names if name not in chunks)
        return ignored
    shutil.copytree(web, destination, ignore=ignore_web)


def stage(root, scanner, destination):
    core = modules(root, ['unified_client', 'shared_client', 'market_movement'])
    scan = modules(scanner, ['full_market_scan', 'channel_state_collector',
                            'position_state_collector', 'cloud_scan', 'control_state'])
    # Never accidentally bundle the scanner repository's older collector files.
    if core & scan:
        raise ValueError('Conflicting runtime modules: ' + str(core & scan))
    for base, names in [(root, core), (scanner, scan)]:
        for name in names:
            relative = Path(name.replace('.', '/') + '.py')
            target = destination / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(base / relative, target)
    for name in ('maple_crypto_constants.cs', 'market_index.html', 'market_ui.js',
                 'market_ui.css', 'market_i18n.js', 'market_watchlist.js'):
        shutil.copy2(root / name, destination / name)
    # A desktop update installs fresh web entry points. Historical website
    # chunks are only needed by old browser pages, not by this new install.
    stage_web(root, destination / 'web')
    shutil.copytree(scanner / 'tools/market_bot_templates', destination / 'tools/market_bot_templates')
    shutil.copytree(root / 'desktop_ui', destination / 'desktop_ui')
    shutil.copytree(root / 'assets/sweep', destination / 'assets/sweep')
    for name in ('font.json', 'catalog.json'):
        shutil.copy2(root / 'server/crates/market-core/assets' / name,
                     destination / 'assets/sweep' / ('shop-font.json' if name == 'font.json' else name))
    shutil.copy2(root / 'assets/app-icon.ico', destination / 'app-icon.ico')
    return core, scan


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--scanner',type=Path,default=Path(__file__).parent/'scanner')
    parser.add_argument('--windivert',type=Path,required=True)
    parser.add_argument('--windivert-source',type=Path,required=True)
    args=parser.parse_args()
    root=Path(__file__).resolve().parent
    commit=subprocess.check_output(['git','-C',str(root),'rev-parse','HEAD'],text=True).strip()
    for ref in ('main','gitlab/main'):
        if subprocess.check_output(['git','-C',str(root),'rev-parse',ref],text=True).strip()!=commit:
            raise ValueError('Release must be built from the pushed main commit')
    if subprocess.check_output(['git','-C',str(root),'status','--porcelain','--untracked-files=no'],text=True).strip():
        raise ValueError('Release sources must be clean')
    scanner_commit=subprocess.check_output(['git','-C',str(args.scanner),'rev-parse','HEAD'],text=True).strip()
    pinned=subprocess.check_output(['git','-C',str(root),'rev-parse',commit+':scanner'],text=True).strip()
    if scanner_commit!=pinned or subprocess.check_output(['git','-C',str(args.scanner),'status','--porcelain'],text=True).strip():
        raise ValueError('Scanner must match the clean pinned submodule')
    # Fail here rather than ship a successful freeze with missing optional
    # imports that only fail when an updater starts the scanner self-test.
    import cv2, numpy, mss, pyautogui, webview, clr
    from collector_update import VERSION
    output=root/'dist'/('unified-'+time.strftime('%Y%m%d_%H%M%S'))
    source=output/'source';source.mkdir(parents=True)
    stage(root,args.scanner.resolve(),source)
    driver=args.windivert.resolve()
    for name in ('WinDivert.dll','WinDivert64.sys'):
        if not (driver/name).is_file(): raise ValueError('Missing driver: '+name)
    if not (driver.parent/'LICENSE').is_file() or not args.windivert_source.is_file():
        raise ValueError('WinDivert license and corresponding source are required')
    command=[sys.executable,'-m','PyInstaller','--noconfirm','--clean','--onedir','--windowed',
        '--icon',str(source/'app-icon.ico'),
        '--name','ClassicWorldCollector','--distpath',str(output),'--workpath',str(output/'build'),
        '--specpath',str(output),'--paths',str(source),'--collect-all','cryptography',
        '--collect-submodules','mss','--hidden-import','psutil','--collect-all','webview',
        '--hidden-import','webview.platforms.edgechromium','--hidden-import','clr',
        '--exclude-module','PIL.AvifImagePlugin','--exclude-module','tkinter',
        '--exclude-module','PyQt5','--exclude-module','PyQt6','--exclude-module','PySide6']
    import ssl
    policy=Path(ssl.__file__).with_name('codex-rejected-cas.pem')
    if policy.is_file():
        command += ['--add-data',f'{policy};.']
    for name in ('maple_crypto_constants.cs','market_index.html','market_ui.js','market_ui.css','market_i18n.js','market_watchlist.js','app-icon.ico'):
        command += ['--add-data',f'{source/name};.']
    for name in ('web','tools/market_bot_templates','desktop_ui','assets/sweep'):
        command += ['--add-data',f'{source/name};{name}']
    command += ['--add-binary',f'{driver/"WinDivert.dll"};vendor/windivert/WinDivert-2.2.2-A/x64',
                '--add-data',f'{driver/"WinDivert64.sys"};vendor/windivert/WinDivert-2.2.2-A/x64',str(source/'unified_client.py')]
    subprocess.run(command,cwd=source,check=True)
    bundle=output/'ClassicWorldCollector'
    # Exercise the actual windowed executable, including its stdout pipes.
    for flag, marker in [('--version', VERSION), ('--self-test', 'Codec self-test passed'),
                         ('--scanner-self-test', 'Scanner self-test passed')]:
        result=subprocess.run([str(bundle/'ClassicWorldCollector.exe'),flag],capture_output=True,
            timeout=30,creationflags=subprocess.CREATE_NO_WINDOW if sys.platform=='win32' else 0)
        if result.returncode or marker.encode() not in result.stdout:
            raise RuntimeError(f'Packaged {flag} failed: {result.stderr.decode("utf-8", errors="replace")}')
    # The scanner uses images only, never OpenCV's video decoder. Keep the
    # archive below older collectors' 80 MiB automatic-update limit.
    for library in (bundle/'_internal/cv2').glob('opencv_videoio_ffmpeg*.dll'):
        library.unlink()
    for name in ('SHARED_CLIENT_GUIDE.md','COLLECTOR_QUICK_START.txt','COPYING.MapleLib','THIRD_PARTY_NOTICES.md'):
        shutil.copy2(root/name,bundle/name)
    shutil.copy2(root/'msnet_reference/LICENSE',bundle/'COPYING.msnet')
    shutil.copy2(driver.parent/'LICENSE',bundle/'COPYING.WinDivert')
    shutil.copy2(args.windivert_source,bundle/'WinDivert-2.2.2-source.zip')
    (bundle/'install-manifest.json').write_text(json.dumps(dict(version=VERSION,scanner_commit=scanner_commit,
        source_commit=commit,source_branch='main',
        sha256={str(p.relative_to(bundle)).replace('\\','/'):hashlib.sha256(p.read_bytes()).hexdigest()
                for p in bundle.rglob('*') if p.is_file()},
        files=[str(p.relative_to(bundle)).replace('\\','/') for p in bundle.rglob('*') if p.is_file()]+['install-manifest.json']),indent=2),encoding='utf-8')
    archive=root/'dist'/f'ClassicWorldCollector-windows-x64-v{VERSION}.zip'
    with zipfile.ZipFile(archive,'w',zipfile.ZIP_DEFLATED,compresslevel=6) as z:
        for path in bundle.rglob('*'):
            if path.is_file(): z.write(path,path.relative_to(output))
    (root/'dist/bundle-path.txt').write_text(str(bundle),encoding='utf-8')
    print('Bundle:',bundle,'Archive:',archive,flush=True)


if __name__=='__main__': main()
