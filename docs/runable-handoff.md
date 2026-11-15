# Package selected Runable exports for Etsy draft delivery

This local Python 3 standard-library tool solves file compatibility without changing Store Ops, Hub orchestration, Runable account access or publication controls. Raw XLSX/DOCX exports are packaged inside an Etsy-compatible ZIP; original files remain intact. It does not connect to Runable, fetch URLs, execute files, extract archives, upload or publish.

```sh
python tools/prepare_runable_handoff.py \
  --root /workspace/exports/my-product \
  --product workbook.xlsx \
  --product instructions.pdf \
  --preview preview.png \
  --out /workspace/outputs/runable-handoff
```

Repeat `--product`/`--preview` for each chosen relative file. No directory, wildcard or automatic recursive inclusion occurs. Products support PDF, PNG, JPG/JPEG, CSV, UTF-8 TXT, XLSX, DOCX, PPTX, EPUB and ODT. Public previews support PNG, JPG/JPEG and WebP. Arbitrary incoming ZIPs, scripts, executables and SVG are rejected. ZIP-based documents are checked for bounded readable members, expected format structure and CRC; nothing is extracted. Signature checks are basic format checks, not complete PDF/image validation or a malware scan. Spreadsheet formula correctness and listing claims still need existing product QA.

The tool rejects missing/empty files, unsupported extensions, traversal/absolute/hidden/sensitive filename components, directories, duplicate selection, preview/product overlap and symlinks (including ancestor symlinks). It does not inspect every byte for secrets: select only intentional customer deliverables and public previews; never choose credential-bearing documents. Metadata/config/session files are not automatically included. The manifest contains names, SHA-256, declared extension-based MIME and actual byte counts, never absolute source paths or credentials.

Conservative total selected source size, including previews: 19,000,000 bytes. Actual product ZIP limit: 20,000,000 bytes. ZIP uses deterministic stored entries and fixed timestamps; no unexpected compression expansion. At most 100 selected files per role and 2,048 internal document members are allowed; expanded ZIP-based document content is bounded to 19,000,000 bytes. Larger legitimate exports require splitting and separate review; the tool will not silently truncate them.

Output is `<out>/<stable-sha256-id>/`:

- `products.zip`: customer product deliverables only, readable CRC verified.
- `public-previews/`: separately copied promotional images; absent from customer ZIP.
- `manifest.json`: file/ZIP hashes, sizes, MIME, deterministic handoff ID, `prepared_not_uploaded`, explicit false upload/publication fields and null income fields.

The same files produce the same ID and ZIP regardless of argument order or destination folder. Changed content produces a different ID. An identical existing handoff is reused after checking every byte; altered/incomplete existing output is rejected rather than overwritten. This prevents accidental duplicate local handoff preparation. It is not remote Etsy idempotency: use the existing authenticated reviewed-draft upload and its attachment receipts. Preview claims and buyer-facing content must match. Inspect Etsy attachment limits at upload time; packaging success is not a live upload or delivery test.

Run checks:

```sh
python -m unittest discover -s test -p runable_handoff_test.py -v
```

Ten tests cover deterministic repeats, exact archive members/hash consistency, preserved originals, preview separation, missing/path/symlink/hidden/sensitive inputs, oversize totals and actual ZIP, malformed document structure/CRC, duplicated/overlapping selections (including normalized path aliases) and tampered existing output.

A local real-artifact exercise packaged the six existing custom-order desk-kit deliverables plus a separate preview at `/workspace/outputs/runable-handoff/c7846d05e670c1ccdfb2d1485ddfd65148756afee36030ddea483fc13882bef1/`. This is **prepared, not uploaded**. It proves local XLSX/PDF/CSV/TXT packaging compatibility only, not Runable ingestion, Etsy draft creation, publication, payment or a sale.
