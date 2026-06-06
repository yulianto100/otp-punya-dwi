/**
 * OTP Detector - Scans incoming WhatsApp messages for OTP codes
 * Supports various Indonesian apps and services
 */

// OTP patterns ordered by specificity (most specific first)
const OTP_PATTERNS = [
  // Specific app patterns
  { regex: /(?:kode|code|pin|OTP)[\s:]*[\s]?([0-9]{4,8})/gi, name: 'generic' },
  { regex: /([0-9]{4,8})[\s]?(?:adalah|merupakan|ialah)[\s]?(?:kode|code|OTP|pin)/gi, name: 'reversed' },
  { regex: /(?:verifikasi|verification|verify)[^0-9]*([0-9]{4,8})/gi, name: 'verification' },
  { regex: /(?:masukkan|input|gunakan|gunakan kode|enter)[^0-9]*([0-9]{4,8})/gi, name: 'action' },
  { regex: /(?:kode Anda|your code|your OTP|your PIN)[^0-9]*([0-9]{4,8})/gi, name: 'your_code' },

  // Indonesian specific
  { regex: /(?:kode verifikasi)[^0-9]*([0-9]{4,8})/gi, name: 'id_verification' },
  { regex: /([0-9]{6})[\s]?(?:untuk|to)\s(?:verifikasi|verify|login|masuk|daftar)/gi, name: 'id_purpose' },

  // Common OTP formats (less specific, check last)
  { regex: /\b([0-9]{4,8})\b/g, name: 'standalone' },
];

// Known app indicators in messages
const APP_SIGNATURES = {
  'Kopi Kenangan': ['kopi kenangan', 'kopken', 'kopi kenangan'],
  'Fore Coffee': ['fore coffee', 'fore'],
  'Grab': ['grab'],
  'Gojek': ['gojek', 'gopay'],
  'Shopee': ['shopee', 'shopeefood'],
  'Tokopedia': ['tokopedia'],
  'Traveloka': ['traveloka'],
  'OVO': ['ovo'],
  'Dana': ['dana'],
  'LinkAja': ['linkaja'],
  'BCA': ['bca', 'bca mobile'],
  'Mandiri': ['mandiri', 'livin'],
  'BRI': ['bri', 'brimo'],
  'WhatsApp': ['whatsapp', 'wa'],
  'Telegram': ['telegram', 'tg'],
  'Google': ['google', 'gmail'],
  'Instagram': ['instagram', 'ig'],
  'TikTok': ['tiktok'],
  'X/Twitter': ['twitter', 'x.com'],
};

function detectOTP(messageText) {
  if (!messageText || typeof messageText !== 'string') return null;

  const text = messageText.trim();
  if (text.length < 4 || text.length > 500) return null;

  // Try patterns from most specific to least
  for (const pattern of OTP_PATTERNS) {
    // Reset regex lastIndex for global patterns
    pattern.regex.lastIndex = 0;
    const match = pattern.regex.exec(text);
    if (match && match[1]) {
      const code = match[1];
      // Validate: OTP should be 4-8 digits, not a year (20xx), not a phone number
      if (code.length >= 4 && code.length <= 8 && !code.startsWith('20') && !code.startsWith('62')) {
        return {
          code,
          pattern: pattern.name,
          confidence: pattern.name === 'standalone' ? 'low' : 'high',
        };
      }
    }
  }

  return null;
}

function detectApp(messageText) {
  if (!messageText) return 'Unknown';
  const lower = messageText.toLowerCase();

  for (const [appName, signatures] of Object.entries(APP_SIGNATURES)) {
    for (const sig of signatures) {
      if (lower.includes(sig)) return appName;
    }
  }

  return 'Unknown';
}

function processMessage(messageText) {
  const otpResult = detectOTP(messageText);
  if (!otpResult) return null;

  const app = detectApp(messageText);

  return {
    otp: otpResult.code,
    app,
    confidence: otpResult.confidence,
    pattern: otpResult.pattern,
  };
}

module.exports = { detectOTP, detectApp, processMessage, OTP_PATTERNS, APP_SIGNATURES };
