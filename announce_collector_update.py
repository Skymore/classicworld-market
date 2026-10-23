"""Announce a verified official stable collector release to connected clients."""
import argparse
import json
import os
from pathlib import Path
from collector_update import read_release, version


def announce(tag, database_url):
    version(tag)
    info = read_release(current='0.0.0')
    if not info or info['version'] != tag:
        raise ValueError('Only the latest complete official stable release can be announced')
    import psycopg
    with psycopg.connect(database_url) as connection:
        connection.execute("SELECT pg_notify('collector_update', %s)", (tag,))
    print('Collector release announced: '+tag)


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--version', default=os.environ.get('COLLECTOR_RELEASE'))
    args=parser.parse_args()
    if not args.version:parser.error('--version or COLLECTOR_RELEASE is required')
    url=os.environ.get('DATABASE_URL')
    if not url:
        config=Path(__file__).resolve().parent/'shared_data/native-runtime.json'
        url=json.loads(config.read_text(encoding='utf-8'))['database_url']
    announce(args.version, url)


if __name__ == '__main__': main()
