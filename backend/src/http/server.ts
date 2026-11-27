/**
 * node:http adapter around `handle`. Small on purpose: one request in, one JSON
 * answer out, body capped so a stray upload cannot grow memory.
 *
 * 8 MB is the audio ceiling: one 120 s PCM recording is 3.84 MB raw, 5.1 MB in
 * base64, plus the JSON envelope. Text routes stay far below it — the cap is
 * about a runaway body, not about trusting the phone.
 */

import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http'
import { handle, type HandlerDeps, type OutgoingResponse } from './handler.js'

export const MAX_BODY_BYTES = 8 * 1024 * 1024

export function createHttpServer(deps: HandlerDeps): Server {
  return createServer((request, response) => {
    void serve(deps, request, response)
  })
}

async function serve(
  deps: HandlerDeps,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  try {
    const result = await readAndHandle(deps, request)
    write(response, result)
  } catch {
    write(response, {
      status: 500,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: '{"error":"unknown"}',
    })
  }
}

function readAndHandle(deps: HandlerDeps, request: IncomingMessage): Promise<OutgoingResponse> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    let size = 0
    let tooBig = false

    request.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        tooBig = true
        return
      }
      chunks.push(chunk)
    })
    request.on('error', () => {
      resolve({ status: 400, headers: {}, body: '{"error":"unknown"}' })
    })
    request.on('end', () => {
      if (tooBig) {
        resolve({ status: 413, headers: {}, body: '{"error":"unknown"}' })
        return
      }
      void handle(deps, {
        method: request.method ?? 'GET',
        path: request.url ?? '/',
        headers: request.headers as IncomingHttpHeaders,
        body: Buffer.concat(chunks).toString('utf8'),
      }).then(resolve)
    })
  })
}

function write(response: ServerResponse, result: OutgoingResponse): void {
  if (response.headersSent) return
  response.writeHead(result.status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...result.headers,
  })
  response.end(result.body)
}
