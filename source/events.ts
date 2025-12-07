import { EventEmitter } from 'node:events'
import type {
  AudioEventData,
  CreatePullPointOptions,
  DetectionEventData,
  EventCategory,
  EventLoopOptions,
  EventProperties,
  EventServiceCapabilities,
  MotionEventData,
  NotificationMessage,
  ParsedTopic,
  PullMessagesOptions,
  PullMessagesResult,
  PullPointSubscription
} from './interfaces/events.types.ts'
import type { Onvif } from './onvif.ts'
import { linerase } from './utils/xml.ts'

// Re-export types for consumers
export type {
  AudioEventData,
  CreatePullPointOptions,
  DetectionEventData,
  EventCategory,
  EventLoopOptions,
  EventProperties,
  EventServiceCapabilities,
  MotionEventData,
  NotificationMessage,
  ParsedTopic,
  PullMessagesOptions,
  PullMessagesResult,
  PullPointSubscription
}

/** Error codes that warrant automatic reconnection */
const RETRY_ERROR_CODES = ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENETUNREACH', 'EHOSTUNREACH']

/** Maximum reconnection delay in milliseconds (2 minutes) */
const MAX_RECONNECT_MS = 2 * 60 * 1000

/** Default termination time for subscriptions */
const DEFAULT_TERMINATION_TIME = 'PT2M'

/** Default pull timeout */
const DEFAULT_PULL_TIMEOUT = 'PT1M'

/** Default message limit per pull */
const DEFAULT_MESSAGE_LIMIT = 10

/**
 * Convert various date formats to Date object
 *
 * @param value - The value to convert to a Date object
 */
function toDate(value: unknown): Date {
  if (value instanceof Date) {
    return value
  }
  if (typeof value === 'string' || typeof value === 'number') {
    return new Date(value)
  }
  // Handle linerase converted dates (they come as Date objects already)
  return new Date()
}

/**
 * ONVIF Events Service
 *
 * Provides access to camera events via PullPoint Subscription.
 * Supports motion detection, tamper, audio, and other ONVIF event types.
 *
 * @example
 * ```typescript
 * const device = new Onvif({ hostname: '192.168.1.100', username: 'admin', password: 'admin' })
 * await device.connect()
 *
 * // Listen for events
 * device.events.on('event', (message) => {
 *   console.log('Event received:', message.topic._)
 * })
 *
 * // Start event loop
 * device.events.startEventLoop()
 *
 * // Later, stop the event loop
 * device.events.stopEventLoop()
 * ```
 */
export class Events extends EventEmitter {
  private readonly onvif: Onvif
  private subscription: PullPointSubscription | undefined
  private terminationTime: Date | undefined
  private shouldPoll = false
  private reconnectMs = 10
  private messageLimit = DEFAULT_MESSAGE_LIMIT
  private eventProperties: EventProperties | undefined

  /** Set of observed event categories during event loop */
  private observedCategories = new Set<EventCategory>()

  constructor(onvif: Onvif) {
    super()
    this.onvif = onvif
  }

  /**
   * Get event service capabilities
   */
  async getServiceCapabilities(): Promise<EventServiceCapabilities> {
    const [data] = await this.onvif.request<{ getServiceCapabilitiesResponse?: { capabilities?: unknown } }>({
      service: 'events',
      body: '<GetServiceCapabilities xmlns="http://www.onvif.org/ver10/events/wsdl"/>'
    })

    const capabilities = data.getServiceCapabilitiesResponse?.capabilities
    if (!capabilities) {
      return {}
    }

    // Capabilities come as attributes, need to handle them properly
    const result = linerase(capabilities)
    return result as EventServiceCapabilities
  }

  /**
   * Get event properties including supported topics
   */
  async getEventProperties(): Promise<EventProperties> {
    const [data] = await this.onvif.request<{ getEventPropertiesResponse?: unknown }>({
      service: 'events',
      body: '<GetEventProperties xmlns="http://www.onvif.org/ver10/events/wsdl"/>'
    })

    this.eventProperties = linerase(data.getEventPropertiesResponse) as EventProperties
    return this.eventProperties
  }

  /**
   * Create a PullPoint subscription for receiving events
   *
   * @param options - Options for creating the subscription
   */
  async createPullPointSubscription(options: CreatePullPointOptions = {}): Promise<PullPointSubscription> {
    const terminationTime = options.initialTerminationTime ?? DEFAULT_TERMINATION_TIME

    let filterXml = ''
    if (options.filter) {
      filterXml = `<Filter>${typeof options.filter === 'string' ? options.filter : ''}</Filter>`
    }

    const [data] = await this.onvif.request<{ createPullPointSubscriptionResponse?: unknown }>({
      service: 'events',
      body: `
        <CreatePullPointSubscription xmlns="http://www.onvif.org/ver10/events/wsdl">
          ${filterXml}
          <InitialTerminationTime>${terminationTime}</InitialTerminationTime>
        </CreatePullPointSubscription>
      `.trim()
    })

    const response = data.createPullPointSubscriptionResponse
    if (!response) {
      throw new Error('Invalid CreatePullPointSubscription response')
    }

    // Response can be array or object depending on camera
    const responseObj = Array.isArray(response) ? response[0] : response
    const raw = linerase(responseObj) as {
      subscriptionReference?: { address?: string; referenceParameters?: { subscriptionId?: string } }
      currentTime?: unknown
      terminationTime?: unknown
    }

    // Parse the subscription reference address
    const address = typeof raw.subscriptionReference?.address === 'string' ? raw.subscriptionReference.address : ''

    const subscription: PullPointSubscription = {
      subscriptionReference: {
        address: this.onvif.parseUrl(address),
        referenceParameters: raw.subscriptionReference?.referenceParameters
      },
      currentTime: toDate(raw.currentTime),
      terminationTime: toDate(raw.terminationTime)
    }

    this.subscription = subscription
    this.terminationTime = this.calculateTerminationTime(subscription)
    return subscription
  }

  /**
   * Pull messages from the subscription
   *
   * @param options - Options for pulling messages
   */
  async pullMessages(options: PullMessagesOptions = {}): Promise<PullMessagesResult> {
    if (!this.subscription) {
      throw new Error('No active subscription. Call createPullPointSubscription first.')
    }

    const timeout = options.timeout ?? DEFAULT_PULL_TIMEOUT
    const messageLimit = options.messageLimit ?? this.messageLimit

    const subscriptionId = this.subscription.subscriptionReference.referenceParameters?.subscriptionId
    const urlAddress = this.subscription.subscriptionReference.address

    const body = this.buildSubscriptionBody(urlAddress, subscriptionId, `
      <PullMessages xmlns="http://www.onvif.org/ver10/events/wsdl">
        <Timeout>${timeout}</Timeout>
        <MessageLimit>${messageLimit}</MessageLimit>
      </PullMessages>
    `)

    const [data] = await this.onvif.request<{ pullMessagesResponse?: unknown }>({
      url: urlAddress.href,
      raw: true,
      body
    })

    const response = data.pullMessagesResponse
    if (!response) {
      throw new Error('Invalid PullMessages response')
    }

    // Response can be array or object depending on camera
    const responseObj = Array.isArray(response) ? response[0] : response
    const raw = linerase(responseObj) as {
      currentTime?: unknown
      terminationTime?: unknown
      notificationMessage?: NotificationMessage | NotificationMessage[]
    }

    // Normalize notification messages to array
    let notifications: NotificationMessage[] = []
    if (raw.notificationMessage) {
      notifications = Array.isArray(raw.notificationMessage) ? raw.notificationMessage : [raw.notificationMessage]
    }

    // Track observed categories from pulled messages
    for (const message of notifications) {
      const topic = message.topic?._
      if (topic) {
        const category = categorizeEvent(topic)
        if (category !== 'unknown') {
          this.observedCategories.add(category)
        }
      }
    }

    return {
      currentTime: toDate(raw.currentTime),
      terminationTime: toDate(raw.terminationTime),
      notificationMessage: notifications
    }
  }

  /**
   * Renew the subscription
   */
  async renew(): Promise<{ currentTime: Date; terminationTime: Date }> {
    if (!this.subscription) {
      throw new Error('No active subscription. Call createPullPointSubscription first.')
    }

    const subscriptionId = this.subscription.subscriptionReference.referenceParameters?.subscriptionId
    const urlAddress = this.subscription.subscriptionReference.address

    const body = this.buildSubscriptionBody(urlAddress, subscriptionId, `
      <Renew xmlns="http://docs.oasis-open.org/wsn/b-2">
        <TerminationTime>${DEFAULT_TERMINATION_TIME}</TerminationTime>
      </Renew>
    `)

    const [data] = await this.onvif.request<{ renewResponse?: unknown }>({
      url: urlAddress.href,
      raw: true,
      body
    })

    const raw = linerase(data.renewResponse) as { currentTime?: unknown; terminationTime?: unknown }

    return {
      currentTime: toDate(raw.currentTime),
      terminationTime: toDate(raw.terminationTime)
    }
  }

  /**
   * Unsubscribe from events
   */
  async unsubscribe(): Promise<void> {
    if (!this.subscription) {
      return
    }

    const subscriptionId = this.subscription.subscriptionReference.referenceParameters?.subscriptionId
    const urlAddress = this.subscription.subscriptionReference.address

    try {
      const body = this.buildSubscriptionBody(urlAddress, subscriptionId, `
        <Unsubscribe xmlns="http://docs.oasis-open.org/wsn/b-2"/>
      `)

      await this.onvif.request({
        url: urlAddress.href,
        raw: true,
        body
      })
    } catch {
      // Ignore unsubscribe errors
    } finally {
      this.subscription = undefined
      this.terminationTime = undefined
    }
  }

  /**
   * Start the event polling loop
   *
   * @param options - Options for the event loop
   */
  startEventLoop(options: EventLoopOptions = {}): void {
    if (this.shouldPoll) {
      return // Already running
    }

    this.shouldPoll = true
    this.messageLimit = options.messageLimit ?? DEFAULT_MESSAGE_LIMIT
    void this.runEventLoop()
  }

  /**
   * Stop the event polling loop
   */
  stopEventLoop(): void {
    this.shouldPoll = false
    // Unsubscribe in background
    void this.unsubscribe()
  }

  /**
   * Check if event loop is running
   */
  get isRunning(): boolean {
    return this.shouldPoll
  }

  /**
   * Get event categories that have been observed (actually received)
   * More reliable than TopicSet-based detection for cameras that don't advertise all capabilities
   */
  getObservedCategories(): EventCategory[] {
    return Array.from(this.observedCategories)
  }

  /**
   * Clear observed categories (e.g., when reconnecting or resetting)
   */
  clearObservedCategories(): void {
    this.observedCategories.clear()
  }

  /**
   * Check if a specific category has been observed
   *
   * @param category - The event category to check
   */
  hasObservedCategory(category: EventCategory): boolean {
    return this.observedCategories.has(category)
  }

  /**
   * Get current subscription (if any)
   */
  get currentSubscription(): PullPointSubscription | undefined {
    return this.subscription
  }

  // -------------------- Private Methods --------------------

  /**
   * Main event loop using async/await
   */
  private async runEventLoop(): Promise<void> {
    while (this.shouldPoll) {
      try {
        // Check if we need to create/renew subscription
        if (!this.subscription || !this.terminationTime || Date.now() > this.terminationTime.getTime()) {
          await this.createPullPointSubscription()
          this.reconnectMs = 10
        }

        // Pull messages
        const result = await this.pullMessages({ messageLimit: this.messageLimit })
        this.reconnectMs = 10

        // Emit events and track observed categories
        if (result.notificationMessage && result.notificationMessage.length > 0) {
          for (const message of result.notificationMessage) {
            // Track observed category
            const topic = message.topic?._
            if (topic) {
              const category = categorizeEvent(topic)
              if (category !== 'unknown') {
                this.observedCategories.add(category)
              }
            }

            this.emit('event', message)
          }
        }

        // Update termination time
        this.terminationTime = this.calculateTerminationTime(result)

        // Try to renew subscription
        try {
          const renewResult = await this.renew()
          this.terminationTime = this.calculateTerminationTime(renewResult)
        } catch {
          // Renew failed, continue anyway - subscription might still be valid
        }
      } catch (error) {
        this.emit('error', error)

        if (this.isRetryableError(error)) {
          // Wait before retry with exponential backoff
          await this.sleep(this.reconnectMs)
          if (this.reconnectMs < MAX_RECONNECT_MS) {
            this.reconnectMs = Math.min(this.reconnectMs * 1.5, MAX_RECONNECT_MS)
          }
        } else {
          // Non-retryable error, try to unsubscribe and restart
          try {
            await this.unsubscribe()
          } catch {
            // Ignore
          }
        }
      }
    }
  }

  /**
   * Sleep helper
   *
   * @param ms - Milliseconds to sleep
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }

  /**
   * Check if error is retryable
   *
   * @param error - The error object to check
   */
  private isRetryableError(error: unknown): boolean {
    if (typeof error === 'object' && error !== null && 'code' in error) {
      const code = (error as { code: string }).code
      return RETRY_ERROR_CODES.includes(code)
    }
    return false
  }

  /**
   * Calculate local termination time accounting for clock drift
   *
   * @param response - The response containing currentTime and terminationTime
   */
  private calculateTerminationTime(response: { currentTime: Date; terminationTime: Date }): Date {
    const serverOffset = response.currentTime.getTime() - Date.now()
    return new Date(response.terminationTime.getTime() - serverOffset)
  }

  /**
   * Build SOAP envelope for subscription-related operations
   *
   * @param urlAddress - The URL address for the subscription
   * @param subscriptionId - The subscription ID (if any)
   * @param bodyContent - The body content XML
   */
  private buildSubscriptionBody(urlAddress: URL, subscriptionId: string | undefined, bodyContent: string): string {
    // Build security header if credentials are available
    let securitySection = ''
    if (this.onvif.username && this.onvif.password) {
      const digest = this.onvif.passwordDigest()
      securitySection = `
        <Security s:mustUnderstand="1" xmlns="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd">
          <UsernameToken>
            <Username>${this.onvif.username}</Username>
            <Password Type="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordDigest">${digest.passDigest}</Password>
            <Nonce EncodingType="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-soap-message-security-1.0#Base64Binary">${digest.nonce}</Nonce>
            <Created xmlns="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd">${digest.timestamp}</Created>
          </UsernameToken>
        </Security>`
    }

    // Build addressing header
    let addressingContent: string
    if (!subscriptionId) {
      addressingContent = `<a:To>${urlAddress.href}</a:To>`
    } else {
      // Axis cameras use subscription ID in reference parameters
      addressingContent = `<a:To mustUnderstand="1">${urlAddress.href}</a:To>
        <SubscriptionId xmlns="http://www.axis.com/2009/event" a:IsReferenceParameter="true">${subscriptionId}</SubscriptionId>`
    }

    return `
      <s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope" xmlns:a="http://www.w3.org/2005/08/addressing">
        <s:Header>
          ${securitySection}
          ${addressingContent}
        </s:Header>
        <s:Body xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema">
          ${bodyContent}
        </s:Body>
      </s:Envelope>
    `.trim()
  }
}

// -------------------- Utility Functions --------------------

/**
 * Parse an ONVIF event topic string into structured data
 *
 * @param topic - The event topic string
 */
export function parseEventTopic(topic: string): ParsedTopic {
  const parts = topic.split('/')
  const firstPart = parts[0] ?? ''
  const colonIndex = firstPart.indexOf(':')

  const namespace = colonIndex > 0 ? firstPart.substring(0, colonIndex) : ''
  const firstPartWithoutNs = colonIndex > 0 ? firstPart.substring(colonIndex + 1) : firstPart

  const cleanParts = [firstPartWithoutNs, ...parts.slice(1)].map((p) => {
    // Remove namespace prefix from each part
    const idx = p.indexOf(':')
    return idx > 0 ? p.substring(idx + 1) : p
  })

  return {
    full: topic,
    namespace,
    parts: cleanParts,
    category: categorizeEvent(topic)
  }
}

/**
 * Categorize an event based on its topic
 *
 * @param topic - The event topic string
 */
export function categorizeEvent(topic: string): EventCategory {
  const topicLower = topic.toLowerCase()

  // Face detection patterns (check before generic analytics)
  if (topicLower.includes('facedetect') || topicLower.includes('facedetection')) {
    return 'face'
  }

  // Person/People detection patterns (check before generic analytics)
  if (
    topicLower.includes('peopledetect') ||
    topicLower.includes('persondetect') ||
    topicLower.includes('humandetect')
  ) {
    return 'person'
  }

  // Vehicle detection patterns (check before generic analytics)
  if (topicLower.includes('vehicledetect') || topicLower.includes('cardetect')) {
    return 'vehicle'
  }

  // Animal detection patterns (check before generic analytics)
  if (
    topicLower.includes('dogcatdetect') ||
    topicLower.includes('animaldetect') ||
    topicLower.includes('petdetect')
  ) {
    return 'animal'
  }

  // License plate detection patterns (check before generic analytics)
  if (topicLower.includes('licenseplate') || topicLower.includes('anpr')) {
    return 'license_plate'
  }

  // Motion detection patterns
  if (
    topicLower.includes('motiondetect') ||
    topicLower.includes('cellmotion') ||
    topicLower.includes('linedetect') ||
    topicLower.includes('fielddetect') ||
    topicLower.includes('motionalarm')
  ) {
    return 'motion'
  }

  // Tamper detection patterns
  if (
    topicLower.includes('imagetooblurry') ||
    topicLower.includes('imagetoodark') ||
    topicLower.includes('imagetoobright') ||
    topicLower.includes('globalscenechange') ||
    topicLower.includes('tamper')
  ) {
    return 'tamper'
  }

  // Audio patterns
  if (topicLower.includes('audioanalytics') || topicLower.includes('audiodetect')) {
    return 'audio'
  }

  // Digital input patterns
  if (topicLower.includes('digitalinput') || topicLower.includes('trigger/digitalinput')) {
    return 'digital_input'
  }

  // Relay patterns
  if (topicLower.includes('relay') || topicLower.includes('relayoutput')) {
    return 'relay'
  }

  // PTZ patterns
  if (topicLower.includes('ptzcontroller') || topicLower.includes('ptzstatus')) {
    return 'ptz'
  }

  // Recording patterns
  if (topicLower.includes('recording')) {
    return 'recording'
  }

  // Analytics patterns (generic fallback)
  if (topicLower.includes('videoanalytics') || topicLower.includes('analytics')) {
    return 'analytics'
  }

  // Device patterns
  if (topicLower.includes('device/')) {
    return 'device'
  }

  return 'unknown'
}

/**
 * Extract motion event data from a notification message
 *
 * @param message - The notification message
 */
export function parseMotionEvent(message: NotificationMessage): MotionEventData | undefined {
  const topic = message.topic?._
  if (!topic) {
    return undefined
  }

  const category = categorizeEvent(topic)
  if (category !== 'motion') {
    return undefined
  }

  // Extract motion state from data
  const data = message.message?.data
  const source = message.message?.source

  let isMotion = false
  let videoSourceToken: string | undefined
  let rule: string | undefined

  // Parse data simple items
  if (data?.simpleItem) {
    const items = Array.isArray(data.simpleItem) ? data.simpleItem : [data.simpleItem]
    for (const item of items) {
      const name = (item.name ?? '').toLowerCase()
      if (name === 'ismotion' || name === 'state') {
        isMotion = item.value === true || item.value === 'true' || item.value === '1'
      }
    }
  }

  // Parse source simple items
  if (source?.simpleItem) {
    const items = Array.isArray(source.simpleItem) ? source.simpleItem : [source.simpleItem]
    for (const item of items) {
      const name = (item.name ?? '').toLowerCase()
      if (name === 'videosourcetoken' || name === 'videosourceconfigurationtoken') {
        videoSourceToken = String(item.value)
      }
      if (name === 'rule') {
        rule = String(item.value)
      }
    }
  }

  const result: MotionEventData = {
    isMotion
  }

  if (videoSourceToken !== undefined) {
    result.videoSourceToken = videoSourceToken
  }
  if (rule !== undefined) {
    result.rule = rule
  }
  if (message.message?.utcTime) {
    result.timestamp = toDate(message.message.utcTime)
  }

  return result
}

/**
 * Extract detection event data from a notification message
 * Handles face, person, vehicle, animal, and license plate detection
 *
 * @param message - The notification message
 */
export function parseDetectionEvent(message: NotificationMessage): DetectionEventData | undefined {
  const topic = message.topic?._
  if (!topic) {
    return undefined
  }

  const category = categorizeEvent(topic)

  // Only handle detection categories
  if (category !== 'face' && category !== 'person' && category !== 'vehicle' && category !== 'animal' && category !== 'license_plate') {
    return undefined
  }

  // Extract detection state from data
  const data = message.message?.data
  const source = message.message?.source

  let isDetected = false
  let videoSourceToken: string | undefined
  let rule: string | undefined
  const additionalData: Record<string, unknown> = {}

  // Parse data simple items
  if (data?.simpleItem) {
    const items = Array.isArray(data.simpleItem) ? data.simpleItem : [data.simpleItem]
    for (const item of items) {
      const name = (item.name ?? '').toLowerCase()
      if (name === 'isdetected' || name === 'state' || name === 'isactive') {
        isDetected = item.value === true || item.value === 'true' || item.value === '1'
      }
      // Capture additional data like license plate text
      if (name === 'platetext' || name === 'licenseplatenumber') {
        additionalData['plateText'] = String(item.value)
      }
      if (name === 'confidence') {
        additionalData['confidence'] = Number(item.value)
      }
    }
  }

  // Parse source simple items
  if (source?.simpleItem) {
    const items = Array.isArray(source.simpleItem) ? source.simpleItem : [source.simpleItem]
    for (const item of items) {
      const name = (item.name ?? '').toLowerCase()
      if (name === 'videosourcetoken' || name === 'videosourceconfigurationtoken') {
        videoSourceToken = String(item.value)
      }
      if (name === 'rule') {
        rule = String(item.value)
      }
    }
  }

  const result: DetectionEventData = {
    category,
    isDetected
  }

  if (videoSourceToken !== undefined) {
    result.videoSourceToken = videoSourceToken
  }
  if (rule !== undefined) {
    result.rule = rule
  }
  if (message.message?.utcTime) {
    result.timestamp = toDate(message.message.utcTime)
  }
  if (Object.keys(additionalData).length > 0) {
    result.data = additionalData
  }

  return result
}

/**
 * Extract audio event data from a notification message
 *
 * @param message - The notification message
 */
export function parseAudioEvent(message: NotificationMessage): AudioEventData | undefined {
  const topic = message.topic?._
  if (!topic) {
    return undefined
  }

  const category = categorizeEvent(topic)
  if (category !== 'audio') {
    return undefined
  }

  // Extract audio state from data
  const data = message.message?.data
  const source = message.message?.source

  let isAudioDetected = false
  let audioSourceToken: string | undefined
  let audioType: string | undefined
  let level: number | undefined
  let rule: string | undefined

  // Parse data simple items
  if (data?.simpleItem) {
    const items = Array.isArray(data.simpleItem) ? data.simpleItem : [data.simpleItem]
    for (const item of items) {
      const name = (item.name ?? '').toLowerCase()
      if (name === 'isaudiodetected' || name === 'state' || name === 'isactive' || name === 'issound') {
        isAudioDetected = item.value === true || item.value === 'true' || item.value === '1'
      }
      if (name === 'audiotype' || name === 'soundtype' || name === 'type') {
        audioType = String(item.value)
      }
      if (name === 'level' || name === 'soundlevel' || name === 'audiolevel') {
        level = Number(item.value)
      }
    }
  }

  // Parse source simple items
  if (source?.simpleItem) {
    const items = Array.isArray(source.simpleItem) ? source.simpleItem : [source.simpleItem]
    for (const item of items) {
      const name = (item.name ?? '').toLowerCase()
      if (name === 'audiosourcetoken' || name === 'audiosourceconfigurationtoken') {
        audioSourceToken = String(item.value)
      }
      if (name === 'rule') {
        rule = String(item.value)
      }
    }
  }

  // Try to extract audio type from topic if not in data
  if (!audioType) {
    const topicLower = topic.toLowerCase()
    if (topicLower.includes('scream')) audioType = 'scream'
    else if (topicLower.includes('gunshot')) audioType = 'gunshot'
    else if (topicLower.includes('glass') || topicLower.includes('break')) audioType = 'glass_break'
    else if (topicLower.includes('cry') || topicLower.includes('baby')) audioType = 'cry'
    else if (topicLower.includes('bark') || topicLower.includes('dog')) audioType = 'bark'
    else if (topicLower.includes('alarm')) audioType = 'alarm'
    else audioType = 'generic'
  }

  const result: AudioEventData = {
    isAudioDetected
  }

  if (audioSourceToken !== undefined) {
    result.audioSourceToken = audioSourceToken
  }
  if (audioType !== undefined) {
    result.audioType = audioType
  }
  if (level !== undefined) {
    result.level = level
  }
  if (rule !== undefined) {
    result.rule = rule
  }
  if (message.message?.utcTime) {
    result.timestamp = toDate(message.message.utcTime)
  }

  return result
}

/**
 * Check if device supports audio detection based on event properties
 *
 * @param properties - The event properties
 */
export function supportsAudioDetection(properties: EventProperties): boolean {
  if (!properties.topicSet) {
    return false
  }
  const topicSetStr = JSON.stringify(properties.topicSet).toLowerCase()
  return (
    topicSetStr.includes('audioanalytics') ||
    topicSetStr.includes('audiodetect') ||
    topicSetStr.includes('sounddetect')
  )
}

/**
 * Check if device supports motion detection based on event properties
 *
 * @param properties - The event properties
 */
export function supportsMotionDetection(properties: EventProperties): boolean {
  if (!properties.topicSet) {
    return false
  }

  // Convert topic set to string for pattern matching
  const topicSetStr = JSON.stringify(properties.topicSet).toLowerCase()

  // Check for common motion detection patterns
  return (
    topicSetStr.includes('motiondetect') ||
    topicSetStr.includes('cellmotion') ||
    topicSetStr.includes('linedetect') ||
    topicSetStr.includes('fielddetect') ||
    topicSetStr.includes('motionalarm')
  )
}

/**
 * Check if device supports face detection based on event properties
 *
 * @param properties - The event properties
 */
export function supportsFaceDetection(properties: EventProperties): boolean {
  if (!properties.topicSet) {
    return false
  }
  const topicSetStr = JSON.stringify(properties.topicSet).toLowerCase()
  return (
    topicSetStr.includes('facedetect') ||
    topicSetStr.includes('facedetection') ||
    topicSetStr.includes('myruledetector') // Reolink cameras use MyRuleDetector/FaceDetect
  )
}

/**
 * Check if device supports person/people detection based on event properties
 *
 * @param properties - The event properties
 */
export function supportsPersonDetection(properties: EventProperties): boolean {
  if (!properties.topicSet) {
    return false
  }
  const topicSetStr = JSON.stringify(properties.topicSet).toLowerCase()
  return (
    topicSetStr.includes('peopledetect') ||
    topicSetStr.includes('persondetect') ||
    topicSetStr.includes('humandetect') ||
    topicSetStr.includes('myruledetector') // Reolink cameras use MyRuleDetector/PeopleDetect
  )
}

/**
 * Check if device supports vehicle detection based on event properties
 *
 * @param properties - The event properties
 */
export function supportsVehicleDetection(properties: EventProperties): boolean {
  if (!properties.topicSet) {
    return false
  }
  const topicSetStr = JSON.stringify(properties.topicSet).toLowerCase()
  return (
    topicSetStr.includes('vehicledetect') ||
    topicSetStr.includes('cardetect') ||
    topicSetStr.includes('myruledetector') // Reolink cameras use MyRuleDetector/VehicleDetect
  )
}

/**
 * Check if device supports animal detection based on event properties
 *
 * @param properties - The event properties
 */
export function supportsAnimalDetection(properties: EventProperties): boolean {
  if (!properties.topicSet) {
    return false
  }
  const topicSetStr = JSON.stringify(properties.topicSet).toLowerCase()
  return (
    topicSetStr.includes('dogcatdetect') ||
    topicSetStr.includes('animaldetect') ||
    topicSetStr.includes('petdetect') ||
    topicSetStr.includes('myruledetector') // Reolink cameras use MyRuleDetector/DogCatDetect
  )
}

/**
 * Check if device supports license plate detection based on event properties
 *
 * @param properties - The event properties
 */
export function supportsLicensePlateDetection(properties: EventProperties): boolean {
  if (!properties.topicSet) {
    return false
  }
  const topicSetStr = JSON.stringify(properties.topicSet).toLowerCase()
  return topicSetStr.includes('licenseplate') || topicSetStr.includes('anpr')
}

/**
 * Get all supported detection types for a device
 *
 * @param properties - The event properties
 */
export function getSupportedDetectionTypes(properties: EventProperties): EventCategory[] {
  const supported: EventCategory[] = []

  if (supportsMotionDetection(properties)) supported.push('motion')
  if (supportsFaceDetection(properties)) supported.push('face')
  if (supportsPersonDetection(properties)) supported.push('person')
  if (supportsVehicleDetection(properties)) supported.push('vehicle')
  if (supportsAnimalDetection(properties)) supported.push('animal')
  if (supportsLicensePlateDetection(properties)) supported.push('license_plate')
  if (supportsAudioDetection(properties)) supported.push('audio')

  return supported
}

/**
 * Get all supported detection types combining TopicSet and observed events
 * This is more reliable than TopicSet alone for cameras like Reolink
 * that send events they don't advertise in the TopicSet
 *
 * @param properties - The event properties from getEventProperties()
 * @param observed - The observed categories from events.getObservedCategories()
 */
export function getAllSupportedDetectionTypes(
  properties: EventProperties,
  observed: EventCategory[]
): EventCategory[] {
  const fromTopicSet = getSupportedDetectionTypes(properties)
  const combined = new Set([...fromTopicSet, ...observed])
  return Array.from(combined)
}
