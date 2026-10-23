"""Publish immutable collector files and the official-domain update manifest."""
import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import tempfile
import zipfile
import collector_update as update


def publish(archive, root, download_base=update.DOWNLOAD_BASES[0]):
    archive, root = Path(archive), Path(root)
    match = re.fullmatch(r'ClassicWorldCollector-windows-x64-(v\d{1,6}\.\d{1,6}\.\d{1,6})\.zip', archive.name)
    if not match or download_base not in update.DOWNLOAD_BASES:
        raise ValueError('Expected an official Windows package and download base')
    tag = match[1]
    with zipfile.ZipFile(archive) as z:
        names = z.namelist()
        if any(any(part in name.lower() for part in ('member.json', 'owner.json', 'google-oauth', 'native-runtime', '.pcap', '.etl', 'shared_data/', 'web/releases/')) for name in names):
            raise ValueError('Private or recursive data found in package')
        install = json.loads(z.read('ClassicWorldCollector/install-manifest.json').decode('utf-8-sig'))
        if install['version'] != tag[1:] or 'ClassicWorldCollector/'+update.EXE not in names:
            raise ValueError('Package version does not match its name')
    with archive.open('rb') as source:
        digest = hashlib.file_digest(source, 'sha256').hexdigest()
    asset = dict(url=download_base+tag+'/'+archive.name, sha256=digest, size=archive.stat().st_size)
    manifest = dict(schema=1, channel='stable', version=tag,
                    published_at=datetime.now(timezone.utc).isoformat(), windows_x64=asset)
    update.release_info(manifest, current='0.0.0')
    releases = root/'web/releases'
    releases.mkdir(parents=True, exist_ok=True)
    stable = releases/'stable.json'
    if stable.exists() and update.version(json.loads(stable.read_text())['version']) > update.version(tag):
        raise ValueError('Refusing to downgrade the stable release')
    # Never point installed clients at a missing or mismatching R2 object.
    if download_base != update.DOWNLOAD_BASES[0]:
        with tempfile.TemporaryDirectory(prefix='collector-release-verify-') as folder:
            update.download(dict(asset, version=tag), Path(folder)/'download.zip')
    target = releases/tag
    target.mkdir(exist_ok=True)
    final = target/archive.name
    if final.exists():
        with final.open('rb') as source:
            if hashlib.file_digest(source, 'sha256').hexdigest() != digest:
                raise ValueError('Published versions are immutable; use a new version')
    else:
        pending = final.with_suffix('.pending')
        shutil.copy2(archive, pending)
        os.replace(pending, final)
    shutil.copy2(root/'SHARED_CLIENT_GUIDE.md', target/'guide.txt')
    shutil.copy2(root/'COLLECTOR_QUICK_START.txt', target/'start-here.txt')
    (target/'SHA256SUMS.txt').write_text(digest+'  '+archive.name+'\n', encoding='utf-8')
    (target/'release-notes.txt').write_text(
        '枫叶市集采集器 '+tag+'\n\n更新检查和下载迁到官网域名，不再依赖 GitHub。\n'
        '保留静默更新、每小时检查、采集上传、个人提醒和 Google 账号绑定。\n'
        'v0.5.9 及以前请关闭旧采集器，完整解压新版到新文件夹后运行，再切一次频道。\n'
        '默认本机配置和记录会继续沿用。以后退出游戏后自动安装更新。\n', encoding='utf-8')
    temporary = stable.with_suffix('.pending')
    temporary.write_text(json.dumps(manifest, ensure_ascii=False, indent=2)+'\n', encoding='utf-8')
    os.replace(temporary, stable)
    print('Published', tag, digest)
    return manifest


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--archive', type=Path, required=True)
    parser.add_argument('--root', type=Path, default=Path(__file__).resolve().parent)
    parser.add_argument('--download-base', choices=update.DOWNLOAD_BASES, default=update.DOWNLOAD_BASES[0])
    args = parser.parse_args()
    publish(args.archive, args.root, args.download_base)
