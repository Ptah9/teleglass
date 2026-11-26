import assert from 'node:assert/strict'
import test from 'node:test'
import { ClientRegistry } from '../dist/tg/clients.js'

function config() {
  return {
    apiId: 1,
    apiHash: 'a'.repeat(32),
    testDc: true,
    host: '127.0.0.1',
    port: 8787,
    dbPath: ':memory:',
    corsOrigins: [],
    encKey: Buffer.alloc(32),
    socksProxy: null,
    mtProxy: null,
    llmBaseUrl: '',
    llmApiKey: null,
    llmModel: '',
    llmModels: [],
  }
}

test('the library never sleeps over a flood wait and never repeats a request', async () => {
  // `send.flood` and "no automatic retry" rest on these two options; a default
  // would make the glasses wait and the library re-send behind our back.
  const registry = new ClientRegistry(config())
  const client = registry.createPending()
  try {
    assert.equal(client.floodSleepThreshold, 0)
    assert.equal(client._requestRetries, 1)
  } finally {
    await client.destroy().catch(() => undefined)
  }
})
