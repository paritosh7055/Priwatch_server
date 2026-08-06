import { PrismaClient, StoreCategory, StoreHealth } from '@prisma/client'
import { prisma } from '../lib/prisma.js'

/** Canonical built-in store metadata — keeps domain/website in sync after renames. */
const BUILTIN_STORES = [
  {
    slug: 'zepto',
    name: 'Zepto',
    domain: 'zepto.com',
    website: 'https://www.zepto.com',
    color: '#3C019F',
    category: StoreCategory.quick_commerce,
    requiresPincode: true,
    status: StoreHealth.healthy,
    builtIn: true,
  },
  {
    slug: 'bigbasket',
    name: 'BigBasket',
    domain: 'bigbasket.com',
    website: 'https://www.bigbasket.com',
    color: '#84C225',
    category: StoreCategory.quick_commerce,
    requiresPincode: true,
    status: StoreHealth.healthy,
    builtIn: true,
  },
  {
    slug: 'tataneu',
    name: 'Tata Neu',
    domain: 'tataneu.com',
    website: 'https://www.tataneu.com',
    color: '#5A2D82',
    category: StoreCategory.ecommerce,
    requiresPincode: false,
    status: StoreHealth.healthy,
    builtIn: true,
  },
] as const

/**
 * Upsert built-in stores so domain renames (e.g. zeptonow.com → zepto.com)
 * show up without a manual DB seed on Railway.
 */
export async function syncBuiltInStores(db: PrismaClient = prisma) {
  for (const store of BUILTIN_STORES) {
    await db.store.upsert({
      where: { slug: store.slug },
      update: {
        name: store.name,
        domain: store.domain,
        website: store.website,
        color: store.color,
        category: store.category,
        requiresPincode: store.requiresPincode,
        status: store.status,
        builtIn: store.builtIn,
      },
      create: { ...store },
    })
  }
}
