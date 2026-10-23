"""Upload reviewed collector artifacts to the dedicated R2 release bucket."""
import argparse
import hashlib
import json
from pathlib import Path
import re

import collector_update as update
from publish_collector_release import publish


def upload(archive, root, config, source=None):
    import boto3
    from botocore.exceptions import ClientError

    archive, root = Path(archive), Path(root)
    credentials = json.loads(Path(config).read_text(encoding='utf-8'))
    account = credentials['account_id']
    if not re.fullmatch(r'[0-9a-f]{32}', account):
        raise ValueError('Invalid Cloudflare account ID')
    # Publishing credentials must be restricted to this bucket in Cloudflare.
    bucket = 'classicworld-releases'
    client = boto3.client('s3',
        endpoint_url=f'https://{account}.r2.cloudflarestorage.com', region_name='auto',
        aws_access_key_id=credentials['access_key_id'],
        aws_secret_access_key=credentials['secret_access_key'])
    manifest = publish(archive, root)
    tag = manifest['version']
    folder = root/'web/releases'/tag
    names = [archive.name, 'SHA256SUMS.txt', 'start-here.txt', 'guide.txt', 'release-notes.txt']
    paths = [folder/name for name in names]
    if source is not None:
        source = Path(source)
        if source.name != f'ClassicWorldCollector-{tag}-source.zip':
            raise ValueError('Expected the corresponding reviewed source archive')
        paths.append(source)
    for path in paths:
        with path.open('rb') as stream:
            digest = hashlib.file_digest(stream, 'sha256').hexdigest()
        key = f'collector/{tag}/{path.name}'
        try:
            previous = client.head_object(Bucket=bucket, Key=key)
        except ClientError as error:
            if error.response['Error']['Code'] not in ('404', 'NoSuchKey', 'NotFound'):
                raise
        else:
            if (previous.get('Metadata', {}).get('sha256') != digest
                    or previous['ContentLength'] != path.stat().st_size):
                raise ValueError(f'Refusing to replace an existing release object: {path.name}')
            print('Already uploaded:', path.name)
            continue
        client.upload_file(str(path), bucket, key, ExtraArgs={
            'ContentType': 'application/zip' if path.suffix == '.zip' else 'text/plain; charset=utf-8',
            'CacheControl': 'public, max-age=31536000, immutable',
            'Metadata': {'sha256': digest},
        })
        print('Uploaded:', path.name)
    # Verify the actual public download before switching installed collectors.
    return publish(archive, root, update.DOWNLOAD_BASES[1])


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--archive', type=Path, required=True)
    parser.add_argument('--source', type=Path)
    parser.add_argument('--root', type=Path, default=Path(__file__).resolve().parent)
    parser.add_argument('--config', type=Path)
    args = parser.parse_args()
    upload(args.archive, args.root, args.config or args.root/'shared_data/r2-publisher.json', args.source)
