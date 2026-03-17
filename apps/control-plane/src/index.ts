import { createApp } from './app'

const PORT = parseInt(process.env.CONTROL_PLANE_PORT || '3010', 10)

if (Number.isNaN(PORT) || PORT < 1 || PORT > 65535) {
  console.error(`Invalid CONTROL_PLANE_PORT: ${process.env.CONTROL_PLANE_PORT}`)
  process.exit(1)
}

async function start() {
  const app = createApp({ logger: true })

  await app.listen({ port: PORT, host: '0.0.0.0' })
  console.log(`Control plane listening on port ${PORT}`)
}

start().catch((err) => {
  console.error('Failed to start control plane:', err)
  process.exit(1)
})
