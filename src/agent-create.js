import agentApp from './agent.js';
import { EtsyApiError, etsyRequest, exchangeToken, getSellerTaxonomy } from './etsy.js';
import {
  decryptValue, encryptValue, sessionCookie, getSessionCookie,
  verifySameOrigin, verifyCsrf,
} from './security.js';

const CREATE_PAGE = '/agent/new';
const CREATE_ACTION = '/agent/new/create';
const MAX_DIGITAL_FILES = 5;
const MAX_PREVIEW_IMAGES = 10;
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_AI_INLINE_BYTES = 18 * 1024 * 1024;
const ALLOWED_DIGITAL_EXTENSIONS = new Set([
  'bmp','doc','gif','jpeg','jpg','mobi','mov','mp3','mpeg','pdf','png','psp','rtf','stl','txt','zip','epub','ibook',
]);
const AI_IMAGE_TYPES = new Set(['image/jpeg','image/png','image/webp','image/gif']);
const ETSY_IMAGE_TYPES = new Set(['image/jpeg','image/png','image/gif','image/svg+xml','image/heic']);

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/health') {
      return json({
        ok: true,
        service: 'Raven Sharp Store Ops',
        version: '0.5.0-agent-create',
        agentCreate: true,
        publishLocked: true,
      });
    }

    if (request.method === 'GET' && url.pathname === '/listings/new' && url.searchParams.get('manual') !== '1') {
      return new Response(null, { status: 303, headers: { Location: CREATE_PAGE } });
    }

    if (request.method === 'GET' && url.pathname === CREATE_PAGE) return newAgentListingPage(request, env);
    if (request.method === 'POST' && url.pathname === CREATE_ACTION) return createAgentDraft(request, env);

    const response = await agentApp.fetch(request, env);
    if (request.method !== 'GET' || url.pathname !== '/') return response;
    if (!response.headers.get('Content-Type')?.includes('text/html') || response.status >= 400) return response;

    const html = await response.text();
    return cloneHtmlResponse(response, injectCreateAction(html, Boolean(env.OPENAI_API_KEY)));
  },
};

async function newAgentListingPage(request, env) {
  try {
    const loaded = await requireAgentSession(request, env);
    const url = new URL(request.url);
    return htmlWithSession(renderCreatePage({
      csrf: loaded.session.csrf,
      shopName: loaded.session.shopName || 'your Etsy shop',
      configured: Boolean(env.OPENAI_API_KEY),
      error: url.searchParams.get('error') || '',
    }), loaded);
  } catch (error) {
    return html(renderFatalPage(safeError(error)), statusForError(error));
  }
}

async function createAgentDraft(request, env) {
  let loaded = null;
  let createdListingId = '';

  try {
    verifySameOrigin(request);
    loaded = await requireAgentSession(request, env);
    const form = await request.formData();
    verifyCsrf(loaded.session, form.get('csrf'));
    assertAiConfigured(env);

    const productFiles = fileList(form, 'product_files');
    const previewImages = fileList(form, 'preview_images');
    const note = cleanShortText(form.get('note'), 800);

    validateProductFiles(productFiles);
    validatePreviewImages(previewImages);

    const shared = await loadCreateContext(env, loaded.session);
    const generated = await generateNewListing(env, { productFiles, previewImages, note, shared });

    const taxonomyId = chooseTaxonomyId(generated.categoryQuery, generated.productKind, shared.taxonomy);
    if (!taxonomyId) {
      throw new Error(`Raven identified this as ${generated.productKindLabel}, but could not match a safe Etsy category. No listing was created.`);
    }

    const sectionId = bestSectionId(generated.sectionQuery, shared.sections);
    const created = await etsyRequest(env, loaded.session, `/shops/${loaded.session.shopId}/listings`, {
      method: 'POST',
      body: buildCreatePayload(generated, taxonomyId, sectionId),
    });

    createdListingId = String(created?.listing_id || '');
    if (!/^\d+$/.test(createdListingId)) throw new Error('Etsy created the draft but did not return a usable listing ID.');

    let uploadedFiles = 0;
    let uploadedImages = 0;
    const uploadNotes = [];

    for (let i = 0; i < productFiles.length; i += 1) {
      try {
        await uploadDigitalFile(env, loaded.session, createdListingId, productFiles[i], i + 1);
        uploadedFiles += 1;
      } catch (error) {
        console.error('Raven product file upload failed', error);
        uploadNotes.push(`${safeDigitalFilename(productFiles[i].name)} could not be attached`);
      }
    }

    for (let i = 0; i < previewImages.length; i += 1) {
      try {
        await uploadPreviewImage(env, loaded.session, createdListingId, previewImages[i], i + 1);
        uploadedImages += 1;
      } catch (error) {
        console.error('Raven preview image upload failed', error);
        uploadNotes.push(`${safeFilename(previewImages[i].name)} could not be added as a preview`);
      }
    }

    const pieces = [
      `Raven identified this as ${generated.productKindLabel}`,
      'created the Etsy draft',
      'wrote the listing',
      `attached ${uploadedFiles}/${productFiles.length} product file${productFiles.length === 1 ? '' : 's'}`,
    ];
    if (previewImages.length) pieces.push(`added ${uploadedImages}/${previewImages.length} preview image${previewImages.length === 1 ? '' : 's'}`);
    if (uploadNotes.length) pieces.push(uploadNotes.join('; '));
    pieces.push('Nothing was published');

    return redirectWithSession(
      `/listings/${createdListingId}/edit?notice=${encodeURIComponent(`${pieces.join('. ')}.`)}`,
      loaded,
    );
  } catch (error) {
    console.error('Raven new-listing agent error', error);
    const message = safeError(error);

    if (createdListingId && loaded) {
      return redirectWithSession(
        `/listings/${createdListingId}/edit?error=${encodeURIComponent(`Draft ${createdListingId} exists, but Raven hit a snag finishing it: ${message}`)}`,
        loaded,
      );
    }

    const location = `${CREATE_PAGE}?error=${encodeURIComponent(message)}`;
    return loaded ? redirectWithSession(location, loaded) : new Response(null, { status: 303, headers: { Location: location } });
  }
}

async function loadCreateContext(env, session) {
  const [shop, sections, taxonomy] = await Promise.all([
    etsyRequest(env, session, `/shops/${session.shopId}`).catch(() => ({})),
    etsyRequest(env, session, `/shops/${session.shopId}/sections`).catch(() => ({ results: [] })),
    getSellerTaxonomy(env, session).catch(() => []),
  ]);

  return {
    currencyCode: String(shop?.currency_code || shop?.currency || '').trim() || 'shop currency',
    sections: Array.isArray(sections?.results) ? sections.results : [],
    taxonomy: Array.isArray(taxonomy) ? taxonomy : [],
  };
}

async function generateNewListing(env, { productFiles, previewImages, note, shared }) {
  const fileMetadata = productFiles.map(file => ({
    name: safeDigitalFilename(file.name),
    type: file.type || extensionMime(file.name),
    extension: extensionOf(file.name),
    bytes: file.size,
  }));
  const previewMetadata = previewImages.map(file => ({
    name: safeFilename(file.name),
    type: file.type || 'image',
    bytes: file.size,
  }));

  const source = {
    task: 'Create one complete digital Etsy draft from these uploaded product assets.',
    sellerNote: note,
    currency: shared.currencyCode,
    productFiles: fileMetadata,
    previewImages: previewMetadata,
    availableShopSections: shared.sections.map(section => String(section.title || '')).filter(Boolean),
  };

  const instructions = [
    'You are Raven Sharp Store Ops, an autonomous Etsy new-listing agent.',
    'Inspect the supplied files and decide what the digital product actually is before writing the listing.',
    'Distinguish these product kinds when supported by the evidence: ebook, digital_pdf, sticker_sheet, art_poster, printable_wall_art, workbook, coloring_book, planner_template, bundle, or other.',
    'A sticker_sheet is a sheet or set of multiple sticker-style designs, labels, cutouts, or decorative elements. An art_poster or printable_wall_art is primarily a single decorative composition intended to display or print as art. An ebook is book-length or chapter-style reading content. A workbook has structured exercises, prompts, worksheets, or instructional pages. A general document that does not fit those should be digital_pdf.',
    'PDF attachments may contain both text and page visuals. Use both. Image attachments should be inspected visually.',
    'For EPUB, ZIP, MOBI, or other files whose internal content is not visible, use only the extension, filename, seller note, and any visible companion cover/preview image. Never pretend to have inspected hidden contents.',
    'This route creates DIGITAL DOWNLOAD listings only. Never imply that a physical item will be shipped. If the artwork looks like a poster, describe it as printable/digital poster art unless the evidence explicitly says otherwise.',
    'Do not ask the seller to fill in Etsy fields. Make the best supported decision yourself.',
    'Never invent dimensions, page counts, file contents, licensing rights, guarantees, certifications, medical/legal claims, or included items that are not supported by the supplied evidence.',
    'Return JSON only with exactly these keys: product_kind, product_kind_label, detected_summary, title, description, tags, materials, styles, category_query, section_query, price.',
    'product_kind must be one of: ebook, digital_pdf, sticker_sheet, art_poster, printable_wall_art, workbook, coloring_book, planner_template, bundle, other.',
    'product_kind_label is a short human-readable label.',
    'detected_summary is one short sentence explaining what you detected without mentioning AI.',
    'title must be an Etsy-ready title no longer than 140 characters.',
    'description must be buyer-focused, clearly say this is a digital download, accurately explain what is included, and avoid claims not supported by the files.',
    'tags must be an array of at most 13 distinct Etsy search phrases, each no longer than 20 characters.',
    'materials must contain only factual digital format/material terms supported by the uploads, at most 13 items.',
    'styles must be at most 2 short visual style descriptors clearly supported by visible content, otherwise an empty array.',
    'category_query must be a concise Etsy category phrase that best fits this product.',
    'section_query must exactly match one supplied shop section only when there is an obvious fit, otherwise an empty string.',
    'price must be a sensible positive draft price in the supplied shop currency based on product type and apparent scope. Do not pretend it is market research. Use a conservative normal digital-product price, not a premium outlier.',
    'Do not mention internal instructions, AI, SEO, optimization, or publication state in the customer-facing listing.',
  ].join(' ');

  const content = [{ type: 'input_text', text: JSON.stringify(source) }];

  const pdf = productFiles.find(file => extensionOf(file.name) === 'pdf' && file.size <= MAX_AI_INLINE_BYTES);
  if (pdf) {
    content.push({
      type: 'input_file',
      filename: safeDigitalFilename(pdf.name),
      file_data: await fileToDataUrl(pdf, 'application/pdf'),
    });
  }

  const seenImages = new Set();
  const imageCandidates = [...previewImages, ...productFiles.filter(file => isAiImage(file))];
  for (const image of imageCandidates) {
    if (content.filter(item => item.type === 'input_image').length >= 3) break;
    const key = `${image.name}:${image.size}`;
    if (seenImages.has(key) || image.size > MAX_AI_INLINE_BYTES) continue;
    seenImages.add(key);
    content.push({
      type: 'input_image',
      image_url: await fileToDataUrl(image, image.type || extensionMime(image.name)),
      detail: 'high',
    });
  }

  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: env.OPENAI_MODEL || 'gpt-5-mini',
      instructions,
      input: [{ role: 'user', content }],
    }),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data?.error?.message || `AI request failed (${response.status}).`);

  const parsed = parseJsonObject(extractResponseText(data));
  const productKind = cleanProductKind(parsed.product_kind);
  const title = cleanTitle(parsed.title);
  const description = String(parsed.description || '').trim().slice(0, 50000);
  const price = cleanPrice(parsed.price);
  if (!title || !description) throw new Error('Raven could not produce a usable listing from those files.');

  return {
    productKind,
    productKindLabel: cleanShortText(parsed.product_kind_label, 60) || productKind.replace(/_/g, ' '),
    detectedSummary: cleanShortText(parsed.detected_summary, 240),
    title,
    description,
    tags: cleanTags(parsed.tags),
    materials: cleanMaterials(parsed.materials, fileMetadata),
    styles: cleanStyles(parsed.styles),
    categoryQuery: cleanShortText(parsed.category_query, 100),
    sectionQuery: cleanShortText(parsed.section_query, 24),
    price,
  };
}

function buildCreatePayload(generated, taxonomyId, sectionId) {
  const payload = new URLSearchParams();
  payload.set('quantity', '999');
  payload.set('title', generated.title);
  payload.set('description', generated.description);
  payload.set('price', generated.price.toFixed(2));
  payload.set('who_made', 'i_did');
  payload.set('when_made', '2020_2026');
  payload.set('taxonomy_id', String(taxonomyId));
  payload.set('type', 'download');
  payload.set('is_supply', 'false');
  payload.set('is_taxable', 'false');
  payload.set('should_auto_renew', 'true');
  if (generated.tags.length) payload.set('tags', generated.tags.join(','));
  if (generated.materials.length) payload.set('materials', generated.materials.join(','));
  if (generated.styles.length) payload.set('styles', generated.styles.join(','));
  if (sectionId) payload.set('shop_section_id', String(sectionId));
  return payload;
}

async function uploadDigitalFile(env, session, listingId, file, rank) {
  const body = new FormData();
  body.append('file', file, safeDigitalFilename(file.name));
  body.append('name', safeDigitalFilename(file.name));
  body.append('rank', String(rank));
  await etsyRequest(env, session, `/shops/${session.shopId}/listings/${listingId}/files`, { method: 'POST', body });
}

async function uploadPreviewImage(env, session, listingId, file, rank) {
  const body = new FormData();
  body.append('image', file, safeFilename(file.name));
  body.append('rank', String(rank));
  await etsyRequest(env, session, `/shops/${session.shopId}/listings/${listingId}/images`, { method: 'POST', body });
}

function validateProductFiles(files) {
  if (!files.length) throw new Error('Choose at least one product file for Raven to inspect.');
  if (files.length > MAX_DIGITAL_FILES) throw new Error(`Etsy allows up to ${MAX_DIGITAL_FILES} digital files per listing.`);
  for (const file of files) {
    const ext = extensionOf(file.name);
    if (!ALLOWED_DIGITAL_EXTENSIONS.has(ext)) throw new Error(`${safeFilename(file.name)} is not an Etsy-supported digital file type.`);
    if (!file.size) throw new Error(`${safeFilename(file.name)} is empty.`);
    if (file.size > MAX_FILE_BYTES) throw new Error(`${safeFilename(file.name)} is over Etsy's 20 MB per-file limit.`);
  }
}

function validatePreviewImages(files) {
  if (files.length > MAX_PREVIEW_IMAGES) throw new Error(`Add at most ${MAX_PREVIEW_IMAGES} preview images at a time.`);
  for (const file of files) {
    if (!file.size) throw new Error(`${safeFilename(file.name)} is empty.`);
    if (file.size > MAX_FILE_BYTES) throw new Error(`${safeFilename(file.name)} is over 20 MB.`);
    if (!ETSY_IMAGE_TYPES.has(String(file.type || '').toLowerCase())) throw new Error(`${safeFilename(file.name)} is not a supported Etsy preview image.`);
  }
}

function fileList(form, field) {
  return form.getAll(field).filter(value => value instanceof File && value.size > 0);
}

function isAiImage(file) {
  return AI_IMAGE_TYPES.has(String(file.type || extensionMime(file.name)).toLowerCase());
}

async function fileToDataUrl(file, fallbackType) {
  const type = String(file.type || fallbackType || 'application/octet-stream');
  const buffer = await file.arrayBuffer();
  return `data:${type};base64,${arrayBufferToBase64(buffer)}`;
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + chunkSize, bytes.length)));
  }
  return btoa(binary);
}

const CATEGORY_FALLBACKS = {
  ebook: ['digital books', 'books', 'ebooks'],
  digital_pdf: ['digital downloads', 'printables', 'digital prints'],
  sticker_sheet: ['stickers', 'planner stickers', 'sticker sheets'],
  art_poster: ['digital prints', 'art prints', 'wall decor'],
  printable_wall_art: ['digital prints', 'printable wall art', 'art prints'],
  workbook: ['workbooks', 'learning and school', 'printables'],
  coloring_book: ['coloring books', 'coloring pages', 'printables'],
  planner_template: ['planner templates', 'planners', 'templates'],
  bundle: ['digital downloads', 'printables', 'templates'],
  other: ['digital downloads', 'printables'],
};

function chooseTaxonomyId(query, productKind, taxonomy) {
  const queries = [query, ...(CATEGORY_FALLBACKS[productKind] || CATEGORY_FALLBACKS.other)]
    .map(value => cleanShortText(value, 100)).filter(Boolean);
  let best = null;
  for (const candidateQuery of queries) {
    const match = scoreTaxonomy(candidateQuery, taxonomy);
    if (match && (!best || match.score > best.score)) best = match;
  }
  return best && best.score >= 4 ? best.id : '';
}

function scoreTaxonomy(query, taxonomy) {
  const needle = normalize(query);
  const tokens = needle.split(' ').filter(token => token.length > 2);
  if (!tokens.length) return null;
  let best = null;
  for (const item of taxonomy || []) {
    const hay = normalize(`${item.name || ''} ${item.path || ''}`);
    if (!hay) continue;
    let score = 0;
    if (hay === needle) score += 14;
    if (hay.endsWith(needle)) score += 7;
    if (hay.includes(needle)) score += 5;
    for (const token of tokens) if (hay.includes(token)) score += 2;
    if (!best || score > best.score) best = { id: String(item.id), score };
  }
  return best;
}

function bestSectionId(query, sections) {
  const needle = normalize(query);
  if (!needle) return '';
  const exact = (sections || []).find(section => normalize(section.title) === needle);
  if (exact) return String(exact.shop_section_id);
  const tokens = needle.split(' ').filter(token => token.length > 2);
  let best = null;
  for (const section of sections || []) {
    const hay = normalize(section.title);
    let score = 0;
    for (const token of tokens) if (hay.includes(token)) score += 2;
    if (!best || score > best.score) best = { id: String(section.shop_section_id), score };
  }
  return best && best.score >= 2 ? best.id : '';
}

function cleanProductKind(value) {
  const allowed = new Set(['ebook','digital_pdf','sticker_sheet','art_poster','printable_wall_art','workbook','coloring_book','planner_template','bundle','other']);
  const kind = String(value || '').trim().toLowerCase();
  return allowed.has(kind) ? kind : 'other';
}

function cleanTitle(value) {
  return String(value || '').replace(/[^\p{L}\p{N}\p{P}\p{Sm}\p{Zs}™©®]/gu, '').replace(/\s+/g, ' ').trim().slice(0, 140);
}

function cleanTags(value) {
  const source = Array.isArray(value) ? value : String(value || '').split(',');
  const output = [];
  const seen = new Set();
  for (const raw of source) {
    const tag = String(raw || '').replace(/[^\p{L}\p{N}\p{Zs}\-'™©®]/gu, '').replace(/\s+/g, ' ').trim().slice(0, 20);
    const key = tag.toLocaleLowerCase();
    if (tag && !seen.has(key)) { seen.add(key); output.push(tag); }
    if (output.length >= 13) break;
  }
  return output;
}

function cleanMaterials(value, fileMetadata) {
  const source = Array.isArray(value) ? value : String(value || '').split(',');
  const output = uniqueClean(source, 13, 45, item => item.replace(/[^\p{L}\p{N}\p{Zs}]/gu, '').replace(/\s+/g, ' ').trim());
  for (const ext of new Set(fileMetadata.map(file => file.extension.toUpperCase()).filter(Boolean))) {
    const label = `${ext} digital file`;
    if (!output.some(item => normalize(item) === normalize(label))) output.push(label);
    if (output.length >= 13) break;
  }
  return output.slice(0, 13);
}

function cleanStyles(value) {
  const source = Array.isArray(value) ? value : String(value || '').split(',');
  return uniqueClean(source, 2, 20, item => item.replace(/[^\p{L}\p{N}\p{Zs}\-']/gu, '').replace(/\s+/g, ' ').trim());
}

function uniqueClean(source, maxItems, maxLength, cleaner) {
  const output = [];
  const seen = new Set();
  for (const raw of source) {
    const item = cleaner(String(raw || '').slice(0, maxLength));
    const key = item.toLocaleLowerCase();
    if (item && !seen.has(key)) { seen.add(key); output.push(item); }
    if (output.length >= maxItems) break;
  }
  return output;
}

function cleanPrice(value) {
  const number = Number(String(value ?? '').replace(/[^0-9.]/g, ''));
  if (!Number.isFinite(number) || number <= 0) return 7.95;
  return Math.min(250, Math.max(1, Math.round(number * 100) / 100));
}

function cleanShortText(value, maxLength) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function extractResponseText(data) {
  if (typeof data?.output_text === 'string' && data.output_text.trim()) return data.output_text.trim();
  const chunks = [];
  for (const item of data?.output || []) {
    for (const part of item?.content || []) {
      if (part?.type === 'output_text' && typeof part.text === 'string') chunks.push(part.text);
    }
  }
  return chunks.join('\n').trim();
}

function parseJsonObject(raw) {
  const text = String(raw || '').trim();
  try { return JSON.parse(text); } catch {}
  const unfenced = text.replace(/^```(?:json)?\s*/i, '').replace(/```$/i, '').trim();
  try { return JSON.parse(unfenced); } catch {}
  const start = unfenced.indexOf('{');
  const end = unfenced.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try { return JSON.parse(unfenced.slice(start, end + 1)); } catch {}
  }
  throw new Error('Raven returned listing content in an unexpected format.');
}

function extensionOf(name) {
  const match = String(name || '').toLowerCase().match(/\.([a-z0-9]+)$/);
  return match ? match[1] : '';
}

function extensionMime(name) {
  return ({ pdf:'application/pdf', png:'image/png', jpg:'image/jpeg', jpeg:'image/jpeg', gif:'image/gif', webp:'image/webp', epub:'application/epub+zip', zip:'application/zip', txt:'text/plain' })[extensionOf(name)] || 'application/octet-stream';
}

function safeDigitalFilename(name) {
  const original = String(name || 'digital-file').trim();
  const ext = extensionOf(original);
  const base = original.replace(/\.[^.]+$/, '').replace(/[^\p{L}\p{N}\p{Zs}\-_.()]/gu, '').replace(/\s+/g, ' ').trim().slice(0, 120) || 'digital-file';
  return ext ? `${base}.${ext}` : base;
}

function safeFilename(name) {
  return String(name || 'file').replace(/[^\p{L}\p{N}._()\- ]/gu, '').replace(/\s+/g, ' ').trim().slice(0, 140) || 'file';
}

function normalize(value) {
  return String(value || '').normalize('NFKD').toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').replace(/\s+/g, ' ').trim();
}

function renderCreatePage({ csrf, shopName, configured, error }) {
  const disabled = configured ? '' : ' disabled';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Raven Auto Listing</title><style>
:root{color-scheme:dark;background:#0d0d12;color:#f5f2ff;font-family:Inter,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at top,#211a34 0,#0d0d12 44%);min-height:100vh}main{max-width:780px;margin:auto;padding:22px 16px 60px}.card{background:#17151f;border:1px solid #34303f;border-radius:18px;padding:20px;box-shadow:0 20px 50px #0006}h1{font-size:1.65rem;margin:.1em 0 .35em}h2{font-size:1.05rem;margin:1.25em 0 .4em}p{line-height:1.5}.muted{color:#b9b3c6}.pill{display:inline-block;border:1px solid #4c3f70;border-radius:999px;padding:6px 10px;font-size:.82rem;color:#d9ceff;background:#211a34}label{display:block;font-weight:700;margin:18px 0 7px}input[type=file],textarea{width:100%;background:#0f0e15;color:#f7f5ff;border:1px solid #464052;border-radius:12px;padding:12px}textarea{min-height:86px;resize:vertical}button,.button{display:inline-block;border:0;border-radius:12px;padding:13px 17px;font-weight:800;text-decoration:none;cursor:pointer;background:#7b5cff;color:white;font-size:1rem}.button.secondary{background:#292532;color:#eee;border:1px solid #45404f}button:disabled{opacity:.45;cursor:not-allowed}.actions{display:flex;gap:10px;flex-wrap:wrap;margin-top:18px}.note{border-left:3px solid #7b5cff;padding-left:12px;color:#c9c3d6}.warning{padding:12px;border-radius:12px;background:#3b2815;color:#ffdda8;margin:14px 0}.error{padding:12px;border-radius:12px;background:#421d26;color:#ffd4dd;margin:14px 0}ul{line-height:1.55;padding-left:21px}
</style></head><body><main><div class="card"><span class="pill">Publish locked</span><h1>⚡ Raven: make a new Etsy listing</h1><p class="muted">Drop in the actual product files. Raven inspects them, decides whether it is an ebook, PDF product, sticker sheet, printable art/poster, workbook, colouring book, template or bundle, then builds the Etsy draft for ${escapeHtml(shopName)}.</p>${error ? `<div class="error">${escapeHtml(error)}</div>` : ''}${!configured ? '<div class="warning">OPENAI_API_KEY is not configured in Cloudflare yet, so the autonomous creator cannot run.</div>' : ''}<form method="post" action="${CREATE_ACTION}" enctype="multipart/form-data"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><label>Product file(s)</label><input type="file" name="product_files" multiple required accept=".pdf,.epub,.mobi,.png,.jpg,.jpeg,.gif,.zip,.txt,.doc,.rtf,.bmp,.stl,.psp,.mov,.mp3,.mpeg,.ibook"><p class="muted">Up to 5 files, 20 MB each. PDFs and images are inspected directly. EPUB/ZIP/MOBI are identified from file type/name plus any cover or preview you add.</p><label>Preview / cover images <span class="muted">(optional)</span></label><input type="file" name="preview_images" multiple accept="image/jpeg,image/png,image/gif,image/svg+xml,image/heic"><p class="muted">These are the images Raven is allowed to upload publicly to the Etsy draft. Product artwork is never silently exposed as a listing preview.</p><label>Anything Raven should know? <span class="muted">(optional)</span></label><textarea name="note" maxlength="800" placeholder="Example: This is volume 2, or this sticker sheet is for planners. Leave blank if the files speak for themselves."></textarea><div class="actions"><button type="submit"${disabled}>⚡ Inspect files and make the draft</button><a class="button secondary" href="/">Back to Store Ops</a><a class="button secondary" href="/listings/new?manual=1">Manual form</a></div></form><h2>What happens automatically</h2><ul><li>Classifies the product from the actual PDF/image content where possible.</li><li>Writes title, description, tags, materials and style.</li><li>Chooses an Etsy category and your shop section when there is a clear match.</li><li>Sets a sensible draft price in the shop currency.</li><li>Creates a <strong>digital-download draft</strong> and attaches the product files.</li><li>Uploads only the preview images you explicitly selected.</li></ul><p class="note"><strong>Nothing publishes automatically.</strong> Physical poster fulfilment is a separate workflow because Etsy requires physical-listing shipping/readiness settings.</p></div></main></body></html>`;
}

function injectCreateAction(html, configured) {
  if (html.includes('href="/agent/new"') || !configured) return html;
  const block = `<section class="card" style="margin-bottom:16px;border:1px solid #5e48b7"><div class="listing-head"><div><h2>✨ New listing from files</h2><p class="muted">Upload the product. Raven figures out what it is and creates the Etsy draft instead of making you fill out the form.</p></div><span class="pill good">Agent-first</span></div><a class="button" href="${CREATE_PAGE}">⚡ Create listing from files</a></section>`;
  return html.replace('<div class="grid">', `${block}<div class="grid">`);
}

async function requireAgentSession(request, env) {
  if (!env.ETSY_KEYSTRING || !env.ETSY_SHARED_SECRET || !env.SESSION_SECRET) throw new Error('Store Ops configuration is incomplete.');
  const cookie = getSessionCookie(request);
  if (!cookie) throw new Error('Connect your Etsy shop before using Raven.');
  let session;
  try { session = await decryptValue(cookie, env.SESSION_SECRET); }
  catch { throw new Error('Your Etsy session could not be read. Reconnect the shop.'); }
  if (Number(session.expiresAt || 0) > Date.now() + 5 * 60 * 1000) return { session, cookie: null };
  const token = await exchangeToken({ grant_type:'refresh_token', client_id:env.ETSY_KEYSTRING, refresh_token:session.refreshToken });
  session = { ...session, accessToken:token.access_token, refreshToken:token.refresh_token || session.refreshToken, expiresAt:Date.now() + Number(token.expires_in || 3600) * 1000 };
  return { session, cookie:sessionCookie(await encryptValue(session, env.SESSION_SECRET)) };
}

function assertAiConfigured(env) {
  if (!env.OPENAI_API_KEY) throw new Error('Raven Agent AI is not configured yet. Add OPENAI_API_KEY as an encrypted Cloudflare secret.');
}

function redirectWithSession(location, loaded) {
  const headers = new Headers({ Location:location });
  if (loaded?.cookie) headers.append('Set-Cookie', loaded.cookie);
  return new Response(null, { status:303, headers });
}

function htmlWithSession(body, loaded) {
  const headers = new Headers({ 'Content-Type':'text/html; charset=utf-8', 'Cache-Control':'no-store' });
  if (loaded?.cookie) headers.append('Set-Cookie', loaded.cookie);
  return new Response(body, { status:200, headers });
}

function html(body, status = 200) {
  return new Response(body, { status, headers:{ 'Content-Type':'text/html; charset=utf-8', 'Cache-Control':'no-store' } });
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), { status, headers:{ 'Content-Type':'application/json; charset=utf-8', 'Cache-Control':'no-store' } });
}

function cloneHtmlResponse(response, body) {
  const headers = new Headers(response.headers);
  headers.delete('Content-Length');
  return new Response(body, { status:response.status, statusText:response.statusText, headers });
}

function renderFatalPage(message) {
  return `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><body style="font-family:system-ui;background:#111;color:#eee;padding:24px"><h1>Raven Store Ops</h1><p>${escapeHtml(message)}</p><p><a style="color:#b8a5ff" href="/">Back to Store Ops</a></p></body>`;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#039;');
}

function safeError(error) {
  if (error instanceof EtsyApiError) return `Etsy replied: ${error.message}`;
  return error instanceof Error ? error.message : 'Raven hit an unexpected error.';
}

function statusForError(error) {
  if (error instanceof EtsyApiError && error.status) return Math.min(599, Math.max(400, Number(error.status)));
  return 500;
}
