#!/usr/bin/env python3
"""Write private ARM parameters from an explicitly supplied relay environment JSON."""

import json
import os
from pathlib import Path
import re
import sys
from datetime import date
from urllib.parse import urlparse


def parameters(settings, image):
    if not isinstance(settings, dict) or not settings:
        raise ValueError('Relay settings must be a non-empty JSON object')
    if not re.fullmatch(r'ghcr\.io/[a-z0-9._/-]+@sha256:[a-f0-9]{64}', image):
        raise ValueError('Use an immutable GHCR image digest')
    for key, value in settings.items():
        if not re.fullmatch(r'KESAMI_[A-Z0-9_]+', key):
            raise ValueError('Only KESAMI_* server settings are accepted')
        if not isinstance(value, str) or not value.strip():
            raise ValueError(f'{key} must be a non-empty string')
    for key in ['KESAMI_SUPABASE_URL', 'KESAMI_SUPABASE_PUBLISHABLE_KEY',
                'KESAMI_SARVAM_API_KEY', 'KESAMI_RELAY_PUBLIC_URL',
                'KESAMI_SUPABASE_DB_URL', 'KESAMI_RAZORPAY_KEY_ID',
                'KESAMI_RAZORPAY_KEY_SECRET', 'KESAMI_RAZORPAY_PLAN_INR',
                'KESAMI_RAZORPAY_WEBHOOK_SECRET', 'KESAMI_GEMINI_API_KEY']:
        if key not in settings:
            raise ValueError(f'Missing required server setting: {key}')
    for key in ['KESAMI_SUPABASE_URL', 'KESAMI_RELAY_PUBLIC_URL']:
        parsed = urlparse(settings[key])
        if (parsed.scheme != 'https' or not parsed.hostname or parsed.username
                or parsed.password or parsed.query or parsed.fragment
                or parsed.path not in ['', '/']):
            raise ValueError(f'{key} must be a bare HTTPS origin')
    database = urlparse(settings['KESAMI_SUPABASE_DB_URL'])
    if database.scheme not in ['postgres', 'postgresql'] or not database.hostname:
        raise ValueError('KESAMI_SUPABASE_DB_URL must be a Postgres connection URL')
    if database.hostname.startswith('db.') and database.hostname.endswith('.supabase.co'):
        raise ValueError('Use the IPv4-compatible Supabase pooler URL for Azure')
    budget = int(os.environ.get('AZURE_MONTHLY_BUDGET') or '0')
    email = os.environ.get('AZURE_BUDGET_EMAIL', '')
    if budget < 0 or (budget > 0 and '@' not in email):
        raise ValueError('A positive budget requires AZURE_BUDGET_EMAIL')
    values = {
        'image': image,
        'relaySettings': settings,
        'registryPassword': os.environ.get('GHCR_PULL_TOKEN', ''),
        'registryUsername': os.environ.get('GHCR_USERNAME') or 'xenxorowdy',
        'monthlyBudget': budget,
        'budgetEmail': email,
        'budgetStartDate': os.environ.get('AZURE_BUDGET_START_DATE') or date.today().replace(day=1).isoformat(),
    }
    return {
        '$schema': 'https://schema.management.azure.com/schemas/2019-04-01/deploymentParameters.json#',
        'contentVersion': '1.0.0.0',
        'parameters': {key: {'value': value} for key, value in values.items()},
    }


if __name__ == '__main__':
    try:
        document = parameters(json.loads(os.environ['KESAMI_RELAY_ENV_JSON']), sys.argv[2])
        # Do not overwrite an existing file or expose server settings in console output.
        with os.fdopen(os.open(Path(sys.argv[1]), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'w') as out:
            json.dump(document, out)
    except (ValueError, KeyError, IndexError) as error:
        sys.exit(f'Parameter validation failed: {error}')
