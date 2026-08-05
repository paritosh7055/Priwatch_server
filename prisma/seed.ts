import 'dotenv/config'
import { PrismaClient, StoreCategory, StoreHealth } from '@prisma/client'
import bcrypt from 'bcryptjs'

const prisma = new PrismaClient()

// Only the stores that were edge/WAF-blocked from the Hetzner (Finland) VPS
// IP — this fork exists to try a different egress IP (e.g. Railway).
const stores = [
  {
    slug: 'zepto',
    name: 'Zepto',
    domain: 'zeptonow.com',
    website: 'https://www.zeptonow.com',
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
]

async function main() {
  const email = process.env.OWNER_EMAIL || 'you@pricewatch.app'
  const password = process.env.OWNER_PASSWORD || 'watch123'
  const name = process.env.OWNER_NAME || 'PriceWatch Owner'

  const passwordHash = await bcrypt.hash(password, 10)

  await prisma.owner.upsert({
    where: { email },
    update: { name, passwordHash },
    create: { email, name, passwordHash },
  })

  for (const store of stores) {
    await prisma.store.upsert({
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
      create: store,
    })
  }

  // Remove Meesho if left from an older seed
  const meesho = await prisma.store.findUnique({ where: { slug: 'meesho' } })
  if (meesho) {
    await prisma.product.deleteMany({ where: { storeId: meesho.id } })
    await prisma.store.delete({ where: { id: meesho.id } })
    console.log('Removed Meesho store + products')
  }

  console.log('Seed complete')
  console.log(`Owner: ${email} / ${password}`)
  console.log(`Stores: ${stores.length}`)
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
