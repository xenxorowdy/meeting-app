import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

from parameters import parameters


IMAGE = 'ghcr.io/xenxorowdy/kesami-relay@sha256:' + 'a' * 64


def settings():
    return {
        'KESAMI_SUPABASE_URL': 'https://example.supabase.co',
        'KESAMI_SUPABASE_PUBLISHABLE_KEY': 'sb_publishable_test',
        'KESAMI_SARVAM_API_KEY': 'synthetic-sarvam-key',
        'KESAMI_GEMINI_API_KEY': 'synthetic-gemini-key',
        'KESAMI_RELAY_PUBLIC_URL': 'https://app.kesami.online',
        'KESAMI_SUPABASE_DB_URL': 'postgresql://user:synthetic@pooler.supabase.com:6543/postgres',
        'KESAMI_RAZORPAY_KEY_ID': 'rzp_test_synthetic',
        'KESAMI_RAZORPAY_KEY_SECRET': 'synthetic-secret',
        'KESAMI_RAZORPAY_PLAN_INR': 'plan_synthetic',
        'KESAMI_RAZORPAY_WEBHOOK_SECRET': 'synthetic-webhook-secret',
    }


class ParameterTests(unittest.TestCase):
    def test_missing_provider_key_is_rejected(self):
        value = settings()
        del value['KESAMI_SARVAM_API_KEY']
        with self.assertRaisesRegex(ValueError, 'KESAMI_SARVAM_API_KEY'):
            parameters(value, IMAGE)

    def test_mutable_image_is_rejected(self):
        with self.assertRaisesRegex(ValueError, 'immutable'):
            parameters(settings(), 'ghcr.io/xenxorowdy/kesami-relay:latest')

    def test_non_server_variables_are_rejected(self):
        with self.assertRaisesRegex(ValueError, 'Only KESAMI'):
            parameters({**settings(), 'PORT': '1234'}, IMAGE)

    def test_malformed_settings_do_not_print_secret_values(self):
        with self.assertRaisesRegex(ValueError, '^KESAMI_SARVAM_API_KEY must be a non-empty string$'):
            parameters({**settings(), 'KESAMI_SARVAM_API_KEY': {'secret': 'private'}}, IMAGE)

    def test_non_https_callback_origin_is_rejected(self):
        with self.assertRaisesRegex(ValueError, 'HTTPS origin'):
            parameters({**settings(), 'KESAMI_RELAY_PUBLIC_URL': 'http://localhost'}, IMAGE)

    def test_ipv6_only_database_host_is_rejected(self):
        with self.assertRaisesRegex(ValueError, 'pooler'):
            parameters({**settings(), 'KESAMI_SUPABASE_DB_URL': 'postgresql://u:p@db.example.supabase.co/postgres'}, IMAGE)

    def test_budget_requires_contact(self):
        with patch.dict(os.environ, {'AZURE_MONTHLY_BUDGET': '3000', 'AZURE_BUDGET_EMAIL': ''}):
            with self.assertRaisesRegex(ValueError, 'AZURE_BUDGET_EMAIL'):
                parameters(settings(), IMAGE)

    def test_empty_optional_workflow_variables_are_supported(self):
        with patch.dict(os.environ, {'AZURE_MONTHLY_BUDGET': '', 'AZURE_BUDGET_START_DATE': ''}):
            self.assertEqual(parameters(settings(), IMAGE)['parameters']['monthlyBudget']['value'], 0)

    def test_cli_creates_private_file_without_output_or_overwrite(self):
        with tempfile.TemporaryDirectory() as directory:
            destination = Path(directory) / 'parameters.json'
            environment = {**os.environ, 'KESAMI_RELAY_ENV_JSON': json.dumps(settings()),
                           'AZURE_MONTHLY_BUDGET': '', 'AZURE_BUDGET_EMAIL': ''}
            command = [sys.executable, str(Path(__file__).with_name('parameters.py')), str(destination), IMAGE]
            result = subprocess.run(command, env=environment, capture_output=True, text=True)
            self.assertEqual((result.returncode, result.stdout, result.stderr, destination.stat().st_mode & 0o777), (0, '', '', 0o600))
            first = destination.read_bytes()
            result = subprocess.run(command, env=environment, capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(destination.read_bytes(), first)


if __name__ == '__main__':
    unittest.main()
