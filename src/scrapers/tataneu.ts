import {
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

/**
 * "Get it as low as ₹67,249" — the combined bank/coupon offer price shown
 * under "Best deal for you". This is a client-computed widget (depends on
 * which offers apply), so it only ever appears in the rendered DOM, never in
 * the raw JSON-LD / plain HTML — we search rendered text, anchored on the
 * label, the same way Flipkart's WOW price is label-anchored rather than
 * matched by a brittle CSS class.
 */
function extractBestDealPrice($: CheerioRoot): number | null {
  let found: number | null = null

  $('*').each((_, el) => {
    if (found) return
    const own = ($(el).clone().children().remove().end().text() || '').replace(/\s+/g, ' ').trim()
    if (!/^get it as low as\.?$/i.test(own)) return

    // Price usually renders as a sibling/child within the same row
    const row = ($(el).parent().text() || '').replace(/\s+/g, ' ')
    const idx = row.search(/get it as low as/i)
    if (idx < 0) return
    const after = row.slice(idx + 'get it as low as'.length, idx + 200)
    const before = row.slice(Math.max(0, idx - 40), idx)
    const amounts = [...after.matchAll(/₹\s*([\d,]+(?:\.\d+)?)/g)]
    const amount = amounts.length
      ? parseMoney(amounts[0][1])
      : parseMoney([...before.matchAll(/₹\s*([\d,]+(?:\.\d+)?)/g)].pop()?.[1] || '')
    if (amount && amount > 999) found = amount
  })

  return found
}

function extractOffersLine($: CheerioRoot): string | undefined {
  let text: string | undefined
  $('*').each((_, el) => {
    if (text) return
    const own = ($(el).clone().children().remove().end().text() || '').trim()
    if (/^with these \d+ offers?$/i.test(own)) {
      text = own
    }
  })
  return text
}

function parseTataNeuDom($: CheerioRoot) {
  const ld = extractJsonLd($)

  const title =
    pickMeta($, ['meta[property="og:title"]', 'h1', 'title']) || ld?.title || undefined
  const image = $('meta[property="og:image"]').attr('content') || ld?.image

  const bodyText = $('body').text() || ''
  const soldOut = /out of stock|sold out|currently unavailable|notify me/i.test(bodyText)
  const available = ld?.available ?? !soldOut

  // MRP / struck-through price
  const oldPrice =
    parseMoney($('[class*="strike"], [class*="Strike"], del, s').first().text()) ||
    parseMoney(ld?.oldPrice != null ? String(ld.oldPrice) : '') ||
    undefined

  // Base selling price shown before any offers are applied
  const sellingPrice =
    parseMoney($('[class*="Price"], [class*="price"]').first().text()) ||
    parseMoney(ld?.price != null ? String(ld.price) : '') ||
    null

  const bestDealPrice = extractBestDealPrice($)
  const offersLine = extractOffersLine($)

  return { title, image, available, oldPrice, sellingPrice, bestDealPrice, offersLine }
}

function noBestDealError(parsed: ReturnType<typeof parseTataNeuDom> | null): Error {
  if (parsed?.sellingPrice && parsed.sellingPrice > 999) {
    return new Error(
      'No "Get it as low as" best-price deal found for this Tata Neu product right now. ' +
        'PriceWatch only tracks the combined-offer price shown under "Best deal for you" — not the base selling price. ' +
        'Open the product on Tata Neu; if you see a "Get it as low as ₹…" card, wait for it to load fully, ' +
        'copy that page link, and try again.',
    )
  }
  return new Error(
    'Could not read this Tata Neu product. Copy the exact product page link from your browser address bar and try again.',
  )
}

async function scrapeTataNeu(ctx: ScrapeContext): Promise<ScrapeResult> {
  assertProductUrl(ctx.url)
  const limits = scrapeLimits()
  let lastParsed: ReturnType<typeof parseTataNeuDom> | null = null

  const tryParse = ($: CheerioRoot, note: string): ScrapeResult | null => {
    const parsed = parseTataNeuDom($)
    lastParsed = parsed
    if (!parsed.bestDealPrice) return null
    if (parsed.sellingPrice && parsed.bestDealPrice >= parsed.sellingPrice) return null

    return {
      title: parsed.title || undefined,
      image: parsed.image,
      price: parsed.bestDealPrice,
      oldPrice: parsed.oldPrice || parsed.sellingPrice || parsed.bestDealPrice,
      discount: 0,
      available: parsed.available,
      offerText: parsed.offersLine,
      source: 'live',
      rawNote: `${note} mode=bestdeal best=${parsed.bestDealPrice} sell=${parsed.sellingPrice ?? '-'}`,
    }
  }

  // Try cheap HTTP first — unlikely to have the offer widget (client-computed)
  // but worth a shot before paying for a full browser render.
  try {
    const $ = await fetchHtml(ctx.url)
    const hit = tryParse($, 'http')
    if (hit) return hit
  } catch {
    /* fall through to browser */
  }

  try {
    const $ = await fetchHtmlBrowser(ctx.url, {
      waitText: /Get it as low as/i,
      waitMs: Math.max(limits.settleMs, 1500),
      navigationTimeoutMs: Math.max(limits.navigationTimeoutMs, 30_000),
    })
    const hit = tryParse($, 'browser')
    if (hit) return hit
    throw noBestDealError(lastParsed)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (/No "Get it as low as"|Could not read this Tata Neu/i.test(msg)) {
      throw err instanceof Error ? err : new Error(msg)
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
