import type { AnyURI, FilterType } from './basics.ts'
import type { OnvifDate } from './onvif.ts'

/**
 * Event Broker Protocol types for MQTT/WebSocket connections
 */
export type EventBrokerProtocol = 'mqtt' | 'mqtts' | 'ws' | 'wss'

/**
 * Connection status for event broker
 */
export type ConnectionStatus = 'Offline' | 'Connecting' | 'Connected'

/**
 * PullPoint Subscription response from CreatePullPointSubscription
 */
export interface PullPointSubscription {
  subscriptionReference: {
    address: URL
    referenceParameters?: {
      subscriptionId?: string | undefined
    } | undefined
  }
  currentTime: Date
  terminationTime: Date
}

/**
 * Raw PullPoint Subscription response (before URL parsing)
 */
export interface RawPullPointSubscription {
  subscriptionReference: {
    address: string
    referenceParameters?: {
      subscriptionId?: string
    }
  }
  currentTime: OnvifDate
  terminationTime: OnvifDate
}

/**
 * Options for creating a PullPoint Subscription
 */
export interface CreatePullPointOptions {
  /** Optional XPATH expression to select specific topics */
  filter?: FilterType
  /** Initial termination time (ISO 8601 duration, e.g., 'PT2M' for 2 minutes) */
  initialTerminationTime?: string
}

/**
 * Options for pulling messages
 */
export interface PullMessagesOptions {
  /** Maximum time to block until response (ISO 8601 duration, e.g., 'PT1M') */
  timeout?: string
  /** Upper limit for the number of messages to return */
  messageLimit?: number
}

/**
 * Result from pulling messages
 */
export interface PullMessagesResult {
  currentTime: Date
  terminationTime: Date
  notificationMessage?: NotificationMessage[]
}

/**
 * Raw PullMessages response (before date parsing)
 */
export interface RawPullMessagesResult {
  currentTime: OnvifDate
  terminationTime: OnvifDate
  notificationMessage?: NotificationMessage | NotificationMessage[]
}

/**
 * Renew subscription result
 */
export interface RenewResult {
  currentTime: Date
  terminationTime: Date
}

/**
 * Raw renew response
 */
export interface RawRenewResult {
  currentTime: OnvifDate
  terminationTime: OnvifDate
}

/**
 * ONVIF Notification Message structure
 */
export interface NotificationMessage {
  /** Topic information */
  topic: {
    /** Topic path (e.g., 'tns1:RuleEngine/CellMotionDetector/Motion') */
    _: string
    /** Topic expression dialect */
    dialect?: string
  }
  /** Producer reference (optional) */
  producerReference?: {
    address?: string
  }
  /** Message content */
  message: {
    /** UTC time of the event */
    utcTime?: OnvifDate
    /** Property operation type */
    propertyOperation?: 'Initialized' | 'Changed' | 'Deleted'
    /** Source information */
    source?: {
      simpleItem?: SimpleItem | SimpleItem[]
    }
    /** Key information */
    key?: {
      simpleItem?: SimpleItem | SimpleItem[]
    }
    /** Data payload */
    data?: {
      simpleItem?: SimpleItem | SimpleItem[]
      elementItem?: unknown[]
    }
  }
}

/**
 * Simple item in notification message
 */
export interface SimpleItem {
  name: string
  value: unknown
}

/**
 * Parsed event topic structure
 */
export interface ParsedTopic {
  /** Full topic path */
  full: string
  /** Namespace prefix (e.g., 'tns1') */
  namespace: string
  /** Topic parts array */
  parts: string[]
  /** Primary category */
  category: EventCategory
}

/**
 * Event categories derived from ONVIF topics
 */
export type EventCategory =
  | 'motion'
  | 'face'
  | 'person'
  | 'vehicle'
  | 'animal'
  | 'license_plate'
  | 'tamper'
  | 'analytics'
  | 'ptz'
  | 'audio'
  | 'recording'
  | 'digital_input'
  | 'relay'
  | 'device'
  | 'unknown'

/**
 * Event properties from GetEventProperties
 */
export interface EventProperties {
  /** List of topic namespaces supported */
  topicNamespaceLocation?: AnyURI[]
  /** True when topic set is fixed for all times */
  fixedTopicSet?: boolean
  /** Set of topics supported */
  topicSet?: unknown
  /** Supported XPath expression dialects */
  topicExpressionDialect?: AnyURI[]
  /** Supported message content filter dialects */
  messageContentFilterDialect?: AnyURI[]
  /** Producer properties filter dialects */
  producerPropertiesFilterDialect?: AnyURI[]
  /** Message content schema locations */
  messageContentSchemaLocation?: AnyURI[]
}

/**
 * Event service capabilities from GetServiceCapabilities
 */
export interface EventServiceCapabilities {
  /** WS Subscription Policy Support */
  WSSubscriptionPolicySupport?: boolean
  /** WS PullPoint Support */
  WSPullPointSupport?: boolean
  /** WS Pausable Subscription Manager Interface Support */
  WSPausableSubscriptionManagerInterfaceSupport?: boolean
  /** Maximum number of notification producers */
  maxNotificationProducers?: number
  /** Maximum number of pull points */
  maxPullPoints?: number
  /** Persistent notification storage support */
  persistentNotificationStorage?: boolean
  /** Event broker protocols supported */
  eventBrokerProtocols?: EventBrokerProtocol[]
}

/**
 * Event loop options
 */
export interface EventLoopOptions {
  /** Message limit per pull request (default: 10) */
  messageLimit?: number
  /** Whether to auto-renew subscription (default: true) */
  autoRenew?: boolean
}

/**
 * Event broker configuration (for MQTT/WebSocket push)
 */
export interface EventBrokerConfig {
  /** Event broker address */
  address?: AnyURI
  /** Topic prefix for published events */
  topicPrefix?: string
  /** User name for authentication */
  userName?: string
  /** Password for authentication */
  password?: string
  /** Certificate ID for client authentication */
  certificateID?: string
  /** Filter for specific topics to publish */
  publishFilter?: FilterType
  /** Quality of service level (0, 1, or 2) */
  qoS?: number
  /** Current connection status */
  status?: ConnectionStatus
  /** Certification path validation policy ID */
  certPathValidationPolicyID?: string
  /** Metadata filter */
  metadataFilter?: FilterType
}

/**
 * Motion event data parsed from notification
 */
export interface MotionEventData {
  /** Whether motion is active */
  isMotion: boolean
  /** Source video source token */
  videoSourceToken?: string | undefined
  /** Rule name that triggered the event */
  rule?: string | undefined
  /** Timestamp of the event */
  timestamp?: Date | undefined
}

/**
 * Generic detection event data for object detection types
 * (face, person, vehicle, animal, license plate)
 */
export interface DetectionEventData {
  /** Event category */
  category: 'face' | 'person' | 'vehicle' | 'animal' | 'license_plate'
  /** Whether detection is active */
  isDetected: boolean
  /** Source video source token */
  videoSourceToken?: string | undefined
  /** Rule name that triggered the event */
  rule?: string | undefined
  /** Timestamp of the event */
  timestamp?: Date | undefined
  /** Additional data from the event (e.g., license plate text) */
  data?: Record<string, unknown> | undefined
}

/**
 * Audio event data parsed from notification
 */
export interface AudioEventData {
  /** Whether audio is detected */
  isAudioDetected: boolean
  /** Audio source token */
  audioSourceToken?: string | undefined
  /** Audio detection type (e.g., 'scream', 'gunshot', 'glass_break', 'cry', 'generic') */
  audioType?: string | undefined
  /** Sound level (if provided) */
  level?: number | undefined
  /** Rule name that triggered the event */
  rule?: string | undefined
  /** Timestamp of the event */
  timestamp?: Date | undefined
}

/**
 * Known ONVIF event topic patterns
 */
export const MOTION_TOPIC_PATTERNS = [
  'tns1:RuleEngine/CellMotionDetector',
  'tns1:VideoAnalytics/tnsx:MotionDetection',
  'tns1:VideoAnalytics/tnsaxis:MotionDetection',
  'tns1:RuleEngine/MyMotionDetectorRule',
  'tns1:RuleEngine/LineDetector',
  'tns1:RuleEngine/FieldDetector',
  'tns1:VideoSource/MotionAlarm',
] as const

export const FACE_TOPIC_PATTERNS = [
  'tns1:RuleEngine/MyRuleDetector/FaceDetect',
  'tns1:RuleEngine/FaceDetector',
  'tns1:VideoAnalytics/FaceDetection',
  'tns1:VideoAnalytics/tnsx:FaceDetection',
] as const

export const PERSON_TOPIC_PATTERNS = [
  'tns1:RuleEngine/MyRuleDetector/PeopleDetect',
  'tns1:RuleEngine/PersonDetector',
  'tns1:VideoAnalytics/PersonDetection',
  'tns1:VideoAnalytics/tnsx:PersonDetection',
  'tns1:RuleEngine/HumanDetector',
] as const

export const VEHICLE_TOPIC_PATTERNS = [
  'tns1:RuleEngine/MyRuleDetector/VehicleDetect',
  'tns1:RuleEngine/VehicleDetector',
  'tns1:VideoAnalytics/VehicleDetection',
  'tns1:VideoAnalytics/tnsx:VehicleDetection',
  'tns1:RuleEngine/CarDetector',
] as const

export const ANIMAL_TOPIC_PATTERNS = [
  'tns1:RuleEngine/MyRuleDetector/DogCatDetect',
  'tns1:RuleEngine/AnimalDetector',
  'tns1:VideoAnalytics/AnimalDetection',
  'tns1:RuleEngine/PetDetector',
] as const

export const LICENSE_PLATE_TOPIC_PATTERNS = [
  'tns1:RuleEngine/LicensePlateDetector',
  'tns1:VideoAnalytics/LicensePlateDetection',
  'tns1:VideoAnalytics/tnsx:LicensePlateRecognition',
  'tns1:RuleEngine/ANPR',
] as const

export const TAMPER_TOPIC_PATTERNS = [
  'tns1:VideoSource/ImageTooBlurry',
  'tns1:VideoSource/GlobalSceneChange',
  'tns1:VideoSource/ImageTooDark',
  'tns1:VideoSource/ImageTooBright',
] as const

export const AUDIO_TOPIC_PATTERNS = [
  'tns1:AudioAnalytics',
  'tns1:RuleEngine/AudioDetector',
] as const

export const DIGITAL_INPUT_TOPIC_PATTERNS = [
  'tns1:Device/Trigger/DigitalInput',
  'tns1:Device/IO/DigitalInput',
] as const

export const RELAY_TOPIC_PATTERNS = [
  'tns1:Device/Trigger/Relay',
  'tns1:Device/IO/RelayOutput',
] as const
