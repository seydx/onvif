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
  private readonly agent: Agent

  constructor(options: HttpClientOptions) {
    this.options = options
    const { hostname, port, useSecure, secureOptions } = options
    this.baseUrl = `${useSecure ? 'https' : 'http'}://${hostname}:${port}`

    // Create undici Agent with SSL/TLS options if needed
    if (useSecure && secureOptions) {
      this.agent = new Agent({
        connect: {
          rejectUnauthorized: secureOptions.rejectUnauthorized ?? false,
          ca: secureOptions.ca,
          cert: secureOptions.cert,
          key: secureOptions.key,
          passphrase: secureOptions.passphrase
        }
      })
    } else {
      this.agent = new Agent()
    }
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
        if (attempt === 0 && isTransientError(error)) continue
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
   * Close the HTTP client and release resources
   */
  public async close(): Promise<void> {
    await this.agent.close()
  }
}
