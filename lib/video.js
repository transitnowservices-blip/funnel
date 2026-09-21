'use strict';
/**
 * lib/video.js — Phase 5: live-video provider abstraction.
 *
 * HONESTY RULE (absolute): no provider credentials exist in this environment,
 * and none may be invented. A media connection may only ever be presented as
 * connected when a genuine provider-backed media session exists — which is
 * impossible here, so the UI must never claim it.
 *
 * Design: a VideoProvider interface with concrete implementations (daily,
 * twilio, agora) that activate ONLY when their env vars are set. Switching
 * providers = config change, not code change. All secrets stay server-side;
 * nothing provider-related is ever sent to frontend code.
 *
 * Env vars (documented in .env.example, WITHOUT values):
 *   VIDEO_PROVIDER        — "daily" | "twilio" | "agora" (unset = no provider)
 *   VIDEO_API_KEY         — provider API key / app id
 *   VIDEO_API_SECRET      — provider API secret / app certificate
 *   VIDEO_PROJECT_ID      — provider project id (where the provider needs one)
 *   VIDEO_WEBHOOK_SECRET  — secret used to verify provider webhooks
 */

/** The interface every concrete provider implements. */
class VideoProvider {
  constructor(name) {
    this.name = name;
  }
  /** True only when this provider's required credentials are present. */
  configured() {
    return false;
  }
  /** Which env vars this provider needs (for honest status reporting). */
  requiredEnv() {
    return [];
  }
  /**
   * Create a provider-side room for a session. MUST throw when the provider
   * is not configured — never return a fake room.
   */
  async createRoom(/* { sessionId } */) {
    throw new Error(`Video provider "${this.name}" is not configured.`);
  }
  /** Verify a provider webhook payload. Throws when unconfigured. */
  verifyWebhook(/* payload, signature */) {
    throw new Error(`Video provider "${this.name}" is not configured.`);
  }
}

function envSet(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

class DailyProvider extends VideoProvider {
  constructor() {
    super('daily');
  }
  requiredEnv() {
    return ['VIDEO_API_KEY'];
  }
  configured() {
    return envSet(process.env.VIDEO_API_KEY);
  }
  async createRoom({ sessionId }) {
    if (!this.configured()) throw new Error('Video provider "daily" is not configured.');
    // Real implementation would POST to https://api.daily.co/v1/rooms with the
    // API key here. Not wired: no credentials exist, and we do not fake it.
    throw new Error('Daily room creation is not wired to the Daily API in this build.');
  }
}

class TwilioVideoProvider extends VideoProvider {
  constructor() {
    super('twilio');
  }
  requiredEnv() {
    return ['VIDEO_API_KEY', 'VIDEO_API_SECRET'];
  }
  configured() {
    return envSet(process.env.VIDEO_API_KEY) && envSet(process.env.VIDEO_API_SECRET);
  }
  async createRoom({ sessionId }) {
    if (!this.configured()) throw new Error('Video provider "twilio" is not configured.');
    throw new Error('Twilio room creation is not wired to the Twilio API in this build.');
  }
}

class AgoraProvider extends VideoProvider {
  constructor() {
    super('agora');
  }
  requiredEnv() {
    return ['VIDEO_API_KEY', 'VIDEO_API_SECRET'];
  }
  configured() {
    return envSet(process.env.VIDEO_API_KEY) && envSet(process.env.VIDEO_API_SECRET);
  }
  async createRoom({ sessionId }) {
    if (!this.configured()) throw new Error('Video provider "agora" is not configured.');
    throw new Error('Agora channel creation is not wired to the Agora API in this build.');
  }
}

/** Registry: provider name -> constructor. */
const PROVIDER_REGISTRY = {
  daily: DailyProvider,
  twilio: TwilioVideoProvider,
  agora: AgoraProvider,
};

function selectedProviderName() {
  const v = String(process.env.VIDEO_PROVIDER || '').trim().toLowerCase();
  return PROVIDER_REGISTRY[v] ? v : null;
}

/** The active provider instance, or null when none is configured. */
function activeProvider() {
  const name = selectedProviderName();
  if (!name) return null;
  const p = new PROVIDER_REGISTRY[name]();
  return p.configured() ? p : null;
}

/**
 * Honest provider status for views. `configured` is true only when a provider
 * is selected AND its credentials are present. Until then every surface must
 * show VIDEO PROVIDER REQUIRED and label workflows SIMULATED TEST.
 */
function providerStatus() {
  const requested = String(process.env.VIDEO_PROVIDER || '').trim().toLowerCase() || null;
  const name = selectedProviderName();
  const provider = activeProvider();
  const missing = [];
  if (name) {
    for (const k of new PROVIDER_REGISTRY[name]().requiredEnv()) {
      if (!envSet(process.env[k])) missing.push(k);
    }
  }
  return {
    configured: !!provider,
    providerName: provider ? provider.name : null,
    requestedName: requested,
    knownProvider: !!name,
    missingEnv: missing,
    // Credentials alone never prove a media connection. This flips to true
    // only after a genuine provider-backed end-to-end call succeeds.
    mediaVerified: false,
    // Until a provider is configured, all media is simulated — say so.
    simulated: !provider,
  };
}

module.exports = {
  VideoProvider,
  DailyProvider,
  TwilioVideoProvider,
  AgoraProvider,
  PROVIDER_REGISTRY,
  selectedProviderName,
  activeProvider,
  providerStatus,
};
