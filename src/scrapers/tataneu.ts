import {
  discountFrom,
  extractJsonLd,
  fetchHtml,
  fetchHtmlBrowser,
  parseMoney,
  pickMeta,
} from './fetchPage.js'
import { scrapeLimits } from './scrapeConfig.js'
import type { ScrapeContext, ScrapeResult, StoreScraper } from './types.js'

type CheerioRoot = ReturnType<typeof import('cheerio').load>

function assertProductUrl(url: string) {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    throw new Error('Tata Neu: invalid product URL')
  }
  if (!/tataneu\.com$/i.test(u.hostname.replace(/^www\./, ''))) {
    throw new Error('Tata Neu: URL must be a tataneu.com product link')
  }
  if (/\/(search|category|list)(\/|$|\?)/i.test(u.pathname)) {
    throw new Error('Tata Neu: paste a product page URL, not a search/category link')
  }
}

/** og:title / <title> on Tata Neu is just "Tata Neu" — useless for the product card. */
function isGenericTitle(t?: string | null) {
  if (!t) return true
  const s = t.trim()
  if (!s) return true
  if (/^tata\s*neu$/i.test(s)) return true
  if (/^https?:\/\//i.test(s)) return true
  return s.toLowerCase() === 'product'
}

function titleFromSkuName(url: string): string | undefined {
  try {
    const sku = new URL(url).searchParams.get('skuName')
    if (!sku) return undefined
    const pretty = sku
      .replace(/-+$/g, '')
      .split('-')
      .filter(Boolean)
      .map((w) => (w.length <= 3 ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1)))
      .join(' ')
    return pretty.length > 8 ? pretty : undefined
  } catch {
    return undefined
  }
}

function extractProductTitle($: CheerioRoot, url: string): string | undefined {
  // Real PDP heading (og:title is just "Tata Neu")
  const h1s = $('h1, h2')
    .map((_, el) => $(el).text().replace(/\s+/g, ' ').trim())
    .get()
    .filter((t) => t && !isGenericTitle(t) && !/^best deal/i.test(t) && !/^₹/.test(t))
  if (h1s[0]) return h1s[0]

  const og = pickMeta($, ['meta[property="og:title"]', 'title'])
  if (!isGenericTitle(og)) return og || undefined

  const ld = extractJsonLd($)
  if (ld?.title && !isGenericTitle(ld.title)) return ld.title

  return titleFromSkuName(url)
}

function extractProductImage($: CheerioRoot): string | undefined {
  // Prefer the main gallery image — og:image is a site favicon on Tata Neu
  const main =
    $('img[alt*="Product main" i]').attr('src') ||
    $('img[alt*="Thumbnail 1" i]').attr('src')
  if (main && /^https?:\/\//i.test(main) && !/favicon|static-assets/i.test(main)) {
    return main
  }

  let found: string | undefined
  $('img').each((_, el) => {
    if (found) return
    const src = ($(el).attr('src') || '').trim()
    if (!/^https?:\/\//i.test(src)) return
    if (/favicon|static-assets|sanity\.io|imagekit\.io\/tatadigitalltd\/production\/.*48x48/i.test(src))
      return
    if (/media\.tatacroma\.com|Croma%20Assets|sku|product/i.test(src)) {
      found = src
    }
  })
  if (found) return found

  const og = $('meta[property="og:image"]').attr('content')
  if (og && /^https?:\/\//i.test(og) && !/favicon/i.test(og)) return og

  const ld = extractJsonLd($)
  if (ld?.image && /^https?:\/\//i.test(ld.image) && !/favicon/i.test(ld.image)) return ld.image

  return undefined
}

/**
 * "Get it as low as ₹35,999" — the combined bank/coupon offer price shown
 * under "Best deal for you". Client-computed widget → only in rendered DOM.
 * Never confuse this with the base selling price (₹37,999) or small bank
 * cashback amounts (₹2,000) that appear in the same card.
 */
function extractBestDealPrice($: CheerioRoot, sellingPrice?: number | null): number | null {
  const pickBest = (candidates: number[]): number | null => {
    const usable = candidates.filter((a) => a > 999)
    if (!usable.length) return null
    if (sellingPrice && sellingPrice > 999) {
      // Real deal price is below selling; ignore tiny cashback figures (₹2,000)
      const below = usable.filter((a) => a < sellingPrice && a >= sellingPrice * 0.4)
      if (below.length) return Math.min(...below)
    }
    // No selling context — take the largest plausible phone-range amount in the
    // "Get it as low as" row (cashback amounts are usually much smaller).
    return usable.sort((a, b) => b - a)[0] || null
  }

  let found: number | null = null

  $('*').each((_, el) => {
    if (found) return
    const own = ($(el).clone().children().remove().end().text() || '').replace(/\s+/g, ' ').trim()
    if (!/^get it as low as\.?$/i.test(own)) return

    const row = ($(el).parent().text() || '').replace(/\s+/g, ' ')
    const idx = row.search(/get it as low as/i)
    if (idx < 0) return
    const after = row.slice(idx + 'get it as low as'.length, idx + 220)
    const amounts = [...after.matchAll(/₹\s*([\d,]+(?:\.\d+)?)/g)]
      .map((m) => parseMoney(m[1]))
      .filter((n): n is number => n != null)
    found = pickBest(amounts)
  })

  if (found) return found

  const body = ($('body').text() || '').replace(/\s+/g, ' ')
  // "Get it as low as With this 1 offer ₹35,999.00"
  const m = body.match(/get it as low as[^₹]{0,120}₹\s*([\d,]+(?:\.\d+)?)/i)
  if (m) {
    const amount = parseMoney(m[1])
    if (amount) return pickBest([amount])
  }
  // Broader: capture every ₹ in the best-deal section
  const section = body.match(/best deal for you[\s\S]{0,400}/i)?.[0]
  if (section) {
    const amounts = [...section.matchAll(/₹\s*([\d,]+(?:\.\d+)?)/g)]
      .map((x) => parseMoney(x[1]))
      .filter((n): n is number => n != null)
    return pickBest(amounts)
  }
  return null
}

function extractOffersLine($: CheerioRoot): string | undefined {
  let text: string | undefined
  $('*').each((_, el) => {
    if (text) return
    const own = ($(el).clone().children().remove().end().text() || '').trim()
    // "With these 2 offers" OR "With this 1 offer"
    if (/^with these? \d+ offers?$/i.test(own)) {
      text = own
    }
  })
  return text
}

function parseTataNeuDom($: CheerioRoot, url: string) {
  const ld = extractJsonLd($)
  const bodyText = ($('body').text() || '').replace(/\s+/g, ' ')
  const htmlHead = $.root().html()?.slice(0, 4000) || ''

  const title = extractProductTitle($, url)
  const image = extractProductImage($)

  const soldOut = /out of stock|sold out|currently unavailable|notify me/i.test(bodyText)
  const available = ld?.available ?? !soldOut

  // Selling / MRP shown on the PDP (₹74,999 / ₹79,999) — not the best-deal price
  const mrp =
    parseMoney($('[class*="strike"], [class*="Strike"], del, s').first().text()) ||
    parseMoney(ld?.oldPrice != null ? String(ld.oldPrice) : '') ||
    undefined

  const sellingFromText = (() => {
    // Prefer the PDP price next to "inclusive of all taxes" — avoids ZipCare
    // protection plan amounts (₹15,479 etc.) that also appear as ₹X₹Y pairs.
    const nearTax = bodyText.match(
      /₹\s*([\d,]+)\s*₹\s*([\d,]+)[^(]{0,30}\(inclusive of all taxes\)/i,
    )
    if (nearTax) {
      const a = parseMoney(nearTax[1])
      const b = parseMoney(nearTax[2])
      if (a && a > 999) return b && b > 999 ? Math.min(a, b) : a
    }
    const singleNearTax = bodyText.match(
      /₹\s*([\d,]+)[^(]{0,30}\(inclusive of all taxes\)/i,
    )
    const n = parseMoney(singleNearTax?.[1] || '')
    return n && n > 999 ? n : null
  })()

  const sellingPrice =
    sellingFromText ||
    parseMoney(ld?.price != null ? String(ld.price) : '') ||
    null

  const bestDealPrice = extractBestDealPrice($, sellingPrice)
  const offersLine = extractOffersLine($)
  const hasBestDealLabel = /get it as low as|best deal for you/i.test(bodyText)

  const edgeBlocked =
    /access denied|reference #\d|edgesuite\.net|request blocked|the request could not be satisfied|akamai|cloudfront/i.test(
      `${title || ''} ${bodyText.slice(0, 2000)} ${htmlHead}`,
    )

  const emptyShell =
    !edgeBlocked &&
    !bestDealPrice &&
    !sellingPrice &&
    !ld?.price &&
    bodyText.length < 800 &&
    !/skuId|product-details|best deal/i.test(bodyText)

  return {
    title,
    image,
    available,
    oldPrice: mrp || sellingPrice || undefined,
    sellingPrice,
    bestDealPrice,
    offersLine,
    hasBestDealLabel,
    edgeBlocked,
    emptyShell,
  }
}

function noBestDealError(parsed: ReturnType<typeof parseTataNeuDom> | null): Error {
  if (parsed?.edgeBlocked || parsed?.emptyShell) {
    return new Error(
      'BLOCKED: Tata Neu denied this server IP (Akamai/CloudFront). ' +
        'Set SCRAPE_PROXY_URL to an Indian residential proxy, then retry.',
    )
  }
  if (parsed?.sellingPrice && parsed.sellingPrice > 999) {
    return new Error(
      'No "Get it as low as" best-price deal found for this Tata Neu product right now. ' +
        'PriceWatch only tracks the combined-offer price shown under "Best deal for you" — not the base selling price. ' +
        'Open the product on Tata Neu; if you see a "Get it as low as ₹…" card, wait for it to load fully, ' +
        'copy that page link, and try again.',
    )
  }
  return new Error(
    'Could not read this Tata Neu product (page loaded but no price data). ' +
      'Copy the exact product page link from your browser address bar and try again.',
  )
}

async function scrapeTataNeu(ctx: ScrapeContext): Promise<ScrapeResult> {
  assertProductUrl(ctx.url)
  const limits = scrapeLimits()
  let lastParsed: ReturnType<typeof parseTataNeuDom> | null = null

  const tryParse = (
    $: CheerioRoot,
    note: string,
    opts?: { allowSellingFallback: boolean },
  ): ScrapeResult | null => {
    const parsed = parseTataNeuDom($, ctx.url)
    lastParsed = parsed
    if (parsed.edgeBlocked || parsed.emptyShell) return null

    // 1) Best-deal present → ALWAYS track that price (never selling).
    const hasBestDeal =
      parsed.bestDealPrice != null &&
      parsed.bestDealPrice > 999 &&
      (!parsed.sellingPrice || parsed.bestDealPrice < parsed.sellingPrice)

    if (hasBestDeal) {
      const best = parsed.bestDealPrice!
      const compareAt = parsed.sellingPrice || parsed.oldPrice || best
      return {
        title: parsed.title || undefined,
        image: parsed.image,
        price: best,
        oldPrice: compareAt,
        discount: discountFrom(compareAt, best),
        available: parsed.available,
        offerText: parsed.offersLine,
        source: 'live',
        rawNote: `${note} mode=bestdeal best=${best} sell=${parsed.sellingPrice ?? '-'}`,
      }
    }

    // Widget label visible but price not parsed yet → don't fall back to selling
    if (parsed.hasBestDealLabel && !opts?.allowSellingFallback) {
      return null
    }

    // 2) No best-deal on this SKU → selling price is OK
    if (opts?.allowSellingFallback && parsed.sellingPrice && parsed.sellingPrice > 999) {
      const sell = parsed.sellingPrice
      const compareAt = parsed.oldPrice || sell
      return {
        title: parsed.title || undefined,
        image: parsed.image,
        price: sell,
        oldPrice: compareAt,
        discount: discountFrom(compareAt, sell),
        available: parsed.available,
        offerText: undefined,
        source: 'live',
        rawNote: `${note} mode=selling sell=${sell} (no Get-it-as-low-as deal on this SKU)`,
      }
    }

    return null
  }

  // Cheap HTTP first — ONLY accept if best-deal already in HTML. Never accept
  // selling here; the offer widget is client-rendered and would be missed.
  try {
    const $ = await fetchHtml(ctx.url)
    const hit = tryParse($, 'http', { allowSellingFallback: false })
    if (hit) return hit
  } catch {
    /* fall through to browser */
  }

  try {
    const $ = await fetchHtmlBrowser(ctx.url, {
      // Wait specifically for the best-deal widget (not just product title/₹,
      // which appear earlier and used to cut the wait short → selling fallback).
      waitText: /Get it as low as/i,
      waitMs: Math.max(limits.settleMs, limits.cloud ? 3000 : 2500),
      navigationTimeoutMs: Math.max(limits.navigationTimeoutMs, 40_000),
    })
    const hit =
      tryParse($, 'browser', { allowSellingFallback: false }) ||
      tryParse($, 'browser', { allowSellingFallback: true })
    if (hit) return hit
    throw noBestDealError(lastParsed)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (
      /No "Get it as low as"|Could not read this Tata Neu|BLOCKED: Tata Neu/i.test(msg)
    ) {
      throw err instanceof Error ? err : new Error(msg)
    }
    if (/BLOCKED: edge\/WAF/i.test(msg)) {
      throw new Error(
        'BLOCKED: Tata Neu denied this server IP (Akamai/CloudFront). ' +
          'Set SCRAPE_PROXY_URL to an Indian residential proxy, then retry.',
      )
    }
    throw new Error(
      /timeout|disabled/i.test(msg)
        ? 'Tata Neu is taking too long to respond. Please wait a minute and try again.'
        : msg,
    )
  }
}

export const tataneuScraper: StoreScraper = {
  slug: 'tataneu',
  scrape: scrapeTataNeu,
}
