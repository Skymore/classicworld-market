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


def publish(archive, root, download_base=update.DOWNLOAD_BASES[0], activate=True):
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
        '枫叶市集 '+tag+' — 扫描与采集\n\n'
        '修复扫描中途无提示退出；状态刷新暂时失败时继续采集，遇到采集异常保留窗口提示。\n'
        '修复边缘店铺误点人物资料：避开店主位置，误开资料后自动关闭并继续。\n'
        '全新官网同款界面，支持浅色、深色和跟随系统主题。启动只显示扫描器窗口。\n'
        '修复更新自检超时，保留账号、设置与采集记录。\n'
        '自动扫描、手动采集、上传、账号和关注提醒合并到一个程序。请关闭旧扫描器和旧采集器。\n'
        '每人每次领取一个洞，完成后再领取下一个；暂停或断线后让其他在线扫描器接手。\n'
        '从 CH1 顺序扫描，连续三个空频道后从 CH40 倒序扫描，避免漏掉高频道的店铺。\n'
        '保留原有账号和记录，后台自动检查、下载更新，退出游戏后安装。\n'
        'v0.5.10 及以后的采集器可以自动升级；旧独立扫描器和 v0.5.9 及以前的采集器需要手动安装这一次。\n', encoding='utf-8')
    if activate:
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
