import assert from 'node:assert/strict'
import test from 'node:test'
import { Logger, describeError, errorTag, maskPhone } from '../dist/log.js'

function capture(level = 'debug') {
  const lines = []
  const logger = new Logger(level, {
    write(chunk) {
      lines.push(String(chunk))
      return true
    },
  })
  return { logger, lines }
}

test('phone numbers are masked, never printed whole', () => {
  assert.equal(maskPhone('+79991234567'), '+7 999 ***-**-67')
  assert.equal(maskPhone('+7 (999) 123-45-67'), '+7 999 ***-**-67')
  assert.equal(maskPhone('9996612345'), '+9 996 ***-**-45')
  assert.equal(maskPhone('123'), '***')
  assert.equal(maskPhone(''), '')
})

test('field names that look like secrets are redacted', () => {
  const { logger, lines } = capture()
  logger.info('probe', {
    api_hash: 'should-not-appear',
    session: 'should-not-appear',
    code: '12345',
    password: 'nope',
    token: 'bearer',
    phone_code_hash: 'hash',
    phone: maskPhone('+79991234567'),
    ok: 'visible',
  })
  const line = lines.join('')
  assert.ok(!line.includes('should-not-appear'))
  assert.ok(!line.includes('12345'))
  assert.ok(!line.includes('bearer'))
  assert.ok(line.includes('+7 999 ***-**-67'))
  assert.ok(line.includes('visible'))
  assert.equal(JSON.parse(line).api_hash, '[redacted]')
})

test('control characters cannot break the one-line format', () => {
  const { logger, lines } = capture()
  logger.info('probe', { value: 'line1\nline2\u0000tail' })
  assert.equal(lines.length, 1)
  assert.ok(!lines[0].includes('\nline2'))
})

test('a login code is redacted, an error code is not', () => {
  const { logger, lines } = capture()
  logger.info('auth.verify', { code: '12345', phone_code_hash: 'hash' })
  logger.error('crash', { code: 'EADDRINUSE' })
  logger.error('crash', { code: 'network' })
  logger.error('crash', { code: 500 })
  const [login, errno, contract, status] = lines.map((line) => JSON.parse(line))
  assert.equal(login.code, '[redacted]')
  assert.equal(login.phone_code_hash, '[redacted]')
  assert.equal(errno.code, 'EADDRINUSE')
  assert.equal(contract.code, 'network')
  assert.equal(status.code, 500)
})

test('a crash keeps its system code and message readable', () => {
  const { logger, lines } = capture()
  const err = Object.assign(new Error('listen EADDRINUSE: address already in use 127.0.0.1:8787'), {
    code: 'EADDRINUSE',
  })
  logger.error('server.failed', { ...describeError(err), host: '127.0.0.1', port: 8787 })
  const line = lines.join('')
  assert.ok(!line.includes('[redacted]'))
  const record = JSON.parse(line)
  assert.equal(record.error, 'Error')
  assert.equal(record.code, 'EADDRINUSE')
  assert.equal(record.port, 8787)
  assert.ok(record.message.includes('address already in use'))
})

test('errorTag shows an RPC code, never a body', () => {
  assert.equal(errorTag({ errorMessage: 'PHONE_CODE_INVALID' }), 'PHONE_CODE_INVALID')
  assert.equal(errorTag(new TypeError('boom')), 'TypeError')
  assert.equal(errorTag({ errorMessage: 'bad message with spaces' }), 'UnknownError')
  assert.equal(errorTag('x'), 'UnknownError')
})
