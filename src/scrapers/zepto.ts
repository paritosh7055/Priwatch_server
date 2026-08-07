/**
 * Zepto integration — production hardened (2026-07).
 *
 * Flow (unchanged architecture):
 *   handshake() → geocodePincode() → resolveStore() → fetchProductDetail()
 *
 * Cookies (XSRF-TOKEN, device_id, session_id, aws-waf-token, serviceability) are
 * persisted to `.scrape-state/zepto.json` via the shared SessionManager so they
 * survive worker restarts — the gap the client called out.
 *
 * The public ScrapeResult contract (available: boolean) is preserved so the worker,
 * queue, scheduler, alerts and Prisma layer are untouched.
 */
import {
  discountFrom,
  extractJsonLd,
  fetchHtml,
  fetchHtmlBrowser,
  parseMoney,
  pickMeta,
} from './fetchPage.js'
import {
  CookieJar,
  Session,
  chromeFingerprint,
  harvestCookies,
  sessions,
  DEFAULT_UA,
} from './lib/scrapeClient.js'
import type { ScrapeContext, ScrapeResult, StoreScraper } from './types.js'

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const PROVIDER = 'zepto'
const UA = process.env.ZEPTO_USER_AGENT?.trim() || DEFAULT_UA
/** Official site: https://www.zepto.com/ */
const ORIGIN = 'https://www.zepto.com'
const BFF = 'https://bff-gateway.zepto.com'
/** Web artifact version — bump if responses degrade. Verified 16.16.0 (2026-07-17). */
const APP_VERSION = process.env.ZEPTO_APP_VERSION?.trim() || '16.16.0'
/** Soft TTL — expired sessions are still tried from disk before a full re-handshake. */
const SESSION_TTL_MS = Number(process.env.ZEPTO_SESSION_TTL_MS || 10 * 60_000)
const DEBUG = /^(1|true|yes|on)$/i.test(process.env.ZEPTO_DEBUG || '')
/** Fallback sample store when no pincode / store resolution fails.
 *  Prefer a store that actually carries common SKUs (fallbackType=NONE). */
const SAMPLE_STORE_ID =
  process.env.ZEPTO_SAMPLE_STORE_ID?.trim() || '0059ff6a-7eb0-477a-a7f5-69256f2c444b'

// ---------------------------------------------------------------------------
// Error taxonomy
// ---------------------------------------------------------------------------
export type ZeptoErrorCode =
  | 'INVALID_PINCODE'
  | 'PIN_NOT_SERVICEABLE'
  | 'STORE_NOT_FOUND'
  | 'PRODUCT_NOT_FOUND'
  | 'SESSION_EXPIRED'
  | 'GEOLOCATION_FAILED'
  | 'API_CHANGED'
  | 'RATE_LIMITED'
  | 'BLOCKED'
  | 'UNKNOWN'

export class ZeptoError extends Error {
  code: ZeptoErrorCode
  status?: number
  constructor(code: ZeptoErrorCode, message: string, status?: number) {
    super(`[${code}] ${message}`)
    this.name = 'ZeptoError'
    this.code = code
    this.status = status
  }
}

export type ZeptoAvailability =
  | 'AVAILABLE'
  | 'OUT_OF_STOCK'
  | 'NOT_SERVICEABLE'
  | 'PRODUCT_NOT_IN_STORE'
  | 'UNKNOWN'

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------
function dbg(...args: unknown[]) {
  if (DEBUG) console.log('[zepto:debug]', ...args)
}
function log(...args: unknown[]) {
  console.log('[zepto]', ...args)
}

/** Persist jar to disk after Set-Cookie updates (serviceability, rotated tokens). */
function persist(session: Session) {
  sessions.save(session)
}

/** Headers matching what Chrome sends to bff-gateway today. */
function bffHeaders(jar: CookieJar, storeId?: string): HeadersInit {
  const deviceId = jar.value('device_id')
  const sessionId = jar.value('session_id')
  const headers: Record<string, string> = {
    'User-Agent': UA,
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'en-IN',
    platform: 'WEB',
    app_sub_platform: 'WEB',
    tenant: 'ZEPTO',
    app_version: APP_VERSION,
    appversion: APP_VERSION,
    'x-without-bearer': 'true',
    Origin: ORIGIN,
    Referer: `${ORIGIN}/`,
    'x-xsrf-token': jar.value('XSRF-TOKEN'),
    Cookie: jar.header(),
    ...chromeFingerprint(),
  }
  if (deviceId) {
    headers.device_id = deviceId
    headers.deviceid = deviceId
  }
  if (sessionId) {
    headers.session_id = sessionId
    headers.sessionid = sessionId
  }
  if (storeId) {
    // CamelCase storeId is required — query param alone can return a stub
    // with outOfStock:true for every product.
    headers.storeId = storeId
    headers.store_id = storeId
    headers.storeid = storeId
    headers.store_ids = storeId
  }
  return headers
}

// ---------------------------------------------------------------------------
// URL parsing
// ---------------------------------------------------------------------------
export function extractZeptoVariantId(url: string): string | null {
  try {
    const u = new URL(url)
    const m = u.pathname.match(/\/pvid\/([0-9a-f-]{36})/i)
    if (m) return m[1]
    return u.searchParams.get('productVariantId') || u.searchParams.get('pvid') || null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// HTTP with error classification
// ---------------------------------------------------------------------------
function classifyStatus(status: number, where: string): ZeptoError | null {
  if (status >= 200 && status < 300) return null
  if (status === 401 || status === 419) return new ZeptoError('SESSION_EXPIRED', `${where} → ${status}`, status)
  if (status === 403 || status === 405) return new ZeptoError('BLOCKED', `${where} → ${status} (WAF/anti-bot)`, status)
  if (status === 429) return new ZeptoError('RATE_LIMITED', `${where} → ${status}`, status)
  if (status === 404) return new ZeptoError('API_CHANGED', `${where} → 404 (endpoint moved?)`, status)
  if (status >= 500) return new ZeptoError('UNKNOWN', `${where} → ${status} (upstream)`, status)
  return new ZeptoError('UNKNOWN', `${where} → ${status}`, status)
}

async function bffGet(session: Session, url: string, where: string, storeId?: string) {
  const started = Date.now()
  let res: Response
  try {
    res = await fetch(url, {
      headers: bffHeaders(session.jar, storeId),
      signal: AbortSignal.timeout(20_000),
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    dbg(`${where} network-error ${Date.now() - started}ms: ${msg}`)
    throw new ZeptoError(/timeout|abort/i.test(msg) ? 'UNKNOWN' : 'BLOCKED', `${where}: ${msg}`)
  }
  session.jar.applySetCookie(res)
  persist(session)
  dbg(`${where} ${res.status} ${Date.now() - started}ms ${url}`)
  const errCls = classifyStatus(res.status, where)
  if (errCls) throw errCls
  return res
}

// ---------------------------------------------------------------------------
// Session (disk-backed) + Playwright fallback for WAF
// ---------------------------------------------------------------------------
function jarLooksValid(jar: CookieJar) {
  return jar.has('XSRF-TOKEN') && jar.has('device_id')
}

async function handshakeViaFetch(origin = ORIGIN): Promise<CookieJar> {
  const jar = new CookieJar()
  const res = await fetch(`${origin}/`, {
    headers: {
      'User-Agent': UA,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-IN,en;q=0.9',
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(20_000),
  })
  jar.applySetCookie(res)
  dbg('handshake(fetch)', origin, res.status, 'cookies:', jar.keys().join(','))
  return jar
}

async function handshakeViaBrowser(origin = ORIGIN): Promise<CookieJar> {
  const cookies = await harvestCookies({
    provider: PROVIDER,
    url: `${origin}/`,
    // Cloud hosts need longer for WAF JS to mint cookies
    waitMs: Number(process.env.ZEPTO_HANDSHAKE_WAIT_MS || 4500),
  })
  const jar = new CookieJar()
  jar.applyPlaywright(cookies)
  dbg('handshake(browser)', origin, 'cookies:', jar.keys().join(','))
  return jar
}

/**
 * Load session from memory → disk → fresh handshake.
 * Disk cookies (incl. aws-waf-token) survive restarts; only re-handshake when
 * forced, missing, or clearly invalid.
 */
async function getSession(force = false): Promise<Session> {
  if (force) sessions.clear(PROVIDER)

  const cached = sessions.get(PROVIDER)
  if (!force && cached && jarLooksValid(cached.jar)) {
    const age = Date.now() - cached.createdAt
    dbg(
      `session: reuse disk/memory cookies age=${Math.round(age / 1000)}s ` +
        `keys=${cached.jar.keys().join(',')}`,
    )
    if (age > SESSION_TTL_MS) {
      cached.meta.stale = true
    }
    return cached
  }

  let jar = new CookieJar()
  try {
    jar = await handshakeViaFetch(ORIGIN)
  } catch (err) {
    dbg('fetch handshake failed:', err instanceof Error ? err.message : err)
    jar = new CookieJar()
  }

  if (!jarLooksValid(jar)) {
    try {
      jar = await handshakeViaBrowser(ORIGIN)
    } catch (err) {
      dbg('browser handshake failed:', err instanceof Error ? err.message : err)
    }
  }

  if (!jarLooksValid(jar)) {
    throw new ZeptoError(
      'BLOCKED',
      'Zepto BFF session cookies missing (XSRF-TOKEN/device_id). ' +
        'Will try product-page scrape fallback. Full pincode checks need a clean session.',
    )
  }

  const session = new Session(PROVIDER)
  session.jar = jar
  session.meta = { hasWaf: jar.has('aws-waf-token') }
  sessions.put(session)
  log(
    `session: saved to disk (.scrape-state/${PROVIDER}.json) cookies=${jar.keys().join(',')}`,
  )
  return session
}

// ---------------------------------------------------------------------------
// Step 1: geocode pincode → lat/lng
// ---------------------------------------------------------------------------
async function geocodePincode(
  session: Session,
  pincode: string,
): Promise<{ lat: number; lng: number; label?: string }> {
  if (!/^\d{6}$/.test(pincode)) {
    throw new ZeptoError('INVALID_PINCODE', `"${pincode}" is not a 6-digit Indian pincode`)
  }

  const autoRes = await bffGet(
    session,
    `${BFF}/api/v1/maps/place/autocomplete/?place_name=${encodeURIComponent(pincode)}`,
    'geocode.autocomplete',
  )
  const auto = (await autoRes.json()) as {
    predictions?: { place_id: string; description?: string }[]
  }
  const pred = auto.predictions?.[0]
  if (!pred?.place_id) {
    throw new ZeptoError('GEOLOCATION_FAILED', `no place match for pincode ${pincode}`)
  }

  const detRes = await bffGet(
    session,
    `${BFF}/api/v1/maps/place/details/?place_id=${encodeURIComponent(pred.place_id)}`,
    'geocode.details',
  )
  const det = (await detRes.json()) as {
    result?: { geometry?: { location?: { lat: number; lng: number } } }
  }
  const loc = det.result?.geometry?.location
  if (loc?.lat == null || loc?.lng == null) {
    throw new ZeptoError('GEOLOCATION_FAILED', `no coordinates for pincode ${pincode}`)
  }
  return { lat: loc.lat, lng: loc.lng, label: pred.description }
}

// ---------------------------------------------------------------------------
// Step 2: lat/lng → dark store (serviceability)
// The homepage HEAD sets a `serviceability` cookie describing the primaryStore
// for the given user_position. Verified working 2026-07-17.
// ---------------------------------------------------------------------------
type StoreInfo = {
  serviceable: boolean
  storeId?: string
  secondaryStoreId?: string
  city?: string
  etaMinutes?: number
  secondaryEtaMinutes?: number
}

function parseServiceability(jar: CookieJar): StoreInfo {
  const raw = jar.value('serviceability')
  if (!raw) return { serviceable: false }
  let svc: {
    primaryStore?: {
      serviceable?: boolean
      isDeliverable?: boolean
      storeId?: string
      etaInMinutes?: string | number
    }
    secondaryStore?: {
      serviceable?: boolean
      isDeliverable?: boolean
      storeId?: string
      etaInMinutes?: string | number
    }
    storeDetailedInfo?: { city?: string }
  }
  try {
    svc = JSON.parse(raw)
  } catch {
    return { serviceable: false }
  }
  const p = svc.primaryStore
  const s = svc.secondaryStore
  const secondaryOk = Boolean((s?.serviceable || s?.isDeliverable) && s?.storeId)
  return {
    serviceable: Boolean(p?.serviceable || p?.isDeliverable),
    storeId: p?.storeId,
    city: svc.storeDetailedInfo?.city,
    etaMinutes: p?.etaInMinutes != null ? Number(p.etaInMinutes) : undefined,
    secondaryStoreId: secondaryOk ? s?.storeId : undefined,
    secondaryEtaMinutes:
      secondaryOk && s?.etaInMinutes != null ? Number(s.etaInMinutes) : undefined,
  }
}

async function resolveStore(session: Session, lat: number, lng: number): Promise<StoreInfo> {
  // Clear stale serviceability so the HEAD resolves THIS pin's store
  session.jar.delete('serviceability')
  const posJson = JSON.stringify({ latitude: lat, longitude: lng })
  const pos = encodeURIComponent(posJson)
  const started = Date.now()

  // 1) Cheap HEAD (works when edge isn't challenging)
  let res: Response
  try {
    res = await fetch(`${ORIGIN}/`, {
      method: 'HEAD',
      headers: {
        'User-Agent': UA,
        Accept: 'text/html',
        'Accept-Language': 'en-IN,en;q=0.9',
        Cookie: session.jar.header({ user_position: pos }),
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(15_000),
    })
  } catch (err) {
    throw new ZeptoError(
      'UNKNOWN',
      `resolveStore HEAD failed: ${err instanceof Error ? err.message : err}`,
    )
  }
  session.jar.applySetCookie(res)
  dbg(`resolveStore HEAD ${res.status} ${Date.now() - started}ms`)

  let info = parseServiceability(session.jar)
  if (info.storeId || info.serviceable) {
    persist(session)
    return info
  }

  // 2) GET fallback (some edges reject HEAD)
  try {
    res = await fetch(`${ORIGIN}/`, {
      headers: {
        'User-Agent': UA,
        Accept: 'text/html',
        'Accept-Language': 'en-IN,en;q=0.9',
        Cookie: session.jar.header({ user_position: pos }),
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(20_000),
    })
    session.jar.applySetCookie(res)
    dbg(`resolveStore GET ${res.status}`)
    info = parseServiceability(session.jar)
    if (info.storeId || info.serviceable) {
      persist(session)
      return info
    }
  } catch (err) {
    dbg('resolveStore GET failed', err instanceof Error ? err.message : err)
  }

  // 3) Browser: complete WAF JS challenge and mint serviceability cookie.
  // Plain fetch often gets HTTP 202 challenge HTML with zero Set-Cookie.
  try {
    const cookies = await harvestCookies({
      provider: PROVIDER,
      url: `${ORIGIN}/`,
      waitMs: Number(process.env.ZEPTO_STORE_WAIT_MS || 5000),
      geolocation: { latitude: lat, longitude: lng },
      presetCookies: [
        ...session.jar.keys().map((name) => ({
          name,
          value: session.jar.raw(name) || '',
          domain: '.zepto.com',
        })),
        {
          name: 'user_position',
          value: pos,
          domain: '.zepto.com',
        },
      ],
    })
    session.jar.applyPlaywright(cookies)
    info = parseServiceability(session.jar)
    dbg(
      `resolveStore browser serviceable=${info.serviceable} store=${info.storeId?.slice(0, 8) ?? '-'}`,
    )
    persist(session)
    return info
  } catch (err) {
    dbg('resolveStore browser failed', err instanceof Error ? err.message : err)
  }

  persist(session)
  // Distinguish "couldn't resolve" (no cookie) from true unserviceable.
  return { serviceable: false }
}

// ---------------------------------------------------------------------------
// Step 3: product detail for a store
// ---------------------------------------------------------------------------
type ZeptoStoreProduct = {
  outOfStock?: boolean
  availableQuantity?: number
  discountedSellingPrice?: number
  superSaverSellingPrice?: number
  mrp?: number
  productVariant?: {
    isActive?: boolean
    Unlisted?: boolean
    images?: Array<{ path?: string }>
  }
}
type ZeptoProductDetail = {
  fallbackType?: string
  product?: {
    name?: string
    brand?: string
    atcActions?: unknown[]
    storeProducts?: ZeptoStoreProduct[]
  }
}

async function fetchProductDetail(
  session: Session,
  storeId: string,
  productVariantId: string,
): Promise<ZeptoProductDetail> {
  const url = `${BFF}/product-assortment-service/api/v2/product-detail?storeId=${encodeURIComponent(storeId)}&productVariantId=${encodeURIComponent(productVariantId)}`
  const res = await bffGet(session, url, 'productDetail', storeId)
  return (await res.json()) as ZeptoProductDetail
}

function paiseToInr(paise?: number | null): number | null {
  if (paise == null || !Number.isFinite(paise) || paise <= 0) return null
  return Math.round(paise) / 100
}

function imageFromDetail(detail: ZeptoProductDetail): string | undefined {
  const path = detail.product?.storeProducts?.[0]?.productVariant?.images?.[0]?.path
  if (!path) return undefined
  if (path.startsWith('http')) return path
  return `https://cdn.zeptonow.com/production/${path.replace(/^\//, '')}`
}

// ---------------------------------------------------------------------------
// Rich per-pincode check result
// ---------------------------------------------------------------------------
export type ZeptoCheck = {
  availability: ZeptoAvailability
  available: boolean
  price: number | null
  oldPrice?: number
  title?: string
  image?: string
  diagnostics: {
    pincode?: string
    city?: string
    lat?: number
    lng?: number
    storeId?: string
    serviceable?: boolean
    productExists?: boolean
    quantity?: number | null
    outOfStock?: boolean
    etaMinutes?: number
  }
}

function computeAvailability(
  sp: ZeptoStoreProduct | undefined,
  atcActions: unknown[] | undefined,
  fallbackType?: string,
): { status: ZeptoAvailability; quantity: number | null } {
  // Zepto returns another store's stub with outOfStock:true when the requested
  // store doesn't carry the variant — that is NOT a real OOS for this pin.
  if (fallbackType && fallbackType !== 'NONE') {
    return { status: 'PRODUCT_NOT_IN_STORE', quantity: null }
  }
  if (!sp) return { status: 'PRODUCT_NOT_IN_STORE', quantity: null }
  if (sp.productVariant?.isActive === false || sp.productVariant?.Unlisted === true) {
    return { status: 'PRODUCT_NOT_IN_STORE', quantity: sp.availableQuantity ?? null }
  }
  const qty = typeof sp.availableQuantity === 'number' ? sp.availableQuantity : null
  const oos = sp.outOfStock === true
  const hasAtc = Array.isArray(atcActions) && atcActions.length > 0
  // In stock when not flagged OOS AND (qty>0 or qty unknown) — atcActions corroborates
  const inStock = !oos && (qty == null || qty > 0) && (hasAtc || qty == null || qty > 0)
  return { status: inStock ? 'AVAILABLE' : 'OUT_OF_STOCK', quantity: qty }
}

/** Core: check one product at one pincode. Never throws for valid business states
 *  (not serviceable / OOS / not-in-store) — only for infra errors. */
export async function checkZeptoPincode(
  url: string,
  pincode: string | undefined,
  variantId: string,
): Promise<ZeptoCheck> {
  const session = await getSession()

  // No pincode → sample-store price only (availability unknown)
  if (!pincode) {
    const detail = await fetchProductDetail(session, SAMPLE_STORE_ID, variantId)
    const sp = detail.product?.storeProducts?.[0]
    const { status } = computeAvailability(sp, detail.product?.atcActions, detail.fallbackType)
    const price = paiseToInr(sp?.discountedSellingPrice) ?? paiseToInr(sp?.superSaverSellingPrice)
    return {
      availability: status === 'PRODUCT_NOT_IN_STORE' ? 'UNKNOWN' : status,
      available: status !== 'OUT_OF_STOCK' && status !== 'PRODUCT_NOT_IN_STORE',
      price: status === 'PRODUCT_NOT_IN_STORE' ? null : price,
      oldPrice: paiseToInr(sp?.mrp) || undefined,
      title: detail.product?.name,
      image: imageFromDetail(detail),
      diagnostics: { storeId: SAMPLE_STORE_ID },
    }
  }

  const geo = await geocodePincode(session, pincode)
  const store = await resolveStore(session, geo.lat, geo.lng)

  const diagBase = {
    pincode,
    city: store.city,
    lat: geo.lat,
    lng: geo.lng,
    storeId: store.storeId,
    serviceable: store.serviceable,
    etaMinutes: store.etaMinutes,
  }

  if (!store.serviceable || !store.storeId) {
    return {
      availability: 'NOT_SERVICEABLE',
      available: false,
      price: null,
      diagnostics: { ...diagBase, productExists: false, quantity: null },
    }
  }

  // Check primary, then secondary (Zepto often fulfils from secondary when
  // primary lacks the SKU — otherwise we false-report PRODUCT_NOT_IN_STORE).
  const storeIds = [store.storeId, store.secondaryStoreId].filter(
    (id, i, arr): id is string => Boolean(id) && arr.indexOf(id) === i,
  )

  let lastTitle: string | undefined
  let lastImage: string | undefined
  let lastOld: number | undefined

  for (const sid of storeIds) {
    const detail = await fetchProductDetail(session, sid, variantId)
    const sp = detail.product?.storeProducts?.[0]
    const { status, quantity } = computeAvailability(
      sp,
      detail.product?.atcActions,
      detail.fallbackType,
    )
    lastTitle = detail.product?.name || lastTitle
    lastImage = imageFromDetail(detail) || lastImage
    lastOld = paiseToInr(sp?.mrp) || lastOld

    if (status === 'PRODUCT_NOT_IN_STORE') {
      dbg(`store ${sid.slice(0, 8)} does not carry variant — trying next`)
      continue
    }

    const price = paiseToInr(sp?.discountedSellingPrice) ?? paiseToInr(sp?.superSaverSellingPrice)
    return {
      availability: status,
      available: status === 'AVAILABLE',
      price,
      oldPrice: lastOld,
      title: lastTitle,
      image: lastImage,
      diagnostics: {
        ...diagBase,
        storeId: sid,
        productExists: true,
        quantity,
        outOfStock: sp?.outOfStock,
        etaMinutes: sid === store.secondaryStoreId ? store.secondaryEtaMinutes : store.etaMinutes,
      },
    }
  }

  return {
    availability: 'PRODUCT_NOT_IN_STORE',
    available: false,
    price: null,
    oldPrice: lastOld,
    title: lastTitle,
    image: lastImage,
    diagnostics: {
      ...diagBase,
      productExists: false,
      quantity: null,
    },
  }
}

// ---------------------------------------------------------------------------
// HTML fallback (share links / no pvid) — availability unknown → true
// ---------------------------------------------------------------------------
function parseZeptoDom($: ReturnType<typeof import('cheerio').load>, note: string): ScrapeResult {
  const ld = extractJsonLd($)
  const title =
    pickMeta($, ['meta[property="og:title"]', 'h1', 'title']) || ld?.title || undefined
  const image = $('meta[property="og:image"]').attr('content') || ld?.image
  const price =
    parseMoney($('meta[property="product:price:amount"]').attr('content')) ||
    parseMoney($('[itemprop="price"]').attr('content')) ||
    parseMoney($('[class*="Price"]').first().text()) ||
    parseMoney($('[class*="price"]').first().text()) ||
    ld?.price ||
    null
  if (!price) throw new ZeptoError('PRODUCT_NOT_FOUND', 'price not found on product page')
  const oldPrice =
    parseMoney($('[class*="mrp"]').first().text()) || parseMoney($('s').first().text()) || undefined
  return {
    title: title || undefined,
    image,
    price,
    oldPrice: oldPrice || undefined,
    discount: discountFrom(oldPrice, price),
    available: true,
    source: 'live',
    rawNote: note,
  }
}

async function scrapeZeptoHtml(url: string): Promise<ScrapeResult> {
  const $ = await fetchHtml(url)
  return parseZeptoDom($, 'html-no-pvid')
}

/**
 * Same idea as Tata Neu / BigBasket: render the product page when the BFF
 * session handshake is blocked (common on Railway/cloud IPs). Price/title/image
 * still track; per-pincode availability is best-effort only.
 */
async function scrapeZeptoPageFallback(url: string): Promise<ScrapeResult> {
  try {
    const $ = await fetchHtmlBrowser(url, {
      waitText: /₹|Rs\.|add to cart|out of stock/i,
      waitMs: 2000,
      navigationTimeoutMs: 35_000,
    })
    return parseZeptoDom($, 'browser-fallback (BFF session blocked)')
  } catch {
    const $ = await fetchHtml(url)
    return parseZeptoDom($, 'http-fallback (BFF session blocked)')
  }
}

// ---------------------------------------------------------------------------
// Public scraper (unchanged contract)
// ---------------------------------------------------------------------------
async function scrapeZepto(ctx: ScrapeContext): Promise<ScrapeResult> {
  const variantId = extractZeptoVariantId(ctx.url)
  if (!variantId) {
    dbg('no pvid in URL — HTML fallback', ctx.url)
    try {
      return await scrapeZeptoHtml(ctx.url)
    } catch {
      return scrapeZeptoPageFallback(ctx.url)
    }
  }

  // One automatic retry with a forced fresh session on WAF/session errors.
  let check: ZeptoCheck
  try {
    check = await checkZeptoPincode(ctx.url, ctx.pincode, variantId)
  } catch (err) {
    // CloudFront often blocks BFF cookie handshake on Railway — same IP can
    // still load the product page (like Tata Neu / BigBasket). Fall back.
    if (err instanceof ZeptoError && err.code === 'BLOCKED') {
      log(`BFF session blocked — product page fallback`)
      return scrapeZeptoPageFallback(ctx.url)
    }
    if (
      err instanceof ZeptoError &&
      (err.code === 'SESSION_EXPIRED' || err.code === 'RATE_LIMITED')
    ) {
      log(`retrying after ${err.code}: forcing fresh session`)
      try {
        await getSession(true)
        check = await checkZeptoPincode(ctx.url, ctx.pincode, variantId)
      } catch (err2) {
        log(
          `BFF still failing (${err2 instanceof Error ? err2.message : err2}) — product page fallback`,
        )
        return scrapeZeptoPageFallback(ctx.url)
      }
    } else {
      throw err
    }
  }

  const d = check.diagnostics
  // Detailed per-pincode log line (as requested)
  log(
    `PIN=${d.pincode ?? '-'} city=${d.city ?? '?'} lat=${d.lat ?? '?'} lng=${d.lng ?? '?'} ` +
      `store=${d.storeId?.slice(0, 8) ?? '-'} serviceable=${d.serviceable ?? '?'} ` +
      `productExists=${d.productExists ?? '?'} qty=${d.quantity ?? '?'} eta=${d.etaMinutes ?? '?'}m ` +
      `=> ${check.availability}`,
  )

  // Business states we still want to record (price tracking / availability flip):
  // Never throw — match Blinkit: keep previous/list price, available:false, status stays tracking.
  if (check.availability === 'NOT_SERVICEABLE' || check.availability === 'PRODUCT_NOT_IN_STORE') {
    let price = check.price ?? 0
    let title = check.title
    let image = check.image
    let oldPrice = check.oldPrice
    let catalogAvailable: boolean | undefined

    // Prefer live catalog from a known sample store (SPA HTML has no price).
    if (!price || !title) {
      try {
        const session = await getSession()
        const detail = await fetchProductDetail(session, SAMPLE_STORE_ID, variantId)
        if (!detail.fallbackType || detail.fallbackType === 'NONE') {
          const sp = detail.product?.storeProducts?.[0]
          const catalogPrice =
            paiseToInr(sp?.discountedSellingPrice) ?? paiseToInr(sp?.superSaverSellingPrice)
          if (catalogPrice) price = catalogPrice
          title = title || detail.product?.name
          image = image || imageFromDetail(detail)
          oldPrice = oldPrice ?? (paiseToInr(sp?.mrp) || undefined)
          const av = computeAvailability(sp, detail.product?.atcActions, detail.fallbackType)
          catalogAvailable = av.status === 'AVAILABLE'
        }
      } catch {
        /* ignore */
      }
    }

    if (!price) {
      try {
        const html = await scrapeZeptoPageFallback(ctx.url)
        price = html.price
        title = title || html.title
        image = image || html.image
        oldPrice = oldPrice ?? html.oldPrice
      } catch {
        try {
          const html = await scrapeZeptoHtml(ctx.url)
          price = html.price
          title = title || html.title
          image = image || html.image
          oldPrice = oldPrice ?? html.oldPrice
        } catch {
          /* no public price */
        }
      }
    }
    if (!price && ctx.previousPrice && ctx.previousPrice > 0) {
      price = ctx.previousPrice
    }

    // Store resolve failed (no serviceability cookie) ≠ pin unserviceable.
    // SUPER_SAVER / national catalog SKUs often aren't in the local dark store
    // but still sell to the pin — don't mark those as "Out of stock here".
    const resolveFailed = !d.storeId && check.availability === 'NOT_SERVICEABLE'
    const superSaver = /marketplaceType=SUPER_SAVER/i.test(ctx.url) || /[?&]marketplace=SUPER_SAVER/i.test(ctx.url)
    const available =
      (resolveFailed && catalogAvailable === true) ||
      (check.availability === 'PRODUCT_NOT_IN_STORE' &&
        catalogAvailable === true &&
        (superSaver || resolveFailed))
        ? true
        : false

    if (!price) {
      return {
        title,
        image,
        price: ctx.previousPrice && ctx.previousPrice > 0 ? ctx.previousPrice : 0,
        oldPrice,
        discount: 0,
        available: false,
        source: 'live',
        rawNote: `pin ${ctx.pincode} ${check.availability} city=${d.city ?? '?'} (no price)`,
      }
    }
    return {
      title,
      image,
      price,
      oldPrice,
      discount: discountFrom(oldPrice, price),
      available,
      source: 'live',
      rawNote: resolveFailed
        ? `pin ${ctx.pincode} STORE_UNRESOLVED catalog=${catalogAvailable ? 'in_stock' : 'n/a'} (list price)`
        : available && check.availability === 'PRODUCT_NOT_IN_STORE'
          ? `pin ${ctx.pincode} SUPER_SAVER/list price (not in local dark store) city=${d.city ?? '?'}`
          : `pin ${ctx.pincode} ${check.availability} city=${d.city ?? '?'}`,
    }
  }

  if (!check.price) {
    throw new ZeptoError('PRODUCT_NOT_FOUND', `pincode ${ctx.pincode}: no price returned`)
  }

  return {
    title: check.title,
    image: check.image,
    price: check.price,
    oldPrice: check.oldPrice,
    discount: discountFrom(check.oldPrice, check.price),
    available: check.available,
    source: 'live',
    rawNote:
      `pin ${ctx.pincode ?? '-'} ${check.availability} city=${d.city ?? '?'} ` +
      `store=${d.storeId?.slice(0, 8) ?? '-'} qty=${d.quantity ?? '?'} oos=${Boolean(d.outOfStock)}`,
  }
}

export const zeptoScraper: StoreScraper = {
  slug: 'zepto',
  scrape: scrapeZepto,
}
