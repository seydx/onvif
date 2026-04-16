import type { ConnectionOptions } from 'node:tls'
import { Agent, request } from 'undici'
import { parseSOAPString } from '../utils/xml.js'

export type HttpClientOptions = {
  hostname: string
  port: number
  basePath: string
  uriMap: Record<string, URL>
  timeout: number
  useSecure: boolean
  secureOptions?: ConnectionOptions
}

export type RequestOptions = {
  body: string
  url?: URL | string
  service?: string
  raw?: boolean
}

/**
 * Transient network / protocol errors worth one retry on a fresh connection.
 * Covers the common "keep-alive stale socket" race where a camera has closed
 * the pooled connection on its side but undici still tries to reuse it —
 * parser sees garbage or FIN bytes and throws HTTPParserError. Also catches
 * sudden socket resets from flaky devices under burst load (e.g. PTZ autotrack
 * hammering ContinuousMove/Stop every few hundred ms).
 */
function isTransientError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  if (error.name === 'HTTPParserError') return true
  const code = (error as { code?: string }).code
  if (code === undefined) return false
  if (code === 'ECONNRESET' || code === 'EPIPE' || code === 'ETIMEDOUT') return true
  // undici-native error codes
  if (code === 'UND_ERR_SOCKET' || code === 'UND_ERR_CLOSED' || code === 'UND_ERR_CONNECT_TIMEOUT') return true
  // HTTP parser errors surface with an HPE_ prefix
  if (code.startsWith('HPE_')) return true
  return false
}

export class HttpClient {
  private readonly baseUrl: string
  private readonly options: HttpClientOptions
  private agent: Agent

  constructor(options: HttpClientOptions) {
    this.options = options
    const { hostname, port, useSecure, secureOptions } = options
    this.baseUrl = `${useSecure ? 'https' : 'http'}://${hostname}:${port}`
    this.agent = this.createAgent()
  }

  private createAgent(): Agent {
    const { useSecure, secureOptions } = this.options
    if (useSecure && secureOptions) {
      return new Agent({
        connections: 1,
        connect: {
          rejectUnauthorized: secureOptions.rejectUnauthorized ?? false,
          ca: secureOptions.ca,
          cert: secureOptions.cert,
          key: secureOptions.key,
          passphrase: secureOptions.passphrase
        }
      })
    }
    return new Agent({
      connections: 1,
    })
  }

  private createUrl(service?: string): string {
    const path = service ? this.options.uriMap[service]?.pathname || this.options.basePath : this.options.basePath
    return new URL(path, this.baseUrl).toString()
  }

  public async request<T>(options: RequestOptions): Promise<[T, string]> {
    // One retry on transient network/parser errors. This matters particularly
    // for PTZ Stop commands — a silently-dropped Stop makes the camera keep
    // panning and causes autotrack oscillation.
    let lastError: unknown
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return await this.sendRequest<T>(options)
      } catch (error) {
        lastError = error
        if (attempt === 0 && isTransientError(error)) {
          // eslint-disable-next-line no-console
          console.warn(
            `[onvif-http] transient error on attempt 1, rotate agent + retry: name=${(error as Error)?.name ?? 'unknown'} code=${(error as { code?: string })?.code ?? 'none'} msg=${(error as Error)?.message ?? ''}`
          )
          // The old pool may contain stale/corrupted sockets — rotate to a
          // fresh Agent so the retry doesn't reuse them. We don't await the
          // old agent's graceful close: concurrent callers that are already
          // mid-request on the old agent must not see their work aborted
          // (which would throw ClientDestroyedError under us).
          this.rotateAgent()
          continue
        }
        throw error
      }
    }
    throw lastError
  }

  private async sendRequest<T>(options: RequestOptions): Promise<[T, string]> {
    const { body, service, url: requestUrl } = options
    const url = requestUrl !== undefined ? (typeof requestUrl === 'string' ? requestUrl : requestUrl.toString()) : this.createUrl(service)

    const response = await request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/soap+xml',
        charset: 'utf-8'
      },
      body,
      bodyTimeout: this.options.timeout,
      headersTimeout: this.options.timeout,
      dispatcher: this.agent
    })

    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw new Error(`HTTP error! status: ${response.statusCode}`)
    }

    const xml = await response.body.text()
    return await parseSOAPString<T>(xml)
  }

  /**
   * Swap `this.agent` for a fresh one so subsequent requests use a clean pool.
   * The old agent's pending requests are allowed to drain via `close()` in the
   * background — we do NOT await it, and we don't call `destroy()` (which would
   * abort concurrent in-flight requests and surface ClientDestroyedError in
   * unrelated callers).
   */
  private rotateAgent(): void {
    const old = this.agent
    this.agent = this.createAgent()
    void old.close().catch(() => {
      /* ignore — agent is discarded anyway */
    })
  }

  /**
   * Close the HTTP client and release resources
   */
  public async close(): Promise<void> {
    await this.agent.close()
  }
}
