import type { ConnectionOptions } from 'node:tls'
import { Agent, request } from 'undici'
import { parseSOAPString } from '../utils/xml.ts'

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
