#!/usr/bin/env python3
"""Decode a bounded restart block; do not emit state contents on errors."""
import json
import math
import re
import sys

try:
    import yaml
except ImportError:
    print('restart YAML parser unavailable: PyYAML is required', file=sys.stderr)
    sys.exit(2)


class UniqueLoader(yaml.SafeLoader):
    def construct_mapping(self, node, deep=False):
        result = {}
        for key_node, value_node in node.value:
            key = self.construct_object(key_node, deep=deep)
            if not isinstance(key, str) or key in result:
                raise ValueError('non-string or duplicate key')
            result[key] = self.construct_object(value_node, deep=deep)
        return result


def json_value(value, depth=0, count=None):
    count = count if count is not None else [0]
    count[0] += 1
    if depth > 32 or count[0] > 20000:
        raise ValueError('restart structure too large')
    if value is None or isinstance(value, (bool, str, int)):
        return value
    if isinstance(value, float) and math.isfinite(value):
        return value
    if isinstance(value, list):
        return [json_value(item, depth + 1, count) for item in value]
    if isinstance(value, dict):
        return {key: json_value(item, depth + 1, count) for key, item in value.items()}
    raise ValueError('restart value is not JSON-compatible')


def decode(data):
    text = data.decode('utf-8').replace('\r\n', '\n')
    headings = list(re.finditer(r'^## RIAVVIO[ \t]*$', text, re.MULTILINE))
    if headings:
        if len(headings) != 1:
            raise ValueError('ambiguous restart section')
        rest = text[headings[0].end():]
        match = re.match(r'\n[ \t\n]*```ya?ml[ \t]*\n(.*?)^```[ \t]*$', rest, re.MULTILINE | re.DOTALL | re.IGNORECASE)
        if not match:
            raise ValueError('missing restart YAML block')
        text = match.group(1)
    for token in yaml.scan(text, Loader=UniqueLoader):
        if isinstance(token, (yaml.tokens.AliasToken, yaml.tokens.AnchorToken, yaml.tokens.TagToken)):
            raise ValueError('aliases, anchors and explicit tags are not allowed')
    return json_value(yaml.load(text, Loader=UniqueLoader))


try:
    raw = sys.stdin.buffer.read(1024 * 1024 + 1)
    if not raw or len(raw) > 1024 * 1024:
        raise ValueError('invalid state size')
    result = decode(raw)
    print(json.dumps(result, ensure_ascii=True, allow_nan=False, separators=(',', ':')))
except (ValueError, TypeError, UnicodeError, yaml.YAMLError, RecursionError):
    print('invalid restart YAML', file=sys.stderr)
    sys.exit(1)
