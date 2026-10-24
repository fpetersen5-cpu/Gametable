#!/usr/bin/env python3
"""Reject non-distributable repository URLs before an expensive release build."""
import os
import ipaddress
import sys
from urllib.parse import urlsplit


def validate_repo_url(value: str, allow_test: bool = False) -> None:
    if not value or any(char.isspace() or ord(char) < 32 for char in value):
        raise ValueError('Repository URL must not be empty or contain whitespace/control characters')
    url = urlsplit(value)
    if url.scheme != 'https' or not url.hostname or url.username or url.password or url.query or url.fragment:
        raise ValueError('Repository URL must be HTTPS without credentials, query or fragment')
    host = url.hostname.lower().rstrip('.')
    if url.port is not None and not 1 <= url.port <= 65535:
        raise ValueError('Repository URL has an invalid port')
    placeholder = host in {'localhost', '127.0.0.1', '::1', 'example.com', 'example.org', 'example.net', 'your-public-host'} or any(
        host.endswith(suffix) for suffix in ('.invalid', '.test', '.localhost', '.example', '.example.com', '.example.org', '.example.net')
    )
    try:
        placeholder = placeholder or not ipaddress.ip_address(host).is_global
    except ValueError:
        pass  # A hostname, not an IP literal. No DNS request is needed.
    if placeholder and not allow_test:
        raise ValueError('Placeholder/local repository URL: set a public host, or GAMETABLE_ALLOW_TEST_RELEASE=1 for an explicitly local test release')
    if not url.path.endswith('/'):
        raise ValueError('Repository URL must end with /')


if __name__ == '__main__':
    try:
        validate_repo_url(os.environ.get('GAMETABLE_REPO_URL', ''), os.environ.get('GAMETABLE_ALLOW_TEST_RELEASE') == '1')
    except ValueError as error:
        sys.exit(str(error))
    if os.environ.get('GAMETABLE_ALLOW_TEST_RELEASE') == '1':
        print('WARNING: test release enabled; do not distribute its placeholder flatpakref.', file=sys.stderr)
