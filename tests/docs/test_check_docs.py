"""Portable documentation checker regressions; temporary files only."""
import importlib.machinery
import importlib.util
import pathlib
import subprocess
import sys
import tempfile
import unittest

SCRIPT = pathlib.Path(__file__).resolve().parents[2] / 'scripts/check-docs'
loader = importlib.machinery.SourceFileLoader('check_docs', str(SCRIPT))
spec = importlib.util.spec_from_loader(loader.name, loader)
module = importlib.util.module_from_spec(spec)
loader.exec_module(module)
HEADER = '---\nstatus: current\nupdated: 2026-10-27\nverified: not verified\n---\n'


class DocumentationChecks(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = pathlib.Path(self.temp.name)
        (self.root / 'docs').mkdir()

    def write(self, name, body, header=HEADER):
        path = self.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(header + body)

    def test_nested_relative_encoded_and_reference_links(self):
        self.write('docs/README.md', '# Index\n[A](features/a.md#пеший-путь)\n')
        self.write('docs/features/a.md', '# Пеший путь\n[home][index]\n[index]: ../README.md\n[asset](<my%20file.txt>)\n')
        (self.root / 'docs/features/my file.txt').write_text('fixture')
        errors, warnings, _ = module.check(self.root)
        self.assertEqual(errors, [])
        self.assertEqual(warnings, [])

    def test_missing_target_and_anchor_are_errors(self):
        self.write('docs/README.md', '# Index\n[bad](missing.md)\n[anchor](#absent)\n')
        errors, _, _ = module.check(self.root)
        self.assertTrue(any('missing local target' in item for item in errors))
        self.assertTrue(any('missing anchor' in item for item in errors))

    def test_required_index_and_portable_current_links(self):
        errors, _, _ = module.check(self.root)
        self.assertTrue(any('missing documentation index' in item for item in errors))
        self.write('docs/README.md', '# Index\n[local machine](/tmp/example.md)\n[escape](../../outside.md)\n')
        errors, _, _ = module.check(self.root)
        self.assertTrue(any('absolute local target' in item for item in errors))
        self.assertTrue(any('local target outside checkout' in item for item in errors))

    def test_unindexed_and_invalid_metadata(self):
        self.write('docs/README.md', '# Index\n')
        self.write('docs/lost.md', '# Lost\n', '---\nstatus: done\nupdated: yesterday\nverified: yes\n---\n')
        errors, _, _ = module.check(self.root)
        for phrase in ['invalid status', 'invalid updated', 'invalid verified', 'not reachable']:
            self.assertTrue(any(phrase in item for item in errors), phrase)

    def test_local_draft_is_checked_without_a_bypass(self):
        self.write('docs/README.md', '# Index\n')
        self.write('docs/local-draft.md', '# Draft\n', '')
        errors, _, _ = module.check(self.root)
        self.assertTrue(any('missing front matter' in item for item in errors))
        self.assertTrue(any('not reachable' in item for item in errors))

    def test_cli_rejects_removed_exclude_option(self):
        result = subprocess.run([sys.executable, '-B', str(SCRIPT), '--exclude', 'docs/local-draft.md'],
                                capture_output=True, text=True)
        self.assertEqual(result.returncode, 2)
        self.assertIn('unrecognized arguments', result.stderr)

    def test_fenced_examples_ignored_and_duplicate_heading_anchors(self):
        self.write('docs/README.md', '# Index\n## Test\n## Test\n[second](#test-1)\n`[inline example](missing.md)`\n```md\n[example](missing.md)\n```\n')
        self.assertEqual(module.check(self.root)[0], [])

    def test_incoming_link_from_tracked_markdown_outside_docs(self):
        self.write('docs/README.md', '# Index\n')
        self.write('experiments/README.md', '[old path](../docs/removed.md)\n', '')
        errors, _, _ = module.check(self.root, extra_files=['experiments/README.md'])
        self.assertTrue(any('missing local target' in item for item in errors))

    def test_large_file_warning_and_unavailable_local_evidence(self):
        self.write('docs/README.md', '# Index\n[evidence](../data/reports/unavailable.json)\n' + 'x' * 100)
        notices = []
        errors, warnings, _ = module.check(self.root, size_limit=20, notices=notices)
        self.assertEqual(errors, [])
        self.assertTrue(any('larger than' in item for item in warnings))
        self.assertFalse(any('local generated' in item for item in warnings))
        self.assertTrue(any('local generated' in item for item in notices))

    def test_size_limit_fails_for_active_contracts_and_plans_only(self):
        names = ['features/contract.md', 'plans/plan.md', 'history/report.md',
                 'archive/spec.md', 'research/audit.md']
        self.write('docs/README.md', '# Index\n' + ''.join(f'[doc]({name})\n' for name in names))
        for name in names:
            header = HEADER.replace('status: current', 'status: history') if name.startswith(('history/', 'archive/')) else HEADER
            self.write('docs/' + name, '# Document\n' + 'x' * 1000, header)
        errors, warnings, _ = module.check(self.root, size_limit=500)
        self.assertEqual({item.split(':')[0] for item in errors},
                         {'docs/features/contract.md', 'docs/plans/plan.md'})
        self.assertEqual(warnings, [])

    def test_historical_size_exemption_preserves_metadata_and_link_checks(self):
        self.write('docs/README.md', '# Index\n[report](history/report.md)\n')
        self.write('docs/history/report.md', '# Report\n[broken](missing.md)\n' + 'x' * 1000,
                   HEADER.replace('status: current', 'status: invalid'))
        errors, warnings, _ = module.check(self.root, size_limit=500)
        self.assertTrue(any('invalid status' in item for item in errors))
        self.assertTrue(any('missing local target' in item for item in errors))
        self.assertFalse(any('larger than' in item for item in errors + warnings))

    def test_utf8_cyrillic_boundary_at_40_kib(self):
        self.write('docs/README.md', '# Index\n[contract](features/contract.md)\n')
        prefix = HEADER + '# Контракт\n'
        limit = 40 * 1024
        for byte_count in (limit - 1, limit, limit + 1):
            with self.subTest(bytes=byte_count):
                remaining = byte_count - len(prefix.encode('utf-8'))
                text = prefix + 'я' * (remaining // 2) + 'x' * (remaining % 2)
                self.write('docs/features/contract.md', text, '')
                self.assertEqual(len(text.encode('utf-8')), byte_count)
                self.assertLess(len(text), limit)
                errors, warnings, _ = module.check(self.root)
                self.assertEqual(bool(errors), byte_count > limit)
                self.assertEqual(warnings, [])

    def test_report_links_warn_in_active_folders_and_are_info_in_history(self):
        names = ['features/contract.md', 'plans/plan.md', 'data/import.md',
                 'history/report.md', 'archive/spec.md', 'research/audit.md']
        self.write('docs/README.md', '# Index\n' + ''.join(f'[doc]({name})\n' for name in names))
        for name in names:
            header = HEADER.replace('status: current', 'status: history') if name.startswith(('history/', 'archive/')) else HEADER
            self.write('docs/' + name, '# Document\n[evidence](../../data/reports/absent.json)\n', header)
        notices = []
        errors, warnings, _ = module.check(self.root, notices=notices)
        self.assertEqual(errors, [])
        self.assertEqual({item.split(':')[0] for item in warnings},
                         {'docs/features/contract.md', 'docs/plans/plan.md', 'docs/data/import.md'})
        self.assertEqual({item.split(':')[0] for item in notices},
                         {'docs/history/report.md', 'docs/archive/spec.md', 'docs/research/audit.md'})

    def test_historical_directories_reject_current_status(self):
        self.write('docs/README.md', '# Index\n[history](history/a.md)\n[archive](archive/a.md)\n')
        self.write('docs/history/a.md', '# History\n')
        self.write('docs/archive/a.md', '# Archive\n')
        errors, _, _ = module.check(self.root)
        self.assertEqual(sum('historical directory requires' in item for item in errors), 2)


if __name__ == '__main__':
    unittest.main()
