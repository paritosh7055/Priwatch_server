import { bigbasketScraper, meeshoScraper } from './meeshoAndQuick.js'
import { zeptoScraper } from './zepto.js'
import { tataneuScraper } from './tataneu.js'
import { demoScrape } from './demo.js'
import type { ScrapeContext, ScrapeResult, StoreScraper } from './types.js'

// This fork only carries the stores that are edge/WAF-blocked from the
// Hetzner (Finland) VPS IP — meant to be deployed somewhere with a different
// egress IP (e.g. Railway) to see if that alone resolves the geo-block.
const scrapers: Record<string, StoreScraper> = {
  meesho: meeshoScraper,
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
