"""Safe upload diagnostics: preserve evidence, never rewrite capture timestamps."""
import json
import time
from email.utils import parsedate_to_datetime


def rejection(error, payload):
    reason = 'http_' + str(error.code)
    # Only known service messages enter logs; gateway HTML and arbitrary
    # response content may contain private information.
    messages = {'Invalid observation schema', 'Invalid player departure',
                'Invalid room roster', 'Observation ID content conflict'}
    try:
        body = json.loads(error.read(4096))
        if isinstance(body, dict) and body.get('error') in messages:
            reason = body['error']
    except (ValueError, OSError, TypeError):
        pass
    detail = dict(status=error.code, reason=reason, at=time.time())
    try:
        server = parsedate_to_datetime(error.headers.get('Date', '')).timestamp()
        observed = float(payload['observed_at'])
        if error.code == 400 and observed > server + 120:
            detail.update(reason='capture_time_ahead', ahead_seconds=round(observed-server))
    except (ValueError, TypeError, KeyError, OverflowError):
        pass
    return detail
