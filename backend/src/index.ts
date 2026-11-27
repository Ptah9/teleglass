/**
 * Process entry point. One backend, one user, local by default.
 *
 * Start:  npm run build && npm start          (or `npm run dev` from app/backend)
 * Env:    app/.env — TG_API_ID, TG_API_HASH, SESSION_ENC_KEY are required.
 */

import { loadConfig, type Config } from './config.js'
import { Db } from './db.js'
import { createHttpServer } from './http/server.js'
import { LlmService } from './llm/service.js'
import { Logger, describeError } from './log.js'
import { SttService } from './stt/service.js'
import { ClientRegistry } from './tg/clients.js'
import { TelegramAuthService } from './tg/service.js'
import { VoiceService } from './voice/service.js'

async function main(): Promise<void> {
  let config: Config
  try {
    config = loadConfig()
  } catch (err) {
    const message = err instanceof Error ? err.message : 'invalid configuration'
    process.stderr.write(`teleglass-backend: ${message}\n`)
    process.exit(1)
  }

  const log = new Logger('info')
  const db = new Db(config.dbPath)

  let clients: ClientRegistry
  try {
    clients = new ClientRegistry(config)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'transport configuration is invalid'
    process.stderr.write(`teleglass-backend: ${message}\n`)
    db.close()
    process.exit(1)
  }

  const auth = new TelegramAuthService({ config, db, clients, log })
  auth.boot()

  const llm = new LlmService({ config, db, log, auth })
  const stt = new SttService({ config, db, log, auth })
  const voice = new VoiceService({ log, auth })

  const server = createHttpServer({ auth, llm, stt, voice, log, corsOrigins: config.corsOrigins })
  let listening = false
  // A failed bind is the most common way this process dies (`EADDRINUSE` when
  // the port is taken). Say why, in words a person can act on, and exit.
  server.on('error', (err) => {
    log.error('server.failed', { ...describeError(err), host: config.host, port: config.port })
    if (listening) return
    try {
      db.close()
    } catch {
      /* closing a half-open database must not hide the reason */
    }
    process.exit(1)
  })
  server.listen(config.port, config.host, () => {
    listening = true
    log.info('listening', {
      host: config.host,
      port: config.port,
      testDc: config.testDc,
      cors: config.corsOrigins.join(','),
    })
  })

  let stopping = false
  const shutdown = (signal: string): void => {
    if (stopping) return
    stopping = true
    log.info('shutdown', { signal })
    server.close(() => {
      void auth
        .stop()
        .catch(() => undefined)
        .then(() => {
          db.close()
          process.exit(0)
        })
    })
    // A stuck socket must not keep the process alive after the signal.
    setTimeout(() => process.exit(0), 5_000).unref()
  }

  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('unhandledRejection', (reason) => {
    log.error('unhandledRejection', describeError(reason))
  })
  process.on('uncaughtException', (err) => {
    log.error('uncaughtException', describeError(err))
    process.exit(1)
  })
}

void main()
