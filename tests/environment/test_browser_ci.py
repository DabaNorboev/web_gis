"""Synthetic APT layouts and mocked commands; never touch host APT or network."""
import importlib.util
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

SCRIPT = Path(__file__).resolve().parents[2] / 'scripts/ci-install-chromium.py'
spec = importlib.util.spec_from_file_location('browser_ci', SCRIPT)
browser = importlib.util.module_from_spec(spec)
spec.loader.exec_module(browser)


class BrowserSetupTest(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        (self.root / 'sources.list.d').mkdir()
        (self.root / 'apt.conf.d').mkdir()
        self.sources = self.root / 'sources.list.d/ubuntu.sources'
        self.source_text = ('Types: deb\nURIs: mirror+file:/etc/apt/apt-mirrors.txt\n'
                            'Suites: noble noble-updates noble-backports noble-security\n'
                            'Components: main universe restricted multiverse\n'
                            'Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg\n')
        self.sources.write_text(self.source_text)
        self.mirrors = self.root / 'apt-mirrors.txt'
        self.mirror_text = (f'{browser.AZURE}\tpriority:1\n{browser.ARCHIVE}\tpriority:2\n'
                            'https://security.ubuntu.com/ubuntu/\tpriority:3\n')
        self.mirrors.write_text(self.mirror_text)
        self.other = self.root / 'sources.list.d/unrelated.sources'
        self.other.write_text('unchanged unrelated source\n')
        writer = patch.object(browser, 'write_root', side_effect=lambda p, s: p.write_text(s))
        self.write = writer.start()
        self.addCleanup(writer.stop)

    def test_azure_failure_falls_back_only_after_official_archive_succeeds(self):
        with patch.object(browser, 'probe', side_effect=[False, True]) as probe:
            browser.prepare_apt(self.root)
        self.assertEqual([call.args[0] for call in probe.call_args_list], [browser.AZURE, browser.ARCHIVE])
        self.assertEqual(self.mirrors.read_text(), self.mirror_text.split('\n', 1)[1])
        self.assertEqual(self.sources.read_text(), self.source_text)
        self.assertEqual(self.other.read_text(), 'unchanged unrelated source\n')
        self.assertEqual((self.root / 'apt.conf.d/zzz-placelens-browser').read_text(), browser.APT_LIMITS)

    def test_healthy_azure_keeps_mirror_list(self):
        with patch.object(browser, 'probe', return_value=True) as probe:
            browser.prepare_apt(self.root)
        probe.assert_called_once_with(browser.AZURE)
        self.assertEqual(self.mirrors.read_text(), self.mirror_text)

    def test_unavailable_official_archive_fails_without_changes(self):
        with patch.object(browser, 'probe', return_value=False):
            with self.assertRaisesRegex(RuntimeError, 'No mirror change'):
                browser.prepare_apt(self.root)
        self.write.assert_not_called()
        self.assertEqual(self.mirrors.read_text(), self.mirror_text)

    def test_unknown_apt_layout_fails_without_network_or_changes(self):
        self.sources.write_text('URIs: https://unrelated.example/ubuntu\n')
        with patch.object(browser, 'probe') as probe:
            with self.assertRaisesRegex(RuntimeError, 'Unsupported runner APT layout'):
                browser.prepare_apt(self.root)
        probe.assert_not_called()
        self.write.assert_not_called()

    def test_install_has_bounded_retries_and_preserves_failure(self):
        for codes in ([100, 124, 0], [100, 124, 100]):
            with self.subTest(codes=codes), patch.object(browser, 'prepare_apt') as prepare, \
                    patch.object(browser.time, 'sleep') as sleep, \
                    patch.object(browser.subprocess, 'run', side_effect=[
                        subprocess.CompletedProcess([], code) for code in codes]) as run:
                if codes[-1] == 0:
                    browser.install_browser()
                else:
                    with self.assertRaisesRegex(RuntimeError, 'exhausted 3 attempts'):
                        browser.install_browser()
                self.assertEqual(prepare.call_count, 3)
                self.assertEqual(sleep.call_count, 2)
                for call in run.call_args_list:
                    self.assertEqual(call.args[0], ['timeout', '--kill-after=10s', '240s',
                                                   'npx', '--no-install', 'playwright', 'install',
                                                   '--with-deps', 'chromium'])

    def test_local_execution_is_rejected_before_apt_changes(self):
        with patch.dict(browser.os.environ, {}, clear=True), patch.object(browser, 'install_browser') as install:
            with self.assertRaisesRegex(RuntimeError, 'restricted to disposable'):
                browser.main()
        install.assert_not_called()


if __name__ == '__main__':
    unittest.main()
