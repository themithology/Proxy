const crypto = require('crypto');
const config = require('../config');
const { cache, circuitBreaker } = require('../utils/cache');
const { buildProxyStreamUrl } = require('./proxy');
const { telemetry } = require('./telemetry');

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0 Safari/537.36';

/**
 * Hamster Wheel Server — Multi-Language OMSS Cascade
 * 
 * Priority 1: Videasy (6+ servers, explicit multi-language support)
 *   - mb-flix, 1movies, cdn, superflix, lamovie, cuevana
 *   - Language-specific sources (German, Italian, French, English, Hindi)
 * 
 * Priority 2: Peachify (6 servers, dub label support)
 *   - moviebox, holly, air, multi, net, bmb
 *   - Encrypted responses, supports dub/sub labels
 * 
 * Priority 3: VidSrc via vsembed.ru (4 CDN domains)
 *   - Fallback with neonhorizonworkshops, wanderlynest, orchidpixelgardens, cloudnestra
 *   - Simpler scraping, good last resort
 */

// ============================================================================
// PROVIDER 1: VIDEASY (Primary)
// ============================================================================

const VIDEASY_SERVERS = [
  { name: 'mb-flix', url: 'https://api.videasy.net/mb-flix/sources-with-title', language: 'english' },
  { name: '1movies', url: 'https://api.videasy.net/1movies/sources-with-title', language: 'english' },
  { name: 'cdn', url: 'https://api.videasy.net/cdn/sources-with-title', language: 'english' },
  { name: 'superflix', url: 'https://api.videasy.net/superflix/sources-with-title', language: 'english' },
  { name: 'lamovie', url: 'https://api.videasy.net/lamovie/sources-with-title', language: 'english' },
  { name: 'cuevana', url: 'https://api2.videasy.net/cuevana/sources-with-title', language: 'english' },
  { name: 'hdmovie', url: 'https://api.videasy.net/hdmovie/sources-with-title', language: 'hindi' }
];

/**
 * Videasy uses enc-dec.app encryption (shared with TMDB-Embed-API)
 * This is battle-tested and well-documented in the OMSS ecosystem
 */
async function decryptVideasyResponse(blob) {
  if (!blob || blob.length < 10) return null;
  
  try {
    // Try direct JSON parse first (some servers return plaintext)
    const json = JSON.parse(blob);
    if (json && (json.sources || json.streams)) return json;
  } catch {
    // Not JSON, needs decryption
  }
  
  // Call enc-dec.app decryption API
  // This is the standard OMSS decryption endpoint used by multiple providers
  try {
    const res = await fetch('https://enc-dec.app/api/decrypt', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': USER_AGENT
      },
      body: JSON.stringify({ data: blob })
    });
    
    if (!res.ok) return null;
    
    const decrypted = await res.text();
    try {
      return JSON.parse(decrypted);
    } catch {
      return null;
    }
  } catch {
    return null;
  }
}

async function resolveVideasy(metadata, preferredAudio = '') {
  const providerKey = 'videasy:hamster';
  if (!circuitBreaker.isAvailable(providerKey)) {
    return {
      ok: false,
      reason: 'circuit_open',
      diag: { stage: 'circuit_breaker', message: 'Videasy circuit breaker open' }
    };
  }
  
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 9500);
  
  try {
    const isTv = metadata.type === 'tv';
    const tmdbId = metadata.tmdbId;
    const season = metadata.season || 1;
    const episode = metadata.episode || 1;
    
    // Fan out to all Videasy servers in parallel
    const results = await Promise.allSettled(
      VIDEASY_SERVERS.map(async (server) => {
        try {
          const params = { tmdb: tmdbId };
          if (isTv) {
            params.s = season;
            params.e = episode;
          }
          
          const apiUrl = `${server.url}?${new URLSearchParams(params)}`;
          const res = await fetch(apiUrl, {
            headers: {
              'User-Agent': USER_AGENT,
              Accept: 'application/json, */*; q=0.01',
              Referer: 'https://player.videasy.net/',
              Origin: 'https://player.videasy.net'
            },
            signal: controller.signal
          });
          
          if (!res.ok) return null;
          
          const blob = await res.text();
          if (!blob || blob.length < 10) return null;
          
          const decrypted = await decryptVideasyResponse(blob);
          if (!decrypted) return null;
          
          const sources = decrypted.sources || decrypted.streams || [];
          if (sources.length === 0) return null;
          
          return {
            server: server.name,
            language: server.language,
            sources
          };
        } catch {
          return null;
        }
      })
    );
    
    const allSources = [];
    let failCount = 0;
    
    for (const result of results) {
      if (result.status === 'rejected' || !result.value) {
        failCount++;
        continue;
      }
      
      const { server, language, sources } = result.value;
      
      for (const source of sources) {
        const streamUrl = source.url || source.file || source.link;
        if (!streamUrl || typeof streamUrl !== 'string') continue;
        
        // Parse quality/language label
        const quality = source.quality || source.label || 'Auto';
        const isHttpStream = /^https?:\/\//i.test(streamUrl);
        const isHls = /\.m3u8(\?|$)/i.test(streamUrl);
        const isMp4 = /\.(mp4|mkv)(\?|$)/i.test(streamUrl);
        
        if (!isHttpStream) continue;
        
        const referer = 'https://player.videasy.net/';
        const proxiedUrl = buildProxyStreamUrl(streamUrl, referer, '', { mode: 'full' });
        
        allSources.push({
          server,
          language,
          quality,
          streamUrl: proxiedUrl,
          rawUrl: streamUrl,
          referer,
          format: isHls ? 'hls' : isMp4 ? 'mp4' : 'hls',
          headers: { Referer: referer }
        });
      }
    }
    
    if (allSources.length === 0) {
      circuitBreaker.recordFailure(providerKey);
      return {
        ok: false,
        reason: 'videasy_no_sources',
        diag: { stage: 'resolve', message: 'All Videasy servers returned no sources' }
      };
    }
    
    circuitBreaker.recordSuccess(providerKey);
    
    // Sort by preferred audio language
    const preferredCode = preferredAudio ? preferredAudio.toLowerCase() : '';
    if (preferredCode) {
      allSources.sort((a, b) => {
        const aMatch = a.language === preferredCode ? 1 : 0;
        const bMatch = b.language === preferredCode ? 1 : 0;
        return bMatch - aMatch;
      });
    }
    
    // Build audio tracks from sources
    const audioTracks = allSources.map((source, idx) => ({
      id: `videasy-${source.server}-${idx}`,
      lang: source.language || 'und',
      label: source.language ? `${source.language.charAt(0).toUpperCase() + source.language.slice(1)} (${source.server})` : `Source ${idx + 1} (${source.server})`,
      type: 'dub',
      streamUrl: source.streamUrl,
      rawUrl: source.rawUrl,
      default: idx === 0
    }));
    
    // Build quality ladder
    const qualities = allSources.map((source, idx) => ({
      label: source.quality || `Auto`,
      height: parseInt(source.quality) || (source.quality === '4K' ? 2160 : source.quality === 'HD' ? 1080 : 0),
      url: source.streamUrl
    }));
    
    const primary = allSources[0];
    
    return {
      server: 'hamster',
      provider: 'videasy',
      format: primary.format,
      rawUrl: primary.rawUrl,
      streamUrl: primary.streamUrl,
      referer: primary.referer,
      headers: primary.headers,
      backupUrls: allSources.slice(1).map((s) => s.streamUrl),
      audioTracks,
      qualities: qualities.length > 0 ? qualities : [{ label: 'Auto', height: 0, url: primary.streamUrl }],
      language: primary.language
    };
  } catch (err) {
    circuitBreaker.recordFailure(providerKey);
    return {
      ok: false,
      reason: 'videasy_error',
      diag: { stage: 'exception', message: err.message }
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

// ============================================================================
// PROVIDER 2: PEACHIFY (Fallback 1)
// ============================================================================

const PEACHIFY_SERVERS = [
  'https://uwu.eat-peach.sbs/moviebox',
  'https://usa.eat-peach.sbs/holly',
  'https://usa.eat-peach.sbs/air',
  'https://usa.eat-peach.sbs/multi',
  'https://uwu.eat-peach.sbs/net',
  'https://uwu.eat-peach.sbs/bmb'
];

/**
 * Peachify uses custom AES encryption
 * Decryption keys are embedded in the response
 */
async function decryptPeachifyResponse(encrypted, key) {
  if (!encrypted || !key) return null;
  
  try {
    const encBuffer = Buffer.from(encrypted, 'base64');
    const keyBuffer = Buffer.from(key, 'hex');
    
    // AES-256-CBC
    const iv = encBuffer.slice(0, 16);
    const ciphertext = encBuffer.slice(16);
    
    const decipher = crypto.createDecipheriv('aes-256-cbc', keyBuffer.slice(0, 32), iv);
    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    
    return JSON.parse(decrypted.toString('utf8'));
  } catch {
    return null;
  }
}

async function resolvePeachify(metadata, preferredAudio = '') {
  const providerKey = 'peachify:hamster';
  if (!circuitBreaker.isAvailable(providerKey)) {
    return {
      ok: false,
      reason: 'circuit_open',
      diag: { stage: 'circuit_breaker', message: 'Peachify circuit breaker open' }
    };
  }
  
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 9500);
  
  try {
    const isTv = metadata.type === 'tv';
    const tmdbId = metadata.tmdbId;
    const season = metadata.season || 1;
    const episode = metadata.episode || 1;
    
    // Fan out to all Peachify servers in parallel
    const results = await Promise.allSettled(
      PEACHIFY_SERVERS.map(async (serverBase) => {
        try {
          const params = { tmdb: tmdbId };
          if (isTv) {
            params.s = season;
            params.e = episode;
          }
          
          const apiUrl = `${serverBase}/api?${new URLSearchParams(params)}`;
          const res = await fetch(apiUrl, {
            headers: {
              'User-Agent': USER_AGENT,
              Accept: 'application/json',
              Referer: 'https://peachify.top/',
              Origin: 'https://peachify.top'
            },
            signal: controller.signal
          });
          
          if (!res.ok) return null;
          
          const json = await res.json();
          if (!json) return null;
          
          // Handle encrypted responses
          let data = json;
          if (json.isEncrypted && json.data && json.key) {
            data = await decryptPeachifyResponse(json.data, json.key);
            if (!data) return null;
          }
          
          const sources = data.sources || [];
          if (sources.length === 0) return null;
          
          return {
            server: new URL(serverBase).hostname,
            sources
          };
        } catch {
          return null;
        }
      })
    );
    
    const allSources = [];
    let failCount = 0;
    
    for (const result of results) {
      if (result.status === 'rejected' || !result.value) {
        failCount++;
        continue;
      }
      
      const { server, sources } = result.value;
      
      for (const source of sources) {
        const streamUrl = source.url || source.file || source.link;
        if (!streamUrl || typeof streamUrl !== 'string') continue;
        
        const quality = source.quality || source.label || 'Auto';
        const dub = source.dub || 'Original';
        const isHttpStream = /^https?:\/\//i.test(streamUrl);
        const isHls = /\.m3u8(\?|$)/i.test(streamUrl);
        const isMp4 = /\.(mp4|mkv)(\?|$)/i.test(streamUrl);
        
        if (!isHttpStream) continue;
        
        const referer = 'https://peachify.top/';
        const proxiedUrl = buildProxyStreamUrl(streamUrl, referer, '', { mode: 'full' });
        
        allSources.push({
          server,
          dub,
          quality,
          streamUrl: proxiedUrl,
          rawUrl: streamUrl,
          referer,
          format: isHls ? 'hls' : isMp4 ? 'mp4' : 'hls',
          headers: { Referer: referer }
        });
      }
    }
    
    if (allSources.length === 0) {
      circuitBreaker.recordFailure(providerKey);
      return {
        ok: false,
        reason: 'peachify_no_sources',
        diag: { stage: 'resolve', message: 'All Peachify servers returned no sources' }
      };
    }
    
    circuitBreaker.recordSuccess(providerKey);
    
    // Sort by preferred audio
    const preferredCode = preferredAudio ? preferredAudio.toLowerCase() : '';
    if (preferredCode) {
      allSources.sort((a, b) => {
        const aMatch = a.dub.toLowerCase().includes(preferredCode) ? 1 : 0;
        const bMatch = b.dub.toLowerCase().includes(preferredCode) ? 1 : 0;
        return bMatch - aMatch;
      });
    }
    
    // Build audio tracks
    const audioTracks = allSources.map((source, idx) => ({
      id: `peachify-${source.server}-${idx}`,
      lang: 'und',
      label: `${source.dub} (${source.server})`,
      type: source.dub.toLowerCase() === 'sub' ? 'sub' : 'dub',
      streamUrl: source.streamUrl,
      rawUrl: source.rawUrl,
      default: idx === 0
    }));
    
    // Build quality ladder
    const qualities = allSources.map((source, idx) => ({
      label: source.quality || `Auto`,
      height: parseInt(source.quality) || 0,
      url: source.streamUrl
    }));
    
    const primary = allSources[0];
    
    return {
      server: 'hamster',
      provider: 'peachify',
      format: primary.format,
      rawUrl: primary.rawUrl,
      streamUrl: primary.streamUrl,
      referer: primary.referer,
      headers: primary.headers,
      backupUrls: allSources.slice(1).map((s) => s.streamUrl),
      audioTracks,
      qualities: qualities.length > 0 ? qualities : [{ label: 'Auto', height: 0, url: primary.streamUrl }],
      dub: primary.dub
    };
  } catch (err) {
    circuitBreaker.recordFailure(providerKey);
    return {
      ok: false,
      reason: 'peachify_error',
      diag: { stage: 'exception', message: err.message }
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

// ============================================================================
// PROVIDER 3: VIDSRC via vsembed.ru (Fallback 2)
// ============================================================================

const VIDSRC_DOMAINS = {
  v1: 'neonhorizonworkshops.com',
  v2: 'wanderlynest.com',
  v3: 'orchidpixelgardens.com',
  v4: 'cloudnestra.com'
};

async function resolveVidsrc(metadata, preferredAudio = '') {
  const providerKey = 'vidsrc:hamster';
  if (!circuitBreaker.isAvailable(providerKey)) {
    return {
      ok: false,
      reason: 'circuit_open',
      diag: { stage: 'circuit_breaker', message: 'VidSrc circuit breaker open' }
    };
  }
  
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 9500);
  
  try {
    const isTv = metadata.type === 'tv';
    const tmdbId = metadata.tmdbId;
    const season = metadata.season || 1;
    const episode = metadata.episode || 1;
    
    // Step 1: Fetch initial embed page
    const baseUrl = 'https://vsembed.ru';
    const embedPath = isTv
      ? `/embed/tv?tmdb=${tmdbId}&season=${season}&episode=${episode}`
      : `/embed/movie?tmdb=${tmdbId}`;
    
    const embedUrl = `${baseUrl}${embedPath}`;
    const embedRes = await fetch(embedUrl, {
      headers: {
        'User-Agent': USER_AGENT,
        Referer: `${baseUrl}/`
      },
      signal: controller.signal
    });
    
    if (!embedRes.ok) {
      circuitBreaker.recordFailure(providerKey);
      return {
        ok: false,
        reason: 'vidsrc_embed_failed',
        diag: { stage: 'embed', message: `Embed page returned ${embedRes.status}` }
      };
    }
    
    const embedHtml = await embedRes.text();
    
    // Step 2: Extract second URL
    const secondUrlMatch = embedHtml.match(/fetch\(['"]([^'"]+)['"]/);
    if (!secondUrlMatch) {
      circuitBreaker.recordFailure(providerKey);
      return {
        ok: false,
        reason: 'vidsrc_no_second_url',
        diag: { stage: 'extract', message: 'Could not extract second URL' }
      };
    }
    
    let secondUrl = secondUrlMatch[1];
    if (secondUrl.startsWith('//')) secondUrl = 'https:' + secondUrl;
    
    // Step 3: Fetch second page
    const secondRes = await fetch(secondUrl, {
      headers: {
        'User-Agent': USER_AGENT,
        Referer: `${baseUrl}/`
      },
      signal: controller.signal
    });
    
    if (!secondRes.ok) {
      circuitBreaker.recordFailure(providerKey);
      return {
        ok: false,
        reason: 'vidsrc_second_page_failed',
        diag: { stage: 'second', message: `Second page returned ${secondRes.status}` }
      };
    }
    
    const secondHtml = await secondRes.text();
    
    // Step 4: Extract third URL
    const thirdUrlMatch = secondHtml.match(/fetch\(['"]([^'"]+)['"]/);
    if (!thirdUrlMatch) {
      circuitBreaker.recordFailure(providerKey);
      return {
        ok: false,
        reason: 'vidsrc_no_third_url',
        diag: { stage: 'extract', message: 'Could not extract third URL' }
      };
    }
    
    let thirdUrl = thirdUrlMatch[1];
    if (thirdUrl.startsWith('//')) thirdUrl = 'https:' + thirdUrl;
    
    // Step 5: Fetch final stream page
    const thirdRes = await fetch(thirdUrl, {
      headers: {
        'User-Agent': USER_AGENT,
        Referer: 'https://cloudnestra.com/'
      },
      signal: controller.signal
    });
    
    if (!thirdRes.ok) {
      circuitBreaker.recordFailure(providerKey);
      return {
        ok: false,
        reason: 'vidsrc_third_page_failed',
        diag: { stage: 'third', message: `Third page returned ${thirdRes.status}` }
      };
    }
    
    const thirdHtml = await thirdRes.text();
    
    // Step 6: Extract m3u8 URLs
    const fileMatch = thirdHtml.match(/file\s*:\s*["']([^"']+)["']/i);
    if (!fileMatch) {
      circuitBreaker.recordFailure(providerKey);
      return {
        ok: false,
        reason: 'vidsrc_no_m3u8',
        diag: { stage: 'extract', message: 'Could not extract m3u8 URLs' }
      };
    }
    
    let fileField = fileMatch[1];
    
    // Replace domain placeholders
    for (const [placeholder, domain] of Object.entries(VIDSRC_DOMAINS)) {
      fileField = fileField.replace(`{${placeholder}}`, domain);
    }
    
    // Split by " or "
    const m3u8Urls = fileField.split(/\s+or\s+/i).filter((url) => !url.includes('{'));
    
    if (m3u8Urls.length === 0) {
      circuitBreaker.recordFailure(providerKey);
      return {
        ok: false,
        reason: 'vidsrc_no_valid_urls',
        diag: { stage: 'extract', message: 'No valid m3u8 URLs after placeholder replacement' }
      };
    }
    
    circuitBreaker.recordSuccess(providerKey);
    
    // Build sources
    const allSources = m3u8Urls.map((url, idx) => {
      const referer = 'https://cloudnestra.com/';
      const proxiedUrl = buildProxyStreamUrl(url, referer, '', { mode: 'full' });
      
      return {
        url: proxiedUrl,
        rawUrl: url,
        referer,
        headers: { Referer: referer },
        format: 'hls'
      };
    });
    
    const primary = allSources[0];
    
    // Build audio tracks (VidSrc returns English only)
    const audioTracks = [
      {
        id: 'vidsrc-english',
        lang: 'en',
        label: 'English',
        type: 'sub',
        streamUrl: primary.url,
        rawUrl: primary.rawUrl,
        default: true
      }
    ];
    
    const qualities = [
      { label: 'Auto', height: 0, url: primary.url }
    ];
    
    return {
      server: 'hamster',
      provider: 'vidsrc',
      format: 'hls',
      rawUrl: primary.rawUrl,
      streamUrl: primary.url,
      referer: primary.referer,
      headers: primary.headers,
      backupUrls: allSources.slice(1).map((s) => s.url),
      audioTracks,
      qualities
    };
  } catch (err) {
    circuitBreaker.recordFailure(providerKey);
    return {
      ok: false,
      reason: 'vidsrc_error',
      diag: { stage: 'exception', message: err.message }
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

// ============================================================================
// HAMSTER WHEEL ORCHESTRATOR
// ============================================================================

/**
 * Hamster Wheel Server Orchestrator
 * Cascades through multi-language OMSS providers:
 *   1. Videasy (6+ servers, explicit multi-language)
 *   2. Peachify (6 servers, dub/sub labels)
 *   3. VidSrc (4 CDN domains, English fallback)
 */
async function resolveHamsterWheelServer(metadata, requestedServerId = 'hamster', preferredAudio = '') {
  const diag = { stage: 'init', steps: [] };
  const stamp = (stage, message, extra) => {
    diag.stage = stage;
    diag.steps.push({ stage, message, ...(extra || {}) });
    diag.message = message;
  };
  
  // Priority 1: Videasy (Primary - explicit multi-language)
  stamp('videasy_attempt', 'Querying Videasy multi-language upstream...');
  try {
    const videasyRes = await resolveVideasy(metadata, preferredAudio);
    if (videasyRes && videasyRes.streamUrl) {
      stamp('videasy_success', `Videasy resolved ${videasyRes.audioTracks.length} audio track(s) from ${videasyRes.provider}`);
      return { ok: true, ...videasyRes, diag };
    }
    stamp('videasy_miss', 'Videasy returned no playable streams for this title.');
  } catch (err) {
    stamp('videasy_error', `Videasy failed: ${err.message}`);
  }
  
  // Priority 2: Peachify (Fallback 1 - dub/sub labels)
  stamp('peachify_attempt', 'Querying Peachify dub/sub upstream...');
  try {
    const peachifyRes = await resolvePeachify(metadata, preferredAudio);
    if (peachifyRes && peachifyRes.streamUrl) {
      stamp('peachify_success', `Peachify resolved ${peachifyRes.audioTracks.length} audio track(s) from ${peachifyRes.provider}`);
      return { ok: true, ...peachifyRes, diag };
    }
    stamp('peachify_miss', 'Peachify returned no playable streams for this title.');
  } catch (err) {
    stamp('peachify_error', `Peachify failed: ${err.message}`);
  }
  
  // Priority 3: VidSrc (Fallback 2 - English only)
  stamp('vidsrc_attempt', 'Querying VidSrc fallback upstream...');
  try {
    const vidsrcRes = await resolveVidsrc(metadata, preferredAudio);
    if (vidsrcRes && vidsrcRes.streamUrl) {
      stamp('vidsrc_success', 'VidSrc resolved English stream.');
      return { ok: true, ...vidsrcRes, diag };
    }
    stamp('vidsrc_miss', 'VidSrc returned no playable streams for this title.');
  } catch (err) {
    stamp('vidsrc_error', `VidSrc failed: ${err.message}`);
  }
  
  // All providers failed
  stamp('hamster_exhausted', 'All Hamster Wheel providers (Videasy, Peachify, VidSrc) failed to resolve a stream.');
  return {
    ok: false,
    reason: 'hamster_all_sources_exhausted',
    diag
  };
}

module.exports = {
  resolveHamsterWheelServer,
  resolveVideasy,
  resolvePeachify,
  resolveVidsrc
};
