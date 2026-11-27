/**
 * PCM → base64 for the wire. `btoa` takes a string, and `String.fromCharCode`
 * with a whole recording in one call blows the argument limit on some engines:
 * the buffer is turned in 32 KB slices.
 *
 * Base64 is ~1.33× the bytes: a 120 s recording is 5.1 MB of JSON body, which
 * is why the backend body cap is 8 MB and not 16 KB.
 */
export function toBase64(pcm: Uint8Array): string {
  const CHUNK = 0x8000
  let binary = ''
  for (let i = 0; i < pcm.length; i += CHUNK) {
    binary += String.fromCharCode(...pcm.subarray(i, i + CHUNK))
  }
  return window.btoa(binary)
}
