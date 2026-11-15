import hashlib
import importlib.util
import json
import tempfile
import unittest
import zipfile
from pathlib import Path

spec = importlib.util.spec_from_file_location('handoff', Path(__file__).resolve().parents[1]/'tools/prepare_runable_handoff.py')
handoff = importlib.util.module_from_spec(spec); spec.loader.exec_module(handoff)

class HandoffTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)/'source'; self.root.mkdir()
        self.out = Path(self.temp.name)/'prepared'
        (self.root/'guide.pdf').write_bytes(b'%PDF-1.7\nOriginal guide\n%%EOF')
        (self.root/'preview.png').write_bytes(b'\x89PNG\r\n\x1a\npublic-preview')
    def prepare(self, products=None, previews=None):
        return handoff.prepare(self.root, products or ['guide.pdf'], previews or [], self.out)
    def test_contents_hashes_preview_separation_and_originals_preserved(self):
        before=(self.root/'guide.pdf').read_bytes()
        target, manifest=self.prepare(previews=['preview.png'])
        with zipfile.ZipFile(target/'products.zip') as archive:
            self.assertEqual(archive.namelist(),['guide.pdf']); self.assertIsNone(archive.testzip())
            self.assertEqual(archive.read('guide.pdf'),before)
        self.assertEqual((target/'public-previews/preview.png').read_bytes(),(self.root/'preview.png').read_bytes())
        self.assertEqual(manifest['products'][0]['sha256'],hashlib.sha256(before).hexdigest())
        self.assertEqual(manifest['archive']['sha256'],hashlib.sha256((target/'products.zip').read_bytes()).hexdigest())
        self.assertEqual(manifest['status'],'prepared_not_uploaded'); self.assertFalse(manifest['uploaded']); self.assertFalse(manifest['published'])
        self.assertIsNone(manifest['income']['received']); self.assertEqual((self.root/'guide.pdf').read_bytes(),before)
    def test_repeat_order_independent_deterministic_identity_and_archive(self):
        (self.root/'data.csv').write_text('event,cost\nA,10\n')
        target, first=self.prepare(['guide.pdf','data.csv'])
        repeated, second=self.prepare(['data.csv','guide.pdf'])
        self.assertEqual(target,repeated); self.assertEqual(first,second)
        handoff.prepare(self.root,['data.csv','guide.pdf'],[],Path(self.temp.name)/'other')
        self.assertEqual((target/'products.zip').read_bytes(),(Path(self.temp.name)/'other'/first['handoff_id']/'products.zip').read_bytes())
        (self.root/'data.csv').write_text('event,cost\nA,11\n')
        self.assertNotEqual(self.prepare(['data.csv','guide.pdf'])[1]['handoff_id'],first['handoff_id'])
    def test_missing_traversal_absolute_directory_hidden_sensitive_and_unsupported(self):
        (self.root/'.env.txt').write_text('secret'); (self.root/'credentials.txt').write_text('secret')
        (self.root/'script.py').write_text('print(1)')
        for name in ['missing.pdf','../guide.pdf',str(self.root/'guide.pdf'),'.env.txt','credentials.txt','script.py','nested/../../guide.pdf']:
            with self.subTest(name=name), self.assertRaises((ValueError,FileNotFoundError)): self.prepare([name])
        (self.root/'folder.pdf').mkdir()
        with self.assertRaises(ValueError): self.prepare(['folder.pdf'])
        self.assertFalse(self.out.exists())
    def test_symlink_inside_and_outside_root_and_output_refused(self):
        (self.root/'escape.pdf').symlink_to(Path(self.temp.name)/'outside.pdf')
        (self.root/'alias.pdf').symlink_to(self.root/'guide.pdf')
        for name in ['escape.pdf','alias.pdf']:
            with self.assertRaises(ValueError): self.prepare([name])
        self.out.symlink_to(self.root,target_is_directory=True)
        with self.assertRaises(ValueError): self.prepare()
    def test_oversized_single_and_total_no_output(self):
        original=handoff.MAX_SOURCE_BYTES; handoff.MAX_SOURCE_BYTES=40
        try:
            (self.root/'large.txt').write_text('x'*41)
            with self.assertRaises(ValueError): self.prepare(['large.txt'])
            (self.root/'a.txt').write_text('a'*25); (self.root/'b.txt').write_text('b'*25)
            with self.assertRaises(ValueError): self.prepare(['a.txt','b.txt'])
        finally: handoff.MAX_SOURCE_BYTES=original
        self.assertFalse(self.out.exists())
    def test_actual_zip_size_limit(self):
        original=handoff.MAX_ZIP_BYTES; handoff.MAX_ZIP_BYTES=10
        try:
            with self.assertRaises(ValueError): self.prepare()
        finally: handoff.MAX_ZIP_BYTES=original
        self.assertFalse(self.out.exists())
    def test_docx_validated_and_crc_corruption_rejected(self):
        path=self.root/'document.docx'
        with zipfile.ZipFile(path,'w',compression=zipfile.ZIP_STORED) as archive:
            archive.writestr('word/document.xml','<document>Original content</document>')
            archive.writestr('_rels/.rels','<relationships/>')
        target,manifest=self.prepare(['document.docx'])
        self.assertIn('wordprocessingml',manifest['products'][0]['mime'])
        data=path.read_bytes().replace(b'Original content',b'Corrupt! content'); path.write_bytes(data)
        with self.assertRaises((ValueError,zipfile.BadZipFile)): self.prepare(['document.docx'])
    def test_archive_traversal_and_mismatched_structure_rejected(self):
        for member in ['../escape.txt','unrelated.xml']:
            with zipfile.ZipFile(self.root/'fake.xlsx','w') as archive: archive.writestr(member,'content')
            with self.assertRaises(ValueError): self.prepare(['fake.xlsx'])
    def test_invalid_signature_duplicate_preview_overlap_and_existing_tamper(self):
        (self.root/'fake.pdf').write_text('not pdf')
        with self.assertRaises(ValueError): self.prepare(['fake.pdf'])
        with self.assertRaises(ValueError): self.prepare(['guide.pdf','guide.pdf'])
        with self.assertRaises(ValueError): self.prepare(['preview.png'],['preview.png'])
        target,_=self.prepare(); (target/'products.zip').write_bytes(b'tampered')
        with self.assertRaises(ValueError): self.prepare()
    def test_normalized_path_alias_cannot_expose_product_as_public_preview(self):
        (self.root/'nested').mkdir()
        (self.root/'nested/art.png').write_bytes((self.root/'preview.png').read_bytes())
        with self.assertRaises(ValueError): self.prepare(['nested//art.png'],['nested/art.png'])
        self.assertFalse(self.out.exists())

if __name__=='__main__': unittest.main()
