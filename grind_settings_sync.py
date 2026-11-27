"""The account's 刷图 settings, shared by every client signed in to it and by the site.

The account keeps one JSON object (account_data pref `grind.settings`) of the shared
choices; this PC keeps the rest (overlay position and capture options, recording and
upload switches, auto buff and potion, hotkeys) in captures/grind/settings.json only.

Merging is three-way per setting against what this PC last agreed with the account
(grind/settings-sync.json): a choice changed on the site or another PC is taken, one
changed only here is sent; changed on both sides, the account's wins. The first time
a PC meets the account, the account's choices win and the ones it lacks come from here.
"""
import json
import threading
from pathlib import Path

from grind_tracker import DEFAULTS, write_json

ROUTE = '/api/v1/collector/grind-settings'
# Seconds between reads of the account (each request is its own process: collector_http);
# a change made here is sent at once, one made on the site arrives within this.
EVERY = 60
# Shared choices; everything else in settings.json stays on this PC.
SHARED = ('idle_seconds', 'end_after_seconds', 'start_events', 'start_window', 'price_basis', 'notable_value',
          'count_mesos_spent', 'min_upload_seconds', 'min_record_seconds', 'buff_warn_seconds', 'buff_sound', 'hp_warn')
SHARED_NESTED = dict(overlay=('layout', 'theme', 'opacity', 'scale', 'fields'),
                     performance=tuple(DEFAULTS['performance']))
CHOICES = dict(price_basis=('typical', 'npc', 'none'),
               **{'overlay.layout': ('slim', 'compact', 'standard', 'detailed', 'rail', 'big'),
                  'overlay.theme': ('dark', 'market', 'cute', 'maple')})


def paths():
    yield from SHARED
    for group, keys in SHARED_NESTED.items():
        for key in keys:
            yield f'{group}.{key}'


def default(path):
    group, _, key = path.partition('.')
    return DEFAULTS[group][key] if key else DEFAULTS[group]


def valid(path, value):
    """A value of the setting's own type (and one of its choices), else None."""
    base = default(path)
    if isinstance(base, bool):
        ok = isinstance(value, bool)
    elif isinstance(base, (int, float)):
        ok = isinstance(value, (int, float)) and not isinstance(value, bool) and abs(value) < 1e13
    elif isinstance(base, list):
        ok = isinstance(value, list) and len(value) <= 32 and all(isinstance(v, str) and len(v) <= 32 for v in value)
    else:
        ok = isinstance(value, str) and len(value) <= 64
    if ok and path in CHOICES:
        ok = value in CHOICES[path]
    return ok


def flat(settings):
    """{path: value} of the shared choices in a settings (or account) object; invalid ones left out."""
    out = {}
    for path in paths():
        group, _, key = path.partition('.')
        source = settings.get(group) if key else settings
        if not isinstance(source, dict):
            continue
        value = source.get(key or group)
        if (key or group) in source and valid(path, value):
            out[path] = value
    return out


def nested(values):
    out = {}
    for path, value in values.items():
        group, _, key = path.partition('.')
        if key:
            out.setdefault(group, {})[key] = value
        else:
            out[group] = value
    return out


def over(value, values):
    """The account's object with these choices written in; keys this version does not know
    (from a newer client or the site) are kept."""
    out = json.loads(json.dumps(value))
    for group, item in nested(values).items():
        if isinstance(item, dict):
            out[group] = {**(out[group] if isinstance(out.get(group), dict) else {}), **item}
        else:
            out[group] = item
    return out


def merge(local, remote, base):
    """The choices both sides take, from this PC's, the account's and the last agreed ones."""
    merged = dict(remote)
    for path, value in local.items():
        if path not in remote:
            merged[path] = value                      # the account lacks it: this PC's
        elif base is not None and path in base and remote[path] == base[path] and value != base[path]:
            merged[path] = value                      # changed only here
    return merged


class SettingsSync:
    """Background loop: read the account every EVERY s, or at once after a local change."""
    def __init__(self, service, post=None):
        self.service = service
        self.post = post or service.sync.site_post
        self.state_path = Path(service.data) / 'settings-sync.json'
        self.wake = threading.Event()
        self.thread = None
        self.lock = threading.Lock()
        self.linked = None
        self.error = None

    def load_state(self):
        try:
            state = json.loads(self.state_path.read_text(encoding='utf-8'))
            return state if isinstance(state, dict) else {}
        except (OSError, ValueError):
            return {}

    def step(self):
        """One read (and, when needed, write) of the account. True when anything changed."""
        with self.lock:
            answer = self.post(ROUTE, {})
            if not answer.get('linked'):
                self.linked = False
                return False
            self.linked = True
            state = self.load_state()
            remote_value = answer.get('value') if isinstance(answer.get('value'), dict) else {}
            remote, version = flat(remote_value), int(answer.get('version') or 0)
            base = state.get('base') if isinstance(state.get('base'), dict) else None
            if not isinstance(state.get('version'), int) or version < state['version']:
                base = None   # first meeting, a reset account or another one: its choices win
            local = flat(self.service.settings())
            merged = merge(local, remote, base)
            changed = False
            here = {p: v for p, v in merged.items() if local.get(p) != v}
            if here:
                self.service.save_settings(nested(here), share=False)
                changed = True
            if merged != remote:
                try:
                    answer = self.post(ROUTE, dict(value=over(remote_value, merged), version=version))
                except Exception as error:
                    if getattr(error, 'code', None) == 409:
                        self.wake.set()   # someone wrote first: read again and merge
                        return changed
                    raise
                version = int(answer.get('version') or version)
                changed = True
            write_json(self.state_path, dict(version=version, base=merged))
            return changed

    def run(self, stop):
        while not stop.is_set():
            try:
                self.step()
                self.error = None
            except Exception as error:
                self.error = type(error).__name__   # offline or not registered: try again later
            self.wake.wait(EVERY)
            self.wake.clear()

    def start(self, stop):
        if self.thread is None:
            self.thread = threading.Thread(target=self.run, args=(stop,), name='grind-settings-sync', daemon=True)
            self.thread.start()

    def changed_here(self):
        self.wake.set()
