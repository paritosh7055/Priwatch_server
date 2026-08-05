import { bigbasketScraper } from './meeshoAndQuick.js'
import { zeptoScraper } from './zepto.js'
import { tataneuScraper } from './tataneu.js'
import { demoScrape } from './demo.js'
import type { ScrapeContext, ScrapeResult, StoreScraper } from './types.js'

// Edge/WAF-blocked stores from the Hetzner VPS — Meesho removed from this fork.
const scrapers: Record<string, StoreScraper> = {
  zepto: zeptoScraper,
  bigbasket: bigbasketScraper,
  tataneu: tataneuScraper,
}

export function getScraperMode(): 'live' | 'demo' | 'auto' {
  const mode = (process.env.SCRAPER_MODE || 'live').toLowerCase()
  if (mode === 'live' || mode === 'demo' || mode === 'auto') return mode
  return 'live'
}

export async function scrapeProduct(ctx: ScrapeContext): Promise<ScrapeResult> {
  const mode = getScraperMode()
  if (mode === 'demo') return demoScrape(ctx)

  const scraper = scrapers[ctx.storeSlug]
  if (!scraper) {
    throw new Error(`No scraper for store: ${ctx.storeSlug}`)
  }

  try {
    return await scraper.scrape(ctx)
  } catch (err) {
    if (mode === 'auto') {
      const demo = demoScrape(ctx)
      demo.rawNote = `live failed → demo (${err instanceof Error ? err.message : 'error'})`
      return demo
    }
    // live: never invent prices — surface the real failure
    throw err
  }
}

export { scrapers }
