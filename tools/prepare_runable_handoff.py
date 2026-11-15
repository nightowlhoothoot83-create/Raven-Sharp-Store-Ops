"""Package explicitly selected local exports; never upload, publish or execute files."""
import argparse
import hashlib
import json
import io
import stat
import tempfile
import zipfile
from pathlib import Path, PurePosixPath

MAX_ZIP_BYTES = 20_000_000
MAX_SOURCE_BYTES = 19_000_000
PRODUCT_TYPES = {'.pdf':'application/pdf', '.png':'image/png', '.jpg':'image/jpeg',
 '.jpeg':'image/jpeg', '.csv':'text/csv', '.txt':'text/plain',
 '.xlsx':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
 '.docx':'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
 '.pptx':'application/vnd.openxmlformats-officedocument.presentationml.presentation',
 '.epub':'application/epub+zip', '.odt':'application/vnd.oasis.opendocument.text'}
PREVIEW_TYPES = {'.png':'image/png', '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.webp':'image/webp'}
SENSITIVE = {'credentials','credential','secrets','secret','token','tokens','id_rsa','id_ed25519','config','password','passwords'}


def safe_parts(name, document_member=False):
    if '\\' in name or ':' in name or len(name) > 240: raise ValueError('Backslash paths are not accepted')
    path = PurePosixPath(name)
    if path.is_absolute() or not path.parts or any(p in {'.','..'} or (p.startswith('.') and not (document_member and p == '.rels')) for p in name.split('/')):
        raise ValueError('Choose explicit relative files without hidden or traversal components')
    for part in path.parts:
        stem = Path(part).stem.lower()
        if stem in SENSITIVE or any(word in stem for word in ('api_key','access_token','private_key','credential','secret','password')):
            raise ValueError('Sensitive filenames are not accepted')
    return path


def no_symlinks(path):
    path = path.absolute()
    for component in [path, *path.parents]:
        if component.is_symlink(): raise ValueError('Symlinks are not accepted')


def verify_content(path, data):
    ext = path.suffix.lower()
    signatures = {'.pdf': b'%PDF-', '.png': b'\x89PNG\r\n\x1a\n', '.jpg': b'\xff\xd8\xff', '.jpeg': b'\xff\xd8\xff'}
    if ext in signatures and not data.startswith(signatures[ext]): raise ValueError('File signature does not match extension')
    if ext == '.webp' and not (data.startswith(b'RIFF') and data[8:12] == b'WEBP'):
        raise ValueError('Invalid WebP file')
    if ext in {'.txt','.csv'}:
        data.decode('utf-8-sig')
        if b'\0' in data: raise ValueError('Text files must not contain NUL bytes')
    if ext in {'.xlsx','.docx','.pptx','.epub','.odt'}:
        # These are ZIP-based formats. Validate bounded contents without extracting.
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            if len(archive.infolist()) > 2048: raise ValueError('Document contains too many members')
            total = 0
            for member in archive.infolist():
                name = member.filename.rstrip('/')
                safe_parts(name, document_member=True)
                if stat.S_ISLNK(member.external_attr >> 16) or member.flag_bits & 1:
                    raise ValueError('Archive symlinks and encryption are not supported')
                total += member.file_size
                if total > MAX_SOURCE_BYTES: raise ValueError('Expanded document exceeds limit')
            if archive.testzip() is not None: raise ValueError('Document archive CRC failed')
            required = {'.xlsx':'xl/workbook.xml','.docx':'word/document.xml','.pptx':'ppt/presentation.xml',
                        '.epub':'META-INF/container.xml','.odt':'content.xml'}[ext]
            if required not in archive.namelist(): raise ValueError('Document structure does not match extension')


def select(root, names, types):
    if len(names) > 100: raise ValueError('Too many selected files')
    selected = []
    total_bytes = 0
    for name in names:
        relative = safe_parts(name)
        path = root.joinpath(*relative.parts)
        no_symlinks(path)
        path.resolve(strict=True).relative_to(root)
        if not path.is_file(): raise ValueError('Only explicitly selected regular files are supported')
        if path.suffix.lower() not in types: raise ValueError('Unsupported export extension: ' + path.suffix)
        size = path.stat().st_size
        if not size or size > MAX_SOURCE_BYTES: raise ValueError('Empty or oversized export')
        total_bytes += size
        if total_bytes > MAX_SOURCE_BYTES: raise ValueError('Conservative total source limit exceeded')
        data = path.read_bytes()
        if len(data) != size: raise ValueError('Export changed during preparation')
        verify_content(path, data)
        selected.append((str(relative), data, types[path.suffix.lower()]))
    if len({name for name, _, _ in selected}) != len(selected): raise ValueError('Duplicate file selection')
    return sorted(selected)


def prepare(root, products, previews, out):
    root, out = Path(root).absolute(), Path(out).absolute()
    no_symlinks(root); no_symlinks(out)
    root = root.resolve(strict=True)
    if not root.is_dir(): raise ValueError('Input root must be a directory')
    if not products: raise ValueError('Select at least one product file')
    files = select(root, products, PRODUCT_TYPES)
    images = select(root, previews, PREVIEW_TYPES)
    if {name for name, _, _ in files} & {name for name, _, _ in images}:
        raise ValueError('Product downloads and public previews must be separate files')
    if sum(len(data) for _, data, _ in files + images) > MAX_SOURCE_BYTES:
        raise ValueError('Conservative total source limit exceeded')
    def records(items):
        return [{'name':name,'bytes':len(data),'mime':mime,'sha256':hashlib.sha256(data).hexdigest()} for name,data,mime in items]
    identity = {'schema_version':1,'products':records(files),'public_previews':records(images)}
    stable = hashlib.sha256(json.dumps(identity, sort_keys=True, separators=(',',':')).encode()).hexdigest()
    manifest = {**identity,'handoff_id':stable,'status':'prepared_not_uploaded',
        'delivery':'products.zip contains product deliverables only; public-previews contains separate promotional files',
        'uploaded':False,'published':False,'income':{'pending':None,'confirmed':None,'received':None,'currency':None}}
    # Prepare all data before writing. No source deletion or modification.
    with tempfile.TemporaryDirectory(prefix='runable-handoff-') as temporary:
        temp = Path(temporary); archive_path = temp/'products.zip'
        with zipfile.ZipFile(archive_path, 'w', compression=zipfile.ZIP_STORED) as archive:
            for name,data,_ in files:
                info = zipfile.ZipInfo(name, date_time=(1980,1,1,0,0,0)); info.external_attr = 0o100644 << 16
                archive.writestr(info,data)
        if archive_path.stat().st_size > MAX_ZIP_BYTES: raise ValueError('Actual ZIP exceeds Etsy limit')
        with zipfile.ZipFile(archive_path) as archive:
            if archive.testzip() is not None: raise ValueError('Output archive CRC failed')
        archive_data = archive_path.read_bytes()
    manifest['archive'] = {'name':'products.zip','mime':'application/zip','bytes':len(archive_data),
        'sha256':hashlib.sha256(archive_data).hexdigest()}
    target = out/stable
    no_symlinks(target)
    expected = {'products.zip':archive_data,'manifest.json':(json.dumps(manifest,sort_keys=True,indent=2)+'\n').encode()}
    expected.update({'public-previews/'+name:data for name,data,_ in images})
    if target.exists():
        actual = set()
        for path in target.rglob('*'):
            no_symlinks(path)
            if path.is_file(): actual.add(path.relative_to(target).as_posix())
        if actual != set(expected) or any((target/name).read_bytes()!=data for name,data in expected.items()):
            raise ValueError('Existing handoff differs; refusing to overwrite')
        return target, manifest
    out.mkdir(parents=True,exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='.handoff-',dir=out) as staging:
        staging = Path(staging)
        for name,data in expected.items():
            path = staging/name; path.parent.mkdir(parents=True,exist_ok=True); path.write_bytes(data)
        # Do not replace existing records if another process won this identity.
        staging.rename(target)
    return target, manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root',required=True); parser.add_argument('--product',action='append',required=True)
    parser.add_argument('--preview',action='append',default=[]); parser.add_argument('--out',required=True)
    args = parser.parse_args()
    try:
        target, manifest = prepare(args.root,args.product,args.preview,args.out)
    except (ValueError,OSError,zipfile.BadZipFile,UnicodeError) as exc:
        parser.exit(2,'Preparation failed: '+str(exc)+'\n')
    print(json.dumps({'directory':str(target),'handoff_id':manifest['handoff_id'],'status':manifest['status']}))

if __name__ == '__main__': main()
